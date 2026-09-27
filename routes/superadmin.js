const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { requirePermission } = require('../helpers/permissions');
const { createNotification } = require('../helpers/notifier');
const { previewText } = require('../helpers/chatReads');
const { createDownloadToken } = require('../helpers/downloadLink');
const asyncHandler = require('../helpers/asyncHandler');
const { paginationParams } = require('../helpers/pagination');
const { LIMITS, escapeLike, tooLong } = require('../helpers/validation');
const emitter = require('../sockets/emitter');
const bus = require('../events/bus');
const backup = require('../helpers/backup');
const {
  BROADCAST_SENT,
  BACKUP_CREATED,
  BACKUP_DOWNLOADED,
  BACKUP_DELETED,
  BACKUP_RESTORED
} = require('../events/types');

const router = express.Router();
router.use(authRequired);

/* ---------------------------------------------------------------- *
 * Global broadcast — sends a notification to every user
 * ---------------------------------------------------------------- */

// POST /api/superadmin/broadcast  { title, body? }
router.post(
  '/broadcast',
  requirePermission('broadcast.send'),
  asyncHandler(async (req, res) => {
    const title = (req.body && req.body.title ? String(req.body.title) : '').trim();
    const body = req.body && req.body.body ? String(req.body.body).trim() : null;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (tooLong(title, LIMITS.broadcastTitle)) {
      return res.status(400).json({ error: `title must be at most ${LIMITS.broadcastTitle} characters` });
    }
    if (body && tooLong(body, LIMITS.broadcastBody)) {
      return res.status(400).json({ error: `body must be at most ${LIMITS.broadcastBody} characters` });
    }

    const users = db.prepare('SELECT id FROM users').all();
    // One transaction for the whole fan-out: either every notification row
    // lands or none does (no half-sent broadcasts on crash).
    const broadcastTx = db.transaction(() => {
      for (const u of users) {
        createNotification({ userId: u.id, type: 'broadcast', title, body });
      }
    });
    broadcastTx();

    // Real-time push for anyone currently connected; anyone offline will
    // still see it next time they load /api/notifications.
    emitter.emit('notification:broadcast', { title, body, createdAt: new Date().toISOString() });
    bus.emit(BROADCAST_SENT, { userId: req.userId, title, body, recipients: users.length });

    res.status(201).json({ ok: true, recipients: users.length });
  })
);

/* ---------------------------------------------------------------- *
 * Database backup / restore
 * ---------------------------------------------------------------- */

// POST /api/superadmin/backup — create a new backup now
router.post(
  '/backup',
  requirePermission('backup.manage'),
  asyncHandler(async (req, res) => {
    const info = await backup.createBackup(req.userId);
    bus.emit(BACKUP_CREATED, { userId: req.userId, filename: info.filename, sizeBytes: info.sizeBytes });
    res.status(201).json(info);
  })
);

// GET /api/superadmin/backup — list existing backups
router.get(
  '/backup',
  requirePermission('backup.manage'),
  asyncHandler(async (req, res) => {
    res.json(backup.listBackups());
  })
);

// GET /api/superadmin/backup/:filename/download
router.get(
  '/backup/:filename/download',
  requirePermission('backup.manage'),
  asyncHandler(async (req, res) => {
    const full = backup.safeBackupPath(req.params.filename);
    if (!full) return res.status(404).json({ error: 'Backup not found' });

    bus.emit(BACKUP_DOWNLOADED, { userId: req.userId, filename: path.basename(full) });
    res.download(full, path.basename(full));
  })
);

// DELETE /api/superadmin/backup/:filename
router.delete(
  '/backup/:filename',
  requirePermission('backup.manage'),
  asyncHandler(async (req, res) => {
    const ok = backup.deleteBackup(req.params.filename);
    if (!ok) return res.status(404).json({ error: 'Backup not found' });
    bus.emit(BACKUP_DELETED, { userId: req.userId, filename: req.params.filename });
    res.json({ ok: true });
  })
);

