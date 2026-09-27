module.exports = {
  name: '001_create_permissions_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
};
