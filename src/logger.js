/**
 * Minimal stdout logger.
 *
 * Everything goes to stdout (including errors) so `docker logs` shows one
 * ordered stream — interleaving stdout and stderr in Docker can reorder lines
 * relative to each other, which makes a failure timeline hard to read.
 */

/**
 * Formats the current time as an ISO-8601 UTC timestamp for log prefixes.
 * @returns {string} e.g. "2026-08-17T21:04:11.023Z"
 */
const stamp = () => new Date().toISOString()

/**
 * Writes a line to stdout with a level and UTC timestamp prefix.
 * @param {string} level - Log level label, e.g. "INFO".
 * @param {string} message - Human-readable message.
 * @param {...unknown} rest - Extra values appended by console formatting.
 * @returns {void}
 */
const write = (level, message, ...rest) => {
  console.log(`[${stamp()}] ${level.padEnd(5)} ${message}`, ...rest)
}

/**
 * Logs an informational message to stdout.
 * @param {string} message - Human-readable message.
 * @param {...unknown} rest - Extra values appended by console formatting.
 * @returns {void}
 */
export const info = (message, ...rest) => write('INFO', message, ...rest)

/**
 * Logs a warning to stdout.
 * @param {string} message - Human-readable message.
 * @param {...unknown} rest - Extra values appended by console formatting.
 * @returns {void}
 */
export const warn = (message, ...rest) => write('WARN', message, ...rest)

/**
 * Logs an error to stdout.
 * @param {string} message - Human-readable message.
 * @param {...unknown} rest - Extra values appended by console formatting.
 * @returns {void}
 */
export const error = (message, ...rest) => write('ERROR', message, ...rest)
