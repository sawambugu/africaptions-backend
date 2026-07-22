# Africaptions CMS — Setup, Deployment & Publishing Guide

This document explains the CMS that was added to `africaptions-backend`, how to run
it locally, how to configure Paystack + M-Pesa billing so clients can pay to unlock
it, how to use the built-in dashboard, how to deploy it, how to keep it running
reliably after deployment, and how to actually publish it live.

---

## 1. What was built

A Content Management System for Africaptions clients, gated behind a paid
**Advanced (Tier 2)** plan:

- **Auth**: email/password accounts, JWT-based sessions.
- **Accounts**: every user belongs to a `Client` (the paying account). A `Client`
  has a `tier`: `FREE`, `STANDARD`, or `ADVANCED`, plus a `tierExpiresAt` date.
- **Billing**: **Paystack** (card / mobile money checkout) and **M-Pesa**
  (direct Safaricom STK Push) both pay for a fixed number of days of `ADVANCED`
  access — neither rail supports true recurring billing on mobile money, so a
  payment extends `tierExpiresAt` rather than starting a subscription. Only the
  Paystack webhook and the M-Pesa callback are allowed to grant the tier — a
  client can never unlock the CMS by editing their own data.
- **Dashboard** (`/dashboard`): a small built-in web UI — login/register,
  upgrade via Paystack or M-Pesa, manage projects/media/captions, and (for
  staff) view/grant client tiers.
- **CMS content** (requires `ADVANCED` tier, or staff/`ADMIN` role):
  - **Projects** — captioning jobs (`title`, `status`, `notes`).
  - **Media assets** — uploaded source video/audio/images per project.
  - **Caption tracks** — SRT/VTT/SCC/TXT caption files per project.
- **Site pages** — simple pages/posts for the marketing website, managed by
  staff (`ADMIN`) only, not tied to a client's tier.
- Staff accounts (`role: ADMIN`) bypass tier checks entirely, so the team can
  always deliver client work regardless of billing status.

### New files of note

```
prisma/schema.prisma          Data model (User, Client, Project, MediaAsset,
                               CaptionTrack, Page, PaymentIntent)
lib/prisma.js                 Shared Prisma client
lib/auth.js                   JWT sign/verify
lib/storage.js                Upload storage (local disk in dev, S3-compatible in prod)
lib/projectAccess.js          Ownership check helper
lib/paystack.js               Paystack API wrapper (initialize + webhook signature)
lib/mpesa.js                  M-Pesa Daraja API wrapper (OAuth + STK Push)
middleware/authenticate.js    Verifies JWT, sets req.user
middleware/requireRole.js     Staff-only route gate
middleware/requireTier.js     "Pay more to unlock this" gate — checks tier + expiry
routes/auth.js                register / login / me
routes/billing.js             Paystack initialize/webhook, M-Pesa stk-push/callback
routes/projects.js            CMS projects (mounts media.js and captions.js)
routes/media.js               Media upload/list/delete
routes/captions.js            Caption track create/list/delete
routes/pages.js                Site content pages
routes/admin.js                Staff: list clients, manually grant/change a tier
public/dashboard/              Static login + CMS + admin dashboard (served at /dashboard)
tests/                        Jest + Supertest tests (auth, tier-gating, billing)
Dockerfile, docker-compose.yml Container + local Postgres
.github/workflows/ci.yml      Runs tests against Postgres on every push
```

### How the "pay more" gate actually works

`middleware/requireTier('ADVANCED')` is applied to every CMS route
(`routes/projects.js:14`). On each request it:
1. Lets `ADMIN` users through unconditionally.
2. Otherwise loads the requesting user's `Client` row. If `tierExpiresAt` has
   passed, it lazily downgrades the client back to `FREE` right there (there's
   no recurring billing to do this for us on mobile money, so this check
   substitutes for a cron job).
3. Compares the (possibly just-downgraded) `tier` against what the route
   requires, and returns `403` with an "upgrade your account" message if it
   isn't high enough.

The *only* code paths that grant `ADVANCED` are:
- `paystackWebhookHandler` in `routes/billing.js`, triggered by Paystack's
  `charge.success` webhook event.
- the `/api/billing/mpesa/callback` route, triggered by Safaricom's STK Push
  result callback.
- `routes/admin.js`'s manual grant endpoint, for staff to hand-adjust a tier
  (e.g. an offline payment).

Both payment flows go through a `PaymentIntent` row (`prisma/schema.prisma`)
created *before* the payment is attempted, and updated to `SUCCESS`/`FAILED`
once the provider confirms it. This exists specifically because M-Pesa's
callback carries back only the `CheckoutRequestID` you gave it — no arbitrary
metadata — so this table is what reconciles "which payment, which client,
which plan" and makes the webhook/callback handlers idempotent against
provider retries.

---

