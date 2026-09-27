const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { avatarUploadMiddleware } = require('../helpers/upload');
const { isManager, isOwner, isMember, getMembership } = require('../helpers/roomRoles');
const { isBlockedEitherWay } = require('../helpers/social');
const { userHasPermission } = require('../helpers/permissions');
const { createNotification } = require('../helpers/notifier');
const { getLastMessage, isUnread, markRead, previewText, getReadStates } = require('../helpers/chatReads');
const { findUserByPhone } = require('../helpers/phone');
const { LIMITS, escapeLike, tooLong } = require('../helpers/validation');
const { getReactionsForMessages } = require('../helpers/reactions');
const emitter = require('../sockets/emitter');
const bus = require('../events/bus');
const {
  GROUP_CREATED,
  ROOM_DELETED,
  ROOM_UPDATED,
  ROOM_MEMBER_REMOVED,
  ROOM_MEMBER_ROLE_CHANGED,
  ROOM_INVITE_CREATED,
  ROOM_INVITE_ACCEPTED,
  ROOM_INVITE_REJECTED,
  ROOM_INVITE_LINK_CREATED,
  ROOM_JOINED_VIA_LINK
} = require('../events/types');

const router = express.Router();

function serializeGroup(group, userId) {
  const membership = userId ? getMembership(group.id, userId) : null;
  const memberCount = db
    .prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?')
    .get(group.id).c;
  const lastMessage = getLastMessage('group', group.id);
  return {
    id: group.id,
    name: group.name,
    type: group.type,
    bio: group.bio || null,
    avatarUrl: group.avatar_path ? `/api/groups/${group.id}/avatar` : null,
    createdBy: group.created_by,
    createdAt: group.created_at,
    memberCount,
    myRole: membership ? membership.role : null,
    locks: {
      messages: !!group.lock_messages,
      files: !!group.lock_files,
      images: !!group.lock_images,
      voice: !!group.lock_voice,
      video: !!group.lock_video
    },
    lastMessage: lastMessage
      ? {
          preview: previewText(lastMessage),
          senderId: lastMessage.sender_id,
          senderName: lastMessage.sender_name,
          createdAt: lastMessage.created_at
        }
      : null,
    unread: userId ? isUnread(userId, 'group', group.id, lastMessage) : false
  };
}

function findGroupOr404(id, res) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!group) {
    res.status(404).json({ error: 'Room not found' });
    return null;
  }
  return group;
}

function canManageAnyGroup(userId) {
  return userHasPermission(userId, 'groups.manage');
}

// GET /api/groups/:id/avatar — serve the room's profile picture.
// Registered before authRequired for the same reason as the user avatar
// route: <img src> can't send an Authorization header.
router.get('/:id/avatar', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!group.avatar_path) return res.status(404).json({ error: 'No avatar set' });
  res.sendFile(path.resolve(group.avatar_path));
});

router.use(authRequired);

// POST /api/groups  { name, type: 'public'|'private', memberPhones?: string[] }
router.post('/', (req, res) => {
  const { name, type = 'private', memberPhones = [] } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required' });
  if (tooLong(name.trim(), LIMITS.groupName)) {
    return res.status(400).json({ error: `Room name must be at most ${LIMITS.groupName} characters` });
  }
  if (!['public', 'private'].includes(type)) {
    return res.status(400).json({ error: "type must be 'public' or 'private'" });
  }

  const createGroup = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO groups (name, created_by, type) VALUES (?, ?, ?)')
      .run(name.trim(), req.userId, type);
    const groupId = info.lastInsertRowid;

    db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(
      groupId,
      req.userId,
      'owner'
    );

    for (const phone of memberPhones) {
      const member = findUserByPhone(db, phone);
      if (member && member.id !== req.userId) {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(
          groupId,
          member.id
        );
      }
    }
    return groupId;
  });

  const groupId = createGroup();
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  bus.emit(GROUP_CREATED, { userId: req.userId, groupId: group.id });
  res.status(201).json(serializeGroup(group, req.userId));
});

