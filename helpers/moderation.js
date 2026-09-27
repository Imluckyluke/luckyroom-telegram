const db = require('../db');

function isBanned(userId) {
  const row = db.prepare('SELECT banned_at FROM users WHERE id = ?').get(userId);
  return !!(row && row.banned_at);
}

// A mute with no muted_until is indefinite; one with a muted_until is
// only active while that timestamp is still in the future.
function isMuted(userId) {
  const row = db.prepare('SELECT is_muted, muted_until FROM users WHERE id = ?').get(userId);
  if (!row || !row.is_muted) return false;
  if (!row.muted_until) return true;
  return new Date(row.muted_until).getTime() > Date.now();
}

module.exports = { isBanned, isMuted };
