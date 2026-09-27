const express = require('express');
const path = require('path');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { avatarUploadMiddleware } = require('../helpers/upload');
const presence = require('../sockets/presence');
const emitter = require('../sockets/emitter');
const { getUserRoleKeys } = require('../helpers/permissions');
const bus = require('../events/bus');
const { USERNAME_SET, USER_BLOCKED, USER_UNBLOCKED, USER_MUTED_BY_USER, USER_UNMUTED_BY_USER } = require('../events/types');
const { isBlocked, isMutedByUser } = require('../helpers/social');
const { LIMITS, tooLong } = require('../helpers/validation');

const router = express.Router();

function findUserOr404(id, res) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user;
}

// GET /api/users/:id/avatar — serve the avatar image file.
// Intentionally registered before router.use(authRequired) below: an
// <img src="..."> or CSS background-image request can't attach an
// Authorization header, so this must stay reachable without a token
// (same as most chat apps — a profile picture isn't sensitive data).
router.get('/:id/avatar', (req, res) => {
  const user = findUserOr404(req.params.id, res);
  if (!user) return;
  if (!user.avatar_path) return res.status(404).json({ error: 'No avatar set' });
  res.sendFile(path.resolve(user.avatar_path));
});

router.use(authRequired);

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

function serializeProfile(user, viewerId) {
  const profile = {
    id: user.id,
    name: user.name,
    username: user.username ? `@${user.username}` : null,
    bio: user.bio || null,
    avatarUrl: user.avatar_path ? `/api/users/${user.id}/avatar` : null,
    createdAt: user.created_at,
    lastSeenAt: user.last_seen_at,
    online: user.hide_online_status ? false : presence.isOnline(user.id),
    roles: getUserRoleKeys(user.id)
  };
  if (viewerId && viewerId !== user.id) {
    profile.blockedByMe = isBlocked(viewerId, user.id);
    profile.mutedByMe = isMutedByUser(viewerId, user.id);
  }
  return profile;
}

// GET /api/users/me — own profile
router.get('/me', (req, res) => {
  const user = findUserOr404(req.userId, res);
  if (!user) return;
  res.json(serializeProfile(user));
});

// PATCH /api/users/me  { name?, bio? } — edit name and/or bio
router.patch('/me', (req, res) => {
  const { name, bio } = req.body || {};

  if (name === undefined && bio === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Name cannot be empty' });
  }
  if (name !== undefined && tooLong(name.trim(), LIMITS.userName)) {
    return res.status(400).json({ error: `Name must be at most ${LIMITS.userName} characters` });
  }
  if (bio !== undefined && tooLong(bio, LIMITS.userBio)) {
    return res.status(400).json({ error: `Bio must be at most ${LIMITS.userBio} characters` });
  }

  if (name !== undefined) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name).trim(), req.userId);
  }
  if (bio !== undefined) {
    const trimmedBio = String(bio).trim();
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(trimmedBio || null, req.userId);
  }

  const user = findUserOr404(req.userId, res);
  if (!user) return;

  const profile = serializeProfile(user);
  emitter.emit('profile:updated', profile); // live update for anyone viewing this profile
  res.json(profile);
});

// POST /api/users/me/avatar  (multipart/form-data, field: "avatar") — edit picture
router.post('/me/avatar', avatarUploadMiddleware(), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  db.prepare(
    `INSERT INTO uploads (user_id, original_name, stored_name, mime_type, size, path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.userId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.file.path);

  db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(req.file.path, req.userId);

  const user = findUserOr404(req.userId, res);
  if (!user) return;

  const profile = serializeProfile(user);
  emitter.emit('profile:updated', profile);
  res.status(201).json(profile);
});

// PUT /api/users/me/username  { username } — set or change your @username
router.put('/me/username', (req, res) => {
  let { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });

  username = String(username).trim().replace(/^@/, '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username must be 5-32 characters, start with a letter, and contain only letters, numbers, and underscores'
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing && existing.id !== req.userId) {
    return res.status(409).json({ error: 'This username is already taken' });
  }

  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.userId);

  const user = findUserOr404(req.userId, res);
  if (!user) return;

  const profile = serializeProfile(user);
  bus.emit(USERNAME_SET, { userId: req.userId });
  emitter.emit('profile:updated', profile);
  res.json(profile);
});

// GET /api/users/:id — view any user's profile
router.get('/:id', (req, res) => {
  const user = findUserOr404(req.params.id, res);
  if (!user) return;
  res.json(serializeProfile(user, req.userId));
});

// ---------------- Personal block/mute of other users ----------------

// POST /api/users/:id/block — block a user for yourself
router.post('/:id/block', (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ error: "Can't block yourself" });
  const target = findUserOr404(targetId, res);
  if (!target) return;

  db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.userId, targetId);
  bus.emit(USER_BLOCKED, { userId: req.userId, targetId });
  res.status(201).json({ blocked: true });
});

// DELETE /api/users/:id/block — unblock a user
router.delete('/:id/block', (req, res) => {
  const targetId = Number(req.params.id);
  db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.userId, targetId);
  bus.emit(USER_UNBLOCKED, { userId: req.userId, targetId });
  res.json({ blocked: false });
});

// POST /api/users/:id/mute — mute a user for yourself
router.post('/:id/mute', (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ error: "Can't mute yourself" });
  const target = findUserOr404(targetId, res);
  if (!target) return;

  db.prepare('INSERT OR IGNORE INTO user_mutes (muter_id, muted_id) VALUES (?, ?)').run(req.userId, targetId);
  bus.emit(USER_MUTED_BY_USER, { userId: req.userId, targetId });
  res.status(201).json({ muted: true });
});

// DELETE /api/users/:id/mute — unmute a user
router.delete('/:id/mute', (req, res) => {
  const targetId = Number(req.params.id);
  db.prepare('DELETE FROM user_mutes WHERE muter_id = ? AND muted_id = ?').run(req.userId, targetId);
  bus.emit(USER_UNMUTED_BY_USER, { userId: req.userId, targetId });
  res.json({ muted: false });
});

// GET /api/users/me/blocks — list of users you've blocked
router.get('/me/blocks', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.username, u.avatar_path FROM users u
       JOIN user_blocks b ON b.blocked_id = u.id
       WHERE b.blocker_id = ?`
    )
    .all(req.userId);
  res.json(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      username: u.username ? `@${u.username}` : null,
      avatarUrl: u.avatar_path ? `/api/users/${u.id}/avatar` : null
    }))
  );
});

// GET /api/users/me/mutes — list of users you've muted
router.get('/me/mutes', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.username, u.avatar_path FROM users u
       JOIN user_mutes m ON m.muted_id = u.id
       WHERE m.muter_id = ?`
    )
    .all(req.userId);
  res.json(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      username: u.username ? `@${u.username}` : null,
      avatarUrl: u.avatar_path ? `/api/users/${u.id}/avatar` : null
    }))
  );
});

module.exports = router;
