const db = require('../db');

// target: { type: 'group' | 'dm', id }
function targetColumn(type) {
  return type === 'group' ? 'group_id' : 'conversation_id';
}

// Most recent message in a room, for the room-list preview. Returns null
// if the room has no messages yet.
function getLastMessage(type, id) {
  const column = targetColumn(type);
  const message = db
    .prepare(
      `SELECT m.id, m.content, m.message_type, m.deleted_at, m.created_at,
              m.sender_id, u.name AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.${column} = ?
       ORDER BY m.id DESC LIMIT 1`
    )
    .get(id);
  return message || null;
}

function getLastReadMessageId(userId, type, id) {
  const column = targetColumn(type);
  const row = db
    .prepare(`SELECT last_read_message_id FROM chat_reads WHERE user_id = ? AND ${column} = ?`)
    .get(userId, id);
  return row ? row.last_read_message_id : 0;
}

// True when the room's most recent message exists, wasn't sent by this
// user, and is newer than what they've last marked as read.
function isUnread(userId, type, id, lastMessage) {
  if (!lastMessage || lastMessage.sender_id === userId) return false;
  return lastMessage.id > getLastReadMessageId(userId, type, id);
}

// Marks everything in the room as read up to its current latest message
// (or up to an explicit messageId, if the caller already knows it).
// Returns the message id that ended up recorded as "read up to".
function markRead(userId, type, id, messageId = null) {
  const column = targetColumn(type);
  const upToId = messageId != null ? messageId : (getLastMessage(type, id) || {}).id || 0;

  const existing = db
    .prepare(`SELECT id, last_read_message_id FROM chat_reads WHERE user_id = ? AND ${column} = ?`)
    .get(userId, id);

  if (existing) {
    if (upToId > existing.last_read_message_id) {
      db.prepare(
        `UPDATE chat_reads SET last_read_message_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(upToId, existing.id);
      return upToId;
    }
    return existing.last_read_message_id;
  }
  db.prepare(
    `INSERT INTO chat_reads (user_id, ${column}, last_read_message_id) VALUES (?, ?, ?)`
  ).run(userId, id, upToId);
  return upToId;
}

// Read state (last read message id) for every current member of a room —
// group members, or both DM participants — used to work out the
// single-tick/double-tick ("seen") indicator on the sender's own messages.
function getReadStates(type, id) {
  if (type === 'group') {
    return db
      .prepare(
        `SELECT gm.user_id AS userId, COALESCE(cr.last_read_message_id, 0) AS lastReadMessageId
         FROM group_members gm
         LEFT JOIN chat_reads cr ON cr.user_id = gm.user_id AND cr.group_id = ?
         WHERE gm.group_id = ?`
      )
      .all(id, id);
  }
  const conv = db.prepare('SELECT user1_id, user2_id FROM conversations WHERE id = ?').get(id);
  if (!conv) return [];
  return [conv.user1_id, conv.user2_id].map((userId) => {
    const row = db
      .prepare('SELECT last_read_message_id FROM chat_reads WHERE user_id = ? AND conversation_id = ?')
      .get(userId, id);
    return { userId, lastReadMessageId: row ? row.last_read_message_id : 0 };
  });
}

// Short, human-readable preview text for the room list (deleted messages
// and attachments get a placeholder instead of raw content/ids).
function previewText(message) {
  if (!message) return null;
  if (message.deleted_at) return 'این پیام حذف شد';
  if (message.message_type === 'image') return '📷 عکس';
  if (message.message_type === 'voice') return '🎤 پیام صوتی';
  if (message.message_type === 'video') return '🎬 ویدیو';
  if (message.message_type === 'file') return '📎 فایل';
  if (message.message_type === 'sticker') return '🌟 استیکر';
  return message.content;
}

module.exports = { getLastMessage, getLastReadMessageId, isUnread, markRead, previewText, getReadStates };
