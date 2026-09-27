const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requirePermission } = require('../helpers/permissions');
const { paginationParams } = require('../helpers/pagination');

const router = express.Router();
router.use(authRequired, requirePermission('logs.view'));

// GET /api/logs?page=&limit=&level=&action=
router.get('/', (req, res) => {
  const { limit, offset } = paginationParams(req.query);

  const conditions = [];
  const params = [];
  if (req.query.level) {
    conditions.push('level = ?');
    params.push(req.query.level);
  }
  if (req.query.action) {
    conditions.push('action = ?');
    params.push(req.query.action);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(`SELECT * FROM logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json(rows);
});

module.exports = router;
