// Adds everything needed for the new account-security features:
// usernames (@username), phone-number verification, password reset via
// OTP, and multi-device session management.
module.exports = {
  name: '012_add_security_features',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN username TEXT;
      ALTER TABLE users ADD COLUMN phone_verified_at TEXT;

      -- Only enforced for non-null usernames, so existing users without
      -- one yet don't collide with each other.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
        ON users(username) WHERE username IS NOT NULL;

      -- One row per logged-in device/browser. The JWT carries the "jti"
      -- (session id) so a session can be looked up, listed, and revoked
      -- independently of the token's own expiry.
      CREATE TABLE IF NOT EXISTS sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        jti          TEXT NOT NULL UNIQUE,
        device_name  TEXT,
        user_agent   TEXT,
        ip_address   TEXT,
        created_at   TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at   TEXT,
        revoked_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(jti);

      -- One-time codes used for both phone verification and password
      -- reset. Only a hash of the code is ever stored.
      CREATE TABLE IF NOT EXISTS otp_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        phone       TEXT NOT NULL,
        purpose     TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        expires_at  TEXT NOT NULL,
        consumed_at TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_codes(phone, purpose);
    `);
  }
};
