const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const {
  requirePermission,
  getUserRoleKeys,
  assignRole,
  revokeRole,
  getUsersWithAnyRole
} = require('../helpers/permissions');
const { isMuted } = require('../helpers/moderation');
const { getUploadLimits, setUploadLimit, resetUploadLimit, CATEGORIES } = require('../helpers/settings');
const asyncHandler = require('../helpers/asyncHandler');
const { createDownloadToken } = require('../helpers/downloadLink');
const presence = require('../sockets/presence');
const emitter = require('../sockets/emitter');
const bus = require('../events/bus');
const { findUserByPhone } = require('../helpers/phone');
const {
  USER_BANNED,
  USER_UNBANNED,
  USER_MUTED,
  USER_UNMUTED,
  ADMIN_ADDED,
  ADMIN_REMOVED,
  ADMIN_ACCESS_LEVEL_CHANGED,
  ADMIN_PRESENCE_VISIBILITY_CHANGED,
  SETTINGS_UPDATED
} = require('../events/types');

const router = express.Router();
router.use(authRequired);

const ADMIN_ROLE_KEYS = ['admin', 'super_admin'];
const ACCESS_LEVELS = ['admin', 'super_admin'];

function findUserOr404(id, res) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return user;
}

function serializeModerationProfile(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    roles: getUserRoleKeys(user.id),
    banned: !!user.banned_at,
    banReason: user.ban_reason || null,
    bannedAt: user.banned_at || null,
    muted: isMuted(user.id),
    mutedUntil: user.muted_until || null
  };
}

function serializeAdmin(user) {
  const hidden = !!user.hide_online_status;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    roles: getUserRoleKeys(user.id),
    online: hidden ? false : presence.isOnline(user.id),
    hideOnlineStatus: hidden
  };
}

// Force-disconnects every active socket for a user (used on ban).
function disconnectUserSockets(userId) {
  const io = emitter.getIO();
  if (!io) return;
  for (const [, socket] of io.sockets.sockets) {
    if (String(socket.userId) === String(userId)) {
      socket.emit('force:disconnect', { reason: 'banned' });
      socket.disconnect(true);
    }
  }
}

/* ---------------------------------------------------------------- *
 * Look up a user by phone (needed to target ban/mute/view-messages actions)
 * ---------------------------------------------------------------- */

// GET /api/admin/users/lookup?phone=...
router.get(
  '/users/lookup',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const phone = (req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const user = findUserByPhone(db, phone);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json(serializeModerationProfile(user));
  })
);

/* ---------------------------------------------------------------- *
 * Ban / Unban / Mute / Unmute
 * ---------------------------------------------------------------- */

// POST /api/admin/users/:id/ban  { reason? }
router.post(
  '/users/:id/ban',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;
    if (user.id === req.userId) return res.status(400).json({ error: "You can't ban yourself" });

    const reason = req.body && req.body.reason ? String(req.body.reason).trim() || null : null;

    db.prepare('UPDATE users SET banned_at = ?, ban_reason = ?, banned_by = ? WHERE id = ?').run(
      new Date().toISOString(),
      reason,
      req.userId,
      user.id
    );

    disconnectUserSockets(user.id);
    bus.emit(USER_BANNED, { userId: req.userId, targetUserId: user.id, reason });

    res.json(serializeModerationProfile(findUserOr404(user.id, res)));
  })
);

// POST /api/admin/users/:id/unban
router.post(
  '/users/:id/unban',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;

    db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL, banned_by = NULL WHERE id = ?').run(user.id);

    bus.emit(USER_UNBANNED, { userId: req.userId, targetUserId: user.id });
    res.json(serializeModerationProfile(findUserOr404(user.id, res)));
  })
);

// POST /api/admin/users/:id/mute  { durationMinutes? } — omit for an indefinite mute
router.post(
  '/users/:id/mute',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;
    if (user.id === req.userId) return res.status(400).json({ error: "You can't mute yourself" });

    const durationMinutes = req.body ? parseInt(req.body.durationMinutes, 10) : NaN;
    const mutedUntil =
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
        : null;

    db.prepare('UPDATE users SET is_muted = 1, muted_until = ?, muted_by = ? WHERE id = ?').run(
      mutedUntil,
      req.userId,
      user.id
    );

    bus.emit(USER_MUTED, { userId: req.userId, targetUserId: user.id, mutedUntil });
    res.json(serializeModerationProfile(findUserOr404(user.id, res)));
  })
);

// POST /api/admin/users/:id/unmute
router.post(
  '/users/:id/unmute',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;

    db.prepare('UPDATE users SET is_muted = 0, muted_until = NULL, muted_by = NULL WHERE id = ?').run(user.id);

    bus.emit(USER_UNMUTED, { userId: req.userId, targetUserId: user.id });
    res.json(serializeModerationProfile(findUserOr404(user.id, res)));
  })
);

/* ---------------------------------------------------------------- *
 * View a user's messages (moderation view — across all their groups/DMs)
 * ---------------------------------------------------------------- */

