// Seeds a baseline permission/role set. This is infrastructure only —
// it does not enforce anything by itself, it just gives future features
// a ready-made RBAC vocabulary to build on.

const PERMISSIONS = [
  { key: 'users.manage', description: 'Manage users (view, edit, block)' },
  { key: 'roles.manage', description: 'Manage roles and permission assignments' },
  { key: 'groups.manage', description: 'Manage any group (not just owned ones)' },
  { key: 'messages.moderate', description: 'View/delete any message' },
  { key: 'uploads.manage', description: 'Manage any uploaded file' },
  { key: 'notifications.manage', description: 'Send/manage notifications for any user' },
  { key: 'logs.view', description: 'View system logs' }
];

const ROLES = [
  { key: 'super_admin', name: 'Super Admin', description: 'Full access to everything', permissions: '*' },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Elevated access for day-to-day administration',
    permissions: [
      'users.manage',
      'groups.manage',
      'messages.moderate',
      'uploads.manage',
      'notifications.manage',
      'logs.view'
    ]
  },
  { key: 'member', name: 'Member', description: 'Regular authenticated user', permissions: [] }
];

module.exports = {
  name: '008_seed_roles_and_permissions',
  up(db) {
    const insertPermission = db.prepare(
      'INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)'
    );
    for (const p of PERMISSIONS) insertPermission.run(p.key, p.description);

    const insertRole = db.prepare(
      'INSERT OR IGNORE INTO roles (key, name, description) VALUES (?, ?, ?)'
    );
    for (const r of ROLES) insertRole.run(r.key, r.name, r.description);

    const getRoleId = db.prepare('SELECT id FROM roles WHERE key = ?');
    const getPermissionId = db.prepare('SELECT id FROM permissions WHERE key = ?');
    const linkRolePermission = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
    );

    const allPermissionIds = db.prepare('SELECT id FROM permissions').all().map((row) => row.id);

    for (const r of ROLES) {
      const role = getRoleId.get(r.key);
      if (!role) continue;

      const permissionIds =
        r.permissions === '*'
          ? allPermissionIds
          : r.permissions.map((key) => getPermissionId.get(key)).filter(Boolean).map((row) => row.id);

      for (const permissionId of permissionIds) {
        linkRolePermission.run(role.id, permissionId);
      }
    }

    // Give every pre-existing user (created before RBAC existed) the base "member" role
    const memberRole = getRoleId.get('member');
    if (memberRole) {
      db.exec(`
        INSERT OR IGNORE INTO user_roles (user_id, role_id)
        SELECT id, ${memberRole.id} FROM users
      `);
    }
  }
};
