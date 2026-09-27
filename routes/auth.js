const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const bus = require('../events/bus');
const {
  USER_REGISTERED,
  USER_LOGGED_IN,
  PHONE_VERIFICATION_REQUESTED,
  PHONE_VERIFIED,
  PASSWORD_RESET_REQUESTED,
  PASSWORD_RESET_COMPLETED,
  SESSION_REVOKED,
  SESSIONS_REVOKED_ALL
} = require('../events/types');
const { assignRole } = require('../helpers/permissions');
const { isSuperAdminPhone } = require('../helpers/superAdmin');
const { authRequired } = require('../middleware/auth');
const sessions = require('../helpers/sessions');
const otp = require('../helpers/otp');
const logger = require('../helpers/logger');
const emitter = require('../sockets/emitter');
const { createRateLimiter } = require('../helpers/rateLimiter');
const accountLock = require('../helpers/accountLock');
const securityQuestions = require('../helpers/securityQuestions');
const { normalizePhone, isValidPhone, findUserByPhone } = require('../helpers/phone');
const config = require('../config');

const router = express.Router();

// Tighter, per-IP limiter for the sensitive auth endpoints (on top of the
// global standard limiter mounted in server.js), to slow down credential
// stuffing / brute forcing against login, registration and password
// recovery specifically.
const authLimiter = createRateLimiter({
  name: 'auth',
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  message: 'Too many attempts, please try again later'
});

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    username: user.username ? `@${user.username}` : null,
    phoneVerified: !!user.phone_verified_at
  };
}

function serializeSession(session, currentJti) {
  return {
    id: session.id,
    deviceName: session.device_name,
    ipAddress: session.ip_address,
    createdAt: session.created_at,
    lastUsedAt: session.last_used_at,
    expiresAt: session.expires_at,
    current: session.jti === currentJti
  };
}

// GET /api/auth/security-questions/catalog — the fixed list of security
// questions the registration form lets a user choose 3 of.
router.get('/security-questions/catalog', (req, res) => {
  res.json({ questions: securityQuestions.getCatalog() });
});

