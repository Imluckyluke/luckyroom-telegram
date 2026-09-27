module.exports = {
  name: '019_add_message_reply',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);
    `);
  }
};
