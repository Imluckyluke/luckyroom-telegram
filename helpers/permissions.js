const db = require('../db');

function getUserRoleKeys(userId) {
  return db
    .prepare(
      `SELECT r.key FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId)
    .map((row) => row.key);
}

function getUserPermissionKeys(userId) {
  return db
    .prepare(
      `SELECT DISTINCT p.key FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`
    )
    .all(userId)
    .map((row) => row.key);
}

function userHasRole(userId, roleKey) {
  return getUserRoleKeys(userId).includes(roleKey);
}

function userHasAnyRole(userId, roleKeys) {
  const keys = getUserRoleKeys(userId);
  return roleKeys.some((k) => keys.includes(k));
}

function userHasPermission(userId, permissionKey) {
  return getUserPermissionKeys(userId).includes(permissionKey);
}

function assignRole(userId, roleKey) {
  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  if (!role) return false;
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, role.id);
  return true;
}

function revokeRole(userId, roleKey) {
  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  if (!role) return false;
  db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, role.id);
  return true;
}

// Users with any of the given roles (used to list admins/super_admins).
function getUsersWithAnyRole(roleKeys) {
  const placeholders = roleKeys.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE r.key IN (${placeholders})
       ORDER BY u.id`
    )
    .all(...roleKeys);
}

// Express middleware — must run after authRequired (needs req.userId)
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!userHasPermission(req.userId, permissionKey)) {
      return res.status(403).json({ error: 'Forbidden: missing permission' });
    }
    next();
  };
}

function requireRole(roleKey) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!userHasRole(req.userId, roleKey)) {
      return res.status(403).json({ error: 'Forbidden: missing role' });
    }
    next();
  };
}

function requireAnyRole(roleKeys) {
  return (req, res, next) => {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!userHasAnyRole(req.userId, roleKeys)) {
      return res.status(403).json({ error: 'Forbidden: missing role' });
    }
    next();
  };
}

module.exports = {
  getUserRoleKeys,
  getUserPermissionKeys,
  userHasRole,
  userHasAnyRole,
  userHasPermission,
  assignRole,
  revokeRole,
  getUsersWithAnyRole,
  requirePermission,
  requireRole,
  requireAnyRole
};
