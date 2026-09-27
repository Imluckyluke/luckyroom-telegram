const db = require('../db');

function getMembership(groupId, userId) {
  return db
    .prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

function isMember(groupId, userId) {
  return !!getMembership(groupId, userId);
}

function isOwner(groupId, userId) {
  const m = getMembership(groupId, userId);
  return !!m && m.role === 'owner';
}

// Owner or admin — allowed to manage members, invites, and the room profile.
function isManager(groupId, userId) {
  const m = getMembership(groupId, userId);
  return !!m && (m.role === 'owner' || m.role === 'admin');
}

module.exports = { getMembership, isMember, isOwner, isManager };
