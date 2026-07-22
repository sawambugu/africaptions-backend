// Staff-only endpoints backing the admin dashboard: viewing all client
// accounts and manually granting/adjusting a tier (e.g. for an offline
// payment, a goodwill extension, or a client who paid Africaptions
// directly outside Paystack/M-Pesa).

const express = require('express');
const prisma = require('../lib/prisma');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');

const router = express.Router();
const TIERS = ['FREE', 'STANDARD', 'ADVANCED'];

router.use(authenticate, requireRole('ADMIN'));

router.get('/clients', async (_req, res) => {
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: 'desc' },
    include: { users: { select: { id: true, email: true } } },
  });
  res.json({ clients });
});

router.patch('/clients/:id/tier', async (req, res) => {
  const { tier, tierExpiresAt } = req.body || {};
  if (!tier || !TIERS.includes(tier)) {
    return res.status(400).json({ error: `tier must be one of: ${TIERS.join(', ')}` });
  }

  const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Client not found.' });
  }

  const client = await prisma.client.update({
    where: { id: req.params.id },
    data: {
      tier,
      // Pass null explicitly for "never expires"; omit the field to leave
      // the current expiry untouched.
      ...(tierExpiresAt !== undefined && {
        tierExpiresAt: tierExpiresAt ? new Date(tierExpiresAt) : null,
      }),
    },
  });
  res.json({ client });
});

module.exports = router;
