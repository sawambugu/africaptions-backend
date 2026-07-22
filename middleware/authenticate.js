const { verifyToken } = require('../lib/auth');

// Reads "Authorization: Bearer <token>", verifies it, and attaches the
// decoded claims to req.user. Downstream middleware (requireRole,
// requireTier) and route handlers rely on req.user being set.
module.exports = function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role, clientId: payload.clientId };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};
