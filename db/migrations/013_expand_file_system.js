// Expands the uploads system: per-category files (file/image/voice),
// at-rest encryption metadata (envelope encryption, see helpers/crypto.js),
// integrity checksum, and the ability to attach an upload to a chat
// message so it can actually be sent/received in a conversation.
module.exports = {
  name: '013_expand_file_system',
  up(db) {
    db.exec(`
      ALTER TABLE uploads ADD COLUMN category TEXT NOT NULL DEFAULT 'file';
      ALTER TABLE uploads ADD COLUMN checksum TEXT;
      ALTER TABLE uploads ADD COLUMN iv TEXT;
      ALTER TABLE uploads ADD COLUMN auth_tag TEXT;
      ALTER TABLE uploads ADD COLUMN encrypted_key TEXT;
      ALTER TABLE uploads ADD COLUMN key_iv TEXT;
      ALTER TABLE uploads ADD COLUMN key_auth_tag TEXT;

      CREATE INDEX IF NOT EXISTS idx_uploads_category ON uploads(category);

      ALTER TABLE messages ADD COLUMN upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text';

      CREATE INDEX IF NOT EXISTS idx_messages_upload ON messages(upload_id);
    `);
  }
};
