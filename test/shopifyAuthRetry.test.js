/**
 * Tests the interaction between the 401 refresh and the network retry budget.
 *
 * These are separate mechanisms and must stay separate: a token that expired
 * early should cost one silent refresh, not three retries with backoff.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

process.env.SHOPIFY_SHOP_DOMAIN = 'tommy-tinkers.myshopify.com'
process.env.SHOPIFY_CLIENT_ID = 'test-client-id'
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret'
process.env.SHOPIFY_API_VERSION = '2026-07'
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/test'
process.env.EMAIL_ENABLED = 'false'
process.env.SHOPIFY_RETRY_BASE_MS = '1'

const { fetchUnfulfilledOrders } = await import('../src/shopifyClient.js')
const { resetAuthCacheForTests } = await import('../src/auth.js')

const realFetch = globalThis.fetch

const emptyOrdersPayload = {
  data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
}

/**
 * Routes stubbed requests to either the token endpoint or the GraphQL endpoint.
 * @param {(callIndex: number) => object} graphqlResponder - Returns the response for each GraphQL call.
 * @returns {{tokenCalls: number, graphqlCalls: number}} Live call counters.
 */
const stubShopify = (graphqlResponder) => {
  const counters = { tokenCalls: 0, graphqlCalls: 0 }
  let issued = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/admin/oauth/access_token')) {
      counters.tokenCalls += 1
      issued += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `token-${issued}`, scope: 'read_orders', expires_in: 86399 })
      }
    }
    counters.graphqlCalls += 1
    return graphqlResponder(counters.graphqlCalls)
  }
  return counters
}

afterEach(() => {
  globalThis.fetch = realFetch
  resetAuthCacheForTests()
})

describe('401 handling', () => {
  it('refreshes once and retries the request, without consuming network retries', async () => {
    const counters = stubShopify((call) => {
      // First GraphQL call 401s (token expired early); the retry succeeds.
      if (call === 1) return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'Invalid API key or access token' }
      return { ok: true, status: 200, json: async () => emptyOrdersPayload }
    })

    const orders = await fetchUnfulfilledOrders()

    assert.deepEqual(orders, [])
    assert.equal(counters.graphqlCalls, 2, 'one 401 plus one retry')
    assert.equal(counters.tokenCalls, 2, 'initial token plus one forced refresh')
  })

  it('does not loop when the 401 persists after a refresh', async () => {
    const counters = stubShopify(() => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API key or access token'
    }))

    await assert.rejects(() => fetchUnfulfilledOrders(), /401/)

    // 3 network attempts, each allowed exactly one auth retry: 6 calls, not an
    // unbounded loop.
    assert.equal(counters.graphqlCalls, 6)
  })

  it('leaves ordinary server errors to the existing backoff, with no refresh', async () => {
    const counters = stubShopify((call) => {
      if (call < 3) return { ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }
      return { ok: true, status: 200, json: async () => emptyOrdersPayload }
    })

    const orders = await fetchUnfulfilledOrders()

    assert.deepEqual(orders, [])
    assert.equal(counters.graphqlCalls, 3, 'two failures then success, via the retry budget')
    assert.equal(counters.tokenCalls, 1, 'a 500 must not trigger a token refresh')
  })

  it('surfaces a token-exchange failure through the retry budget', async () => {
    let tokenCalls = 0
    globalThis.fetch = async (url) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        tokenCalls += 1
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"invalid_client"}' }
      }
      throw new Error('GraphQL should never be reached without a token')
    }

    await assert.rejects(() => fetchUnfulfilledOrders(), /invalid_client/)
    assert.equal(tokenCalls, 3, 'the token exchange itself is retried by the existing backoff')
  })
})
