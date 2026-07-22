// Africaptions Media House — backend
// Express API: public contact form, the Africaptions CMS (auth, billing,
// projects/media/captions gated behind the Advanced/Tier 2 plan, and site
// content pages), and in production can also serve the built frontend as
// static files.

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
const { LOCAL_UPLOAD_DIR } = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// Stripe needs the raw, unparsed request body to verify webhook signatures,
// so this route MUST be registered before the global express.json() below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRoute.webhookHandler);

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

// Serves locally-uploaded media in development. In production, set
// STORAGE_DRIVER=s3 (see docs/CMS_SETUP_AND_DEPLOYMENT.md) — this local
// path is not persisted across deploys on most hosts.
app.use('/uploads', express.static(LOCAL_UPLOAD_DIR));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Serve the static frontend in production (optional — Sammy may host
// the frontend separately, e.g. on Vercel/Netlify, instead).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Only start listening when run directly (`node server.js`), not when
// required by tests (they import `app` and drive it with supertest instead).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Africaptions backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