// GET /api/groups  — rooms the current user belongs to
router.get('/', (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.* FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ?
       ORDER BY g.created_at DESC`
    )
    .all(req.userId);
  res.json(groups.map((g) => serializeGroup(g, req.userId)));
});

// POST /api/groups/:id/read — mark this room's messages as read up to now
router.post('/:id/read', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isMember(group.id, req.userId)) {
    return res.status(403).json({ error: 'Not a member of this room' });
  }
  const lastReadMessageId = markRead(req.userId, 'group', group.id);
  emitter.emit('chat:read', { target: { type: 'group', id: group.id }, userId: req.userId, lastReadMessageId });
  res.json({ ok: true });
});

// GET /api/groups/:id/reads — last-read message id for every current member (read-receipt ticks)
router.get('/:id/reads', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isMember(group.id, req.userId)) {
    return res.status(403).json({ error: 'Not a member of this room' });
  }
  res.json(getReadStates('group', group.id));
});

// GET /api/groups/public?q=  — discover public rooms to join (not already a member of)
router.get('/public', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${escapeLike(q)}%`;
  const rows = q
    ? db
        .prepare(
          `SELECT * FROM groups WHERE type = 'public' AND name LIKE ? ESCAPE '\\'
           AND id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
           ORDER BY created_at DESC LIMIT 50`
        )
        .all(like, req.userId)
    : db
        .prepare(
          `SELECT * FROM groups WHERE type = 'public'
           AND id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
           ORDER BY created_at DESC LIMIT 50`
        )
        .all(req.userId);
  res.json(rows.map((g) => serializeGroup(g, req.userId)));
});

// POST /api/groups/:id/join  — only public rooms can be joined directly
router.post('/:id/join', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (group.type !== 'public') {
    return res.status(403).json({ error: 'This room is private — you need an invite' });
  }

  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, req.userId);
  emitter.joinUserToRoom(req.userId, { type: 'group', id: group.id });
  res.json(serializeGroup(group, req.userId));
});

// DELETE /api/groups/:id  — delete a room (owner, or a global room manager)
router.delete('/:id', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isOwner(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only the room owner can delete this room' });
  }

  db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
  bus.emit(ROOM_DELETED, { userId: req.userId, groupId: group.id });
  emitter.emit('room:deleted', { groupId: group.id });
  res.json({ deleted: true });
});

// PATCH /api/groups/:id  { name?, bio? }  — room profile (owner/admin)
router.patch('/:id', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can edit the room profile' });
  }

  const { name, bio } = req.body || {};
  if (name === undefined && bio === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Room name cannot be empty' });
  }
  if (name !== undefined && tooLong(name.trim(), LIMITS.groupName)) {
    return res.status(400).json({ error: `Room name must be at most ${LIMITS.groupName} characters` });
  }
  if (bio !== undefined && tooLong(bio, LIMITS.groupBio)) {
    return res.status(400).json({ error: `Room bio must be at most ${LIMITS.groupBio} characters` });
  }
  if (name !== undefined) {
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(String(name).trim(), group.id);
  }
  if (bio !== undefined) {
    db.prepare('UPDATE groups SET bio = ? WHERE id = ?').run(String(bio).trim() || null, group.id);
  }

  const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(group.id);
  const payload = serializeGroup(updated, req.userId);
  bus.emit(ROOM_UPDATED, { userId: req.userId, groupId: group.id });
  emitter.emit('room:updated', payload);
  res.json(payload);
});

// PATCH /api/groups/:id/locks { lockMessages?, lockFiles?, lockImages?, lockVoice? }
// (booleans) — owner/admin only. When a lock is on, regular members can't
// send that kind of content; owner/admin can always send everything.
router.patch('/:id/locks', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can change room locks' });
  }

  const { lockMessages, lockFiles, lockImages, lockVoice, lockVideo } = req.body || {};
  const fields = [
    ['lock_messages', lockMessages],
    ['lock_files', lockFiles],
    ['lock_images', lockImages],
    ['lock_voice', lockVoice],
    ['lock_video', lockVideo]
  ].filter(([, v]) => v !== undefined);

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  const setClause = fields.map(([col]) => `${col} = ?`).join(', ');
  const values = fields.map(([, v]) => (v ? 1 : 0));
  db.prepare(`UPDATE groups SET ${setClause} WHERE id = ?`).run(...values, group.id);

  const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(group.id);
  const payload = serializeGroup(updated, req.userId);
  bus.emit(ROOM_UPDATED, { userId: req.userId, groupId: group.id });
  emitter.emit('room:updated', payload);
  res.json(payload);
});

