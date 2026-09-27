module.exports = {
  name: '006_create_logs_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        level      TEXT NOT NULL DEFAULT 'info',
        action     TEXT NOT NULL,
        message    TEXT,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        meta       TEXT,
        ip         TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action);
      CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
    `);
  }
};
