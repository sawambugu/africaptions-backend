# africaptions-backend

Backend for Africaptions Media House: the public contact form API, plus a
CMS (auth, Paystack + M-Pesa billing, and content management) gated behind a
paid **Advanced (Tier 2)** client plan, and a small built-in dashboard at
`/dashboard`.

See [`docs/CMS_SETUP_AND_DEPLOYMENT.md`](docs/CMS_SETUP_AND_DEPLOYMENT.md)
for the full setup, deployment, and publishing guide.

## Quick start
```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, Paystack/M-Pesa keys
npx prisma migrate dev
npm run dev
```
Then open `http://localhost:4000/dashboard`.