// POST /api/groups/:id/avatar  (multipart/form-data, field: "avatar") — room picture
router.post('/:id/avatar', (req, res, next) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can change the room picture' });
  }
  next();
}, avatarUploadMiddleware(), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  db.prepare(
    `INSERT INTO uploads (user_id, original_name, stored_name, mime_type, size, path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.userId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.file.path);

  db.prepare('UPDATE groups SET avatar_path = ? WHERE id = ?').run(req.file.path, req.params.id);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  const payload = serializeGroup(group, req.userId);
  bus.emit(ROOM_UPDATED, { userId: req.userId, groupId: group.id });
  emitter.emit('room:updated', payload);
  res.status(201).json(payload);
});

// GET /api/groups/:id/members
router.get('/:id/members', (req, res) => {
  if (!isMember(req.params.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Not a member of this room' });
  }

  const members = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.username, u.avatar_path, gm.role, gm.joined_at
       FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = ?
       ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at`
    )
    .all(req.params.id);

  res.json(
    members.map((m) => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      username: m.username ? `@${m.username}` : null,
      avatarUrl: m.avatar_path ? `/api/users/${m.id}/avatar` : null,
      role: m.role,
      joinedAt: m.joined_at
    }))
  );
});

// DELETE /api/groups/:id/members/:userId  — remove a member (owner/admin)
router.delete('/:id/members/:userId', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  const targetId = Number(req.params.userId);
  const requester = getMembership(group.id, req.userId);
  const target = getMembership(group.id, targetId);

  const manager = requester && (requester.role === 'owner' || requester.role === 'admin');
  if (!manager && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can remove members' });
  }
  if (!target) return res.status(404).json({ error: 'This user is not a member of the room' });
  if (target.role === 'owner') return res.status(403).json({ error: "Can't remove the room owner" });
  if (target.role === 'admin' && requester?.role !== 'owner' && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only the room owner can remove an admin' });
  }

  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group.id, targetId);
  bus.emit(ROOM_MEMBER_REMOVED, { userId: req.userId, groupId: group.id, targetId });
  emitter.emit('room:member_removed', { groupId: group.id, userId: targetId });
  emitter.leaveUserFromRoom(targetId, { type: 'group', id: group.id });
  emitter.emitToUser(targetId, 'room:removed', { groupId: group.id });
  res.json({ removed: true });
});

// PATCH /api/groups/:id/members/:userId  { role: 'admin'|'member' }  — promote/demote (owner only)
router.patch('/:id/members/:userId', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  const targetId = Number(req.params.userId);
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'member'" });
  }
  if (!isOwner(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only the room owner can change member roles' });
  }
  const target = getMembership(group.id, targetId);
  if (!target) return res.status(404).json({ error: 'This user is not a member of the room' });
  if (target.role === 'owner') return res.status(403).json({ error: "Can't change the owner's role" });

  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(
    role,
    group.id,
    targetId
  );
  bus.emit(ROOM_MEMBER_ROLE_CHANGED, { userId: req.userId, groupId: group.id, targetId, role });
  emitter.emit('room:member_role_changed', { groupId: group.id, userId: targetId, role });
  res.json({ userId: targetId, role });
});

// ---------------- Invites (invite a specific user; they accept/reject) ----------------

// POST /api/groups/:id/invites  { phone? , username? }
router.post('/:id/invites', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can invite users' });
  }

  const { phone, username } = req.body || {};
  if (!phone && !username) return res.status(400).json({ error: 'phone or username is required' });

  let target;
  if (username) {
    target = db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(String(username).trim().replace(/^@/, ''));
  } else {
    target = findUserByPhone(db, phone);
  }
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isMember(group.id, target.id)) return res.status(409).json({ error: 'User is already a member' });
  if (isBlockedEitherWay(req.userId, target.id)) {
    return res.status(403).json({ error: "Can't invite this user" });
  }

  const existing = db
    .prepare("SELECT * FROM group_invites WHERE group_id = ? AND invited_user_id = ? AND status = 'pending'")
    .get(group.id, target.id);
  if (existing) return res.status(409).json({ error: 'An invite is already pending for this user' });

  const info = db
    .prepare('INSERT INTO group_invites (group_id, invited_user_id, invited_by) VALUES (?, ?, ?)')
    .run(group.id, target.id, req.userId);
  const invite = db.prepare('SELECT * FROM group_invites WHERE id = ?').get(info.lastInsertRowid);

  createNotification({
    userId: target.id,
    type: 'group_invite',
    title: `دعوت به گروه ${group.name}`,
    body: null,
    data: { groupId: group.id, inviteId: invite.id }
  });
  bus.emit(ROOM_INVITE_CREATED, { userId: req.userId, groupId: group.id, invitedUserId: target.id });
  emitter.emitToUser(target.id, 'room:invite', { invite: { ...invite, groupName: group.name } });

  res.status(201).json(invite);
});

