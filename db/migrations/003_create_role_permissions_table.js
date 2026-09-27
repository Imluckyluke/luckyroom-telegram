module.exports = {
  name: '003_create_role_permissions_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (role_id, permission_id)
      );
    `);
  }
};
