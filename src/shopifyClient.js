/**
 * Shopify GraphQL Admin API client.
 *
 * Read-only by design: the only operation in this module is a paginated
 * `orders` query. There is no mutation anywhere in this codebase, and the
 * access token is expected to hold `read_orders` and nothing else.
 */

import { getAccessToken, invalidateAccessToken } from './auth.js'
import { config } from './config.js'
import { info, warn } from './logger.js'

const UNFULFILLED_QUERY = 'status:open AND fulfillment_status:unfulfilled AND financial_status:paid'

const ORDERS_QUERY = `
  query UnfulfilledOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        name
        createdAt
        displayFulfillmentStatus
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          displayName
        }
        lineItems(first: 100) {
          totalCount
          nodes {
            quantity
          }
        }
      }
    }
  }
`

/**
 * @typedef {object} UnfulfilledOrder
 * @property {string} id - Shopify GID, e.g. "gid://shopify/Order/12345".
 * @property {string} legacyResourceId - Numeric order id used in admin URLs.
 * @property {string} name - Human order name, e.g. "TT1028NZ".
 * @property {string} createdAt - ISO-8601 UTC creation timestamp.
 * @property {string} customerName - Customer display name, or "Unknown customer".
 * @property {string} totalAmount - Decimal total as a string, e.g. "129.50".
 * @property {string} currencyCode - ISO currency code, e.g. "NZD".
 * @property {number} lineItemCount - Number of distinct line items.
 * @property {number} itemQuantity - Total quantity across all line items.
 * @property {string} adminUrl - Deep link to the order in the Shopify admin.
 */

/**
 * Sleeps for a number of milliseconds.
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extracts the numeric resource id from a Shopify GraphQL GID.
 *
 * Admin URLs take the bare number, never the GID. Putting the full
 * `gid://shopify/Order/1234` in the path produces a link that still *looks*
 * plausible in an embed but 404s when tapped, so this is worth being explicit
 * about rather than interpolating a field and hoping.
 *
 * @example
 * extractNumericId('gid://shopify/Order/1234567890') // => '1234567890'
 * extractNumericId('1234567890')                     // => '1234567890'
 * extractNumericId(null)                             // => ''
 * @param {string|number|null|undefined} gid - A GID, or an already-numeric id.
 * @returns {string} The numeric id, or an empty string when none can be found.
 */
export const extractNumericId = (gid) => {
  if (gid === null || gid === undefined) return ''
  const raw = String(gid).trim()
  if (raw === '') return ''
  // Take the trailing numeric segment, ignoring any ?query suffix Shopify may
  // append to a GID (e.g. gid://shopify/Order/123?namespace=x).
  const match = raw.match(/(\d+)(?:\?.*)?$/)
  return match ? match[1] : ''
}

/**
 * Builds the Shopify admin deep link for an order.
 *
 * @example
 * // storeHandle "tommy-tinkers", order gid://shopify/Order/1234567890
 * // => "https://admin.shopify.com/store/tommy-tinkers/orders/1234567890"
 * @param {string} orderId - Order GID or numeric id.
 * @returns {string} Absolute admin URL.
 */
export const buildAdminUrl = (orderId) =>
  `https://admin.shopify.com/store/${config.shopify.storeHandle}/orders/${extractNumericId(orderId)}`

/**
 * Normalises a raw GraphQL order node into the shape the rest of the app uses.
 * @param {object} node - Raw `orders.nodes[]` entry from the GraphQL response.
 * @returns {UnfulfilledOrder} Normalised order.
 */
const normaliseOrder = (node) => {
  const lineItems = node.lineItems?.nodes ?? []
  return {
    id: node.id,
    // Prefer the explicit field, but fall back to the GID so the admin link
    // still resolves if legacyResourceId is ever absent from the response.
    legacyResourceId: extractNumericId(node.legacyResourceId) || extractNumericId(node.id),
    name: node.name ?? 'Unknown order',
    createdAt: node.createdAt,
    // A guest checkout has no customer record attached, so displayName is null
    // rather than absent — fall back so the embed never renders "undefined".
    customerName: node.customer?.displayName?.trim() || 'Unknown customer',
    totalAmount: node.currentTotalPriceSet?.shopMoney?.amount ?? '0',
    currencyCode: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? config.alerting.currency,
    // totalCount is the true line item count; `nodes` is capped at the 100 we
    // asked for, so it would under-report a very large order.
    lineItemCount: node.lineItems?.totalCount ?? lineItems.length,
    itemQuantity: lineItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    adminUrl: buildAdminUrl(node.legacyResourceId ?? node.id)
  }
}

