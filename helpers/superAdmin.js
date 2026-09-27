// Single-super-admin bootstrap, driven by the SUPER_ADMIN_PHONE env var —
// nothing is hardcoded here. Whoever owns that number is the one and only
// holder of the super_admin (and admin) roles:
//
// - at register time, a matching phone is granted super_admin immediately;
// - at server startup, syncExclusiveSuperAdmin() grants it to the matching
//   account AND revokes admin/super_admin from everyone else, so dashboard
//   access can never leak to another account (or linger on a deleted one).
const db = require('../db');
const { assignRole, revokeRole } = require('./permissions');
const { normalizePhone } = require('./phone');

function superAdminDigits() {
  const raw = process.env.SUPER_ADMIN_PHONE || '';
  const digits = normalizePhone(raw);
  return digits || null;
}

function normalizedPhoneDigits(phone) {
  return normalizePhone(phone);
}

function isSuperAdminPhone(phone) {
  const target = superAdminDigits();
  if (!target) return false;
  return normalizePhone(phone) === target;
}

// Runs once at server startup. Makes the env-configured phone the SOLE
// super_admin: grants member+super_admin to it (if registered yet) and
// strips admin/super_admin from every other user.
function ensureDefaultSuperAdmin() {
  const target = superAdminDigits();
  if (!target) {
    console.warn('[admin] SUPER_ADMIN_PHONE is not set — no super_admin will exist.');
    return { applied: false, reason: 'missing-env' };
  }

  const adminRoleIds = db
    .prepare(`SELECT id FROM roles WHERE key IN ('admin', 'super_admin')`)
    .all()
    .map((r) => r.id);
  if (adminRoleIds.length) {
    const placeholders = adminRoleIds.map(() => '?').join(',');
    const holders = db
      .prepare(
        `SELECT DISTINCT ur.user_id AS userId, u.phone AS phone
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.role_id IN (${placeholders})`
      )
      .all(...adminRoleIds);
    for (const h of holders) {
      if (normalizePhone(h.phone) === target) continue;
      revokeRole(h.userId, 'admin');
      revokeRole(h.userId, 'super_admin');
      assignRole(h.userId, 'member');
    }
  }

  const users = db.prepare('SELECT id, phone FROM users').all();
  let granted = false;
  for (const user of users) {
    if (normalizePhone(user.phone) === target) {
      assignRole(user.id, 'member');
      assignRole(user.id, 'super_admin');
      granted = true;
    }
  }
  if (granted) console.log('[admin] super_admin synced to the configured phone.');
  else console.warn('[admin] SUPER_ADMIN_PHONE is set but no account uses it yet — register with that number.');
  return { applied: true, granted };
}

module.exports = { normalizedPhoneDigits, isSuperAdminPhone, ensureDefaultSuperAdmin };
