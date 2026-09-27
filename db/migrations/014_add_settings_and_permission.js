// Adds a generic key/value `settings` table (so upload size limits can be
// changed from the admin panel without a server restart / env edit), and a
// new `settings.manage` permission wired to `super_admin` only — regular
// `admin`s can still manage uploads (`uploads.manage`) but not change the
// system-wide limits.
module.exports = {
  name: '014_add_settings_and_permission',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    db.prepare('INSERT OR IGNORE INTO permissions (key, description) VALUES (?, ?)').run(
      'settings.manage',
      'Manage system-wide settings (e.g. per-category upload size limits)'
    );

    const superAdmin = db.prepare("SELECT id FROM roles WHERE key = 'super_admin'").get();
    const permission = db.prepare("SELECT id FROM permissions WHERE key = 'settings.manage'").get();
    if (superAdmin && permission) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(
        superAdmin.id,
        permission.id
      );
    }
  }
};
