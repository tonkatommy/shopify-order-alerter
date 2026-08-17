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

### 1. Create the Shopify app in the Dev Dashboard

Shopify closed the old in-admin custom app flow on **1 January 2026**. Apps
created before then still work, but new ones — including this store's — are
created in the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard/).
There is no static `shpat_` token to copy any more; you get a **client ID and
client secret** instead, and the service exchanges them for short-lived tokens
at runtime.

**Getting to the Dev Dashboard.** Either go to
<https://dev.shopify.com/dashboard/> directly, or from the store admin:
**Settings → Apps → Develop apps → "Build apps in Dev Dashboard"**.

1. In the Dev Dashboard, click **Apps → Create app**. Name it something like
   `Order Alerter`.
2. Open the app's **Configuration** and set the **Admin API access scopes** to
   exactly one scope: **`read_orders`**. Nothing else — this service only
   reads. If you need orders older than 60 days you'll also need
   `read_all_orders`, which Shopify grants on request and which is still
   read-only.
3. **Release a version.** Scope changes only take effect once they're in a
   released version — this is the step that's easy to miss, and skipping it
   produces a token whose scopes don't match what you configured. Create the
   version, then release it.
4. **Install the app on the store.** From the app, choose **Install** and pick
   your store. A client credentials grant only works once the app is actually
   installed on a store in the same Dev Dashboard organisation.
5. Go to the app's **Settings** page. The **Client ID** and **Client secret**
   are both there. Copy them into `.env` as `SHOPIFY_CLIENT_ID` and
   `SHOPIFY_CLIENT_SECRET`.

**Store the secret properly the first time.** Rotating credentials on an
admin-created app means uninstalling and reinstalling the app — not a one-click
regenerate. Put the secret in a password manager as you copy it, so a lost
`.env` doesn't turn into a reinstall.

**Use the myshopify domain.** `SHOPIFY_SHOP_DOMAIN` must be your
`*.myshopify.com` domain (**Settings → Domains**, shown as the permanent
domain), not the customer-facing `shop.tommytinkers.nz`. Tokens are issued per
store on the myshopify host, so the customer-facing domain returns 401 on the
token exchange itself. The service refuses to start if this looks wrong.

If you see `shop_not_permitted` from the token endpoint, the app and the store
aren't in the same Dev Dashboard organisation — owning the store isn't enough,
it has to appear under the same org.

#### Why the token refreshes (and why that's not a problem)

Dev Dashboard apps use an OAuth **client credentials grant**. The token that
comes back is valid for about 24 hours (`expires_in` is 86399 seconds), so
unlike the old static token it cannot simply be pasted into `.env` once.

`src/auth.js` handles this: it exchanges the client ID and secret for a token,
caches it in memory with its expiry, and refreshes automatically when within
five minutes of expiry — before a request fails, not after. If Shopify returns
a 401 anyway (clock drift, or a revoked token), it forces one refresh and
retries the request once. That refresh is separate from the network retry
budget, so it doesn't eat into the three backoff attempts.

You'll see a line like this in `docker logs` roughly once a day:

```
[2026-08-18T09:00:02.114Z] INFO  Refreshed Shopify access token (scope: read_orders, valid 24h)
```

**That is normal.** It's the system working, not a fault. The token itself and
the client secret are never logged. Nothing is persisted to disk — a restart
just fetches a new token.

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
| `SHOPIFY_SHOP_DOMAIN` | — | `your-store.myshopify.com`, no scheme. Must be the myshopify domain |
| `SHOPIFY_CLIENT_ID` | — | Dev Dashboard → app → Settings |
| `SHOPIFY_CLIENT_SECRET` | — | Same page. Credential — store it properly |
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
- **See the failure embed:** put a wrong character in `SHOPIFY_CLIENT_SECRET`
  and run `--once=check`. You should get the red embed after 3 attempts.
- **Watch a token refresh:** run `--once=check` and look for the
  `Refreshed Shopify access token` line — it appears on the first call of
  every run, since the token cache is in-memory and starts empty.
- **Inspect state:**
  `docker compose exec order-alerter cat /data/state.json`

### Running the tests

```bash
npm test
```

Node's built-in test runner, no extra dependency. Covers the token lifecycle
(caching, proactive refresh, the 401 path) and the admin deep-link format —
a malformed link looks plausible in an embed and only fails when you tap it,
so its exact output is pinned:

```
gid://shopify/Order/1234567890
  -> https://admin.shopify.com/store/tommy-tinkers/orders/1234567890
```

## Project layout

```
src/
  index.js          entry point, cron scheduling, --once runner
  config.js         environment parsing and validation
  auth.js           client credentials grant, token cache and refresh
  shopifyClient.js  read-only GraphQL client, retries, pagination
  alerter.js        the two jobs: overdue check and daily digest
  embeds.js         Discord embed builders and limit handling
  discord.js        webhook sender, 429 handling, message splitting
  email.js          SMTP digest (HTML + plain-text)
  state.js          dedup state: load, prune, persist
  format.js         money, dates, ages — UTC maths, NZT display
test/
  auth.test.js              token cache, proactive refresh, error paths
  shopifyAuthRetry.test.js  401 refresh vs. the network retry budget
  shopifyClient.test.js     admin deep-link and GID extraction
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
