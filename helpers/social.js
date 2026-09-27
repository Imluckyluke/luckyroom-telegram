const db = require('../db');

function isBlocked(blockerId, blockedId) {
  return !!db
    .prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(blockerId, blockedId);
}

// True if either user has blocked the other (used to stop messages flowing
// in either direction once one side has blocked).
function isBlockedEitherWay(userA, userB) {
  return isBlocked(userA, userB) || isBlocked(userB, userA);
}

function isMutedByUser(muterId, mutedId) {
  return !!db
    .prepare('SELECT 1 FROM user_mutes WHERE muter_id = ? AND muted_id = ?')
    .get(muterId, mutedId);
}

module.exports = { isBlocked, isBlockedEitherWay, isMutedByUser };
