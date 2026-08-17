/**
 * Environment configuration.
 *
 * Every setting arrives as an environment variable so the same image can be
 * moved between hosts without a rebuild. Validation happens once at import
 * time: a container that is misconfigured should fail loudly on boot rather
 * than silently skipping alerts at 3am.
 */

/**
 * Reads a required environment variable.
 * @param {string} name - Variable name.
 * @returns {string} The trimmed value.
 * @throws {Error} If the variable is missing or empty.
 */
const required = (name) => {
  const value = (process.env[name] ?? '').trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

/**
 * Reads an optional environment variable, falling back to a default.
 * @param {string} name - Variable name.
 * @param {string} fallback - Value used when unset or empty.
 * @returns {string} The trimmed value or the fallback.
 */
const optional = (name, fallback) => {
  const value = (process.env[name] ?? '').trim()
  return value || fallback
}

/**
 * Reads an environment variable as a positive number.
 * @param {string} name - Variable name.
 * @param {number} fallback - Value used when unset or empty.
 * @returns {number} The parsed number.
 * @throws {Error} If the value is set but is not a positive finite number.
 */
const numeric = (name, fallback) => {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got: ${raw}`)
  }
  return parsed
}

/**
 * Reads an environment variable as a boolean ("true"/"1" are true).
 * @param {string} name - Variable name.
 * @param {boolean} fallback - Value used when unset or empty.
 * @returns {boolean} The parsed boolean.
 */
const boolean = (name, fallback) => {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return raw === 'true' || raw === '1' || raw === 'yes'
}

/**
 * Splits a comma-separated environment variable into a list of trimmed values.
 * @param {string} name - Variable name.
 * @returns {string[]} Non-empty entries, or an empty array when unset.
 */
const list = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

/**
 * Assembles the configuration object from the environment.
 * @returns {object} The validated configuration.
 * @throws {Error} If any required variable is missing or malformed.
 */
const buildConfig = () => {
  const shopDomain = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, '')

  const handleOverride = (process.env.SHOPIFY_STORE_HANDLE ?? '').trim()
  if (!/\.myshopify\.com$/i.test(shopDomain) && !handleOverride) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be a *.myshopify.com domain (or set SHOPIFY_STORE_HANDLE for admin links)')
  }

  // The store handle is what admin.shopify.com uses in deep links, and it is
  // the subdomain of the *.myshopify.com domain — derive it so there is one
  // less variable to get wrong, but allow an override for odd stores.
  const derivedHandle = shopDomain.replace(/\.myshopify\.com$/i, '')
  return {
    shopify: {
      shopDomain,
      storeHandle: optional('SHOPIFY_STORE_HANDLE', derivedHandle),
      accessToken: required('SHOPIFY_ACCESS_TOKEN'),
      // Pinned to a dated version on purpose. Shopify deprecates versions on a
      // schedule; floating on "unstable" or "latest" means a silent breaking
      // change lands with no deploy of ours. Bump this one line deliberately.
      apiVersion: required('SHOPIFY_API_VERSION'),
      maxRetries: numeric('SHOPIFY_MAX_RETRIES', 3),
      retryBaseMs: numeric('SHOPIFY_RETRY_BASE_MS', 1000)
    },
    discord: {
      webhookUrl: required('DISCORD_WEBHOOK_URL')
    },
    email: {
      enabled: boolean('EMAIL_ENABLED', true),
      host: optional('SMTP_HOST', 'smtp.resend.com'),
      port: numeric('SMTP_PORT', 587),
      // Port 587 is STARTTLS, so the connection starts plaintext and upgrades;
      // only port 465 is implicit TLS from the first byte.
      secure: boolean('SMTP_SECURE', false),
      user: optional('SMTP_USER', 'resend'),
      pass: optional('SMTP_PASS', ''),
      from: optional('EMAIL_FROM', ''),
      to: list('EMAIL_TO')
    },
    alerting: {
      thresholdHours: (() => {
        const raw = (process.env.ALERT_THRESHOLD_HOURS ?? '').trim()
        if (!raw) return 48
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Environment variable ALERT_THRESHOLD_HOURS must be a non-negative number, got: ${raw}`)
        }
        return parsed
      })(),
      timezone: optional('TIMEZONE', 'Pacific/Auckland'),
      currency: optional('CURRENCY', 'NZD'),
      checkCron: optional('CHECK_CRON', '0 * * * *'),
      digestCron: optional('DIGEST_CRON', '0 9 * * *'),
      runOnStart: boolean('RUN_CHECK_ON_START', true)
    },
    state: {
      filePath: optional('STATE_FILE_PATH', '/data/state.json')
    },
    branding: {
      storeName: optional('STORE_NAME', 'Tommy Tinkers NZ'),
      footer: optional('EMBED_FOOTER', 'Tommy Tinkers NZ · Order Alerter')
    }
  }
}

// Config is validated at import time, and a failure exits with a one-line
// message rather than a stack trace: a missing variable is the most likely
// first-run problem, and in `docker logs` the stack buries the useful line.
let built
try {
  built = buildConfig()
} catch (err) {
  console.error(`Configuration error: ${err.message}`)
  console.error('See .env.example for every supported variable.')
  process.exit(1)
}

/** @type {ReturnType<typeof buildConfig>} */
export const config = built

/**
 * Validates cross-field email configuration once the base config is built.
 * Kept separate from the getters so email can be disabled entirely without
 * tripping the required-field checks.
 * @returns {void}
 * @throws {Error} If email is enabled but credentials or addresses are missing.
 */
export const validateEmailConfig = () => {
  if (!config.email.enabled) return
  if (!config.email.pass) throw new Error('EMAIL_ENABLED is true but SMTP_PASS is not set')
  if (!config.email.from) throw new Error('EMAIL_ENABLED is true but EMAIL_FROM is not set')
  if (config.email.to.length === 0) throw new Error('EMAIL_ENABLED is true but EMAIL_TO is not set')
}
