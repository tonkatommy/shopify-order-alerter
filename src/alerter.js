/**
 * Alert orchestration.
 *
 * Two entry points, matching the two schedules: the hourly overdue check and
 * the daily digest. Both are read-only with respect to Shopify — this service
 * never fulfils, modifies, or cancels anything.
 */

import { config } from './config.js'
import { sendEmbeds } from './discord.js'
import { sendDigestEmail } from './email.js'
import { buildCheckFailedEmbed, buildDigestEmbeds, buildOverdueEmbed } from './embeds.js'
import { ageInHours } from './format.js'
import { error, info } from './logger.js'
import { fetchUnfulfilledOrders } from './shopifyClient.js'
import { hasAlerted, loadState, markAlerted, pruneResolved, saveState } from './state.js'

/**
 * Reports a failed Shopify check to Discord.
 *
 * Best-effort: if Discord is also unreachable we log and move on, because
 * throwing here would kill the scheduled job for the rest of the process life.
 * @param {Error} err - The failure. `err.attempts` is used when present.
 * @param {string} context - Which job failed, for the log line.
 * @returns {Promise<void>} Resolves once the attempt completes.
 */
const reportFailure = async (err, context) => {
  const attempts = err.attempts ?? config.shopify.maxRetries
  error(`${context} failed after ${attempts} attempt(s): ${err.message}`)
  try {
    await sendEmbeds([buildCheckFailedEmbed(err, attempts)])
  } catch (notifyErr) {
    error(`Could not deliver check-failed embed to Discord: ${notifyErr.message}`)
  }
}

/**
 * Runs the hourly overdue check.
 *
 * Fetches open, paid, unfulfilled orders; alerts once per order that has passed
 * ALERT_THRESHOLD_HOURS; prunes state for orders that have since left the
 * queue. On total API failure it sends the red check-failed embed, so silence
 * is never ambiguous between "no orders" and "broken".
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {Promise<{checked: number, alerted: number, failed: boolean}>} Run summary.
 */
export const runOverdueCheck = async (now = new Date()) => {
  let orders
  try {
    orders = await fetchUnfulfilledOrders()
  } catch (err) {
    await reportFailure(err, 'Hourly unfulfilled-order check')
    return { checked: 0, alerted: 0, failed: true }
  }

  const state = await loadState()

  // Prune before deciding, so an order that was fulfilled and then somehow
  // reopened is treated as new rather than being silently suppressed.
  pruneResolved(
    state,
    orders.map((order) => order.id)
  )

  const overdue = orders.filter((order) => {
    const age = ageInHours(order.createdAt, now)
    return age > config.alerting.thresholdHours && !hasAlerted(state, order.id)
  })

  if (overdue.length === 0) {
    await saveState(state)
    info(`Check complete: ${orders.length} unfulfilled, 0 new overdue alert(s)`)
    return { checked: orders.length, alerted: 0, failed: false }
  }

  const embeds = overdue.map((order) => buildOverdueEmbed(order, now))
  await sendEmbeds(embeds)

  // Only marked after Discord accepted the message — if the send throws, the
  // order stays unmarked and is retried next hour rather than lost.
  for (const order of overdue) markAlerted(state, order.id, now)
  await saveState(state)

  info(`Check complete: ${orders.length} unfulfilled, ${overdue.length} new overdue alert(s) sent`)
  return { checked: orders.length, alerted: overdue.length, failed: false }
}

/**
 * Runs the daily digest.
 *
 * Lists every currently-unfulfilled order regardless of age to Discord and, if
 * enabled, by email. An empty queue still produces the green "queue is clear"
 * embed and an email, so a quiet morning is never confused with an outage.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {Promise<{orders: number, failed: boolean}>} Run summary.
 */
export const runDailyDigest = async (now = new Date()) => {
  let orders
  try {
    orders = await fetchUnfulfilledOrders()
  } catch (err) {
    await reportFailure(err, 'Daily digest check')
    return { orders: 0, failed: true }
  }

  const embeds = buildDigestEmbeds(orders, now)
  await sendEmbeds(embeds)

  // Email failures are isolated from Discord: a bad SMTP key should not cost
  // the Discord digest that already went out.
  try {
    await sendDigestEmail(orders, now)
  } catch (err) {
    error(`Digest email failed: ${err.message}`)
  }

  info(`Digest complete: ${orders.length} unfulfilled order(s) reported`)
  return { orders: orders.length, failed: false }
}
