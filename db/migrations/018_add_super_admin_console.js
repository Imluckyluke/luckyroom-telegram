// Adds three permissions for the super-admin console features
// (global broadcast, database backup/restore, and full room/chat
// browsing) and wires them to `super_admin` only — regular `admin`s do
// not get these, since they touch every user's data and the raw DB file.
module.exports = {
  name: '018_add_super_admin_console',
  up(db) {
    const PERMISSIONS = [
      { key: 'broadcast.send', description: 'Send a global notification/announcement to every user' },
      { key: 'backup.manage', description: 'Create, list, download, and restore database backups' },
      { key: 'chats.view_all', description: 'Browse every room and every user\'s chats/messages' }
    ];

    const insertPermission = db.prepare(
      'INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)'
    );
    for (const p of PERMISSIONS) insertPermission.run(p.key, p.description);

    const superAdmin = db.prepare("SELECT id FROM roles WHERE key = 'super_admin'").get();
    const getPermissionId = db.prepare('SELECT id FROM permissions WHERE key = ?');
    const linkRolePermission = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
    );

    if (superAdmin) {
      for (const p of PERMISSIONS) {
        const permission = getPermissionId.get(p.key);
        if (permission) linkRolePermission.run(superAdmin.id, permission.id);
      }
    }
  }
};
