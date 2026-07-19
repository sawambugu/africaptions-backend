// Africaptions Media House — backend
// Minimal Express API that serves the contact form and, in production,
// can also serve the built frontend as static files.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const contactRoute = require('./routes/contact');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Basic abuse protection on the contact endpoint
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/contact', contactLimiter, contactRoute);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Serve the static frontend in production (optional — Sammy may host
// the frontend separately, e.g. on Vercel/Netlify, instead).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.listen(PORT, () => {
  console.log(`Africaptions backend running on http://localhost:${PORT}`);
});