// GET /api/admin/users/:id/messages?before=<messageId>&limit=50
router.get(
  '/users/:id/messages',
  requirePermission('messages.moderate'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;

    const messages = db
      .prepare(
        `SELECT m.id, m.content, m.message_type, m.created_at, m.edited_at, m.deleted_at,
                m.group_id, g.name AS group_name, m.conversation_id,
                m.upload_id, up.original_name AS upload_name, up.mime_type AS upload_mime,
                up.size AS upload_size,
                m.sticker_id, si.mime_type AS sticker_mime
         FROM messages m
         LEFT JOIN groups g ON g.id = m.group_id
         LEFT JOIN uploads up ON up.id = m.upload_id
         LEFT JOIN sticker_items si ON si.id = m.sticker_id
         WHERE m.sender_id = ? AND m.id < ?
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(user.id, before, limit);

    res.json(messages.reverse());
  })
);

/* ---------------------------------------------------------------- *
 * Admin management: add / remove / list / access level / hide presence
 * ---------------------------------------------------------------- */

// GET /api/admin/admins — list all admins & super admins
router.get(
  '/admins',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const admins = getUsersWithAnyRole(ADMIN_ROLE_KEYS);
    res.json(admins.map(serializeAdmin));
  })
);

// POST /api/admin/admins  { userId } — add admin (promote a member to 'admin')
router.post(
  '/admins',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    const user = findUserOr404(userId, res);
    if (!user) return;

    assignRole(user.id, 'admin');
    bus.emit(ADMIN_ADDED, { userId: req.userId, targetUserId: user.id });

    res.status(201).json(serializeAdmin(findUserOr404(user.id, res)));
  })
);

// DELETE /api/admin/admins/:id — remove admin (revoke admin & super_admin, back to member)
router.delete(
  '/admins/:id',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;
    if (user.id === req.userId) return res.status(400).json({ error: "You can't remove yourself as admin" });

    revokeRole(user.id, 'admin');
    revokeRole(user.id, 'super_admin');
    assignRole(user.id, 'member');

    bus.emit(ADMIN_REMOVED, { userId: req.userId, targetUserId: user.id });
    res.json(serializeAdmin(findUserOr404(user.id, res)));
  })
);

// PATCH /api/admin/admins/:id/access-level  { level: 'admin' | 'super_admin' }
router.patch(
  '/admins/:id/access-level',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;

    const { level } = req.body || {};
    if (!ACCESS_LEVELS.includes(level)) {
      return res.status(400).json({ error: `level must be one of: ${ACCESS_LEVELS.join(', ')}` });
    }
    if (!getUserRoleKeys(user.id).some((k) => ADMIN_ROLE_KEYS.includes(k))) {
      return res.status(400).json({ error: 'User is not an admin yet — add them as admin first' });
    }

    ACCESS_LEVELS.filter((k) => k !== level).forEach((k) => revokeRole(user.id, k));
    assignRole(user.id, level);

    bus.emit(ADMIN_ACCESS_LEVEL_CHANGED, { userId: req.userId, targetUserId: user.id, level });
    res.json(serializeAdmin(findUserOr404(user.id, res)));
  })
);

// PATCH /api/admin/admins/:id/hide-presence  { hidden: boolean }
router.patch(
  '/admins/:id/hide-presence',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const user = findUserOr404(req.params.id, res);
    if (!user) return;

    const hidden = !!(req.body || {}).hidden;
    db.prepare('UPDATE users SET hide_online_status = ? WHERE id = ?').run(hidden ? 1 : 0, user.id);

    bus.emit(ADMIN_PRESENCE_VISIBILITY_CHANGED, { userId: req.userId, targetUserId: user.id, hidden });
    res.json(serializeAdmin(findUserOr404(user.id, res)));
  })
);

/* ---------------------------------------------------------------- *
 * System settings — super_admin only (settings.manage permission)
 * ---------------------------------------------------------------- */

// GET /api/admin/settings/upload-limits — current per-category size limits
router.get(
  '/settings/upload-limits',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const limits = getUploadLimits();
    res.json(limits);
  })
);

// PATCH /api/admin/settings/upload-limits  { file?, image?, voice? }  — sizes in MB
// e.g. { "voice": 25 } raises just the voice-message limit to 25 MB.
router.patch(
  '/settings/upload-limits',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const requested = CATEGORIES.filter((c) => body[c] !== undefined);
    if (requested.length === 0) {
      return res.status(400).json({ error: `Provide at least one of: ${CATEGORIES.join(', ')}` });
    }

    const updated = {};
    for (const category of requested) {
      try {
        updated[category] = setUploadLimit(category, body[category], req.userId);
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }

    bus.emit(SETTINGS_UPDATED, { userId: req.userId, setting: 'upload-limits', values: updated });
    res.json(getUploadLimits());
  })
);

// DELETE /api/admin/settings/upload-limits/:category — revert a category back to the .env default
router.delete(
  '/settings/upload-limits/:category',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    try {
      resetUploadLimit(req.params.category);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    bus.emit(SETTINGS_UPDATED, { userId: req.userId, setting: 'upload-limits', reset: req.params.category });
    res.json(getUploadLimits());
  })
);

// GET /api/admin/uploads/:id/link — mint a short-lived signed link for an
// attachment shown in the moderation message viewer (dashboard "مشاهده
// پیام‌ها" panel). Only works for uploads actually attached to a message,
// same safeguard as the superadmin version.
router.get(
  '/uploads/:id/link',
  requirePermission('messages.moderate'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const upload = db.prepare('SELECT id FROM uploads WHERE id = ?').get(id);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    const attached = db.prepare('SELECT 1 FROM messages WHERE upload_id = ?').get(id);
    if (!attached) return res.status(403).json({ error: 'Forbidden' });

    const { token, expiresAt } = createDownloadToken(id);
    const target = req.query.inline === '1' ? 'stream' : 'download';
    res.json({ url: `/api/uploads/${id}/${target}?token=${token}`, expiresAt });
  })
);

module.exports = router;