// Dedicated multer instance for restore uploads: plain disk storage into
// the OS temp dir, restricted to .db files, generous but bounded size.
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `restore_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
  }),
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.db') {
      return cb(new Error('File must be a .db SQLite file'));
    }
    cb(null, true);
  },
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

// POST /api/superadmin/backup/restore  (multipart, field name "backup")
// Validates and swaps the on-disk database file, then exits the process
// so the host's process manager restarts it against the restored file.
// The response is sent BEFORE exiting so the admin panel gets a clear
// "restart in progress" message instead of a dropped connection error.
router.post(
  '/backup/restore',
  requirePermission('backup.manage'),
  restoreUpload.single('backup'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: backup)' });

    let result;
    try {
      result = backup.restoreFromFile(req.file.path);
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Invalid backup file: ' + err.message });
    }
    fs.unlink(req.file.path, () => {});

    bus.emit(BACKUP_RESTORED, { userId: req.userId, preRestoreBackup: result.preRestoreBackup });

    res.json({
      ok: true,
      message: 'Restore complete. The server is restarting to load the restored database.',
      preRestoreBackup: result.preRestoreBackup
    });

    // Give the response time to flush, then exit. A process manager
    // (pm2/systemd/docker restart policy) is required to bring it back up —
    // `node server.js` alone will NOT restart itself.
    setTimeout(() => process.exit(0), 300);
  })
);

/* ---------------------------------------------------------------- *
 * Rooms browser — list every room, view its messages
 * ---------------------------------------------------------------- */

// GET /api/superadmin/rooms?search=&page=&limit=
router.get(
  '/rooms',
  requirePermission('chats.view_all'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const search = (req.query.search || '').trim();

    const where = search ? "WHERE g.name LIKE ? ESCAPE '\\'" : '';
    const params = search ? [`%${escapeLike(search)}%`] : [];

    const rooms = db
      .prepare(
        `SELECT g.id, g.name, g.type, g.created_at,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS memberCount,
                (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.id) AS messageCount
         FROM groups g
         ${where}
         ORDER BY g.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM groups g ${where}`)
      .get(...params).c;

    res.json({ rooms, total, limit, offset });
  })
);

/* ---------------------------------------------------------------- *
 * Users browser — list users, a user's chats, and a chat's messages
 * (used both for the rooms browser's message view and the
 * user -> chats -> messages drill-down)
 * ---------------------------------------------------------------- */

// GET /api/superadmin/users?search=&page=&limit=
router.get(
  '/users',
  requirePermission('chats.view_all'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const search = (req.query.search || '').trim();

    const where = search ? "WHERE name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'" : '';
    const params = search ? [`%${escapeLike(search)}%`, `%${escapeLike(search)}%`] : [];

    const users = db
      .prepare(`SELECT id, name, phone, created_at FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...params).c;

    res.json({ users, total, limit, offset });
  })
);

// GET /api/superadmin/users/:id/chats — every group + DM this user is in
router.get(
  '/users/:id/chats',
  requirePermission('chats.view_all'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.type, gm.role
         FROM groups g JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = ? ORDER BY g.id DESC`
      )
      .all(userId)
      .map((g) => ({ chatType: 'group', id: g.id, name: g.name, role: g.role }));

    const dms = db
      .prepare(
        `SELECT c.id,
                CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END AS otherUserId,
                (SELECT name FROM users WHERE id = CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END) AS otherUserName
         FROM conversations c
         WHERE c.user1_id = ? OR c.user2_id = ?
         ORDER BY c.id DESC`
      )
      .all(userId, userId, userId, userId)
      .map((c) => ({ chatType: 'dm', id: c.id, name: c.otherUserName, otherUserId: c.otherUserId }));

    res.json({ groups, dms });
  })
);

// GET /api/superadmin/chats/:type/:id/messages?before=&limit=
// :type is 'group' or 'dm' — works for both the rooms browser and the
// user -> chats drill-down, since a chat's messages don't depend on
// which path you found the chat through.
router.get(
  '/chats/:type/:id/messages',
  requirePermission('chats.view_all'),
  asyncHandler(async (req, res) => {
    const { type } = req.params;
    if (type !== 'group' && type !== 'dm') return res.status(400).json({ error: 'type must be group or dm' });

    const id = Number(req.params.id);
    const column = type === 'group' ? 'group_id' : 'conversation_id';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;

    const messages = db
      .prepare(
        `SELECT m.id, m.content, m.message_type, m.created_at, m.edited_at, m.deleted_at,
                m.sender_id, u.name AS sender_name,
                m.upload_id, up.original_name AS upload_name, up.mime_type AS upload_mime,
                up.size AS upload_size,
                m.sticker_id, si.mime_type AS sticker_mime
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         LEFT JOIN uploads up ON up.id = m.upload_id
         LEFT JOIN sticker_items si ON si.id = m.sticker_id
         WHERE m.${column} = ? AND m.id < ?
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(id, before, limit);

    res.json(
      messages.reverse().map((m) => ({ ...m, preview: previewText(m) }))
    );
  })
);

// GET /api/superadmin/uploads/:id/link — mint a short-lived signed link for
// an attachment that belongs to a message the admin is viewing (dashboard
// message browser). Unlike the regular /api/uploads/:id/link, this doesn't
// require the admin to be a member of the chat — only that the file is
// actually attached to a real message (so it can't be used to fetch
// arbitrary users' unrelated uploads) and that the admin has chats.view_all.
router.get(
  '/uploads/:id/link',
  requirePermission('chats.view_all'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const upload = db.prepare('SELECT id FROM uploads WHERE id = ?').get(id);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

    const attached = db.prepare('SELECT 1 FROM messages WHERE upload_id = ?').get(id);
    if (!attached) return res.status(403).json({ error: 'Forbidden' });

    const { token, expiresAt } = createDownloadToken(id);
    const target = req.query.inline === '1' ? 'stream' : 'download';
    res.json({ url: `/api/uploads/${id}/${target}?token=${token}`, expiresAt });
  })
);

module.exports = router;