// POST /api/auth/register  { name, phone, password, deviceName?, securityQuestions? }
// securityQuestions is optional here: the client now collects the account
// basics first and asks the 3 security questions in a separate step right
// after registration (see /security-questions/setup below). Kept optional
// (rather than removed) so an older client sending them inline still works.
router.post('/register', authLimiter, (req, res) => {
  const { name, phone, password, deviceName, securityQuestions: chosenQuestions } = req.body || {};

  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'name, phone and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const canonicalPhone = normalizePhone(phone);
  if (!isValidPhone(canonicalPhone)) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  let validatedQuestions = null;
  if (chosenQuestions !== undefined) {
    if (!Array.isArray(chosenQuestions) || chosenQuestions.length !== 3) {
      return res.status(400).json({ error: 'Please choose and answer exactly 3 security questions' });
    }
    const questionIds = chosenQuestions.map((q) => Number(q && q.questionId));
    const hasDuplicate = new Set(questionIds).size !== questionIds.length;
    const hasInvalidId = questionIds.some((id) => !securityQuestions.isValidQuestionId(id));
    const hasEmptyAnswer = chosenQuestions.some((q) => !q || !String(q.answer || '').trim());
    if (hasDuplicate || hasInvalidId || hasEmptyAnswer) {
      return res
        .status(400)
        .json({ error: 'Security questions must be 3 distinct questions from the list, each with an answer' });
    }
    validatedQuestions = chosenQuestions;
  }

  const existing = findUserByPhone(db, phone);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists' });
  }

  const password_hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare('INSERT INTO users (name, phone, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), canonicalPhone, password_hash);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  assignRole(user.id, 'member');
  if (isSuperAdminPhone(user.phone)) {
    assignRole(user.id, 'super_admin');
  }

  if (validatedQuestions) {
    const insertQuestion = db.prepare(
      'INSERT INTO user_security_questions (user_id, question_id, answer_hash) VALUES (?, ?, ?)'
    );
    for (const q of validatedQuestions) {
      insertQuestion.run(user.id, Number(q.questionId), securityQuestions.hashAnswer(q.answer));
    }
  }

  const { token } = sessions.issueSession(user, req, deviceName);

  bus.emit(USER_REGISTERED, { userId: user.id });
  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/security-questions/setup  { securityQuestions }  (auth required)
// Second step of registration: the freshly-registered (and now logged-in)
// user picks and answers their 3 security questions. Only allowed once —
// if the account already has questions saved, this is rejected so it can't
// be used to silently overwrite them (use the forgot-password flow's reset
// for that).
router.post('/security-questions/setup', authLimiter, authRequired, (req, res) => {
  const { securityQuestions: chosenQuestions } = req.body || {};

  if (!Array.isArray(chosenQuestions) || chosenQuestions.length !== 3) {
    return res.status(400).json({ error: 'Please choose and answer exactly 3 security questions' });
  }
  const questionIds = chosenQuestions.map((q) => Number(q && q.questionId));
  const hasDuplicate = new Set(questionIds).size !== questionIds.length;
  const hasInvalidId = questionIds.some((id) => !securityQuestions.isValidQuestionId(id));
  const hasEmptyAnswer = chosenQuestions.some((q) => !q || !String(q.answer || '').trim());
  if (hasDuplicate || hasInvalidId || hasEmptyAnswer) {
    return res
      .status(400)
      .json({ error: 'Security questions must be 3 distinct questions from the list, each with an answer' });
  }

  const already = db
    .prepare('SELECT COUNT(*) AS c FROM user_security_questions WHERE user_id = ?')
    .get(req.userId);
  if (already && already.c > 0) {
    return res.status(409).json({ error: 'Security questions are already set for this account' });
  }

  const setupTx = db.transaction(() => {
    const insertQuestion = db.prepare(
      'INSERT INTO user_security_questions (user_id, question_id, answer_hash) VALUES (?, ?, ?)'
    );
    for (const q of chosenQuestions) {
      insertQuestion.run(req.userId, Number(q.questionId), securityQuestions.hashAnswer(q.answer));
    }
  });
  setupTx();

  res.status(201).json({ ok: true });
});

// POST /api/auth/login  { phone, password, deviceName? }
router.post('/login', authLimiter, (req, res) => {
  const { phone, password, deviceName } = req.body || {};
  if (!phone || !password) {
    return res.status(400).json({ error: 'phone and password are required' });
  }

  const user = findUserByPhone(db, phone);

  // Account-level lock (independent of the IP rate limiter above): once an
  // account has racked up too many failed attempts, it's locked out for a
  // while regardless of which IP is trying, or whether this particular
  // attempt has the right password.
  if (user && accountLock.isLocked(user)) {
    return res.status(423).json({
      error: 'Too many failed attempts, this account is temporarily locked',
      retryAfterSeconds: accountLock.lockRemainingSeconds(user)
    });
  }

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    if (user) accountLock.registerFailedAttempt(user.id);
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }
  if (user.banned_at) {
    return res.status(403).json({ error: 'Your account has been banned', reason: user.ban_reason || null });
  }

  accountLock.clearFailedAttempts(user.id);
  const { token } = sessions.issueSession(user, req, deviceName);

  bus.emit(USER_LOGGED_IN, { userId: user.id });
  res.json({ token, user: publicUser(user) });
});

// POST /api/auth/logout — ends only the current device's session
router.post('/logout', authRequired, (req, res) => {
  if (!req.sessionId) return res.json({ success: true }); // pre-session-tracking token, nothing to revoke

  const revoked = sessions.revokeSessionById(req.userId, req.sessionId);
  if (revoked) {
    emitter.disconnectSession(revoked.jti, 'logout');
    bus.emit(SESSION_REVOKED, { userId: req.userId, sessionId: revoked.id });
  }
  res.json({ success: true });
});

// GET /api/auth/sessions — list this account's active sessions/devices
router.get('/sessions', authRequired, (req, res) => {
  const list = sessions.listActiveSessions(req.userId).map((s) => serializeSession(s, req.jti));
  res.json({ sessions: list });
});

// DELETE /api/auth/sessions/others — force logout every device except this one
router.delete('/sessions/others', authRequired, (req, res) => {
  const revoked = sessions.revokeAllSessions(req.userId, { exceptJti: req.jti || null });
  revoked.forEach((s) => emitter.disconnectSession(s.jti, 'force_logout'));
  bus.emit(SESSIONS_REVOKED_ALL, { userId: req.userId, count: revoked.length, keptCurrent: true });
  res.json({ success: true, revokedCount: revoked.length });
});

// DELETE /api/auth/sessions — force logout every device, including this one
router.delete('/sessions', authRequired, (req, res) => {
  const revoked = sessions.revokeAllSessions(req.userId);
  revoked.forEach((s) => emitter.disconnectSession(s.jti, 'force_logout'));
  bus.emit(SESSIONS_REVOKED_ALL, { userId: req.userId, count: revoked.length, keptCurrent: false });
  res.json({ success: true, revokedCount: revoked.length });
});

// DELETE /api/auth/sessions/:id — revoke one specific session/device
router.delete('/sessions/:id', authRequired, (req, res) => {
  const revoked = sessions.revokeSessionById(req.userId, req.params.id);
  if (!revoked) return res.status(404).json({ error: 'Session not found' });

  emitter.disconnectSession(revoked.jti, 'session_deleted');
  bus.emit(SESSION_REVOKED, { userId: req.userId, sessionId: revoked.id });
  res.json({ success: true });
});

// POST /api/auth/phone/verify/request — generates an OTP for the account's own phone number
router.post('/phone/verify/request', authLimiter, authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.phone_verified_at) {
    return res.status(400).json({ error: 'Phone number is already verified' });
  }

  const result = otp.createOtp({ userId: user.id, phone: user.phone, purpose: 'phone_verify' });
  if (result.throttled) {
    return res
      .status(429)
      .json({ error: 'Please wait before requesting another code', retryAfterSeconds: result.retryAfterSeconds });
  }

  // No SMS gateway is wired up — the code is delivered out of band (SMS
  // provider). Only the fact that a code was issued is logged; the code
  // itself is never written to logs, since logs are readable by admins.
  logger.info('otp.phone_verify_generated', `Code issued for ${user.phone}`, { userId: user.id });
  bus.emit(PHONE_VERIFICATION_REQUESTED, { userId: user.id });
  res.json({ success: true, expiresAt: result.expiresAt });
});

