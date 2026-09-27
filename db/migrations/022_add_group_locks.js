// Per-room send locks, settable by the room's owner/admins: when a lock
// is on, only owner/admin members can send that kind of content — regular
// members are blocked (enforced in sockets/index.js message:send /
// message:forward).
module.exports = {
  name: '022_add_group_locks',
  up(db) {
    db.exec(`
      ALTER TABLE groups ADD COLUMN lock_messages INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE groups ADD COLUMN lock_files INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE groups ADD COLUMN lock_images INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE groups ADD COLUMN lock_voice INTEGER NOT NULL DEFAULT 0;
    `);
  }
};
