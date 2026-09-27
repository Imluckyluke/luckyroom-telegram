const jwt = require('jsonwebtoken');
const { isBanned } = require('../helpers/moderation');
const { findActiveSessionByJti, touchSession } = require('../helpers/sessions');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (isBanned(payload.sub)) {
      return res.status(403).json({ error: 'Your account has been banned' });
    }

    // Tokens issued before session tracking existed have no "jti" — treat
    // them as before. Newly issued tokens always carry one, so this check
    // is what makes "delete session" / "force logout" actually work.
    if (payload.jti) {
      const session = findActiveSessionByJti(payload.jti);
      if (!session) {
        return res.status(401).json({ error: 'Session has been revoked, please log in again' });
      }
      touchSession(payload.jti);
      req.sessionId = session.id;
      req.jti = payload.jti;
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function verifySocketToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET); // throws if invalid
}

module.exports = { authRequired, verifySocketToken };