/**
 * Issues a single GraphQL request against the Admin API.
 *
 * The token comes from the auth module on every call rather than from a static
 * env var, because Dev Dashboard tokens expire roughly daily.
 * @param {string} query - GraphQL document.
 * @param {object} variables - Query variables.
 * @param {boolean} [allowAuthRetry=true] - Whether a 401 may trigger one forced refresh.
 * @returns {Promise<object>} The `data` payload of the response.
 * @throws {Error} On transport failure, non-2xx status, or GraphQL errors.
 */
const requestOnce = async (query, variables, allowAuthRetry = true) => {
  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getAccessToken()
    },
    body: JSON.stringify({ query, variables })
  })

  // A 401 means Shopify considers the token dead even though our expiry maths
  // said otherwise — clock drift, or the token was revoked. Force one refresh
  // and retry once. Deliberately inside a single network attempt so it does not
  // consume the caller's backoff budget, and gated by `allowAuthRetry` so a
  // genuinely bad client secret can't loop.
  if (response.status === 401 && allowAuthRetry) {
    invalidateAccessToken()
    await getAccessToken({ forceRefresh: true })
    return requestOnce(query, variables, false)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>')
    throw new Error(`Shopify HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`)
  }

  const payload = await response.json()

  // Shopify returns HTTP 200 with a populated `errors` array for query-level
  // problems (bad scope, throttling, malformed field), so a 200 alone is not
  // success — treat these as failures or we would report a false empty queue.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors.map((entry) => entry.message).join('; ')
    throw new Error(`Shopify GraphQL error: ${messages}`)
  }

  return payload.data
}

/**
 * Issues a GraphQL request with exponential backoff.
 * @param {string} query - GraphQL document.
 * @param {object} variables - Query variables.
 * @returns {Promise<object>} The `data` payload of the response.
 * @throws {Error} If every attempt fails; the last error is rethrown with a count.
 */
const requestWithRetry = async (query, variables) => {
  const { maxRetries, retryBaseMs } = config.shopify
  let lastError

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestOnce(query, variables)
    } catch (err) {
      lastError = err
      if (attempt === maxRetries) break
      // Exponential backoff: a home connection dropping for a few seconds must
      // not turn into a false "queue is clear" digest.
      const delay = retryBaseMs * 2 ** (attempt - 1)
      warn(`Shopify request failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  const failure = new Error(lastError?.message ?? 'Unknown Shopify error')
  failure.attempts = maxRetries
  failure.cause = lastError
  throw failure
}

/**
 * Fetches every open, paid, unfulfilled order from the Shopify Admin API.
 *
 * Read-only. Pages through results so a backlog larger than one page is never
 * silently truncated.
 * @returns {Promise<UnfulfilledOrder[]>} Orders sorted oldest-first.
 * @throws {Error} If all retry attempts fail; `error.attempts` holds the count.
 */
export const fetchUnfulfilledOrders = async () => {
  const orders = []
  let after = null
  let hasNextPage = true
  let pages = 0

  while (hasNextPage) {
    const data = await requestWithRetry(ORDERS_QUERY, {
      first: 50,
      after,
      query: UNFULFILLED_QUERY
    })

    const connection = data?.orders
    if (!connection) throw new Error('Shopify response missing orders connection')

    orders.push(...connection.nodes.map(normaliseOrder))
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage)
    after = connection.pageInfo?.endCursor ?? null
    pages += 1

    // Defensive stop: a cursor bug on either side should not spin forever on a
    // store that only ever has a handful of open orders.
    if (pages >= 20) {
      warn('Stopped paginating Shopify orders after 20 pages')
      break
    }
  }

  info(`Fetched ${orders.length} unfulfilled order(s) from Shopify across ${pages} page(s)`)
  return orders
}

/**
 * The Shopify search query string used to select alertable orders.
 * Exported so the README and logs can quote a single source of truth.
 * @returns {string} The search query.
 */
export const getOrderQuery = () => UNFULFILLED_QUERY
