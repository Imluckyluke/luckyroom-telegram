// Adds the columns needed for the admin panel's moderation actions:
// ban, mute, and per-admin online-status visibility.
module.exports = {
  name: '011_add_moderation_fields_to_users',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN banned_at TEXT;
      ALTER TABLE users ADD COLUMN ban_reason TEXT;
      ALTER TABLE users ADD COLUMN banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

      ALTER TABLE users ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN muted_until TEXT;
      ALTER TABLE users ADD COLUMN muted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

      ALTER TABLE users ADD COLUMN hide_online_status INTEGER NOT NULL DEFAULT 0;
    `);
  }
};
