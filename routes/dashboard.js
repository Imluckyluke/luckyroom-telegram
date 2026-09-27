const express = require('express');
const { authRequired } = require('../middleware/auth');
const { requireAnyRole } = require('../helpers/permissions');
const { buildSnapshot } = require('../helpers/dashboardStats');
const emitter = require('../sockets/emitter');
const asyncHandler = require('../helpers/asyncHandler');

const router = express.Router();
router.use(authRequired, requireAnyRole(['admin', 'super_admin']));

// GET /api/dashboard/stats — one-time snapshot (the live view uses the
// /dashboard Socket.IO namespace for real-time updates after this).
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const snapshot = await buildSnapshot(emitter.getIO());
    res.json(snapshot);
  })
);

module.exports = router;
