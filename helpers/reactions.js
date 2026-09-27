const db = require('../db');

// Reactions for a single message, grouped by emoji with the ids of
// everyone who used it (so each client can work out "mine" for itself).
function getMessageReactions(messageId) {
  const rows = db
    .prepare('SELECT emoji, user_id FROM message_reactions WHERE message_id = ?')
    .all(messageId);

  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  return [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

// Bulk variant used when hydrating a page of message history — one
// query instead of one per message. Returns Map<messageId, reactions[]>.
function getReactionsForMessages(messageIds) {
  const ids = [...new Set(messageIds)];
  const result = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${placeholders})`)
    .all(...ids);

  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.message_id)) grouped.set(r.message_id, new Map());
    const byEmoji = grouped.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  for (const [messageId, byEmoji] of grouped) {
    result.set(
      messageId,
      [...byEmoji.entries()].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
    );
  }
  return result;
}

// A user may only have one reaction per message — pressing the same
// emoji again removes it, pressing a different one replaces it.
// Returns the new reaction list for the message.
function toggleReaction(messageId, userId, emoji) {
  const existing = db
    .prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?')
    .get(messageId, userId);

  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  } else {
    db.prepare(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = datetime('now')`
    ).run(messageId, userId, emoji);
  }

  return getMessageReactions(messageId);
}

module.exports = { getMessageReactions, getReactionsForMessages, toggleReaction };
