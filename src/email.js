/**
 * SMTP email sender for the daily digest.
 *
 * Written against plain SMTP rather than a provider SDK. The defaults target
 * Resend (smtp.resend.com, username "resend", password = API key), but nothing
 * here is Resend-specific — pointing SMTP_HOST elsewhere is the whole migration.
 */

import nodemailer from 'nodemailer'

import { config } from './config.js'
import { ageInHours, formatDate, formatDateTime, formatMoney, humanizeAge } from './format.js'
import { info, warn } from './logger.js'

let transporter = null

/**
 * Lazily creates the shared nodemailer transport.
 *
 * Created once and reused so nodemailer can pool the SMTP connection instead of
 * reconnecting for each daily send.
 * @returns {import('nodemailer').Transporter} The SMTP transport.
 */
const getTransporter = () => {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass
    }
  })
  return transporter
}

/**
 * Escapes a string for safe interpolation into the HTML email body.
 * Customer names come from Shopify and are free text, so they are untrusted.
 * @param {string} value - Raw text.
 * @returns {string} HTML-escaped text.
 */
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * Builds the plain-text alternative for the digest email.
 * @param {import('./shopifyClient.js').UnfulfilledOrder[]} orders - Orders, oldest first.
 * @param {Date} now - Reference instant.
 * @returns {string} Plain-text body.
 */
const buildTextBody = (orders, now) => {
  const heading = `${config.branding.storeName} — unfulfilled order digest`
  const generated = `Generated ${formatDateTime(now.toISOString(), config.alerting.timezone)} (${config.alerting.timezone})`

  if (orders.length === 0) {
    return `${heading}\n\n${generated}\n\nQueue is clear. Nothing paid and awaiting fulfilment.\n`
  }

  const lines = orders.map((order) => {
    const age = humanizeAge(ageInHours(order.createdAt, now))
    const total = formatMoney(order.totalAmount, order.currencyCode)
    const placed = formatDate(order.createdAt, config.alerting.timezone)
    return `- ${order.name} — ${order.customerName} — ${total} — placed ${placed} — ${age} old\n  ${order.adminUrl}`
  })

  return `${heading}\n\n${generated}\n\n${orders.length} order${orders.length === 1 ? '' : 's'} awaiting fulfilment:\n\n${lines.join('\n')}\n`
}

/**
 * Builds the HTML body for the digest email.
 *
 * Inline styles only, and no remote images: mail clients strip <style> blocks
 * and block external assets by default.
 * @param {import('./shopifyClient.js').UnfulfilledOrder[]} orders - Orders, oldest first.
 * @param {Date} now - Reference instant.
 * @returns {string} HTML body.
 */
const buildHtmlBody = (orders, now) => {
  const generated = `${formatDateTime(now.toISOString(), config.alerting.timezone)} (${config.alerting.timezone})`
  const shell = (inner) => `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="padding:20px 24px;background:#facc15;">
        <div style="font-size:18px;font-weight:700;">${escapeHtml(config.branding.storeName)}</div>
        <div style="font-size:13px;opacity:0.8;">Unfulfilled order digest</div>
      </div>
      <div style="padding:24px;">
        ${inner}
      </div>
      <div style="padding:14px 24px;background:#f1f5f9;font-size:12px;color:#64748b;">
        ${escapeHtml(config.branding.footer)} · generated ${escapeHtml(generated)}
      </div>
    </div>
  </body>
</html>`

  if (orders.length === 0) {
    return shell(
      `<p style="margin:0;font-size:15px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:8px;"></span><strong>Queue is clear.</strong> Nothing paid and awaiting fulfilment.</p>`
    )
  }

  const rows = orders
    .map((order) => {
      const age = humanizeAge(ageInHours(order.createdAt, now))
      const overdue = ageInHours(order.createdAt, now) > config.alerting.thresholdHours
      return `<tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-weight:600;">
          <a href="${escapeHtml(order.adminUrl)}" style="color:#0f172a;text-decoration:none;">${escapeHtml(order.name)}</a>
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(order.customerName)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${escapeHtml(formatMoney(order.totalAmount, order.currencyCode))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${escapeHtml(formatDate(order.createdAt, config.alerting.timezone))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap;color:${overdue ? '#b45309' : '#475569'};font-weight:${overdue ? '600' : '400'};">${escapeHtml(age)}</td>
      </tr>`
    })
    .join('')

  return shell(`<p style="margin:0 0 16px;font-size:15px;"><strong>${orders.length} order${orders.length === 1 ? '' : 's'}</strong> awaiting fulfilment.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="text-align:left;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">
          <th style="padding:0 8px 8px;">Order</th>
          <th style="padding:0 8px 8px;">Customer</th>
          <th style="padding:0 8px 8px;">Total</th>
          <th style="padding:0 8px 8px;">Placed</th>
          <th style="padding:0 8px 8px;">Age</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`)
}

/**
 * Sends the daily digest email listing every currently-unfulfilled order.
 *
 * Sends regardless of order age — the digest is a full picture, unlike the
 * threshold-gated Discord alerts. An empty queue still gets an email so that
 * silence always means "the service is down", never "nothing to do".
 * @param {import('./shopifyClient.js').UnfulfilledOrder[]} orders - Orders, oldest first.
 * @param {Date} [now=new Date()] - Reference instant, injectable for tests.
 * @returns {Promise<boolean>} True if an email was sent, false if email is disabled.
 * @throws {Error} If the SMTP send fails.
 */
export const sendDigestEmail = async (orders, now = new Date()) => {
  if (!config.email.enabled) {
    info('Email is disabled, skipping digest email')
    return false
  }

  const subject =
    orders.length === 0
      ? `${config.branding.storeName} — unfulfilled queue is clear`
      : `${config.branding.storeName} — ${orders.length} unfulfilled order${orders.length === 1 ? '' : 's'}`

  await getTransporter().sendMail({
    from: config.email.from,
    to: config.email.to.join(', '),
    subject,
    text: buildTextBody(orders, now),
    html: buildHtmlBody(orders, now)
  })

  info(`Sent digest email to ${config.email.to.length} recipient(s)`)
  return true
}

/**
 * Verifies the SMTP connection and credentials without sending mail.
 * Used by the manual test command so a bad API key surfaces immediately.
 * @returns {Promise<boolean>} True if the transport verified, false if disabled.
 * @throws {Error} If verification fails.
 */
export const verifyEmailTransport = async () => {
  if (!config.email.enabled) {
    warn('Email is disabled, nothing to verify')
    return false
  }
  await getTransporter().verify()
  info(`SMTP transport verified against ${config.email.host}:${config.email.port}`)
  return true
}
