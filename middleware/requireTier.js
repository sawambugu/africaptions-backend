// Gates a route behind a minimum subscription tier. This is the actual
// "pay more to unlock the CMS" check: staff (role ADMIN) always pass,
// everyone else needs their Client account's tier to be at or above the
// tier required for the route. Must run after `authenticate`.

const prisma = require('../lib/prisma');

const TIER_RANK = { FREE: 0, STANDARD: 1, ADVANCED: 2 };

module.exports = function requireTier(minTier) {
  const minRank = TIER_RANK[minTier];
  if (minRank === undefined) {
    throw new Error(`requireTier: unknown tier "${minTier}"`);
  }

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (req.user.role === 'ADMIN') {
      return next();
    }
    if (!req.user.clientId) {
      return res.status(403).json({
        error: `This feature requires the ${minTier} plan. Upgrade your account to continue.`,
      });
    }

    const client = await prisma.client.findUnique({ where: { id: req.user.clientId } });
    if (!client || TIER_RANK[client.tier] < minRank) {
      return res.status(403).json({
        error: `This feature requires the ${minTier} plan. Upgrade your account to continue.`,
        currentTier: client ? client.tier : null,
        requiredTier: minTier,
      });
    }

    req.client = client;
    next();
  };
};
