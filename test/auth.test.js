/**
 * Unit tests for the client credentials token lifecycle.
 *
 * The failure this guards against is silent and slow: a token that works today
 * and starts 401ing about 24 hours later, overnight, with no alert going out.
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

const { getAccessToken, invalidateAccessToken, getTokenStatus, resetAuthCacheForTests } = await import('../src/auth.js')

const realFetch = globalThis.fetch

/**
 * Installs a fetch stub that issues sequentially-numbered tokens.
 * @param {object} [options] - Options.
 * @param {number} [options.expiresIn=86399] - Value returned as `expires_in`.
 * @returns {{calls: object[]}} Recorder holding each request's parsed body.
 */
const stubTokenEndpoint = ({ expiresIn = 86399 } = {}) => {
  const calls = []
  let issued = 0
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(options.body)) })
    issued += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `token-${issued}`, scope: 'read_orders', expires_in: expiresIn })
    }
  }
  return { calls }
}

afterEach(() => {
  globalThis.fetch = realFetch
  resetAuthCacheForTests()
})

describe('getAccessToken', () => {
  it('posts the client credentials grant to the myshopify token endpoint', async () => {
    const { calls } = stubTokenEndpoint()
    const token = await getAccessToken()

    assert.equal(token, 'token-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://tommy-tinkers.myshopify.com/admin/oauth/access_token')
    assert.deepEqual(calls[0].body, {
      grant_type: 'client_credentials',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret'
    })
  })

  it('reuses the cached token while it is fresh', async () => {
    const { calls } = stubTokenEndpoint()
    await getAccessToken()
    await getAccessToken()
    await getAccessToken()

    assert.equal(calls.length, 1, 'should not re-request a token that is still valid')
  })

  it('refreshes proactively within 5 minutes of expiry', async () => {
    const { calls } = stubTokenEndpoint()
    const start = new Date('2026-08-17T00:00:00Z')
    await getAccessToken({ now: start })

    // 23h55m in: inside the refresh margin, so it should not be handed out.
    const nearExpiry = new Date(start.getTime() + (86399 - 4 * 60) * 1000)
    const token = await getAccessToken({ now: nearExpiry })

    assert.equal(calls.length, 2)
    assert.equal(token, 'token-2')
  })

  it('does not refresh while still outside the margin', async () => {
    const { calls } = stubTokenEndpoint()
    const start = new Date('2026-08-17T00:00:00Z')
    await getAccessToken({ now: start })

    const wellBefore = new Date(start.getTime() + 12 * 3600 * 1000)
    await getAccessToken({ now: wellBefore })

    assert.equal(calls.length, 1)
  })

  it('fetches a new token when forced', async () => {
    const { calls } = stubTokenEndpoint()
    await getAccessToken()
    const token = await getAccessToken({ forceRefresh: true })

    assert.equal(calls.length, 2)
    assert.equal(token, 'token-2')
  })

  it('coalesces concurrent refreshes into one request', async () => {
    const { calls } = stubTokenEndpoint()
    const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()])

    assert.equal(calls.length, 1, 'concurrent callers should share one token request')
    assert.deepEqual(tokens, ['token-1', 'token-1', 'token-1'])
  })

  it('throws with Shopify\'s reason when the exchange is rejected', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"invalid_client"}'
    })

    await assert.rejects(() => getAccessToken(), /invalid_client/)
  })

  it('throws when the response has no access_token', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ scope: 'read_orders' }) })

    await assert.rejects(() => getAccessToken(), /did not include an access_token/)
  })
})

describe('invalidateAccessToken', () => {
  it('forces the next call to fetch a fresh token', async () => {
    const { calls } = stubTokenEndpoint()
    await getAccessToken()
    invalidateAccessToken()
    const token = await getAccessToken()

    assert.equal(calls.length, 2)
    assert.equal(token, 'token-2')
  })
})

describe('getTokenStatus', () => {
  it('reports expiry without exposing the token', async () => {
    stubTokenEndpoint()
    await getAccessToken()
    const status = getTokenStatus()

    assert.equal(status.hasToken, true)
    assert.equal(status.scope, 'read_orders')
    assert.ok(status.expiresAt)
    assert.ok(!JSON.stringify(status).includes('token-1'), 'status must never carry the token itself')
  })
})
