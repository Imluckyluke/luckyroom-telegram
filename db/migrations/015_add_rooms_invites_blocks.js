// Adds everything needed for: public/private rooms, room profile
// (avatar + bio), member roles (owner/admin/member), member invites
// (direct invite + shareable invite link, with accept/reject), and
// personal (per-user) block/mute of other users.
module.exports = {
  name: '015_add_rooms_invites_blocks',
  up(db) {
    db.exec(`
      -- Room (group) type + profile -------------------------------------
      ALTER TABLE groups ADD COLUMN type TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE groups ADD COLUMN bio TEXT;
      ALTER TABLE groups ADD COLUMN avatar_path TEXT;

      -- Member roles: 'owner' | 'admin' | 'member' ----------------------
      ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

      -- The creator of every existing group becomes its owner
      UPDATE group_members SET role = 'owner'
        WHERE (group_id, user_id) IN (
          SELECT id, created_by FROM groups
        );

      -- Shareable invite links --------------------------------------------
      CREATE TABLE IF NOT EXISTS group_invite_links (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        code       TEXT NOT NULL UNIQUE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invite_links_group ON group_invite_links(group_id);

      -- Direct invites (invite a specific user; they accept/reject) ------
      CREATE TABLE IF NOT EXISTS group_invites (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invited_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at  TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_unique
        ON group_invites(group_id, invited_user_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_invites_invited_user ON group_invites(invited_user_id);

      -- Personal block/mute of other users --------------------------------
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS user_mutes (
        muter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        muted_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (muter_id, muted_id)
      );
    `);
  }
};
