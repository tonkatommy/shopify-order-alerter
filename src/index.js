/**
 * Entry point: schedules the hourly check and the daily digest.
 *
 * No web server and no inbound ports — this is a long-lived process whose only
 * job is to wake on a cron schedule and make outbound calls.
 */

import cron from 'node-cron'

import { runDailyDigest, runOverdueCheck } from './alerter.js'
import { config, validateEmailConfig } from './config.js'
import { verifyEmailTransport } from './email.js'
import { error, info } from './logger.js'
import { getOrderQuery } from './shopifyClient.js'

/**
 * Parses the `--once=<job>` argument used for manual test runs.
 * @param {string[]} argv - Process arguments.
 * @returns {string|null} The requested job name, or null for scheduled mode.
 */
const parseOnceArg = (argv) => {
  const flag = argv.find((arg) => arg.startsWith('--once'))
  if (!flag) return null
  const [, value] = flag.split('=')
  return value || 'check'
}

/**
 * Logs the effective configuration at boot.
 * Secrets are never logged — only whether they are present.
 * @returns {void}
 */
const logStartupSummary = () => {
  info(`Store:      ${config.shopify.shopDomain} (handle: ${config.shopify.storeHandle})`)
  info(`API:        Admin GraphQL ${config.shopify.apiVersion} (read-only)`)
  info(`Query:      ${getOrderQuery()}`)
  info(`Threshold:  ${config.alerting.thresholdHours} hours`)
  info(`Timezone:   ${config.alerting.timezone}`)
  info(`Check cron: ${config.alerting.checkCron}`)
  info(`Digest cron:${config.alerting.digestCron}`)
  info(`State file: ${config.state.filePath}`)
  info(`Email:      ${config.email.enabled ? `${config.email.host}:${config.email.port} -> ${config.email.to.join(', ')}` : 'disabled'}`)
}

/**
 * Runs a single job once and exits. Used for manual verification.
 * @param {string} job - One of "check", "digest", or "email".
 * @returns {Promise<void>} Resolves when the job has finished.
 */
const runOnce = async (job) => {
  info(`Running one-off job: ${job}`)
  if (job === 'digest') {
    await runDailyDigest()
  } else if (job === 'email') {
    await verifyEmailTransport()
  } else if (job === 'check') {
    await runOverdueCheck()
  } else {
    throw new Error(`Unknown job "${job}". Use --once=check, --once=digest, or --once=email`)
  }
}

/**
 * Wraps a scheduled job so a thrown error is logged instead of taking the
 * process down — a crashed container would stop every future alert too.
 * @param {string} name - Job name for logging.
 * @param {() => Promise<unknown>} job - The job to run.
 * @returns {() => Promise<void>} A safe callback for node-cron.
 */
const guard = (name, job) => async () => {
  try {
    await job()
  } catch (err) {
    error(`Unhandled failure in ${name}: ${err.stack ?? err.message}`)
  }
}

/**
 * Boots the service: validates config, then either runs one job or schedules both.
 * @returns {Promise<void>} Resolves once scheduling is in place.
 */
const main = async () => {
  validateEmailConfig()
  info(`${config.branding.storeName} order alerter starting`)
  logStartupSummary()

  const once = parseOnceArg(process.argv)
  if (once) {
    await runOnce(once)
    info('One-off run complete')
    return
  }

  cron.schedule(config.alerting.checkCron, guard('hourly check', runOverdueCheck), {
    timezone: config.alerting.timezone
  })

  // The digest time is a local-clock promise ("09:00 NZT"), so the schedule is
  // pinned to the store timezone. node-cron handles the NZDT shift for us; a
  // UTC schedule would drift by an hour twice a year.
  cron.schedule(config.alerting.digestCron, guard('daily digest', runDailyDigest), {
    timezone: config.alerting.timezone
  })

  info('Schedules registered, waiting for next run')

  if (config.alerting.runOnStart) {
    info('RUN_CHECK_ON_START is enabled, running an immediate check')
    await guard('startup check', runOverdueCheck)()
  }
}

main().catch((err) => {
  error(`Fatal startup error: ${err.stack ?? err.message}`)
  process.exit(1)
})

// Docker sends SIGTERM on `docker compose down`; without a handler Node ignores
// it in PID 1 and the container waits out the full 10s kill timeout.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    info(`Received ${signal}, shutting down`)
    process.exit(0)
  })
}
