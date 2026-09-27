const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requirePermission, getUserRoleKeys, getUserPermissionKeys } = require('../helpers/permissions');

const router = express.Router();
router.use(authRequired);

// GET /api/roles/me — current user's roles & permissions
router.get('/me', (req, res) => {
  res.json({
    roles: getUserRoleKeys(req.userId),
    permissions: getUserPermissionKeys(req.userId)
  });
});

// GET /api/roles — list all roles
router.get('/', requirePermission('roles.manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM roles ORDER BY id').all());
});

// GET /api/roles/permissions — list all permissions
router.get('/permissions', requirePermission('roles.manage'), (req, res) => {
  res.json(db.prepare('SELECT * FROM permissions ORDER BY id').all());
});

module.exports = router;
