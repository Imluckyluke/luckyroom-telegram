// Shared input guards: everything with a free-text field gets a server-side
// cap so one huge payload can't bloat the DB or stall the event loop.
const LIMITS = {
  messageContent: 4000,
  groupName: 100,
  groupBio: 500,
  userName: 100,
  userBio: 500,
  broadcastTitle: 200,
  broadcastBody: 2000,
  username: 32
};

// Escape LIKE wildcards so search boxes can't inject % / _ patterns.
function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function tooLong(value, max) {
  return String(value || '').length > max;
}

module.exports = { LIMITS, escapeLike, tooLong };