// GET /api/groups/invites  — pending invites addressed to me
router.get('/invites', (req, res) => {
  const invites = db
    .prepare(
      `SELECT gi.*, g.name AS group_name, g.type AS group_type, u.name AS invited_by_name
       FROM group_invites gi
       JOIN groups g ON g.id = gi.group_id
       JOIN users u ON u.id = gi.invited_by
       WHERE gi.invited_user_id = ? AND gi.status = 'pending'
       ORDER BY gi.created_at DESC`
    )
    .all(req.userId);
  res.json(invites);
});

// POST /api/groups/invites/:inviteId/accept
router.post('/invites/:inviteId/accept', (req, res) => {
  const invite = db.prepare('SELECT * FROM group_invites WHERE id = ?').get(req.params.inviteId);
  if (!invite || invite.invited_user_id !== req.userId) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (invite.status !== 'pending') return res.status(409).json({ error: 'Invite already responded to' });

  const acceptTx = db.transaction(() => {
    db.prepare("UPDATE group_invites SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(
      invite.id
    );
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(
      invite.group_id,
      req.userId
    );
  });
  acceptTx();

  bus.emit(ROOM_INVITE_ACCEPTED, { userId: req.userId, groupId: invite.group_id });
  emitter.joinUserToRoom(req.userId, { type: 'group', id: invite.group_id });
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(invite.group_id);
  res.json(serializeGroup(group, req.userId));
});

// POST /api/groups/invites/:inviteId/reject
router.post('/invites/:inviteId/reject', (req, res) => {
  const invite = db.prepare('SELECT * FROM group_invites WHERE id = ?').get(req.params.inviteId);
  if (!invite || invite.invited_user_id !== req.userId) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (invite.status !== 'pending') return res.status(409).json({ error: 'Invite already responded to' });

  db.prepare("UPDATE group_invites SET status = 'rejected', responded_at = datetime('now') WHERE id = ?").run(
    invite.id
  );
  bus.emit(ROOM_INVITE_REJECTED, { userId: req.userId, groupId: invite.group_id });
  res.json({ rejected: true });
});

// ---------------- Invite links (share a link; joining is immediate) ----------------

// POST /api/groups/:id/invite-link  — create/regenerate this room's invite link
router.post('/:id/invite-link', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can create an invite link' });
  }

  db.prepare(
    "UPDATE group_invite_links SET revoked_at = datetime('now') WHERE group_id = ? AND revoked_at IS NULL"
  ).run(group.id);

  const code = crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO group_invite_links (group_id, code, created_by) VALUES (?, ?, ?)').run(
    group.id,
    code,
    req.userId
  );

  bus.emit(ROOM_INVITE_LINK_CREATED, { userId: req.userId, groupId: group.id });
  res.status(201).json({ code, path: `/api/groups/join/${code}` });
});

// GET /api/groups/:id/invite-link  — current active link, if any
router.get('/:id/invite-link', (req, res) => {
  const group = findGroupOr404(req.params.id, res);
  if (!group) return;
  if (!isManager(group.id, req.userId) && !canManageAnyGroup(req.userId)) {
    return res.status(403).json({ error: 'Only room admins can view the invite link' });
  }
  const link = db
    .prepare('SELECT * FROM group_invite_links WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(group.id);
  if (!link) return res.json({ code: null });
  res.json({ code: link.code, path: `/api/groups/join/${link.code}` });
});

// GET /api/groups/invite/:code  — preview a room by its invite code
router.get('/invite/:code', (req, res) => {
  const link = db
    .prepare('SELECT * FROM group_invite_links WHERE code = ? AND revoked_at IS NULL')
    .get(req.params.code);
  if (!link) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(link.group_id);
  if (!group) return res.status(404).json({ error: 'Room no longer exists' });
  res.json(serializeGroup(group, req.userId));
});

// POST /api/groups/join/:code  — join a room via its invite link (immediate, no accept/reject)
router.post('/join/:code', (req, res) => {
  const link = db
    .prepare('SELECT * FROM group_invite_links WHERE code = ? AND revoked_at IS NULL')
    .get(req.params.code);
  if (!link) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(link.group_id);
  if (!group) return res.status(404).json({ error: 'Room no longer exists' });

  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, req.userId);
  bus.emit(ROOM_JOINED_VIA_LINK, { userId: req.userId, groupId: group.id });
  emitter.joinUserToRoom(req.userId, { type: 'group', id: group.id });
  res.json(serializeGroup(group, req.userId));
});

