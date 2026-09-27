const db = require('../db');
const bus = require('../events/bus');
const { NOTIFICATION_CREATED } = require('../events/types');

// Creates a notification row for a user. Delivery (socket push, push
// notification, email, etc.) is left to listeners of NOTIFICATION_CREATED —
// this helper only owns persistence + the event emission.
function createNotification({ userId, type, title, body = null, data = null }) {
  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, type, title, body, data ? JSON.stringify(data) : null);

  const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
  bus.emit(NOTIFICATION_CREATED, notification);
  return notification;
}

module.exports = { createNotification };
