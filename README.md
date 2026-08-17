# shopify-order-alerter

A small, self-hosted service that watches the Tommy Tinkers NZ Shopify store
for orders that have been paid but not yet fulfilled, and tells you about them
in two ways:

- **Discord**, immediately, when an order has been sitting unfulfilled for
  longer than a threshold (default 48 hours).
- **Email**, once a day at 09:00 NZT, as a digest of everything currently
  outstanding — or a single "queue is clear" line when there's nothing.

It runs under Docker Compose on an always-on box, has no database, no web
server, and no inbound ports.

## Report only

This service **never fulfils, modifies, or cancels anything**. The only
Shopify operation in the codebase is a read query, and the access token it
expects holds a single scope: `read_orders`. If you find yourself granting
write scopes to make something work, something has gone wrong.

## How it works

| Job | Schedule | What it does |
| --- | --- | --- |
| Overdue check | Hourly (`0 * * * *`) | Queries Shopify, alerts on Discord for each order older than `ALERT_THRESHOLD_HOURS` that hasn't been alerted before |
| Daily digest | 09:00 NZT (`0 9 * * *`) | Posts the full outstanding queue to Discord and emails the same list |

Both schedules are evaluated in `TIMEZONE` (Pacific/Auckland), so 09:00 stays
09:00 across the daylight-saving shift.

The Shopify query is:

```
status:open AND fulfillment_status:unfulfilled AND financial_status:paid
```

### Discord output

Every message is an embed, colour-coded:

| Embed | Colour | Hex | Decimal |
| --- | --- | --- | --- |
| Overdue order alert | orange | `#f97316` | `16347926` |
| Daily digest | yellow | `#facc15` | `16436245` |
| Queue clear | green | `#22c55e` | `2278750` |
| Check failed | red | `#dc2626` | `14427686` |

The first three are the Tommy Tinkers NZ brand palette. Red is deliberately
outside it — a system failure must not look like normal output.

An overdue alert titles itself with the order name and age
(`TT1028NZ — unfulfilled for 6 days`), deep-links to the order in the Shopify
admin, and carries Customer / Total / Placed / Items as inline fields.

Discord's per-message limits (10 embeds, 25 fields per embed, 6000 characters)
are respected by **splitting across multiple requests**, never by truncating.
At Tommy Tinkers volumes this will probably never trigger, but a digest that
silently drops orders is worse than one that arrives as two messages.

### Failure is never silent

If the Shopify API fails on all retry attempts, the red "check failed" embed
goes out with the error and the retry count. Silence always means the service
itself is down — it never means "no orders". Failures are Discord-only by
design; an outage would otherwise mean up to 24 emails in a day.

### Deduplication

Alerted order IDs are persisted to a JSON file on a named volume, so an order
alerts once rather than once per hour. Entries are pruned as soon as an order
stops coming back from the query (fulfilled or cancelled), so the file doesn't
grow forever. A missing or corrupt state file starts fresh rather than
crashing — the worst case is one duplicate alert.

## Setup

### 1. Create the Shopify custom app

1. In the Shopify admin, go to **Settings → Apps and sales channels →
   Develop apps**.
2. Click **Allow custom app development** if you haven't before, then
   **Create an app**. Name it something like `Order Alerter`.
3. Open **Configuration → Admin API integration → Configure**.
4. Grant exactly one scope: **`read_orders`**. Nothing else. If you need
   orders older than 60 days you'll also need `read_all_orders`, which Shopify
   grants on request — it is still read-only.
5. Save, then go to **API credentials → Install app**.
6. Reveal and copy the **Admin API access token** (starts with `shpat_`). It
   is shown once. Put it in `.env` as `SHOPIFY_ACCESS_TOKEN`.

### 2. Create the Discord webhook

1. In Discord, right-click the channel you want alerts in →
   **Edit Channel → Integrations → Webhooks → New Webhook**.
2. Name it (e.g. `Order Alerter`), pick the channel, and **Copy Webhook URL**.
3. Put it in `.env` as `DISCORD_WEBHOOK_URL`.

**Treat this URL as a credential.** Anyone who has it can post to your channel.
It is not committed, it is not logged, and it should not be pasted anywhere
public. If it leaks, delete the webhook in Discord and make a new one.

### 3. Set up email (Resend)

The email sender is plain SMTP via nodemailer, with Resend as the default
target. Nothing in the code is Resend-specific — changing `SMTP_HOST` is the
entire migration to another provider.

1. In Resend, verify the domain you want to send from
   (**Domains → Add Domain**, then add the DNS records).
2. Create an API key (**API Keys → Create API Key**), sending permission only.
3. In `.env`:
   - `SMTP_HOST=smtp.resend.com`
   - `SMTP_PORT=587` and `SMTP_SECURE=false` (587 is STARTTLS; use 465 with
     `SMTP_SECURE=true` if you prefer implicit TLS)
   - `SMTP_USER=resend` — the literal string, this is what Resend expects
   - `SMTP_PASS=re_...` — your **API key**, not an account password
   - `EMAIL_FROM` — an address on the domain you verified
   - `EMAIL_TO` — where the digest goes (comma-separated for several)

