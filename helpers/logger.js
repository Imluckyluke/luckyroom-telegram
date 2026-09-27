const db = require('../db');
const config = require('../config');

const LEVELS = ['error', 'warn', 'info', 'debug'];

function write(level, action, message = null, opts = {}) {
  const { userId = null, meta = null, ip = null } = opts;

  try {
    db.prepare(
      `INSERT INTO logs (level, action, message, user_id, meta, ip)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(level, action, message, userId, meta ? JSON.stringify(meta) : null, ip);
  } catch (err) {
    // Logging should never crash the app
    console.error('[logger] failed to persist log entry:', err.message);
  }

  if (config.log.toConsole && LEVELS.indexOf(level) <= LEVELS.indexOf(config.log.level)) {
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[${level.toUpperCase()}] ${action}${message ? ' - ' + message : ''}`);
  }
}

module.exports = {
  error: (action, message, opts) => write('error', action, message, opts),
  warn: (action, message, opts) => write('warn', action, message, opts),
  info: (action, message, opts) => write('info', action, message, opts),
  debug: (action, message, opts) => write('debug', action, message, opts)
};