// POST /api/auth/phone/verify/confirm  { code }
router.post('/phone/verify/confirm', authRequired, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.phone_verified_at) {
    return res.status(400).json({ error: 'Phone number is already verified' });
  }

  const result = otp.verifyOtp({ phone: user.phone, purpose: 'phone_verify', code: String(code) });
  if (!result.ok) return res.status(400).json({ error: result.error });

  const verifiedAt = new Date().toISOString();
  db.prepare('UPDATE users SET phone_verified_at = ? WHERE id = ?').run(verifiedAt, user.id);

  bus.emit(PHONE_VERIFIED, { userId: user.id });
  res.json({ success: true, phoneVerifiedAt: verifiedAt });
});

// POST /api/auth/password/forgot  { phone } — always responds the same way,
// regardless of whether the phone number is registered, to avoid leaking
// which phone numbers have accounts.
router.post('/password/forgot', authLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const trimmedPhone = String(phone).trim();
  const user = findUserByPhone(db, trimmedPhone);

  if (user) {
    const result = otp.createOtp({ userId: user.id, phone: user.phone, purpose: 'password_reset' });
    if (!result.throttled) {
      // No SMS gateway is wired up — the code is delivered out of band.
      // Never log the code itself: logs are readable by admins.
      logger.info('otp.password_reset_generated', `Code issued for ${user.phone}`, { userId: user.id });
      bus.emit(PASSWORD_RESET_REQUESTED, { userId: user.id });
    }
  }

  res.json({
    success: true,
    message: 'If this phone number has an account, a verification code has been sent to it'
  });
});

