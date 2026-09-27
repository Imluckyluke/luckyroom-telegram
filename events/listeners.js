const bus = require('./bus');
const types = require('./types');
const logger = require('../helpers/logger');

// Generic audit-trail listener: every known domain event gets recorded
// in the logs table automatically. Feature-specific listeners (sending
// a push notification, etc.) can be added later without touching this.
function registerCoreListeners() {
  Object.values(types).forEach((eventName) => {
    bus.on(eventName, (payload = {}) => {
      logger.info(eventName, null, {
        userId: payload.userId || payload.user_id || null,
        meta: payload
      });
    });
  });
}

module.exports = { registerCoreListeners };
