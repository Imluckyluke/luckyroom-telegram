const express = require('express');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { authRequired } = require('../middleware/auth');
const asyncHandler = require('../helpers/asyncHandler');
const { importTelegramStickerPack } = require('../helpers/stickerImport');

const router = express.Router();

function packWithItems(packId) {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId);
  if (!pack) return null;
  pack.items = db
    .prepare('SELECT id, pack_id, mime_type, kind, emoji FROM sticker_items WHERE pack_id = ? ORDER BY sort_order, id')
    .all(packId);
  return pack;
}

// GET /api/stickers/packs — every pack, each with its items (small
// per-item payload — no binary data, just ids/mime/kind/emoji — actual
// bytes are fetched lazily per sticker via /api/stickers/file/:id).
router.get('/packs', authRequired, (req, res) => {
  const packs = db.prepare('SELECT * FROM sticker_packs ORDER BY sort_order, id').all();
  res.json(packs.map((p) => packWithItems(p.id)));
});

// POST /api/stickers/packs/import  { url }  — url is a Telegram
// "https://t.me/addstickers/<name>" link (or bare pack name). Downloads
// every sticker via the Telegram Bot API and stores it locally so it can
// be sent inside the app from then on.
router.post(
  '/packs/import',
  authRequired,
  asyncHandler(async (req, res) => {
    const url = (req.body && req.body.url) || '';
    if (!url.trim()) return res.status(400).json({ error: 'لینک پک استیکر رو وارد کن' });

    let imported;
    try {
      imported = await importTelegramStickerPack(url);
    } catch (e) {
      const status = e.code === 'NO_BOT_TOKEN' ? 500 : 400;
      return res.status(status).json({ error: e.message || 'ایمپورت پک استیکر ناموفق بود' });
    }

    const existing = db.prepare('SELECT id FROM sticker_packs WHERE name = ?').get(imported.name);
    if (existing) {
      return res.status(200).json(packWithItems(existing.id));
    }

    const insertPack = db
      .prepare('INSERT INTO sticker_packs (name, title, added_by) VALUES (?, ?, ?)')
      .run(imported.name, imported.title, req.userId);
    const packId = insertPack.lastInsertRowid;

    const insertItem = db.prepare(
      'INSERT INTO sticker_items (pack_id, file_name, mime_type, kind, emoji, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    imported.items.forEach((item, index) => {
      insertItem.run(packId, item.fileName, item.mimeType, item.kind, item.emoji, index);
    });

    res.status(201).json(packWithItems(packId));
  })
);

// DELETE /api/stickers/packs/:id — only whoever imported it can remove it.
router.delete('/packs/:id', authRequired, (req, res) => {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(req.params.id);
  if (!pack) return res.status(404).json({ error: 'پک استیکر پیدا نشد' });
  if (pack.added_by !== req.userId) return res.status(403).json({ error: 'اجازه حذف این پک رو نداری' });
  db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(pack.id);
  res.json({ ok: true });
});

// GET /api/stickers/file/:id — serves the raw sticker file. Not
// authenticated, same as avatars: these are shared app assets, not
// private user data, so plain <img>/<video> tags can point straight at
// this URL.
router.get('/file/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM sticker_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'استیکر پیدا نشد' });
  const filePath = path.join(config.stickers.dir, item.file_name);
  res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.sendFile(path.resolve(filePath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'فایل استیکر پیدا نشد' });
  });
});

module.exports = router;
