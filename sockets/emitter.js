// Lets REST routes (e.g. profile edits) broadcast real-time updates
// through the same Socket.IO server that sockets/index.js manages,
// without those routes needing a direct reference to `io`.
const sessionRegistry = require('./sessionRegistry');

let ioRef = null;

function setIO(io) {
  ioRef = io;
}

function getIO() {
  return ioRef;
}

function emit(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}

// Sends an event only to socket(s) belonging to one user (e.g. upload
// progress updates), instead of broadcasting to everyone.
function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  for (const socket of ioRef.sockets.sockets.values()) {
    if (socket.userId === userId) socket.emit(event, payload);
  }
}

// Immediately disconnects any live socket(s) tied to a revoked session,
// notifying the client first so it can show a "logged out" message.
function disconnectSession(jti, reason = 'session_revoked') {
  if (!ioRef || !jti) return;
  sessionRegistry.getSocketIds(jti).forEach((socketId) => {
    const socket = ioRef.sockets.sockets.get(socketId);
    if (!socket) return;
    socket.emit('session:revoked', { reason });
    socket.disconnect(true);
  });
}

// Joins any live socket(s) belonging to a user to a group/DM room, used
// when someone is added to a room after their socket already connected
// (so they start receiving message:new for it immediately, without
// needing to reconnect).
function joinUserToRoom(userId, target) {
  if (!ioRef || !userId || !target) return;
  const roomName = target.type === 'group' ? `group:${target.id}` : `dm:${target.id}`;
  for (const socket of ioRef.sockets.sockets.values()) {
    if (socket.userId === userId) socket.join(roomName);
  }
}

// Removes a user's live socket(s) from a room — used when they are kicked
// or the room is deleted. Without this they keep receiving message:new for
// a chat they no longer belong to until they reconnect.
function leaveUserFromRoom(userId, target) {
  if (!ioRef || !userId || !target) return;
  const roomName = target.type === 'group' ? `group:${target.id}` : `dm:${target.id}`;
  for (const socket of ioRef.sockets.sockets.values()) {
    if (socket.userId === userId) socket.leave(roomName);
  }
}

module.exports = { setIO, getIO, emit, emitToUser, disconnectSession, joinUserToRoom, leaveUserFromRoom };