const MESSAGE_SELECT = `
  m.id, m.content, m.message_type, m.upload_id, m.sticker_id, m.created_at, m.edited_at, m.deleted_at,
  m.pinned_at, m.pinned_by, pinner.name AS pinned_by_name, m.reply_to_id, m.forwarded_from_name,
  u.id AS sender_id, u.name AS sender_name, u.avatar_path AS sender_avatar_path
`;

// Attaches lightweight upload metadata (name/type/size) to any message
// rows that carry a file/image/voice attachment, and resolves the
// sender's avatar path into a fetchable URL for the client.
function withAttachments(messages) {
  return messages.map((m) => {
    const { sender_avatar_path, ...rest } = m;
    const withAvatar = {
      ...rest,
      senderAvatarUrl: sender_avatar_path ? `/api/users/${m.sender_id}/avatar` : null
    };
    if (!m.upload_id) return withAvatar;
    const attachment = db
      .prepare('SELECT id, original_name, mime_type, size, category FROM uploads WHERE id = ?')
      .get(m.upload_id);
    return { ...withAvatar, attachment };
  });
}

// Attaches full sticker item data (file id/mime/kind/emoji + pack info) to
// any message rows that carry a sticker_id, mirroring what the socket layer
// attaches on live send — without this, stickers loaded from history have
// no `sticker` object and silently fail to render for both participants.
function withStickers(messages) {
  return messages.map((m) => {
    if (!m.sticker_id) return m;
    const sticker = db
      .prepare(
        `SELECT si.id, si.mime_type, si.kind, si.emoji, sp.id AS pack_id, sp.title AS pack_title
         FROM sticker_items si JOIN sticker_packs sp ON sp.id = si.pack_id
         WHERE si.id = ?`
      )
      .get(m.sticker_id);
    return { ...m, sticker };
  });
}

// Attaches a small preview of the message being replied to (sender name,
// content/type, and whether it was since deleted) so the client can render
// a Telegram-style quote block without a separate round trip per message.
function withReplyPreviews(messages) {
  const ids = [...new Set(messages.filter((m) => m.reply_to_id).map((m) => m.reply_to_id))];
  if (!ids.length) return messages.map((m) => ({ ...m, replyTo: null }));

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.message_type, m.deleted_at, u.id AS sender_id, u.name AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id IN (${placeholders})`
    )
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return messages.map((m) => ({ ...m, replyTo: m.reply_to_id ? byId.get(m.reply_to_id) || null : null }));
}

// Attaches each message's reactions, grouped by emoji, in one bulk query.
function withReactions(messages) {
  const byId = getReactionsForMessages(messages.map((m) => m.id));
  return messages.map((m) => ({ ...m, reactions: byId.get(m.id) || [] }));
}

function requireGroupMember(req, res) {
  const isMemberRow = db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!isMemberRow) {
    res.status(403).json({ error: 'Not a member of this group' });
    return false;
  }
  return true;
}

// GET /api/groups/:id/messages?before=<messageId>&limit=50  (infinite scroll)
router.get('/:id/messages', (req, res) => {
  if (!requireGroupMember(req, res)) return;

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = parseInt(req.query.before) || Number.MAX_SAFE_INTEGER;

  const messages = db
    .prepare(
      `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.group_id = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(req.params.id, before, limit);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages.reverse())))));
});

// GET /api/groups/:id/messages/search?q=<text>&before=<messageId>&limit=50
router.get('/:id/messages/search', (req, res) => {
  if (!requireGroupMember(req, res)) return;

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = parseInt(req.query.before) || Number.MAX_SAFE_INTEGER;

  const messages = db
    .prepare(
      `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.group_id = ? AND m.id < ? AND m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(req.params.id, before, `%${escapeLike(q)}%`, limit);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages.reverse())))));
});

// GET /api/groups/:id/messages/pinned
router.get('/:id/messages/pinned', (req, res) => {
  if (!requireGroupMember(req, res)) return;

  const messages = db
    .prepare(
      `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.group_id = ? AND m.pinned_at IS NOT NULL
       ORDER BY m.pinned_at DESC`
    )
    .all(req.params.id);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages)))));
});

module.exports = router;
