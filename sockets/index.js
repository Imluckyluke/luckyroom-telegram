const db = require('../db');
const crypto = require('crypto');
const { verifySocketToken } = require('../middleware/auth');
const bus = require('../events/bus');
const {
  MESSAGE_SENT,
  MESSAGE_EDITED,
  MESSAGE_DELETED,
  MESSAGE_PINNED,
  MESSAGE_UNPINNED,
  MESSAGE_REACTED,
  PRESENCE_CHANGED
} = require('../events/types');
const presence = require('./presence');
const emitter = require('./emitter');
const sessionRegistry = require('./sessionRegistry');
const { isBanned, isMuted } = require('../helpers/moderation');
const { isBlockedEitherWay } = require('../helpers/social');
const { isManager } = require('../helpers/roomRoles');
const { findActiveSessionByJti, touchSession } = require('../helpers/sessions');
const { getMessageReactions, toggleReaction } = require('../helpers/reactions');
const { LIMITS } = require('../helpers/validation');

function isGroupMember(groupId, userId) {
  return !!db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

function isConversationParticipant(convId, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  return conv && (conv.user1_id === userId || conv.user2_id === userId);
}

// Returns the id of the other participant in a DM conversation.
function otherParticipant(convId, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv) return null;
  return conv.user1_id === userId ? conv.user2_id : conv.user1_id;
}

function room(target) {
  return target.type === 'group' ? `group:${target.id}` : `dm:${target.id}`;
}

// Loads a message row and confirms it actually belongs to the given target,
// so a group id / dm id can't be used to reach a message from elsewhere.
function getMessageForTarget(messageId, target) {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!message) return null;
  if (target.type === 'group' && message.group_id === Number(target.id)) return message;
  if (target.type === 'dm' && message.conversation_id === Number(target.id)) return message;
  return null;
}

function isMemberOfTarget(target, userId) {
  return target.type === 'group'
    ? isGroupMember(target.id, userId)
    : isConversationParticipant(target.id, userId);
}

// Returns an error message if this group's send locks block `userId` from
// sending this kind of content, or null if they're allowed. Owners/admins
// always bypass locks — the locks are for regular members only.
function lockErrorForGroup(groupId, userId, messageType) {
  if (isManager(groupId, userId)) return null;
  const group = db
    .prepare('SELECT lock_messages, lock_files, lock_images, lock_voice, lock_video FROM groups WHERE id = ?')
    .get(groupId);
  if (!group) return null;
  if (messageType === 'text' && group.lock_messages) return 'Only room admins can send messages in this room';
  if (messageType === 'file' && group.lock_files) return 'Only room admins can send files in this room';
  if (messageType === 'image' && group.lock_images) return 'Only room admins can send images in this room';
  if (messageType === 'voice' && group.lock_voice) return 'Only room admins can send voice messages in this room';
  if (messageType === 'video' && group.lock_video) return 'Only room admins can send videos in this room';
  return null;
}

