const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const bus = require('../events/bus');
const { CONVERSATION_CREATED } = require('../events/types');
const { isBlockedEitherWay } = require('../helpers/social');
const emitter = require('../sockets/emitter');
const { getLastMessage, isUnread, markRead, previewText, getReadStates } = require('../helpers/chatReads');
const { getReactionsForMessages } = require('../helpers/reactions');
const presence = require('../sockets/presence');
const { escapeLike } = require('../helpers/validation');
const { findUserByPhone } = require('../helpers/phone');

const router = express.Router();
router.use(authRequired);

// Same online/last-seen shape used across profile and conversation
// payloads — hidden-status users always read as offline to everyone else.
function presencePayload(user) {
  return {
    online: user.hide_online_status ? false : presence.isOnline(user.id),
    lastSeenAt: user.last_seen_at
  };
}

// Returns { conv, isNew } so callers can tell whether this DM already
// existed (the other participant already has it in their room list) or
// was just created (they need to be told in real time).
function findOrCreateConversation(userA, userB) {
  const [u1, u2] = userA < userB ? [userA, userB] : [userB, userA];

  let conv = db
    .prepare('SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?')
    .get(u1, u2);

  if (conv) return { conv, isNew: false };

  const info = db
    .prepare('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)')
    .run(u1, u2);
  conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  return { conv, isNew: true };
}

// POST /api/conversations  { phone } or { username } or { userId }  — start or fetch a DM with a user
router.post('/', (req, res) => {
  const { phone, username, userId } = req.body || {};
  if (!phone && !username && !userId) {
    return res.status(400).json({ error: 'phone, username, or userId is required' });
  }

  let other;
  if (userId) {
    other = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!other) return res.status(404).json({ error: 'No user with this id' });
  } else if (username) {
    const clean = String(username).trim().replace(/^@/, '');
    other = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(clean);
    if (!other) return res.status(404).json({ error: 'No user with this username' });
  } else {
    other = findUserByPhone(db, phone);
    if (!other) return res.status(404).json({ error: 'No user with this phone number' });
  }

  if (other.id === req.userId) return res.status(400).json({ error: "Can't start a conversation with yourself" });
  if (isBlockedEitherWay(req.userId, other.id)) {
    return res.status(403).json({ error: "Can't message this user" });
  }

  const { conv, isNew } = findOrCreateConversation(req.userId, other.id);

  if (isNew) {
    bus.emit(CONVERSATION_CREATED, { userId: req.userId, conversationId: conv.id });
    emitter.joinUserToRoom(req.userId, { type: 'dm', id: conv.id });
    emitter.joinUserToRoom(other.id, { type: 'dm', id: conv.id });

    // Without this, the other participant only sees the new DM after a
    // refresh (their room list was already loaded before this conversation
    // existed, and nothing tells their open tab to reload it).
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    emitter.emitToUser(other.id, 'conversation:new', {
      id: conv.id,
      created_at: conv.created_at,
      other: {
        id: me.id,
        name: me.name,
        phone: me.phone,
        username: me.username ? `@${me.username}` : null,
        avatarUrl: me.avatar_path ? `/api/users/${me.id}/avatar` : null,
        ...presencePayload(me)
      }
    });
  }

  res.status(201).json({
    ...conv,
    other: {
      id: other.id,
      name: other.name,
      phone: other.phone,
      username: other.username ? `@${other.username}` : null,
      avatarUrl: other.avatar_path ? `/api/users/${other.id}/avatar` : null,
      ...presencePayload(other)
    }
  });
});

// GET /api/conversations — all DMs for the current user, with the other participant's info
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
              CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END AS other_id
       FROM conversations c
       WHERE c.user1_id = ? OR c.user2_id = ?
       ORDER BY c.created_at DESC`
    )
    .all(req.userId, req.userId, req.userId);

  const withUsers = rows.map((c) => {
    const otherRow = db.prepare('SELECT * FROM users WHERE id = ?').get(c.other_id);
    const other = otherRow && {
      id: otherRow.id,
      name: otherRow.name,
      phone: otherRow.phone,
      username: otherRow.username ? `@${otherRow.username}` : null,
      avatarUrl: otherRow.avatar_path ? `/api/users/${otherRow.id}/avatar` : null,
      ...presencePayload(otherRow)
    };
    const lastMessage = getLastMessage('dm', c.id);
    return {
      id: c.id,
      created_at: c.created_at,
      other,
      lastMessage: lastMessage
        ? {
            preview: previewText(lastMessage),
            senderId: lastMessage.sender_id,
            senderName: lastMessage.sender_name,
            createdAt: lastMessage.created_at
          }
        : null,
      unread: isUnread(req.userId, 'dm', c.id, lastMessage)
    };
  });
  res.json(withUsers);
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

function requireParticipant(req, res) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }
  if (conv.user1_id !== req.userId && conv.user2_id !== req.userId) {
    res.status(403).json({ error: 'Not a participant in this conversation' });
    return null;
  }
  return conv;
}

// POST /api/conversations/:id/read — mark this conversation's messages as read up to now
router.post('/:id/read', (req, res) => {
  if (!requireParticipant(req, res)) return;
  const convId = Number(req.params.id);
  const lastReadMessageId = markRead(req.userId, 'dm', convId);
  emitter.emit('chat:read', { target: { type: 'dm', id: convId }, userId: req.userId, lastReadMessageId });
  res.json({ ok: true });
});

// GET /api/conversations/:id/reads — last-read message id for both participants (read-receipt ticks)
router.get('/:id/reads', (req, res) => {
  if (!requireParticipant(req, res)) return;
  res.json(getReadStates('dm', Number(req.params.id)));
});

// GET /api/conversations/:id/messages?before=<messageId>&limit=50  (infinite scroll)
router.get('/:id/messages', (req, res) => {
  if (!requireParticipant(req, res)) return;

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = parseInt(req.query.before) || Number.MAX_SAFE_INTEGER;

  const messages = db
    .prepare(
      `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.conversation_id = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(req.params.id, before, limit);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages.reverse())))));
});

// GET /api/conversations/:id/messages/search?q=<text>&before=<messageId>&limit=50
router.get('/:id/messages/search', (req, res) => {
  if (!requireParticipant(req, res)) return;

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
       WHERE m.conversation_id = ? AND m.id < ? AND m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(req.params.id, before, `%${escapeLike(q)}%`, limit);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages.reverse())))));
});

// GET /api/conversations/:id/messages/pinned
router.get('/:id/messages/pinned', (req, res) => {
  if (!requireParticipant(req, res)) return;

  const messages = db
    .prepare(
      `SELECT ${MESSAGE_SELECT}
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.conversation_id = ? AND m.pinned_at IS NOT NULL
       ORDER BY m.pinned_at DESC`
    )
    .all(req.params.id);

  res.json(withReactions(withReplyPreviews(withStickers(withAttachments(messages)))));
});

module.exports = router;
