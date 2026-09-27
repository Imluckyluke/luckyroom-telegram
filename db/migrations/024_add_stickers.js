// Stickers: shared, app-wide sticker packs (imported from a Telegram
// sticker-pack link) that any user can send from a Telegram-style sticker
// panel in the composer. Packs/items are not per-user private data — they
// behave like a small shared media library, similar to avatars.
module.exports = {
  name: '024_add_stickers',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sticker_packs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,   -- Telegram set short_name
        title       TEXT NOT NULL,
        added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sticker_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id     INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
        file_name   TEXT NOT NULL,   -- stored filename on disk (uploads/stickers/<packId>/<file_name>)
        mime_type   TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'image', -- 'image' | 'video' | 'animated'
        emoji       TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id, sort_order);

      ALTER TABLE messages ADD COLUMN sticker_id INTEGER REFERENCES sticker_items(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_sticker ON messages(sticker_id);
    `);
  }
};
