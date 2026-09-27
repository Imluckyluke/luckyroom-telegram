module.exports = {
  name: '009_add_profile_fields_to_users',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN bio TEXT;
      ALTER TABLE users ADD COLUMN avatar_path TEXT;
      ALTER TABLE users ADD COLUMN last_seen_at TEXT;
    `);
  }
};
