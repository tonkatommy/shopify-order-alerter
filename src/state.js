/**
 * Alert deduplication state.
 *
 * The only thing persisted is the set of order ids we have already alerted on,
 * so an order alerts once instead of once per hourly poll. The file lives on a
 * mounted volume so a container restart does not re-alert the whole backlog.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { config } from './config.js'
import { info, warn } from './logger.js'

/**
 * @typedef {object} AlertState
 * @property {Record<string, string>} alerted - Order id -> ISO timestamp of the alert.
 */

/**
 * Returns an empty state object.
 * @returns {AlertState} Fresh state.
 */
const emptyState = () => ({ alerted: {} })

/**
 * Loads alert state from disk.
 *
 * A missing file is the normal first-run case, and a corrupt file (half-written
 * during a power cut on a home box) is recoverable — the worst case of starting
 * fresh is one duplicate alert, whereas crashing means no alerts at all. So
 * both cases fall back to empty state rather than throwing.
 * @returns {Promise<AlertState>} The loaded state, or fresh state on any problem.
 */
export const loadState = async () => {
  try {
    const raw = await readFile(config.state.filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.alerted !== 'object' || parsed.alerted === null) {
      warn('State file has unexpected shape, starting fresh')
      return emptyState()
    }
    return { alerted: { ...parsed.alerted } }
  } catch (err) {
    if (err.code === 'ENOENT') {
      info('No state file found, starting fresh')
    } else {
      warn(`Could not read state file (${err.message}), starting fresh`)
    }
    return emptyState()
  }
}

/**
 * Writes alert state to disk atomically.
 *
 * Written to a temp file and renamed, because rename is atomic on the same
 * filesystem — a crash mid-write then leaves the previous good file intact
 * rather than a truncated one.
 * @param {AlertState} state - State to persist.
 * @returns {Promise<void>} Resolves once the file is in place.
 */
export const saveState = async (state) => {
  const path = config.state.filePath
  const temp = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  } catch (err) {
    // A failed state write must not take the process down: the alert itself
    // already went out, and the cost is a possible duplicate next hour.
    warn(`Could not persist state file: ${err.message}`)
  }
}

/**
 * Reports whether an order has already been alerted on.
 * @param {AlertState} state - Current state.
 * @param {string} orderId - Shopify order GID.
 * @returns {boolean} True if an alert was already sent for this order.
 */
export const hasAlerted = (state, orderId) => Object.hasOwn(state.alerted, orderId)

/**
 * Records that an order has been alerted on.
 * @param {AlertState} state - State to mutate.
 * @param {string} orderId - Shopify order GID.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {AlertState} The same state object, for chaining.
 */
export const markAlerted = (state, orderId, now = new Date()) => {
  state.alerted[orderId] = now.toISOString()
  return state
}

/**
 * Drops state entries for orders no longer returned by the query.
 *
 * An order leaves the result set once it is fulfilled or cancelled, and at that
 * point its entry is dead weight — pruning is what stops the file growing
 * without bound over the years this box will be running.
 * @param {AlertState} state - State to mutate.
 * @param {string[]} currentOrderIds - Order GIDs present in the latest poll.
 * @returns {number} How many stale entries were removed.
 */
export const pruneResolved = (state, currentOrderIds) => {
  const live = new Set(currentOrderIds)
  let removed = 0
  for (const orderId of Object.keys(state.alerted)) {
    if (!live.has(orderId)) {
      delete state.alerted[orderId]
      removed += 1
    }
  }
  if (removed > 0) info(`Pruned ${removed} resolved order(s) from state`)
  return removed
}
