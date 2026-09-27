const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : null;
}

function guessDeviceName(userAgent) {
  if (!userAgent) return 'Unknown device';
  if (/android/i.test(userAgent)) return 'Android device';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iOS device';
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/mac os/i.test(userAgent)) return 'Mac';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'Unknown device';
}

// Issues a JWT for `user` and records a matching session row (device,
// user agent, IP). The token's own "jti" claim is how a live request or
// socket connection is later matched back to that session row.
function issueSession(user, req, deviceName) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: user.id, jti }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

  const decoded = jwt.decode(token);
  const expiresAt = decoded && decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null;
  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO sessions (user_id, jti, device_name, user_agent, ip_address, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    jti,
    (deviceName && String(deviceName).trim().slice(0, 100)) || guessDeviceName(req.headers['user-agent']),
    req.headers['user-agent'] || null,
    clientIp(req),
    nowIso,
    nowIso,
    expiresAt
  );

  return { token, jti };
}

function findActiveSessionByJti(jti) {
  return db.prepare('SELECT * FROM sessions WHERE jti = ? AND revoked_at IS NULL').get(jti);
}

function touchSession(jti) {
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE jti = ? AND revoked_at IS NULL').run(
    new Date().toISOString(),
    jti
  );
}

function listActiveSessions(userId) {
  return db
    .prepare(
      `SELECT id, jti, device_name, user_agent, ip_address, created_at, last_used_at, expires_at
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY last_used_at DESC`
    )
    .all(userId);
}

// Revokes one session by id, scoped to its owner. Returns the revoked
// row (so its jti can be used to kick any live socket) or null if it
// didn't exist / wasn't theirs / was already revoked.
function revokeSessionById(userId, sessionId) {
  const session = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .get(sessionId, userId);
  if (!session) return null;

  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
  return session;
}

// Revokes every active session for a user, optionally keeping one (the
// caller's own current session) alive. Returns the rows that were revoked.
function revokeAllSessions(userId, { exceptJti = null } = {}) {
  const rows = exceptJti
    ? db
        .prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND jti != ?')
        .all(userId, exceptJti)
    : db.prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL').all(userId);

  if (rows.length === 0) return rows;

  const now = new Date().toISOString();
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);

  return rows;
}

module.exports = {
  issueSession,
  findActiveSessionByJti,
  touchSession,
  listActiveSessions,
  revokeSessionById,
  revokeAllSessions
};
