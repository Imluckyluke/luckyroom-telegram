const db = require('../db');
const presence = require('../sockets/presence');
const { ramStats, cpuUsagePercent, serverStatus } = require('./systemStats');
const { nowJalali } = require('./jalali');

const ADMIN_ROLE_KEYS = ['admin', 'super_admin'];
const HOURS_WINDOW = 24;

function counts() {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const onlineUsers = presence.onlineCount();
  const offlineUsers = Math.max(totalUsers - onlineUsers, 0);

  const totalMessages = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NULL').get().c;
  const totalRooms = db.prepare('SELECT COUNT(*) AS c FROM groups').get().c;

  const totalAdmins = db
    .prepare(
      `SELECT COUNT(DISTINCT ur.user_id) AS c
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE r.key IN (${ADMIN_ROLE_KEYS.map(() => '?').join(',')})`
    )
    .get(...ADMIN_ROLE_KEYS).c;

  const totalVoiceMessages = db
    .prepare("SELECT COUNT(*) AS c FROM uploads WHERE mime_type LIKE 'audio/%'")
    .get().c;
  const totalFiles = db
    .prepare("SELECT COUNT(*) AS c FROM uploads WHERE mime_type IS NULL OR mime_type NOT LIKE 'audio/%'")
    .get().c;

  return {
    totalUsers,
    onlineUsers,
    offlineUsers,
    totalMessages,
    totalRooms,
    totalAdmins,
    totalFiles,
    totalVoiceMessages
  };
}

// Builds an hourly bucket array covering the last HOURS_WINDOW hours, oldest first.
function hourBuckets() {
  const buckets = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  for (let i = HOURS_WINDOW - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    buckets.push({
      hourStart: d,
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      key: d.toISOString().slice(0, 13) // "YYYY-MM-DDTHH"
    });
  }
  return buckets;
}

function messagesChart() {
  const buckets = hourBuckets();
  const since = buckets[0].hourStart.toISOString();

  const rows = db
    .prepare("SELECT created_at FROM messages WHERE created_at >= datetime(?, '-1 hour')")
    .all(since);

  const countByKey = new Map(buckets.map((b) => [b.key, 0]));
  for (const row of rows) {
    const key = new Date(row.created_at.replace(' ', 'T') + 'Z').toISOString().slice(0, 13);
    if (countByKey.has(key)) countByKey.set(key, countByKey.get(key) + 1);
  }

  return {
    labels: buckets.map((b) => b.label),
    values: buckets.map((b) => countByKey.get(b.key) || 0)
  };
}

// "User activity" proxy: number of distinct message senders per hour.
function userActivityChart() {
  const buckets = hourBuckets();
  const since = buckets[0].hourStart.toISOString();

  const rows = db
    .prepare("SELECT created_at, sender_id FROM messages WHERE created_at >= datetime(?, '-1 hour')")
    .all(since);

  const sendersByKey = new Map(buckets.map((b) => [b.key, new Set()]));
  for (const row of rows) {
    const key = new Date(row.created_at.replace(' ', 'T') + 'Z').toISOString().slice(0, 13);
    if (sendersByKey.has(key)) sendersByKey.get(key).add(row.sender_id);
  }

  return {
    labels: buckets.map((b) => b.label),
    values: buckets.map((b) => sendersByKey.get(b.key).size)
  };
}

function databaseStatus() {
  try {
    db.prepare('SELECT 1').get();
    return { ok: true, message: 'متصل' };
  } catch (err) {
    return { ok: false, message: 'قطع' };
  }
}

function websocketStatus(io) {
  let connections = 0;
  try {
    connections = io.sockets.sockets.size;
  } catch (err) {
    connections = 0;
  }
  return { ok: true, connections };
}

// Full snapshot for the dashboard. `io` is optional (needed only for the
// websocket connection count); pass it when available.
async function buildSnapshot(io) {
  const cpuPercent = await cpuUsagePercent();
  return {
    counts: counts(),
    system: {
      ram: ramStats(),
      cpuPercent,
      server: serverStatus()
    },
    status: {
      server: { ok: true },
      database: databaseStatus(),
      websocket: websocketStatus(io)
    },
    charts: {
      messages: messagesChart(),
      userActivity: userActivityChart()
    },
    date: nowJalali(),
    generatedAt: new Date().toISOString()
  };
}

module.exports = { buildSnapshot, counts };