function serializeMessage(messageId) {
  const message = db
    .prepare(
      `SELECT m.id, m.content, m.message_type, m.upload_id, m.sticker_id, m.created_at, m.edited_at, m.deleted_at,
              m.pinned_at, m.pinned_by, pinner.name AS pinned_by_name, m.reply_to_id, m.forwarded_from_name,
              u.id AS sender_id, u.name AS sender_name, u.avatar_path AS sender_avatar_path
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       LEFT JOIN users pinner ON pinner.id = m.pinned_by
       WHERE m.id = ?`
    )
    .get(messageId);

  if (message) {
    message.senderAvatarUrl = message.sender_avatar_path ? `/api/users/${message.sender_id}/avatar` : null;
    delete message.sender_avatar_path;
  }

  if (message && message.upload_id) {
    message.attachment = db
      .prepare(
        `SELECT id, original_name, mime_type, size, category
         FROM uploads WHERE id = ?`
      )
      .get(message.upload_id);
  }

  if (message && message.sticker_id) {
    message.sticker = db
      .prepare(
        `SELECT si.id, si.mime_type, si.kind, si.emoji, sp.id AS pack_id, sp.title AS pack_title
         FROM sticker_items si JOIN sticker_packs sp ON sp.id = si.pack_id
         WHERE si.id = ?`
      )
      .get(message.sticker_id);
  }

  if (message && message.reply_to_id) {
    message.replyTo = db
      .prepare(
        `SELECT m.id, m.content, m.message_type, m.deleted_at, u.id AS sender_id, u.name AS sender_name
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(message.reply_to_id) || null;
  } else if (message) {
    message.replyTo = null;
  }

  if (message) {
    message.reactions = getMessageReactions(message.id);
  }

  return message;
}

// Confirms an upload exists, belongs to the sender, isn't already
// attached to another message, and its category matches the message
// type being sent (a "voice" upload can't be sent as an "image", etc).
function loadOwnUnattachedUpload(uploadId, userId, expectedCategory) {
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
  if (!upload || upload.user_id !== userId) return null;
  if (upload.category !== expectedCategory) return null;
  const alreadyUsed = db.prepare('SELECT 1 FROM messages WHERE upload_id = ?').get(uploadId);
  if (alreadyUsed) return null;
  return upload;
}

function loadStickerItem(stickerId) {
  return db.prepare('SELECT * FROM sticker_items WHERE id = ?').get(stickerId);
}

// Forwarding an attachment reuses the same encrypted bytes on disk (the
// per-file key isn't tied to any user, so re-decrypting works the same
// regardless of who "owns" the row) — this just clones the uploads row
// under the forwarding user so it can be attached to a brand-new message
// without violating the one-upload-per-message constraint above.
function cloneUploadForForward(sourceUploadId, forwarderId) {
  const source = db.prepare('SELECT * FROM uploads WHERE id = ?').get(sourceUploadId);
  if (!source) return null;

  const storedName = `fwd_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  const info = db
    .prepare(
      `INSERT INTO uploads
         (user_id, original_name, stored_name, mime_type, size, path,
          category, checksum, iv, auth_tag, encrypted_key, key_iv, key_auth_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      forwarderId,
      source.original_name,
      storedName,
      source.mime_type,
      source.size,
      source.path,
      source.category,
      source.checksum,
      source.iv,
      source.auth_tag,
      source.encrypted_key,
      source.key_iv,
      source.key_auth_tag
    );

  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(info.lastInsertRowid);
}

function registerSocketHandlers(io) {
  emitter.setIO(io);

  // Authenticate every connecting socket using the same JWT issued by /api/auth
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = verifySocketToken(token);
      if (isBanned(payload.sub)) {
        return next(new Error('Banned'));
      }

      // Same rule as the HTTP middleware: tokens without a "jti" (issued
      // before session tracking existed) are let through as before; ones
      // with a jti must point to a session that hasn't been revoked.
      if (payload.jti) {
        const session = findActiveSessionByJti(payload.jti);
        if (!session) return next(new Error('Session revoked'));
        socket.jti = payload.jti;
      }

      socket.userId = payload.sub;
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = db.prepare('SELECT id, name, phone, hide_online_status FROM users WHERE id = ?').get(socket.userId);

    if (socket.jti) {
      sessionRegistry.register(socket.jti, socket.id);
      touchSession(socket.jti);
    }

    // Join every room this user belongs to (not just the one currently open)
    // so the room list can update its last-message preview/unread dot for
    // background chats in real time.
    const myGroupIds = db
      .prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(socket.userId)
      .map((r) => r.group_id);
    const myConvIds = db
      .prepare('SELECT id FROM conversations WHERE user1_id = ? OR user2_id = ?')
      .all(socket.userId, socket.userId)
      .map((r) => r.id);
    myGroupIds.forEach((id) => socket.join(room({ type: 'group', id })));
    myConvIds.forEach((id) => socket.join(room({ type: 'dm', id })));

    // Presence: broadcast that this user is online (only the first
    // connection for a user flips them from offline -> online).
    // Admins with hide_online_status set never appear online to others.
    if (presence.markOnline(socket.userId)) {
      if (!user.hide_online_status) {
        io.emit('presence:update', { userId: socket.userId, online: true });
      }
      bus.emit(PRESENCE_CHANGED, { userId: socket.userId, online: true });
    }

    socket.on('disconnect', () => {
      if (socket.jti) sessionRegistry.unregister(socket.jti, socket.id);

      // Only when their last connection closes do we mark them offline
      if (presence.markOffline(socket.userId)) {
        const lastSeenAt = new Date().toISOString();
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, socket.userId);
        if (!user.hide_online_status) {
          io.emit('presence:update', { userId: socket.userId, online: false, lastSeenAt });
        }
        bus.emit(PRESENCE_CHANGED, { userId: socket.userId, online: false });
      }
    });

    // Join a room to receive messages for a group or a DM conversation
    socket.on('join', (target) => {
      if (!target || !target.type || !target.id) return;
      if (target.type === 'group' && !isGroupMember(target.id, socket.userId)) return;
      if (target.type === 'dm' && !isConversationParticipant(target.id, socket.userId)) return;
      socket.join(room(target));
    });

    // target: { type: 'group' | 'dm', id }, content: string, attachment?: { uploadId, category }
    // attachment.category is one of 'file' | 'image' | 'voice' | 'video' — the upload
    // must already exist (POST /api/uploads/file|image|voice|video), belong to
    // the sender, and not be attached to any other message yet. content is
    // optional when an attachment is present (used as a caption).
    socket.on('message:send', ({ target, content, attachment, sticker, replyToId }) => {
      const trimmedContent = content ? String(content).trim() : '';
      if (!target || (!trimmedContent && !attachment && !sticker)) return;
      if (trimmedContent.length > LIMITS.messageContent) {
        return socket.emit('error:message', { error: `Message is too long (max ${LIMITS.messageContent} characters)` });
      }

      if (isBanned(socket.userId)) {
        return socket.emit('error:message', { error: 'Your account has been banned' });
      }
      if (isMuted(socket.userId)) {
        return socket.emit('error:message', { error: 'You are muted and cannot send messages' });
      }

      // A reply target must be a real, non-deleted message that already
      // belongs to this same group/conversation — this stops a reply id
      // from another room being attached to a message here.
      let replyTo = null;
      if (replyToId) {
        const candidate = getMessageForTarget(replyToId, target);
        if (candidate && !candidate.deleted_at) replyTo = candidate;
      }

      let upload = null;
      let stickerItem = null;
      let messageType = 'text';
      if (attachment && attachment.uploadId && attachment.category) {
        if (!['file', 'image', 'voice', 'video'].includes(attachment.category)) {
          return socket.emit('error:message', { error: 'Invalid attachment category' });
        }
        upload = loadOwnUnattachedUpload(attachment.uploadId, socket.userId, attachment.category);
        if (!upload) {
          return socket.emit('error:message', { error: 'Attachment not found or already sent' });
        }
        messageType = attachment.category;
      } else if (sticker && sticker.itemId) {
        stickerItem = loadStickerItem(sticker.itemId);
        if (!stickerItem) {
          return socket.emit('error:message', { error: 'Sticker not found' });
        }
        messageType = 'sticker';
      }

      let allowed = false;
      let insert;
      if (target.type === 'group') {
        allowed = isGroupMember(target.id, socket.userId);
        if (allowed) {
          const lockError = lockErrorForGroup(target.id, socket.userId, messageType === 'sticker' ? 'image' : messageType);
          if (lockError) return socket.emit('error:message', { error: lockError });
        }
        insert = () =>
          db
            .prepare(
              'INSERT INTO messages (sender_id, group_id, content, message_type, upload_id, sticker_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              socket.userId,
              target.id,
              trimmedContent,
              messageType,
              upload ? upload.id : null,
              stickerItem ? stickerItem.id : null,
              replyTo ? replyTo.id : null
            );
      } else if (target.type === 'dm') {
        allowed = isConversationParticipant(target.id, socket.userId);
        if (allowed) {
          const other = otherParticipant(target.id, socket.userId);
          if (other && isBlockedEitherWay(socket.userId, other)) {
            return socket.emit('error:message', { error: "Can't message this user" });
          }
        }
        insert = () =>
          db
            .prepare(
              'INSERT INTO messages (sender_id, conversation_id, content, message_type, upload_id, sticker_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              socket.userId,
              target.id,
              trimmedContent,
              messageType,
              upload ? upload.id : null,
              stickerItem ? stickerItem.id : null,
              replyTo ? replyTo.id : null
            );
      }

      if (!allowed) return socket.emit('error:message', { error: 'Not allowed to send to this target' });

      const info = insert();
      const message = serializeMessage(info.lastInsertRowid);

      io.to(room(target)).emit('message:new', { target, message });

      bus.emit(MESSAGE_SENT, { userId: user.id, target, messageId: message.id });
    });

    // sourceTarget: where the original message lives, destTarget: where to
    // send it. Re-sends the original content and, if present, the actual
    // attachment (cloned so it can be attached to this new message) rather
    // than just a text description of it.
    socket.on('message:forward', ({ sourceTarget, destTarget, messageId }) => {
      if (!sourceTarget || !destTarget || !messageId) return;

      if (isBanned(socket.userId)) {
        return socket.emit('error:message', { error: 'Your account has been banned' });
      }
      if (isMuted(socket.userId)) {
        return socket.emit('error:message', { error: 'You are muted and cannot send messages' });
      }
      if (!isMemberOfTarget(sourceTarget, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const source = getMessageForTarget(messageId, sourceTarget);
      if (!source || source.deleted_at) {
        return socket.emit('error:message', { error: 'Message not found' });
      }

      let allowed = false;
      if (destTarget.type === 'group') {
        allowed = isGroupMember(destTarget.id, socket.userId);
        if (allowed) {
          // Stickers are images for lock purposes (same rule as message:send).
          const lockType = source.message_type === 'sticker' ? 'image' : source.message_type;
          const lockError = lockErrorForGroup(destTarget.id, socket.userId, lockType);
          if (lockError) return socket.emit('error:message', { error: lockError });
        }
      } else if (destTarget.type === 'dm') {
        allowed = isConversationParticipant(destTarget.id, socket.userId);
        if (allowed) {
          const other = otherParticipant(destTarget.id, socket.userId);
          if (other && isBlockedEitherWay(socket.userId, other)) {
            return socket.emit('error:message', { error: "Can't message this user" });
          }
        }
      }
      if (!allowed) return socket.emit('error:message', { error: 'Not allowed to send to this target' });

      let clonedUpload = null;
      if (source.upload_id) {
        clonedUpload = cloneUploadForForward(source.upload_id, socket.userId);
        if (!clonedUpload) {
          return socket.emit('error:message', { error: 'Attachment not found' });
        }
      }

      const senderName = db.prepare('SELECT name FROM users WHERE id = ?').get(source.sender_id).name;

      let insert;
      if (destTarget.type === 'group') {
        insert = () =>
          db
            .prepare(
              `INSERT INTO messages (sender_id, group_id, content, message_type, upload_id, sticker_id, forwarded_from_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(socket.userId, destTarget.id, source.content, source.message_type, clonedUpload ? clonedUpload.id : null, source.sticker_id || null, senderName);
      } else {
        insert = () =>
          db
            .prepare(
              `INSERT INTO messages (sender_id, conversation_id, content, message_type, upload_id, sticker_id, forwarded_from_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(socket.userId, destTarget.id, source.content, source.message_type, clonedUpload ? clonedUpload.id : null, source.sticker_id || null, senderName);
      }

      const info = insert();
      const message = serializeMessage(info.lastInsertRowid);

      io.to(room(destTarget)).emit('message:new', { target: destTarget, message });

      bus.emit(MESSAGE_SENT, { userId: user.id, target: destTarget, messageId: message.id });
      socket.emit('message:forwarded', { messageId: message.id });
    });

    // target: { type, id }, messageId, content — only the original sender can edit
    socket.on('message:edit', ({ target, messageId, content }) => {
      if (!target || !messageId || !content || !String(content).trim()) return;
      if (String(content).trim().length > LIMITS.messageContent) {
        return socket.emit('error:message', { error: `Message is too long (max ${LIMITS.messageContent} characters)` });
      }
      if (!isMemberOfTarget(target, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const message = getMessageForTarget(messageId, target);
      if (!message || message.deleted_at) {
        return socket.emit('error:message', { error: 'Message not found' });
      }
      if (message.sender_id !== socket.userId) {
        return socket.emit('error:message', { error: 'Only the sender can edit this message' });
      }

      const editedAt = new Date().toISOString();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(
        String(content).trim(),
        editedAt,
        messageId
      );

      io.to(room(target)).emit('message:edited', { target, message: serializeMessage(messageId) });
      bus.emit(MESSAGE_EDITED, { userId: user.id, target, messageId });
    });

    // target: { type, id }, messageId — only the original sender can delete (soft delete)
    socket.on('message:delete', ({ target, messageId }) => {
      if (!target || !messageId) return;
      if (!isMemberOfTarget(target, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const message = getMessageForTarget(messageId, target);
      if (!message || message.deleted_at) {
        return socket.emit('error:message', { error: 'Message not found' });
      }
      if (message.sender_id !== socket.userId) {
        return socket.emit('error:message', { error: 'Only the sender can delete this message' });
      }

      const deletedAt = new Date().toISOString();
      db.prepare("UPDATE messages SET deleted_at = ?, content = '' WHERE id = ?").run(deletedAt, messageId);

      io.to(room(target)).emit('message:deleted', { target, messageId, deletedAt });
      bus.emit(MESSAGE_DELETED, { userId: user.id, target, messageId });
    });

    // target: { type, id }, messageId — any member/participant can pin
    socket.on('message:pin', ({ target, messageId }) => {
      if (!target || !messageId) return;
      if (!isMemberOfTarget(target, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const message = getMessageForTarget(messageId, target);
      if (!message || message.deleted_at) {
        return socket.emit('error:message', { error: 'Message not found' });
      }

      const pinnedAt = new Date().toISOString();
      db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(
        pinnedAt,
        socket.userId,
        messageId
      );

      io.to(room(target)).emit('message:pinned', { target, message: serializeMessage(messageId) });
      bus.emit(MESSAGE_PINNED, { userId: user.id, target, messageId });
    });

    // target: { type, id }, messageId — any member/participant can unpin
    socket.on('message:unpin', ({ target, messageId }) => {
      if (!target || !messageId) return;
      if (!isMemberOfTarget(target, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const message = getMessageForTarget(messageId, target);
      if (!message) {
        return socket.emit('error:message', { error: 'Message not found' });
      }

      db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(messageId);

      io.to(room(target)).emit('message:unpinned', { target, messageId });
      bus.emit(MESSAGE_UNPINNED, { userId: user.id, target, messageId });
    });

    // target: { type, id }, messageId, emoji — any member/participant can react;
    // sending the same emoji again removes it, a different one replaces it.
    const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    socket.on('message:react', ({ target, messageId, emoji }) => {
      if (!target || !messageId || !ALLOWED_REACTIONS.includes(emoji)) return;
      if (!isMemberOfTarget(target, socket.userId)) {
        return socket.emit('error:message', { error: 'Not allowed to act on this target' });
      }

      const message = getMessageForTarget(messageId, target);
      if (!message || message.deleted_at) {
        return socket.emit('error:message', { error: 'Message not found' });
      }

      const reactions = toggleReaction(messageId, socket.userId, emoji);

      io.to(room(target)).emit('message:reaction', { target, messageId, reactions });
      bus.emit(MESSAGE_REACTED, { userId: socket.userId, target, messageId, emoji });
    });

    socket.on('typing', (target) => {
      if (!target || !target.type || !target.id) return;
      // Only members may broadcast typing into a room — otherwise any
      // connected client could spam typing indicators into arbitrary chats.
      if (!isMemberOfTarget(target, socket.userId)) return;
      socket.to(room(target)).emit('typing', { target, user: { id: user.id, name: user.name } });
    });
  });
}

module.exports = { registerSocketHandlers };
