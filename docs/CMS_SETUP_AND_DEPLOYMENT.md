# Africaptions CMS — Setup, Deployment & Publishing Guide

This document explains the CMS that was added to `africaptions-backend`, how to run
it locally, how to configure billing so clients can pay to unlock it, how to deploy
it, how to keep it running reliably after deployment, and how to actually publish
it live.

---

## 1. What was built

A Content Management System for Africaptions clients, gated behind a paid
**Advanced (Tier 2)** plan:

- **Auth**: email/password accounts, JWT-based sessions.
- **Accounts**: every user belongs to a `Client` (the paying account). A `Client`
  has a `tier`: `FREE`, `STANDARD`, or `ADVANCED`.
- **Billing**: Stripe Checkout upgrades a client to `ADVANCED`. A Stripe webhook
  is the *only* thing allowed to change a client's tier — this means the CMS
  can never be unlocked by a client tampering with their own data.
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
prisma/schema.prisma        Data model (User, Client, Project, MediaAsset, CaptionTrack, Page)
lib/prisma.js                Shared Prisma client
lib/auth.js                  JWT sign/verify
lib/storage.js                Upload storage (local disk in dev, S3-compatible in prod)
lib/projectAccess.js          Ownership check helper
middleware/authenticate.js    Verifies JWT, sets req.user
middleware/requireRole.js     Staff-only route gate
middleware/requireTier.js     "Pay more to unlock this" gate — the core of Tier 2
routes/auth.js                register / login / me
routes/billing.js             Stripe checkout session + webhook
routes/projects.js            CMS projects (mounts media.js and captions.js)
routes/media.js               Media upload/list/delete
routes/captions.js            Caption track create/list/delete
routes/pages.js                Site content pages
tests/                        Jest + Supertest tests (auth + tier-gating)
Dockerfile, docker-compose.yml Container + local Postgres
.github/workflows/ci.yml      Runs tests against Postgres on every push
```

### How the "pay more" gate actually works

`middleware/requireTier('ADVANCED')` is applied to every CMS route
(`routes/projects.js:14`). On each request it:
1. Lets `ADMIN` users through unconditionally.
2. Otherwise loads the requesting user's `Client` row and compares its `tier`
   against the tier the route requires.
3. Returns `403` with an "upgrade your account" message if the tier isn't high
   enough.

The *only* code path that sets `tier: 'ADVANCED'` is the Stripe webhook handler
in `routes/billing.js`. Nothing else writes to that field, which is what makes
this a real paywall rather than a client-editable flag.

---

## 2. Local setup, step by step

### 2.1 Prerequisites
- Node.js 22+
- PostgreSQL 16 (locally installed, or via Docker — see §5)
- A [Stripe](https://dashboard.stripe.com) account (free, test mode is enough
  for development)

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
- Stripe vars — fill in after §4.

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
Check `http://localhost:4000/api/health` → `{"status":"ok"}`.

### 2.5 Try the flow end-to-end
```bash
# Register a client account (starts on the FREE tier)
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@studio.com","password":"password123","clientName":"Studio Co"}'

# Save the returned token, then try the CMS (will 403 — still on FREE tier)
curl http://localhost:4000/api/projects -H "Authorization: Bearer <token>"
```
To manually unlock it while testing (before wiring Stripe), open Prisma Studio:
```bash
npx prisma studio
```
and set that Client's `tier` to `ADVANCED` directly — then retry the request above.

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

---

## 3. Running the test suite
```bash
createdb africaptions_test
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/africaptions_test" \
  npx prisma migrate deploy
npm test
```
The tests (`tests/auth.test.js`, `tests/tier-gating.test.js`) cover registration,
login, and — most importantly — that FREE/STANDARD clients are blocked from the
CMS while ADVANCED clients and ADMIN staff get through, and that clients can
only ever see their own projects.

CI (`.github/workflows/ci.yml`) runs this same suite against a throwaway
Postgres container on every push, so a regression in the tier gate fails the
build before it reaches production.

---

## 4. Setting up Stripe billing for the Advanced (Tier 2) plan

1. **Create the product & price** (Stripe Dashboard → Product catalog):
   - Add a product, e.g. "Africaptions CMS — Advanced".
   - Add a recurring price (e.g. monthly). Copy its **Price ID** (`price_...`)
     into `STRIPE_PRICE_ADVANCED` in `.env`.
2. **Get your API keys** (Developers → API keys):
   - Copy the **Secret key** (`sk_test_...` in test mode) into `STRIPE_SECRET_KEY`.
