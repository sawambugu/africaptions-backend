# africaptions-backend

Backend for Africaptions Media House: the public contact form API, plus a
CMS (auth, Stripe billing, and content management) gated behind a paid
**Advanced (Tier 2)** client plan.

See [`docs/CMS_SETUP_AND_DEPLOYMENT.md`](docs/CMS_SETUP_AND_DEPLOYMENT.md)
for the full setup, deployment, and publishing guide.

## Quick start
```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, Stripe keys
npx prisma migrate dev
npm run dev
```