// POST /api/auth/password/reset  { phone, code, newPassword }
router.post('/password/reset', authLimiter, (req, res) => {
  const { phone, code, newPassword } = req.body || {};
  if (!phone || !code || !newPassword) {
    return res.status(400).json({ error: 'phone, code and newPassword are required' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const trimmedPhone = String(phone).trim();
  const user = findUserByPhone(db, trimmedPhone);
  if (!user) return res.status(400).json({ error: 'Invalid phone number or code' });

  const result = otp.verifyOtp({ phone: user.phone, purpose: 'password_reset', code: String(code) });
  if (!result.ok) return res.status(400).json({ error: result.error });

  const password_hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, user.id);
  accountLock.clearFailedAttempts(user.id);

  // A password reset means the old password may have been compromised —
  // sign every device (including whichever one is mid-reset) out.
  const revoked = sessions.revokeAllSessions(user.id);
  revoked.forEach((s) => emitter.disconnectSession(s.jti, 'password_reset'));

  bus.emit(PASSWORD_RESET_COMPLETED, { userId: user.id });
  res.json({ success: true, message: 'Password has been reset, please log in again' });
});

// POST /api/auth/password/security-questions  { phone }
// Step 1 of the security-question based recovery flow: returns the 3
// questions this account picked at registration, so the client can render
// them and let the user answer one. Unlike /password/forgot this cannot
// stay fully silent about whether the phone is registered, since the
// actual question text has to be shown to be answered.
router.post('/password/security-questions', authLimiter, (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const trimmedPhone = String(phone).trim();
  const user = findUserByPhone(db, trimmedPhone);
  if (!user) return res.status(404).json({ error: 'No account found for this phone number' });

  if (user && accountLock.isLocked(user)) {
    return res.status(423).json({
      error: 'Too many failed attempts, this account is temporarily locked',
      retryAfterSeconds: accountLock.lockRemainingSeconds(user)
    });
  }

  const rows = db
    .prepare('SELECT question_id FROM user_security_questions WHERE user_id = ? ORDER BY id')
    .all(user.id);
  if (!rows.length) {
    return res.status(404).json({ error: 'No security questions are set for this account' });
  }

  const questions = rows.map((r) => ({ id: r.question_id, text: securityQuestions.questionText(r.question_id) }));
  res.json({ questions });
});

// POST /api/auth/password/reset-with-answer  { phone, questionId, answer, newPassword }
// Step 2: answering correctly to just ONE of the account's 3 chosen
// questions is enough to set a new password.
router.post('/password/reset-with-answer', authLimiter, (req, res) => {
  const { phone, questionId, answer, newPassword } = req.body || {};
  if (!phone || !questionId || !answer || !newPassword) {
    return res.status(400).json({ error: 'phone, questionId, answer and newPassword are required' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const trimmedPhone = String(phone).trim();
  const user = findUserByPhone(db, trimmedPhone);
  if (!user) return res.status(400).json({ error: 'Invalid phone number or answer' });

  if (accountLock.isLocked(user)) {
    return res.status(423).json({
      error: 'Too many failed attempts, this account is temporarily locked',
      retryAfterSeconds: accountLock.lockRemainingSeconds(user)
    });
  }

  const row = db
    .prepare('SELECT * FROM user_security_questions WHERE user_id = ? AND question_id = ?')
    .get(user.id, Number(questionId));
  if (!row || !securityQuestions.verifyAnswer(answer, row.answer_hash)) {
    accountLock.registerFailedAttempt(user.id);
    return res.status(400).json({ error: 'Invalid phone number or answer' });
  }

  const password_hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, user.id);
  accountLock.clearFailedAttempts(user.id);

  // Same as an OTP-based reset: the old password may be compromised, so
  // sign every device out.
  const revoked = sessions.revokeAllSessions(user.id);
  revoked.forEach((s) => emitter.disconnectSession(s.jti, 'password_reset'));

  bus.emit(PASSWORD_RESET_COMPLETED, { userId: user.id });
  res.json({ success: true, message: 'Password has been reset, please log in again' });
});

module.exports = router;
