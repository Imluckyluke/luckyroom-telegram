// Google (Gmail) identity: lets users sign in with a Google account.
// Google users have no phone number or password, but users.phone and
// users.password_hash are NOT NULL UNIQUE columns, so Google accounts get
// an internal placeholder phone ("google:<sub>") that can never collide
// with a real normalized number, plus an unusable random password hash
// (password login always fails for them). Their real contact is `email`.
module.exports = {
  name: '025_add_google_identity',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN google_id TEXT;
      ALTER TABLE users ADD COLUMN email TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
    `);
  }
};
