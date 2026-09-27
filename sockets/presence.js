// Tracks how many active sockets each user currently has open.
// A user counts as "online" as long as at least one socket is connected
// (they may have the app open in multiple tabs/devices).
const connectionsByUser = new Map();

function markOnline(userId) {
  const count = connectionsByUser.get(userId) || 0;
  connectionsByUser.set(userId, count + 1);
  return count === 0; // true the moment the user goes from offline -> online
}

function markOffline(userId) {
  const count = connectionsByUser.get(userId) || 0;
  if (count <= 1) {
    connectionsByUser.delete(userId);
    return true; // true the moment the user goes from online -> offline
  }
  connectionsByUser.set(userId, count - 1);
  return false;
}

function isOnline(userId) {
  return connectionsByUser.has(userId);
}

function onlineCount() {
  return connectionsByUser.size;
}

module.exports = { markOnline, markOffline, isOnline, onlineCount };
