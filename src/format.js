/**
 * Display formatting helpers.
 *
 * Rule of the module: arithmetic happens in UTC, presentation happens in the
 * store's local timezone. Shopify returns `createdAt` as an ISO-8601 UTC
 * instant, and Date arithmetic on those instants is timezone-independent, so
 * age is always correct. Converting to Pacific/Auckland before subtracting
 * would introduce a one-hour error twice a year when NZDT starts and ends.
 */

/**
 * Computes the age of an order in hours from its UTC creation timestamp.
 * @param {string} createdAt - ISO-8601 timestamp from Shopify (UTC).
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {number} Age in fractional hours. Negative values are clamped to 0.
 */
export const ageInHours = (createdAt, now = new Date()) => {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return 0
  const hours = (now.getTime() - created.getTime()) / 3_600_000
  return hours > 0 ? hours : 0
}

/**
 * Renders an age in hours as a short human phrase, e.g. "6 days", "3 hours".
 * @param {number} hours - Age in fractional hours.
 * @returns {string} Human-readable duration.
 */
export const humanizeAge = (hours) => {
  if (hours < 1) return 'less than an hour'
  if (hours < 48) {
    const whole = Math.floor(hours)
    return `${whole} hour${whole === 1 ? '' : 's'}`
  }
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/**
 * Formats a UTC timestamp as DD/MM/YYYY in the configured display timezone.
 * @param {string} isoTimestamp - ISO-8601 timestamp (UTC).
 * @param {string} timezone - IANA timezone name, e.g. "Pacific/Auckland".
 * @returns {string} Date as DD/MM/YYYY, or "unknown" if unparseable.
 */
export const formatDate = (isoTimestamp, timezone) => {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return 'unknown'
  // en-GB gives DD/MM/YYYY ordering natively; the timeZone option does the
  // UTC -> NZST/NZDT shift, including daylight saving, without a date library.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date)
}

/**
 * Formats a UTC timestamp as DD/MM/YYYY HH:mm in the display timezone.
 * @param {string} isoTimestamp - ISO-8601 timestamp (UTC).
 * @param {string} timezone - IANA timezone name.
 * @returns {string} Date and time, or "unknown" if unparseable.
 */
export const formatDateTime = (isoTimestamp, timezone) => {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

/**
 * Formats a money amount as NZD with a leading $ symbol.
 * @param {string|number} amount - Decimal amount from Shopify, e.g. "129.50".
 * @param {string} [currency='NZD'] - ISO currency code, used for non-NZD stores.
 * @returns {string} e.g. "$129.50", or "$0.00" when the amount is unparseable.
 */
export const formatMoney = (amount, currency = 'NZD') => {
  const value = Number(amount)
  const safe = Number.isFinite(value) ? value : 0
  // narrowSymbol keeps NZD as "$" rather than "NZ$" — the store is NZ-only, so
  // the disambiguating prefix is noise. Non-NZD codes still get their symbol.
  const formatted = new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol'
  }).format(safe)
  return formatted
}
