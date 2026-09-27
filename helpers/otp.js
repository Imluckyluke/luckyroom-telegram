const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6-digit, zero can't be a leading digit issue since range excludes it
}

function latestOtp(phone, purpose) {
  return db
    .prepare(
      `SELECT * FROM otp_codes WHERE phone = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(phone, purpose);
}

// created_at is a sqlite-default UTC "YYYY-MM-DD HH:MM:SS" string (same
// convention as the rest of the schema); expires_at is set by this app in
// full ISO form. Normalize the former the way helpers/dashboardStats.js does.
function parseSqliteDatetime(value) {
  return new Date(value.replace(' ', 'T') + 'Z');
}

// Creates and stores a new OTP for (phone, purpose), returning the
// plaintext code so the caller can send it via SMS — only a hash is ever
// persisted. Throttled to one new code per resend window to avoid SMS
// spamming a number.
function createOtp({ userId = null, phone, purpose }) {
  const recent = latestOtp(phone, purpose);
  if (recent) {
    const elapsedSec = (Date.now() - parseSqliteDatetime(recent.created_at).getTime()) / 1000;
    if (elapsedSec < config.otp.resendSeconds) {
      return { throttled: true, retryAfterSeconds: Math.max(1, Math.ceil(config.otp.resendSeconds - elapsedSec)) };
    }
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO otp_codes (user_id, phone, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, phone, purpose, hashCode(code), expiresAt);

  return { throttled: false, code, expiresAt };
}

// Verifies a code against the latest unconsumed OTP for (phone, purpose).
// Consumes it on success so it can't be replayed.
function verifyOtp({ phone, purpose, code }) {
  const row = latestOtp(phone, purpose);
  if (!row) {
    return { ok: false, error: 'No verification code was requested for this number' };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Verification code has expired, request a new one' };
  }
  if (row.attempts >= config.otp.maxAttempts) {
    return { ok: false, error: 'Too many incorrect attempts, request a new code' };
  }
  if (hashCode(code) !== row.code_hash) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: 'Invalid verification code' };
  }

  db.prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { ok: true, row };
}

module.exports = { createOtp, verifyOtp };
