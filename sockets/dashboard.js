const { verifySocketToken } = require('../middleware/auth');
const { userHasAnyRole } = require('../helpers/permissions');
const { buildSnapshot } = require('../helpers/dashboardStats');
const bus = require('../events/bus');
const {
  MESSAGE_SENT,
  MESSAGE_DELETED,
  FILE_UPLOADED,
  GROUP_CREATED,
  CONVERSATION_CREATED,
  USER_REGISTERED,
  PRESENCE_CHANGED
} = require('../events/types');

const ADMIN_ROLE_KEYS = ['admin', 'super_admin'];
const TICK_MS = 3000;

function registerDashboardNamespace(io) {
  const nsp = io.of('/dashboard');

  nsp.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = verifySocketToken(token);
      if (!userHasAnyRole(payload.sub, ADMIN_ROLE_KEYS)) {
        return next(new Error('Forbidden'));
      }
      socket.userId = payload.sub;
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  async function broadcast() {
    if (nsp.sockets.size === 0) return;
    try {
      const snapshot = await buildSnapshot(io);
      nsp.emit('dashboard:stats', snapshot);
    } catch (err) {
      // Don't let a transient stats failure crash the tick loop
    }
  }

  nsp.on('connection', async (socket) => {
    try {
      socket.emit('dashboard:stats', await buildSnapshot(io));
    } catch (err) {
      socket.emit('error:dashboard', { error: 'Failed to load stats' });
    }
  });

  // Periodic tick keeps CPU/RAM/uptime and chart buckets fresh in real time.
  setInterval(broadcast, TICK_MS);

  // Immediate refresh on events that change a count shown on the dashboard.
  [
    MESSAGE_SENT,
    MESSAGE_DELETED,
    FILE_UPLOADED,
    GROUP_CREATED,
    CONVERSATION_CREATED,
    USER_REGISTERED,
    PRESENCE_CHANGED
  ].forEach((eventName) => bus.on(eventName, () => broadcast()));
}

module.exports = { registerDashboardNamespace };
