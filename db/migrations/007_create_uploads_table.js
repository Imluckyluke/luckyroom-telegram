module.exports = {
  name: '007_create_uploads_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name   TEXT NOT NULL UNIQUE,
        mime_type     TEXT,
        size          INTEGER,
        path          TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at);
    `);
  }
};
