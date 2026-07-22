// Africaptions Media House — backend
// Express API: public contact form, the Africaptions CMS (auth, billing via
// Paystack/M-Pesa, projects/media/captions gated behind the Advanced/Tier 2
// plan, admin tools, and site content pages), a small built-in dashboard,
// and in production can also serve the built marketing frontend as static
// files.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const contactRoute = require('./routes/contact');
const authRoute = require('./routes/auth');
const billingRoute = require('./routes/billing');
const projectsRoute = require('./routes/projects');
const pagesRoute = require('./routes/pages');
const adminRoute = require('./routes/admin');
const { LOCAL_UPLOAD_DIR } = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// Paystack needs the raw, unparsed request body to verify webhook
// signatures, so this route MUST be registered before the global
// express.json() below. (M-Pesa's callback isn't signed the same way and
// is handled as a normal JSON route inside routes/billing.js.)
app.post(
  '/api/billing/paystack/webhook',
  express.raw({ type: 'application/json' }),
  billingRoute.paystackWebhookHandler
);

app.use(express.json());

// Basic abuse protection on the contact endpoint
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/contact', contactLimiter, contactRoute);

app.use('/api/auth', authRoute);
app.use('/api/billing', billingRoute);
app.use('/api/projects', projectsRoute);
app.use('/api/pages', pagesRoute);
app.use('/api/admin', adminRoute);

// Serves locally-uploaded media in development. In production, set
// STORAGE_DRIVER=s3 (see docs/CMS_SETUP_AND_DEPLOYMENT.md) — this local
// path is not persisted across deploys on most hosts.
app.use('/uploads', express.static(LOCAL_UPLOAD_DIR));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Built-in client/admin dashboard (plain HTML/CSS/JS, talks to the API
// above via fetch). Available at /dashboard.
app.use('/dashboard', express.static(path.join(__dirname, 'public', 'dashboard')));

// Serve the static marketing frontend in production (optional — Sammy may
// host the frontend separately, e.g. on Vercel/Netlify, instead).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Only start listening when run directly (`node server.js`), not when
// required by tests (they import `app` and drive it with supertest instead).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Africaptions backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
