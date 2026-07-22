// POST /api/auth/register  — creates a Client account (tier FREE) and its first user.
// POST /api/auth/login     — verifies credentials, returns a JWT.
// GET  /api/auth/me        — returns the current user + their client's tier.

const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { signToken } = require('../lib/auth');
const authenticate = require('../middleware/authenticate');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  const { email, password, clientName } = req.body || {};

  if (!email || !password || !clientName) {
    return res.status(400).json({ error: 'email, password and clientName are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: 'CLIENT',
      client: { create: { name: clientName } },
    },
    include: { client: true },
  });

  const token = signToken(user);
  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, role: user.role },
    client: { id: user.client.id, name: user.client.name, tier: user.client.tier },
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  const user = await prisma.user.findUnique({ where: { email }, include: { client: true } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role },
    client: user.client ? { id: user.client.id, name: user.client.name, tier: user.client.tier } : null,
  });
});

router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { client: true },
  });
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json({
    user: { id: user.id, email: user.email, role: user.role },
    client: user.client ? { id: user.client.id, name: user.client.name, tier: user.client.tier } : null,
  });
});

module.exports = router;
