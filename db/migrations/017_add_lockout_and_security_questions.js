// Adds:
// - per-account brute-force lockout fields on users (helpers/accountLock.js)
// - user_security_questions: the 3 questions each user picked at
//   registration + hashed answers, used by the security-question based
//   forgot-password flow (helpers/securityQuestions.js, routes/auth.js)
module.exports = {
  name: '017_add_lockout_and_security_questions',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN locked_until TEXT;

      CREATE TABLE IF NOT EXISTS user_security_questions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        question_id  INTEGER NOT NULL,
        answer_hash  TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, question_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_security_questions_user ON user_security_questions(user_id);
    `);
  }
};
