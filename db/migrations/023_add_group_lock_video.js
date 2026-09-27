// Adds the missing "video" send-lock alongside the existing
// messages/files/images/voice locks (022_add_group_locks.js).
module.exports = {
  name: '023_add_group_lock_video',
  up(db) {
    db.exec(`
      ALTER TABLE groups ADD COLUMN lock_video INTEGER NOT NULL DEFAULT 0;
    `);
  }
};
