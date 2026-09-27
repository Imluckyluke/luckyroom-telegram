// Tracks, per user, the last message they've read in each room (group or
// DM conversation). Used to show an unread indicator + last-message preview
// in the room list instead of a static "private/public" label.
module.exports = {
  name: '016_add_chat_reads',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_reads (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id              INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        conversation_id       INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        last_read_message_id  INTEGER NOT NULL DEFAULT 0,
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((group_id IS NULL) != (conversation_id IS NULL))
      );

      -- One row per (user, room). Partial unique indexes so the "other"
      -- always-NULL column never trips a false collision.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reads_user_group
        ON chat_reads(user_id, group_id) WHERE group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reads_user_conversation
        ON chat_reads(user_id, conversation_id) WHERE conversation_id IS NOT NULL;
    `);
  }
};
