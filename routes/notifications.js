const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { paginationParams } = require('../helpers/pagination');

const router = express.Router();
router.use(authRequired);

// GET /api/notifications?page=&limit=
router.get('/', (req, res) => {
  const { limit, offset } = paginationParams(req.query);
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.userId, limit, offset);
  res.json(rows);
});

// GET /api/notifications/unread-count
router.get('/unread-count', (req, res) => {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(req.userId);
  res.json({ count: row.count });
});

// POST /api/notifications/:id/read
router.post('/:id/read', (req, res) => {
  const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  if (notification.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });

  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/notifications/read-all
router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

module.exports = router;
