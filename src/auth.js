/**
 * Shopify access token acquisition via the OAuth client credentials grant.
 *
 * Apps created in the Shopify Dev Dashboard do not issue a static token the way
 * the retired admin custom-app flow did. Instead the app exchanges its client ID
 * and secret for an access token that Shopify expires after ~24 hours
 * (`expires_in` is documented as 86399 seconds). Without proactive refresh the
 * service would authenticate once and then start returning 401s about a day
 * later — overnight, silently.
 *
 * Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

import { config } from './config.js'
import { info, warn } from './logger.js'

/**
 * Refresh this long before the token actually expires. Covers the request
 * round-trip plus modest clock drift on a home lab box, without refreshing so
 * eagerly that we burn tokens on every poll.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** @type {{token: string, expiresAt: number, scope: string}|null} */
let cached = null

/**
 * In-flight refresh, so concurrent callers share one token request instead of
 * racing and each replacing the other's token.
 * @type {Promise<string>|null}
 */
let pending = null

/**
 * Builds the OAuth token endpoint URL for the store.
 *
 * Always on the *.myshopify.com domain: tokens are issued per store on that
 * host, so pointing this at a customer-facing domain returns 401.
 * @returns {string} Absolute token endpoint URL.
 */
const tokenEndpoint = () => `https://${config.shopify.shopDomain}/admin/oauth/access_token`

/**
 * Reports whether the cached token is usable for the next request.
 * @param {Date} now - Reference instant.
 * @returns {boolean} True if a cached token exists and is outside the refresh margin.
 */
const isFresh = (now) => cached !== null && now.getTime() < cached.expiresAt - REFRESH_MARGIN_MS

/**
 * Requests a new access token from Shopify using the client credentials grant.
 * @param {Date} now - Reference instant that expiry is measured from.
 * @returns {Promise<string>} The new access token.
 * @throws {Error} If Shopify rejects the exchange or returns an unusable body.
 */
const requestToken = async (now) => {
  const response = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>')
    // The body carries Shopify's reason (invalid_client, shop_not_permitted)
    // which is what actually tells you which credential is wrong. It never
    // contains our secret — that only ever goes out in the request.
    throw new Error(`Shopify token request failed: HTTP ${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
  }

  const payload = await response.json()
  if (!payload?.access_token) {
    throw new Error('Shopify token response did not include an access_token')
  }

  // Default to 24h if Shopify ever omits expires_in, so a malformed response
  // degrades to "refresh daily" rather than "refresh on every single request".
  const expiresInSeconds = Number(payload.expires_in) || 86399
  // Measured from the same instant the freshness check uses, so the two can
  // never disagree about when this token dies.
  cached = {
    token: payload.access_token,
    expiresAt: now.getTime() + expiresInSeconds * 1000,
    scope: payload.scope ?? 'unknown'
  }

  // Logged so a refresh is visibly routine in `docker logs` rather than
  // mistaken for a fault. The token and the secret are never logged.
  info(`Refreshed Shopify access token (scope: ${cached.scope}, valid ${Math.round(expiresInSeconds / 3600)}h)`)

  return cached.token
}

/**
 * Returns a valid Shopify access token, refreshing it when needed.
 *
 * Cached in memory only. A restart simply fetches a new one — persisting a
 * credential that expires in 24 hours would be all risk and no benefit.
 * @param {object} [options] - Options.
 * @param {boolean} [options.forceRefresh=false] - Ignore the cache and fetch a new token.
 * @param {Date} [options.now=new Date()] - Reference instant, injectable for tests.
 * @returns {Promise<string>} A usable access token.
 * @throws {Error} If the token exchange fails.
 */
export const getAccessToken = async ({ forceRefresh = false, now = new Date() } = {}) => {
  if (!forceRefresh && isFresh(now)) return cached.token

  // Coalesce concurrent refreshes onto one request.
  if (pending) return pending

  pending = requestToken(now).finally(() => {
    pending = null
  })

  return pending
}

/**
 * Discards the cached token so the next request fetches a fresh one.
 *
 * Used on an unexpected 401: Shopify considers the token dead even though our
 * clock says it should still be valid, so trust Shopify over the local clock.
 * @returns {void}
 */
export const invalidateAccessToken = () => {
  if (cached) warn('Shopify rejected the cached access token, forcing a refresh')
  cached = null
}

/**
 * Reports cached-token status for logging and tests. Never exposes the token.
 * @returns {{hasToken: boolean, expiresAt: string|null, scope: string|null}} Status summary.
 */
export const getTokenStatus = () => ({
  hasToken: cached !== null,
  expiresAt: cached ? new Date(cached.expiresAt).toISOString() : null,
  scope: cached?.scope ?? null
})

/**
 * Clears all cached auth state. Exported for tests.
 * @returns {void}
 */
export const resetAuthCacheForTests = () => {
  cached = null
  pending = null
}