Set `EMAIL_ENABLED=false` to run Discord-only.

### 4. Configure and run

```bash
git clone https://github.com/tonkatommy/shopify-order-alerter.git
cd shopify-order-alerter
cp .env.example .env
$EDITOR .env          # fill in the four credentials and your addresses
docker compose up -d --build
docker compose logs -f
```

On boot the service prints its effective configuration (never secrets), then
runs one check immediately if `RUN_CHECK_ON_START=true`.

## Configuration

Every setting is an environment variable. `.env.example` documents all of them;
these are the ones you're most likely to touch.

| Variable | Default | Notes |
| --- | --- | --- |
| `SHOPIFY_SHOP_DOMAIN` | — | `your-store.myshopify.com`, no scheme |
| `SHOPIFY_ACCESS_TOKEN` | — | `shpat_...`, `read_orders` scope only |
| `SHOPIFY_API_VERSION` | — | Pinned dated string, e.g. `2026-07` |
| `DISCORD_WEBHOOK_URL` | — | Channel webhook |
| `ALERT_THRESHOLD_HOURS` | `48` | Age at which an order becomes an alert |
| `TIMEZONE` | `Pacific/Auckland` | Display and cron timezone |
| `CHECK_CRON` | `0 * * * *` | Hourly overdue check |
| `DIGEST_CRON` | `0 9 * * *` | Daily digest, in `TIMEZONE` |
| `STATE_FILE_PATH` | `/data/state.json` | Must be on the mounted volume |
| `EMAIL_ENABLED` | `true` | `false` for Discord-only |
| `RUN_CHECK_ON_START` | `true` | Run one check on boot |
| `SHOPIFY_MAX_RETRIES` | `3` | Attempts before declaring failure |

### On pinning the API version

`SHOPIFY_API_VERSION` is a dated string on purpose and must not float. Shopify
retires versions on a schedule, and floating means a breaking change lands with
no deploy of yours. When you're ready to move, bump the one line in `.env` and
restart — check Shopify's changelog for the version you're moving to first.

## Testing a run manually

Each job can be run once, on demand, without waiting for the schedule.

Against a running container:

```bash
# Hourly overdue check — sends real Discord alerts for anything overdue
docker compose run --rm order-alerter node src/index.js --once=check

# Full digest — posts to Discord and sends the email
docker compose run --rm order-alerter node src/index.js --once=digest

# Verify SMTP credentials only, sends no mail
docker compose run --rm order-alerter node src/index.js --once=email
```

Without Docker (Node 20+):

```bash
npm install
set -a && source .env && set +a
npm run check     # or: npm run digest
```

Useful things to try:

- **Force an alert:** temporarily set `ALERT_THRESHOLD_HOURS=0` and run
  `--once=check`. Every open unfulfilled order alerts. Delete the state file
  (`docker compose exec order-alerter rm /data/state.json`) to re-alert them.
- **See the queue-clear embed:** run `--once=digest` when nothing is
  outstanding.
- **See the failure embed:** put a wrong character in `SHOPIFY_ACCESS_TOKEN`
  and run `--once=check`. You should get the red embed after 3 attempts.
- **Inspect state:**
  `docker compose exec order-alerter cat /data/state.json`

## Project layout

```
src/
  index.js          entry point, cron scheduling, --once runner
  config.js         environment parsing and validation
  shopifyClient.js  read-only GraphQL client, retries, pagination
  alerter.js        the two jobs: overdue check and daily digest
  embeds.js         Discord embed builders and limit handling
  discord.js        webhook sender, 429 handling, message splitting
  email.js          SMTP digest (HTML + plain-text)
  state.js          dedup state: load, prune, persist
  format.js         money, dates, ages — UTC maths, NZT display
```

Separation is deliberate: the Shopify client, the alert logic, the embed
builders and the notification senders don't know about each other's internals,
so the embed shape can change without touching the polling code.

## A note on time

Shopify returns `createdAt` in UTC, and all age arithmetic is done on those UTC
instants. Conversion to Pacific/Auckland happens only for display. Doing it the
other way around would introduce a one-hour error twice a year when NZDT starts
and ends.

Dates display as DD/MM/YYYY and money as NZD with a `$` symbol.

## Licence and content

The **code** in this repository is licensed under the MIT Licence — see
[LICENSE](LICENSE).

**Tommy Tinkers NZ branding and content are all rights reserved.** That
includes the Tommy Tinkers NZ name, logo, brand colour palette, store content,
and any product or customer data this service handles. The MIT licence covers
the software only and grants no rights to the brand or its content.
