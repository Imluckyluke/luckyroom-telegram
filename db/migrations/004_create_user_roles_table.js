module.exports = {
  name: '004_create_user_roles_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, role_id)
      );
    `);
  }
};
