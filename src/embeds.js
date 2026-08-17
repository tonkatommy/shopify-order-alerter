/**
 * Discord embed builders.
 *
 * One exported function per embed type so the shape of each message can be
 * changed in isolation. Nothing here performs I/O — these are pure builders,
 * which keeps them trivially testable and keeps the sender dumb.
 */

import { config } from './config.js'
import { ageInHours, formatDate, formatMoney, humanizeAge } from './format.js'

/**
 * Embed colours, as the decimal integers the Discord API expects.
 *
 * Discord rejects "#f97316" — the `color` field is an integer, so each hex is
 * pre-converted here rather than at each call site. Orange, yellow and green
 * are the Tommy Tinkers NZ brand palette; red is deliberately outside it,
 * because a system failure must not be mistakable for normal output.
 * @type {{overdue: number, digest: number, clear: number, failure: number}}
 */
export const COLOURS = {
  overdue: 16347926, // #f97316 orange — an order has passed the threshold
  digest: 16436245, // #facc15 yellow — routine daily summary
  clear: 2278750, //  #22c55e green  — nothing outstanding
  failure: 14427686 // #dc2626 red    — the check itself broke
}

/** Discord's hard limits on a single webhook request. */
export const DISCORD_LIMITS = {
  embedsPerMessage: 10,
  fieldsPerEmbed: 25,
  totalCharacters: 6000
}

/**
 * Builds the standard footer object shared by order-bearing embeds.
 * @returns {{text: string}} Discord footer object.
 */
const footer = () => ({ text: config.branding.footer })

/**
 * Builds the orange "order is overdue" embed for a single order.
 * @param {import('./shopifyClient.js').UnfulfilledOrder} order - The order.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {object} A Discord embed object.
 */
export const buildOverdueEmbed = (order, now = new Date()) => {
  const hours = ageInHours(order.createdAt, now)
  return {
    title: `${order.name} — unfulfilled for ${humanizeAge(hours)}`,
    // Deep link so the alert is one tap from the order in the Shopify admin.
    url: order.adminUrl,
    color: COLOURS.overdue,
    fields: [
      { name: 'Customer', value: order.customerName, inline: true },
      { name: 'Total', value: formatMoney(order.totalAmount, order.currencyCode), inline: true },
      { name: 'Placed', value: formatDate(order.createdAt, config.alerting.timezone), inline: true },
      { name: 'Items', value: String(order.lineItemCount), inline: true }
    ],
    footer: footer(),
    // The order's own creation time, not now() — the embed timestamp should
    // anchor to when the order was placed, which is what the alert is about.
    timestamp: order.createdAt
  }
}

/**
 * Builds the value line shown under an order's name in the daily digest.
 * @param {import('./shopifyClient.js').UnfulfilledOrder} order - The order.
 * @param {Date} now - Reference instant.
 * @returns {string} e.g. "Jane Doe · $129.50 · 3 days old".
 */
const digestFieldValue = (order, now) => {
  const parts = [
    order.customerName,
    formatMoney(order.totalAmount, order.currencyCode),
    `${humanizeAge(ageInHours(order.createdAt, now))} old`
  ]
  return parts.join(' · ')
}

/**
 * Builds the yellow daily digest embed(s) listing every unfulfilled order.
 *
 * Returns an array because Discord caps an embed at 25 fields; a long queue is
 * split across continuation embeds rather than truncated. Callers must also
 * respect the 10-embeds-per-message cap — see `chunkEmbedsForMessages`.
 * @param {import('./shopifyClient.js').UnfulfilledOrder[]} orders - Orders, oldest first.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {object[]} One or more Discord embed objects.
 */
export const buildDigestEmbeds = (orders, now = new Date()) => {
  if (orders.length === 0) return [buildQueueClearEmbed(now)]

  const chunks = []
  for (let index = 0; index < orders.length; index += DISCORD_LIMITS.fieldsPerEmbed) {
    chunks.push(orders.slice(index, index + DISCORD_LIMITS.fieldsPerEmbed))
  }

  return chunks.map((chunk, chunkIndex) => ({
    title:
      chunkIndex === 0
        ? `Unfulfilled queue — ${orders.length} order${orders.length === 1 ? '' : 's'}`
        : `Unfulfilled queue — continued (${chunkIndex + 1}/${chunks.length})`,
    color: COLOURS.digest,
    fields: chunk.map((order) => ({
      name: order.name,
      value: digestFieldValue(order, now),
      inline: false
    })),
    footer: footer(),
    timestamp: now.toISOString()
  }))
}

/**
 * Builds the green "queue is clear" embed used when nothing is outstanding.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {object} A Discord embed object.
 */
export const buildQueueClearEmbed = (now = new Date()) => ({
  title: 'Unfulfilled queue — 0 orders',
  description: 'Queue is clear. Nothing paid and awaiting fulfilment.',
  color: COLOURS.clear,
  footer: footer(),
  timestamp: now.toISOString()
})

/**
 * Builds the red "check failed" embed. Carries no order data by design —
 * when the API is unreachable, any order data we hold is stale.
 * @param {Error|string} err - The failure, or its message.
 * @param {number} attempts - How many attempts were made before giving up.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {object} A Discord embed object.
 */
export const buildCheckFailedEmbed = (err, attempts, now = new Date()) => {
  const message = typeof err === 'string' ? err : (err?.message ?? 'Unknown error')
  return {
    title: 'Shopify check failed',
    // Discord truncates long descriptions server-side; trim so the retry count
    // at the end is never the part that gets cut.
    description: `${message.slice(0, 3500)}\n\nRetries attempted: ${attempts}`,
    color: COLOURS.failure,
    footer: footer(),
    timestamp: now.toISOString()
  }
}

/**
 * Approximates the character count Discord charges an embed against the
 * 6000-character-per-message budget: title, description, field names and
 * values, and footer text all count.
 * @param {object} embed - A Discord embed object.
 * @returns {number} Total counted characters.
 */
export const measureEmbed = (embed) => {
  let total = 0
  total += (embed.title ?? '').length
  total += (embed.description ?? '').length
  total += (embed.footer?.text ?? '').length
  for (const field of embed.fields ?? []) {
    total += (field.name ?? '').length + (field.value ?? '').length
  }
  return total
}

/**
 * Splits embeds into per-message batches that satisfy Discord's caps on
 * embeds-per-message and total characters-per-message.
 *
 * Splitting rather than truncating is deliberate: a digest that drops orders
 * silently is worse than one that arrives as two messages.
 * @param {object[]} embeds - Embeds to send, in order.
 * @returns {object[][]} Batches, each safe to send as one webhook request.
 */
export const chunkEmbedsForMessages = (embeds) => {
  const batches = []
  let current = []
  let currentChars = 0

  for (const embed of embeds) {
    const size = measureEmbed(embed)
    const wouldExceedCount = current.length + 1 > DISCORD_LIMITS.embedsPerMessage
    const wouldExceedChars = currentChars + size > DISCORD_LIMITS.totalCharacters

    if (current.length > 0 && (wouldExceedCount || wouldExceedChars)) {
      batches.push(current)
      current = []
      currentChars = 0
    }

    current.push(embed)
    currentChars += size
  }

  if (current.length > 0) batches.push(current)
  return batches
}
