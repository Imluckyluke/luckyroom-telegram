// Tracks which live socket ids belong to a given session (JWT "jti"), so
// that revoking a session over the REST API (session delete, force
// logout of other devices, password reset) can immediately disconnect
// any open socket using it instead of waiting for the token to expire.
const socketIdsByJti = new Map();

function register(jti, socketId) {
  if (!jti) return;
  if (!socketIdsByJti.has(jti)) socketIdsByJti.set(jti, new Set());
  socketIdsByJti.get(jti).add(socketId);
}

function unregister(jti, socketId) {
  if (!jti) return;
  const set = socketIdsByJti.get(jti);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) socketIdsByJti.delete(jti);
}

function getSocketIds(jti) {
  return Array.from(socketIdsByJti.get(jti) || []);
}

module.exports = { register, unregister, getSocketIds };