## 2. Local setup, step by step

### 2.1 Prerequisites
- Node.js 22+
- PostgreSQL 16 (locally installed, or via Docker — see §5)
- A [Paystack](https://dashboard.paystack.com) account (test mode is enough
  for development; Paystack operates in Nigeria, Ghana, South Africa and Kenya)
- A [Safaricom Developer](https://developer.safaricom.co.ke) account for
  M-Pesa Daraja sandbox credentials

### 2.2 Install and configure
```bash
cd africaptions-backend
npm install                      # also runs `prisma generate` automatically
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — point at your Postgres instance.
- `JWT_SECRET` — generate one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- Leave `STORAGE_DRIVER=local` for now (see §7 for production storage).
- `ADVANCED_PLAN_DAYS` / `ADVANCED_PLAN_PRICE_KES` — how many days of access a
  payment buys and what it costs (defaults: 30 days / KES 2000).
- Paystack/M-Pesa vars — fill in after §4.

### 2.3 Create the database and run migrations
```bash
createdb africaptions            # or: psql -c "CREATE DATABASE africaptions;"
npx prisma migrate dev           # applies prisma/migrations, generates the client
```
This created the `prisma/migrations/` folder already committed in this repo —
in normal day-to-day work you'll only need `npx prisma migrate dev` again when
you change `prisma/schema.prisma`.

### 2.4 Run it
```bash
npm run dev        # nodemon, auto-restarts on file changes
# or
npm start
```
Check `http://localhost:4000/api/health` → `{"status":"ok"}`, then open
`http://localhost:4000/dashboard` in a browser.

### 2.5 Try the flow end-to-end (via the dashboard)
1. Open `http://localhost:4000/dashboard`, switch to "Create account", and
   register a studio. You'll land on the **Upgrade** tab (still `FREE`).
2. To manually unlock it while testing (before wiring real payments), open
   Prisma Studio:
   ```bash
   npx prisma studio
   ```
   and set that `Client`'s `tier` to `ADVANCED` — then log out/in on the
   dashboard (or just reload) to see the **Projects** tab unlock.
3. Once §4 is configured, use the real "Pay with Paystack" / "Pay with
   M-Pesa" buttons on the Upgrade tab instead of Prisma Studio.

You can also drive it directly with curl if you prefer:
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@studio.com","password":"password123","clientName":"Studio Co"}'
# Save the returned token, then:
curl http://localhost:4000/api/projects -H "Authorization: Bearer <token>"   # 403 until upgraded
```

### 2.6 Creating a staff (admin) account
There's no public "become admin" endpoint on purpose. Create staff accounts
directly in the database:
```bash
node -e "
const bcrypt = require('bcryptjs');
const prisma = require('./lib/prisma');
(async () => {
  const passwordHash = await bcrypt.hash('choose-a-strong-password', 12);
  const user = await prisma.user.create({
    data: { email: 'staff@africaptions.com', passwordHash, role: 'ADMIN' },
  });
  console.log('Created admin:', user.email);
  process.exit(0);
})();
"
```
Staff accounts see an extra **Clients (admin)** tab in the dashboard, listing
every client's tier/expiry with a dropdown to manually grant/change it.

---

## 3. Running the test suite
```bash
createdb africaptions_test
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/africaptions_test" \
  npx prisma migrate deploy
npm test
```
The tests cover registration/login (`tests/auth.test.js`), that FREE/STANDARD
clients are blocked from the CMS while ADVANCED clients and ADMIN staff get
through and clients only ever see their own projects
(`tests/tier-gating.test.js`), and the billing/expiry logic
(`tests/billing.test.js`): tier auto-expiry, payment ownership checks, admin
manual grants, and that Paystack/M-Pesa initiation fails gracefully (502, not
a crash) when credentials aren't configured.

CI (`.github/workflows/ci.yml`) runs this same suite against a throwaway
Postgres container on every push, so a regression in the tier gate fails the
build before it reaches production.

---

## 4. Setting up Paystack + M-Pesa billing

### 4.1 Paystack
1. **Get your API keys** (Paystack Dashboard → Settings → API Keys & Webhooks):
   copy the **Secret key** (`sk_test_...` in test mode) into
   `PAYSTACK_SECRET_KEY`.
2. **Set up the webhook**: Settings → API Keys & Webhooks → Webhook URL:
   `https://<your-domain>/api/billing/paystack/webhook`. Paystack signs every
   webhook with your secret key (no separate signing secret to copy — verified
   in `lib/paystack.js` via HMAC-SHA512 of the raw body).
3. **Local webhook testing**: Paystack has no CLI tunnel like Stripe's; use
   [ngrok](https://ngrok.com) (`ngrok http 4000`) and set that HTTPS URL as
   the webhook URL temporarily while testing.
4. **Test the upgrade flow**: on the dashboard's Upgrade tab, click "Pay with
   Paystack", and pay with Paystack's test card `4084 0840 8408 4081` (any
   future expiry, CVC `408`, PIN `0000`, OTP `123456`). Confirm the account
   flips to `ADVANCED` (dashboard header badge, or `GET /api/auth/me`).

### 4.2 M-Pesa (Safaricom Daraja API)
1. Create an app at [developer.safaricom.co.ke](https://developer.safaricom.co.ke)
   and subscribe it to **Lipa Na M-Pesa Online**. Copy the sandbox
   **Consumer Key**/**Consumer Secret** into `MPESA_CONSUMER_KEY` /
   `MPESA_CONSUMER_SECRET`.
2. The sandbox ships with a published test shortcode/passkey (see the Daraja
   docs) — set `MPESA_SHORTCODE` and `MPESA_PASSKEY` to those for testing; use
   your own Paybill/Till + passkey once you have one for production.
3. Set `MPESA_CALLBACK_SECRET` to a long random value — Daraja doesn't sign
   callbacks the way Stripe/Paystack sign webhooks, so this shared secret
   (appended to the callback URL as `?key=...`) is what stops randoms from
   POSTing fake "payment succeeded" callbacks.
4. **Local callback testing**: Safaricom's sandbox must be able to reach your
   `APP_URL` over the public internet — use ngrok here too, and set `APP_URL`
   to the ngrok HTTPS URL while testing.
5. **Test the upgrade flow**: on the dashboard's Upgrade tab, enter a Safaricom
   test MSISDN (Daraja sandbox docs list valid test numbers) and click "Send
   STK push". In the sandbox, the "prompt" auto-completes rather than actually
   texting a phone; the dashboard polls `/api/billing/status/:reference` and
   flips to Advanced once Safaricom's callback lands.

### 4.3 Why days-based access instead of a subscription
Paystack subscriptions require a saved card authorization, which mobile-money
and M-Pesa payers don't have. Rather than build two different billing models
per payment method, both providers use the same mechanism: a successful
payment extends `Client.tierExpiresAt` by `ADVANCED_PLAN_DAYS`
(`routes/billing.js`'s `extendExpiry`). This means clients simply pay again
before it lapses — worth surfacing a renewal reminder in the dashboard or via
email as a future enhancement, but out of scope for this build.

---

## 5. Local development with Docker (optional alternative to §2)

```bash
docker compose up --build
```
This starts Postgres and the app together, runs `prisma migrate deploy`
automatically on container start (see `Dockerfile`'s `CMD`), and persists
both the database and `/app/uploads` in named Docker volumes.

---

## 6. Deploying to production

Any Node-friendly host works since everything is a standard Dockerfile /
`npm start` app with an external Postgres database. Below is the concrete
path for **Render** (simple, has a managed Postgres, free TLS, auto-deploy on
git push) — swap the equivalent steps for Railway/Fly.io/a VPS if you prefer.

### 6.1 Provision the database
1. Render Dashboard → New → PostgreSQL. Note the **Internal Database URL**.

### 6.2 Provision the web service
1. Render Dashboard → New → Web Service → connect the `africaptions-backend`
   GitHub repo, branch `main` (or your deploy branch).
2. Runtime: **Docker** (it will pick up the committed `Dockerfile`).
3. Set environment variables (Render → Environment):
   - `DATABASE_URL` = the Internal Database URL from 6.1
   - `JWT_SECRET` = a strong random value (generate fresh — don't reuse the dev one)
   - `APP_URL` = `https://your-service.onrender.com` (update once you have a
     custom domain)
   - `PAYSTACK_SECRET_KEY` = your **live mode** key once ready to accept real
     payments (see §8)
   - `MPESA_ENV=production`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`,
     `MPESA_SHORTCODE`, `MPESA_PASSKEY` = your **production** Daraja app
     credentials (a live Paybill/Till, not the sandbox ones)
   - `MPESA_CALLBACK_SECRET` = a fresh strong random value
   - `STORAGE_DRIVER=s3` plus the `S3_*` variables (see §7 — do this before
     going live, not after)
   - `NODE_ENV=production`
4. Deploy. The Dockerfile's start command (`prisma migrate deploy && node
   server.js`) applies any pending migrations automatically on every deploy —
   this is what keeps the schema in sync without a manual step.
5. Once live, go back to Paystack (§4.1) and update the webhook URL to
   `https://your-domain/api/billing/paystack/webhook`, and to your Daraja app
   (§4.2) to confirm the callback URL your server sends
   (`{APP_URL}/api/billing/mpesa/callback?key=...`) is reachable.

### 6.3 Verify the deploy
```bash
curl https://your-domain/api/health
```
Then open `https://your-domain/dashboard`, register a test account, and
repeat the upgrade flow from §4 against the live URL.

---

## 7. Media storage in production (don't skip this)

Render, Railway, Heroku, and most PaaS hosts run on an **ephemeral
filesystem** — anything written to disk (like uploaded media/caption files
under `STORAGE_DRIVER=local`) is **deleted on every redeploy or restart**.
This will silently look fine in a demo and then lose real client files later.

Before onboarding a real paying client, switch to object storage:
1. Create a bucket — any S3-compatible option works (AWS S3, Cloudflare R2,
   Backblaze B2, DigitalOcean Spaces). Cloudflare R2 has no egress fees, which
   is worth considering if clients frequently download their media.
2. Set in production:
   ```
   STORAGE_DRIVER=s3
   S3_BUCKET=...
   S3_REGION=...
   S3_ENDPOINT=...           # only needed for non-AWS providers
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_PUBLIC_URL_BASE=https://cdn.yourdomain.com   # or the bucket's public URL
   ```
3. No code changes needed — `lib/storage.js` already switches drivers based on
   `STORAGE_DRIVER`.

---

## 8. Keeping it working after deployment

- **Migrations run automatically on deploy** (baked into the Dockerfile's
  start command). If you ever deploy without Docker (e.g. `npm start`
  directly on a VPS), run `npx prisma migrate deploy` manually first.
- **Rotate `JWT_SECRET` deliberately, not accidentally** — changing it
  invalidates every issued session token, forcing all users to log in again.
  Fine to do intentionally (e.g. suspected leak); avoid doing it as a side
  effect of copy-pasting a fresh `.env.example`.
- **Move Paystack and M-Pesa from test/sandbox → live when ready to charge
  real clients**: get Paystack's live secret key and update the webhook URL
  under live mode; apply for/activate a production Daraja app with a real
  Paybill or Till number (this involves Safaricom's go-live approval process —
  start it well before you need it, it isn't instant). Test and live
  credentials are entirely separate — a client who "paid" in sandbox/test
  mode never actually gets charged.
- **Back up the database.** Managed Postgres (Render/Railway/RDS/Supabase)
  usually includes automatic daily backups — confirm this is turned on and
  test a restore at least once so you know the process works before you need it.
- **Monitor uptime** — point a free service (UptimeRobot, Better Stack, or
  your host's built-in health checks) at `/api/health` so you hear about
  outages before a client does.
- **Watch both providers' delivery logs** — Paystack Dashboard → Settings →
  API Keys & Webhooks shows webhook delivery attempts; Safaricom's Daraja
  portal shows callback delivery status. A failed delivery on either means a
  client paid but never got upgraded to `ADVANCED` — worth an occasional
  glance, especially right after a deploy (a redeploy can briefly 502 an
  in-flight webhook/callback).
- **Re-run `npm audit` / update dependencies periodically** — this is a
  Node/Express app talking to the public internet; treat dependency updates
  (especially `express`, `jsonwebtoken`, `multer`) as routine maintenance, not
  optional.
- **CI stays green as a gate**: don't merge/deploy a branch where
  `.github/workflows/ci.yml` is failing — the tier-gating tests failing is a
  signal the paywall itself may be broken.

---

## 9. Publishing / going live checklist

1. ☐ Production Postgres provisioned, `DATABASE_URL` set, migrations applied.
2. ☐ Fresh, unique `JWT_SECRET` and `MPESA_CALLBACK_SECRET` set in production
   (not the dev values).
3. ☐ `STORAGE_DRIVER=s3` configured with a real bucket (§7) — **do this before
   any real client uploads a file**.
4. ☐ Paystack switched to **live mode** key + webhook URL, M-Pesa Daraja app
   moved from sandbox to a real, approved Paybill/Till (§8), and one real
   small-amount test purchase completed on each rail to confirm the whole loop
   (pay → webhook/callback → tier upgrade) works with real money rails.
5. ☐ Custom domain pointed at the host, `APP_URL` updated to match, and the
   Paystack webhook + M-Pesa callback URL updated to the final domain.
6. ☐ At least one real `ADMIN` staff account created (§2.6) so the team can
   manage any client's projects and grant/adjust tiers manually if needed.
7. ☐ `/dashboard` reachable at the production domain and walked through once
   end-to-end (register → upgrade → create project → upload media → add a
   caption track).
8. ☐ Uptime monitor pointed at `/api/health` (§8).
9. ☐ Announce/enable the paid tier — e.g. update the pricing page copy so
   "Advanced" clearly states it unlocks the client CMS portal, and link to
   `/dashboard` (or embed it) from wherever clients sign up.

Once every box above is checked, the Tier 2 CMS is genuinely production-ready:
a client can sign up, pay via Paystack or M-Pesa, get upgraded automatically,
and manage their captioning projects through the dashboard — and the system
will keep working through redeploys, restarts, and routine maintenance.
