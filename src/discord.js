/**
 * Discord webhook sender.
 *
 * Knows how to put embeds on the wire and how to behave when Discord pushes
 * back. It does not know what any embed means — that lives in embeds.js.
 */

import { config } from './config.js'
import { chunkEmbedsForMessages } from './embeds.js'
import { info, warn } from './logger.js'

const MAX_RATE_LIMIT_RETRIES = 5

/**
 * Sleeps for a number of milliseconds.
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * POSTs a single webhook payload, honouring Discord's 429 rate limiting.
 * @param {object[]} embeds - Embeds for one message (already within limits).
 * @returns {Promise<void>} Resolves once Discord accepts the message.
 * @throws {Error} If Discord rejects the message or rate limiting never clears.
 */
const postEmbeds = async (embeds) => {
  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetch(config.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds })
    })

    if (response.status === 429) {
      // Discord dictates the wait via retry_after (seconds, fractional). Only
      // fall back to the header or a fixed delay when the body is unreadable —
      // ignoring it risks getting the webhook temporarily banned.
      const body = await response.json().catch(() => ({}))
      const headerSeconds = Number(response.headers.get('retry-after'))
      const seconds = Number(body.retry_after) || (Number.isFinite(headerSeconds) ? headerSeconds : 1)
      const waitMs = Math.ceil(seconds * 1000) + 250
      warn(`Discord rate limited, waiting ${waitMs}ms (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})`)
      await sleep(waitMs)
      continue
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>')
      throw new Error(`Discord webhook HTTP ${response.status}: ${body.slice(0, 500)}`)
    }

    return
  }

  throw new Error(`Discord webhook still rate limited after ${MAX_RATE_LIMIT_RETRIES} attempts`)
}

/**
 * Sends embeds to the configured Discord webhook, splitting them across as
 * many messages as Discord's per-message limits require.
 * @param {object[]} embeds - Embeds to send, in display order.
 * @returns {Promise<number>} The number of webhook requests sent.
 * @throws {Error} If any request is rejected by Discord.
 */
export const sendEmbeds = async (embeds) => {
  if (embeds.length === 0) return 0

  const batches = chunkEmbedsForMessages(embeds)
  for (const [index, batch] of batches.entries()) {
    await postEmbeds(batch)
    // Space consecutive messages slightly so a split digest does not trip the
    // webhook bucket on the very next request.
    if (index < batches.length - 1) await sleep(500)
  }

  info(`Sent ${embeds.length} embed(s) to Discord in ${batches.length} message(s)`)
  return batches.length
}
