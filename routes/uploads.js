const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { uploadMiddleware, decryptUploadToBuffer } = require('../helpers/upload');
const trackUploadProgress = require('../helpers/uploadProgress');
const { createDownloadToken, verifyDownloadToken } = require('../helpers/downloadLink');
const { getUploadLimits } = require('../helpers/settings');
const asyncHandler = require('../helpers/asyncHandler');
const bus = require('../events/bus');
const { FILE_UPLOADED } = require('../events/types');
const emitter = require('../sockets/emitter');

const router = express.Router();

const CATEGORY_BY_ROUTE = { file: 'file', image: 'image', voice: 'voice', video: 'video' };

// True if `userId` is allowed to read this upload: either they uploaded
// it themselves, or it's attached to a message in a group/DM they belong
// to (i.e. it was actually sent to them in a chat).
function canAccessUpload(record, userId) {
  if (record.user_id === userId) return true;

  const message = db.prepare('SELECT * FROM messages WHERE upload_id = ?').get(record.id);
  if (!message) return false;

  if (message.group_id) {
    return !!db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(message.group_id, userId);
  }
  if (message.conversation_id) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(message.conversation_id);
    return !!conv && (conv.user1_id === userId || conv.user2_id === userId);
  }
  return false;
}

function getUpload(id) {
  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
}

function publicUpload(record) {
  const { path, iv, auth_tag, encrypted_key, key_iv, key_auth_tag, ...safe } = record;
  return safe;
}

// Authorize either via the normal JWT (Authorization header) or via a
// short-lived signed link token (?token=...) — lets a file be opened by
// URL (e.g. pasted into a browser tab) without exposing the JWT, while
// still requiring possession of a valid, non-expired, file-specific token.
function authorizeFileAccess(req, res, next) {
  const record = getUpload(req.params.id);
  if (!record) return res.status(404).json({ error: 'Upload not found' });

  const token = req.query.token;
  if (token) {
    const verifiedId = verifyDownloadToken(token, record.id);
    if (verifiedId === record.id) {
      req.upload = record;
      return next();
    }
    return res.status(403).json({ error: 'Invalid or expired link' });
  }

  const header = req.headers.authorization || '';
  const jwtToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!jwtToken) return res.status(401).json({ error: 'Missing token' });

  return authRequired(req, res, () => {
    if (!canAccessUpload(record, req.userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.upload = record;
    next();
  });
}

// Serves the decrypted file with proper Range (206 Partial Content)
// support — required for `<audio>`/`<video>` seeking and online voice
// playback, and generally good behaviour for downloads too.
function serveUpload(record, req, res, { inline }) {
  const buffer = decryptUploadToBuffer(record);
  const mimeType = record.mime_type || 'application/octet-stream';
  const disposition = inline ? 'inline' : 'attachment';
  const filename = encodeURIComponent(record.original_name || 'file');

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${filename}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache');

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${buffer.length}`);
      return res.status(416).end();
    }
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : buffer.length - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= buffer.length) {
      res.setHeader('Content-Range', `bytes */${buffer.length}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.end(buffer.subarray(start, end + 1));
  }

  res.setHeader('Content-Length', buffer.length);
  return res.end(buffer);
}

// GET /api/uploads/limits — current effective per-category size limits
// (DB override from the super-admin panel if set, otherwise the .env
// default), so clients can show/enforce them before picking a file.
router.get('/limits', authRequired, (req, res) => {
  const limits = getUploadLimits();
  res.json({
    file: { maxSizeMb: limits.file.maxSizeMb, allowedMimeTypes: limits.file.allowedMimeTypes },
    image: { maxSizeMb: limits.image.maxSizeMb, allowedMimeTypes: limits.image.allowedMimeTypes },
    voice: { maxSizeMb: limits.voice.maxSizeMb, allowedMimeTypes: limits.voice.allowedMimeTypes },
    video: { maxSizeMb: limits.video.maxSizeMb, allowedMimeTypes: limits.video.allowedMimeTypes }
  });
});

// POST /api/uploads/file   (multipart field "file")   — send a generic file
// POST /api/uploads/image  (multipart field "image")  — send a photo
// POST /api/uploads/voice  (multipart field "voice")  — send a voice message
// POST /api/uploads/video  (multipart field "video")  — send a video
Object.entries(CATEGORY_BY_ROUTE).forEach(([route, category]) => {
  router.post(
    `/${route}`,
    authRequired,
    trackUploadProgress,
    uploadMiddleware(category),
    asyncHandler(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const info = db
        .prepare(
          `INSERT INTO uploads
             (user_id, original_name, stored_name, mime_type, size, path,
              category, checksum, iv, auth_tag, encrypted_key, key_iv, key_auth_tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.userId,
          req.file.originalname,
          req.file.filename,
          req.file.mimetype,
          req.file.size,
          req.file.path,
          category,
          req.file.checksum,
          req.file.iv,
          req.file.authTag,
          req.file.encryptedKey,
          req.file.keyIv,
          req.file.keyAuthTag
        );

      const record = getUpload(info.lastInsertRowid);
      bus.emit(FILE_UPLOADED, { userId: req.userId, uploadId: record.id, category });

      const uploadId = req.headers['x-upload-id'];
      if (uploadId) {
        emitter.emitToUser(req.userId, 'upload:progress', { uploadId, percent: 100, done: true });
      }

      res.status(201).json(publicUpload(record));
    })
  );
});

// Multer errors (file too large, disallowed type) land here instead of
// crashing — surfaced as clean 400s referencing the size/type limits.
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File exceeds the maximum allowed size' });
  }
  if (err.message && err.message.startsWith('File type not allowed')) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.startsWith('File extension not allowed')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// GET /api/uploads — list current user's own uploads
router.get('/', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM uploads WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json(rows.map(publicUpload));
});

// GET /api/uploads/:id — metadata (owner, or anyone it was sent to in chat)
router.get('/:id', authRequired, (req, res) => {
  const record = getUpload(req.params.id);
  if (!record) return res.status(404).json({ error: 'Upload not found' });
  if (!canAccessUpload(record, req.userId)) return res.status(403).json({ error: 'Forbidden' });
  res.json(publicUpload(record));
});

// GET /api/uploads/:id/link — mint a secure, expiring download link that
// works without an Authorization header (e.g. to open in a new tab).
// ?inline=1 points the link at /stream instead of /download, so images,
// audio, and video open/play directly in the browser instead of the
// browser treating it as a file to save (Content-Disposition: inline vs
// attachment) — same token, just a different target route.
router.get('/:id/link', authRequired, (req, res) => {
  const record = getUpload(req.params.id);
  if (!record) return res.status(404).json({ error: 'Upload not found' });
  if (!canAccessUpload(record, req.userId)) return res.status(403).json({ error: 'Forbidden' });

  const { token, expiresAt } = createDownloadToken(record.id);
  const target = req.query.inline === '1' ? 'stream' : 'download';
  res.json({
    url: `/api/uploads/${record.id}/${target}?token=${token}`,
    expiresAt
  });
});

// GET /api/uploads/:id/download — force download (Content-Disposition: attachment)
router.get('/:id/download', authorizeFileAccess, (req, res) => {
  serveUpload(req.upload, req, res, { inline: false });
});

// GET /api/uploads/:id/stream — inline, Range-enabled (online voice playback / image preview)
router.get('/:id/stream', authorizeFileAccess, (req, res) => {
  serveUpload(req.upload, req, res, { inline: true });
});

module.exports = router;