3. **Set up the webhook**:
   - Developers → Webhooks → Add endpoint → URL:
     `https://<your-domain>/api/billing/webhook`
     (for local dev, use the Stripe CLI instead — see below).
   - Subscribe to events: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`.
   - Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
4. **Local webhook testing** (no public URL needed):
   ```bash
   stripe listen --forward-to localhost:4000/api/billing/webhook
   ```
   This prints a temporary `whsec_...` — use that in your local `.env` while
   testing.
5. **Test the upgrade flow**:
   ```bash
   curl -X POST http://localhost:4000/api/billing/checkout-session \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json"
   ```
   Open the returned `url`, pay with Stripe's test card `4242 4242 4242 4242`
   (any future expiry/CVC), and confirm the client's tier flips to `ADVANCED`
   (check via `GET /api/auth/me`).

**Note on other African payment rails**: if you'd rather accept Paystack,
Flutterwave, or M-Pesa directly, the entitlement gate (`requireTier`) doesn't
care how `Client.tier` gets set — only `routes/billing.js` would need a
different provider's webhook/callback wired to the same
`prisma.client.update({ data: { tier: 'ADVANCED' } })` call. Everything else
in this guide is unaffected.

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
   - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ADVANCED` = your **live mode** values
     once you're ready to accept real payments (see §8)
   - `STORAGE_DRIVER=s3` plus the `S3_*` variables (see §7 — do this before
     going live, not after)
   - `NODE_ENV=production`
4. Deploy. The Dockerfile's start command (`prisma migrate deploy && node
   server.js`) applies any pending migrations automatically on every deploy —
   this is what keeps the schema in sync without a manual step.
5. Once live, go back to Stripe (§4.3) and add the webhook endpoint pointing
   at `https://your-domain/api/billing/webhook`, then set
   `STRIPE_WEBHOOK_SECRET` on Render to the new signing secret it gives you.

### 6.3 Verify the deploy
```bash
curl https://your-domain/api/health
```
Then repeat the register → login → checkout-session smoke test from §2.5/§4.5
against the live URL.

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
- **Move Stripe from test → live mode when ready to charge real clients**:
  create a live-mode product/price, get live API keys, add a *separate*
  live-mode webhook endpoint, and swap `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_ADVANCED`, `STRIPE_WEBHOOK_SECRET` to the live values. Test
  and live Stripe data are entirely separate — a client who "paid" in test
  mode never actually gets charged.
- **Back up the database.** Managed Postgres (Render/Railway/RDS/Supabase)
  usually includes automatic daily backups — confirm this is turned on and
  test a restore at least once so you know the process works before you need it.
- **Monitor uptime** — point a free service (UptimeRobot, Better Stack, or
  your host's built-in health checks) at `/api/health` so you hear about
  outages before a client does.
- **Watch the Stripe webhook's delivery log** (Stripe Dashboard → Developers
  → Webhooks → your endpoint) — failed deliveries mean a client paid but
  never got upgraded to `ADVANCED`. Stripe retries automatically, but it's
  worth an occasional glance, especially right after a deploy (a redeploy can
  briefly 502 an in-flight webhook).
- **Re-run `npm audit` / update dependencies periodically** — this is a
  Node/Express app talking to the public internet; treat dependency updates
  (especially `express`, `jsonwebtoken`, `multer`, `stripe`) as routine
  maintenance, not optional.
- **CI stays green as a gate**: don't merge/deploy a branch where
  `.github/workflows/ci.yml` is failing — the tier-gating tests failing is a
  signal the paywall itself may be broken.

---

## 9. Publishing / going live checklist

1. ☐ Production Postgres provisioned, `DATABASE_URL` set, migrations applied.
2. ☐ Fresh, unique `JWT_SECRET` set in production (not the dev value).
3. ☐ `STORAGE_DRIVER=s3` configured with a real bucket (§7) — **do this before
   any real client uploads a file**.
4. ☐ Stripe switched to **live mode** keys/price/webhook (§8), and a real
   $1-equivalent test purchase completed and refunded to confirm the whole
   loop (checkout → webhook → tier upgrade) works with real money rails.
5. ☐ Custom domain pointed at the host, `APP_URL` updated to match, and the
   Stripe webhook + success/cancel URLs updated to the final domain.
6. ☐ At least one real `ADMIN` staff account created (§2.6) so the team can
   manage any client's projects.
7. ☐ Frontend (marketing site / client portal, wherever it lives) pointed at
   the production API base URL, with a pricing/upgrade page that calls
   `POST /api/billing/checkout-session` for the Advanced plan.
8. ☐ Uptime monitor pointed at `/api/health` (§8).
9. ☐ Announce/enable the paid tier — e.g. update the pricing page copy so
   "Advanced" clearly states it unlocks the client CMS portal.

Once every box above is checked, the Tier 2 CMS is genuinely production-ready:
a client can sign up, pay, get upgraded automatically, and manage their
captioning projects — and the system will keep working through redeploys,
restarts, and routine maintenance.
