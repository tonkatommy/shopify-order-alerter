/**
 * Unit tests for admin deep-link construction and GID handling.
 *
 * A malformed admin link still looks plausible inside a Discord embed — you
 * only find out it's wrong when you tap it on your phone and get a 404. These
 * pin the exact expected output format.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// Config is validated at import time, so a usable environment must exist before
// the module under test is imported.
process.env.SHOPIFY_SHOP_DOMAIN = 'tommy-tinkers.myshopify.com'
process.env.SHOPIFY_CLIENT_ID = 'test-client-id'
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret'
process.env.SHOPIFY_API_VERSION = '2026-07'
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/test'
process.env.EMAIL_ENABLED = 'false'

const { buildAdminUrl, extractNumericId } = await import('../src/shopifyClient.js')

describe('extractNumericId', () => {
  it('extracts the numeric id from an order GID', () => {
    assert.equal(extractNumericId('gid://shopify/Order/1234567890'), '1234567890')
  })

  it('passes through an already-numeric id', () => {
    assert.equal(extractNumericId('1234567890'), '1234567890')
    assert.equal(extractNumericId(1234567890), '1234567890')
  })

  it('ignores a query-string suffix on the GID', () => {
    assert.equal(extractNumericId('gid://shopify/Order/1234567890?namespace=x'), '1234567890')
  })

  it('returns an empty string for missing or unusable input', () => {
    assert.equal(extractNumericId(null), '')
    assert.equal(extractNumericId(undefined), '')
    assert.equal(extractNumericId(''), '')
    assert.equal(extractNumericId('   '), '')
    assert.equal(extractNumericId('gid://shopify/Order/'), '')
  })
})

describe('buildAdminUrl', () => {
  it('builds the admin deep link with the store handle and numeric id', () => {
    assert.equal(
      buildAdminUrl('gid://shopify/Order/1234567890'),
      'https://admin.shopify.com/store/tommy-tinkers/orders/1234567890'
    )
  })

  it('never leaks the gid:// prefix into the path', () => {
    const url = buildAdminUrl('gid://shopify/Order/1234567890')
    assert.ok(!url.includes('gid'), `admin URL must not contain the GID: ${url}`)
    assert.ok(!url.includes('shopify/Order'), `admin URL must not contain the GID path: ${url}`)
  })

  it('accepts a bare numeric id and produces the same link', () => {
    assert.equal(
      buildAdminUrl('1234567890'),
      'https://admin.shopify.com/store/tommy-tinkers/orders/1234567890'
    )
  })

  it('derives the store handle from the myshopify subdomain', () => {
    // tommy-tinkers.myshopify.com -> /store/tommy-tinkers/, not the full domain.
    assert.ok(buildAdminUrl('1').startsWith('https://admin.shopify.com/store/tommy-tinkers/orders/'))
  })
})
