const migrations = [
  require('./001_create_permissions_table'),
  require('./002_create_roles_table'),
  require('./003_create_role_permissions_table'),
  require('./004_create_user_roles_table'),
  require('./005_create_notifications_table'),
  require('./006_create_logs_table'),
  require('./007_create_uploads_table'),
  require('./008_seed_roles_and_permissions'),
  require('./009_add_profile_fields_to_users'),
  require('./010_add_message_features'),
  require('./011_add_moderation_fields_to_users'),
  require('./012_add_security_features'),
  require('./013_expand_file_system'),
  require('./014_add_settings_and_permission'),
  require('./015_add_rooms_invites_blocks'),
  require('./016_add_chat_reads'),
  require('./017_add_lockout_and_security_questions'),
  require('./018_add_super_admin_console'),
  require('./019_add_message_reply'),
  require('./020_add_message_reactions'),
  require('./021_add_message_forward'),
  require('./022_add_group_locks'),
  require('./023_add_group_lock_video'),
  require('./024_add_stickers')
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row) => row.name)
  );

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    const runInTransaction = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    });

    runInTransaction();
    console.log(`[migrate] applied: ${migration.name}`);
  }
}

module.exports = { runMigrations, migrations };
