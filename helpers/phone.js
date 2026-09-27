// Single place for phone-number handling.
//
// Iranian mobile numbers arrive in many shapes: 09123456789, +989123456789,
// 989123456789, 00989123456789, with spaces/dashes. Everything auth-related
// (register, login, OTP, invites, lookups) must agree on one canonical form,
// otherwise the same SIM can own several accounts and the super-admin check
// (helpers/superAdmin.js) can match accounts it shouldn't.
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('98')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function isValidPhone(phone) {
  return /^9\d{9}$/.test(normalizePhone(phone));
}

// Looks a user up by phone, accepting both the canonical form and whatever
// raw string is already stored (accounts created before normalization).
function findUserByPhone(db, phone) {
  const trimmed = String(phone || '').trim();
  const normalized = normalizePhone(trimmed);
  if (trimmed && trimmed !== normalized) {
    return db.prepare('SELECT * FROM users WHERE phone = ? OR phone = ?').get(trimmed, normalized);
  }
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized || trimmed);
}

module.exports = { normalizePhone, isValidPhone, findUserByPhone };
