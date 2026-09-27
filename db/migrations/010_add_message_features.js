module.exports = {
  name: '010_add_message_features',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN edited_at TEXT;
      ALTER TABLE messages ADD COLUMN deleted_at TEXT;
      ALTER TABLE messages ADD COLUMN pinned_at TEXT;
      ALTER TABLE messages ADD COLUMN pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(group_id, conversation_id, pinned_at);
    `);
  }
};
