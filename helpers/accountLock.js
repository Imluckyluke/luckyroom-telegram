// Account-level brute-force protection: independent of the IP-based
// rate limiter (helpers/rateLimiter.js), so an attacker spreading login
// attempts across many IPs still can't grind a single account's
// password or security-question answers.
const db = require('../db');
const config = require('../config');

function isLocked(user) {
  if (!user.locked_until) return false;
  return new Date(user.locked_until).getTime() > Date.now();
}

function lockRemainingSeconds(user) {
  if (!isLocked(user)) return 0;
  return Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
}

// Call after a failed login/security-answer attempt. Locks the account
// once the configured threshold is hit.
function registerFailedAttempt(userId) {
  const user = db.prepare('SELECT id, failed_login_attempts FROM users WHERE id = ?').get(userId);
  if (!user) return;

  const attempts = (user.failed_login_attempts || 0) + 1;

  if (attempts >= config.accountLock.maxFailedAttempts) {
    const lockedUntil = new Date(Date.now() + config.accountLock.lockMinutes * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?').run(lockedUntil, userId);
  } else {
    db.prepare('UPDATE users SET failed_login_attempts = ? WHERE id = ?').run(attempts, userId);
  }
}

// Call after a successful login/password reset to clear the counter.
function clearFailedAttempts(userId) {
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}

module.exports = { isLocked, lockRemainingSeconds, registerFailedAttempt, clearFailedAttempts };
