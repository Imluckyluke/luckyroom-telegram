// Imports a public Telegram sticker pack ("addstickers" link) using the
// Telegram Bot API and stores the actual sticker files on our own disk, so
// the chat app can serve/send them itself (no dependency on Telegram at
// send/render time).
//
// Supported sticker kinds coming back from Telegram:
//   - static (.webp)         -> stored as-is, kind: 'image'
//   - video stickers (.webm) -> stored as-is, kind: 'video'
//   - animated (.tgs, gzipped Lottie JSON) -> browsers can't render .tgs
//     natively, so instead of the animation we store Telegram's own static
//     preview thumbnail for that sticker (a .webp), kind: 'animated'. The
//     sticker is still fully usable (pickable, sendable, shows an image),
//     it just won't be a moving image.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const API_ROOT = 'https://api.telegram.org';

function requireBotToken() {
  if (!config.stickers.telegramBotToken) {
    const err = new Error('استیکر: توکن ربات تلگرام تنظیم نشده (TELEGRAM_BOT_TOKEN)');
    err.code = 'NO_BOT_TOKEN';
    throw err;
  }
  return config.stickers.telegramBotToken;
}

// Accepts a full link (https://t.me/addstickers/<name>, t.me/addemoji/<name>),
// a "tg://addstickers?set=<name>" deep link, or just the bare pack name.
function parsePackName(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let match = raw.match(/(?:t\.me\/addstickers\/|t\.me\/addemoji\/)([a-zA-Z0-9_]+)/i);
  if (match) return match[1];

  match = raw.match(/tg:\/\/addstickers\?set=([a-zA-Z0-9_]+)/i);
  if (match) return match[1];

  // Bare name (no slashes/spaces) — accept as-is.
  if (/^[a-zA-Z0-9_]+$/.test(raw)) return raw;

  return null;
}

async function callBotApi(method, params) {
  const token = requireBotToken();
  const url = `${API_ROOT}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    const desc = (data && data.description) || `Telegram API error (${res.status})`;
    const err = new Error(desc);
    err.code = 'TELEGRAM_API_ERROR';
    throw err;
  }
  return data.result;
}

async function downloadTelegramFile(fileId) {
  const token = requireBotToken();
  const fileInfo = await callBotApi('getFile', { file_id: fileId });
  if (!fileInfo || !fileInfo.file_path) {
    throw new Error('فایل استیکر روی تلگرام پیدا نشد');
  }
  const fileUrl = `${API_ROOT}/file/bot${token}/${fileInfo.file_path}`;
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`دانلود فایل استیکر ناموفق بود (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), remotePath: fileInfo.file_path };
}

function extFromRemotePath(remotePath, fallback) {
  const ext = path.extname(remotePath || '');
  return ext || fallback;
}

function randomStickerFilename(ext) {
  return `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// Fetches metadata + all sticker files for a Telegram sticker set, saving
// files under config.stickers.dir/<safe-pack-name>/. Returns
// { name, title, items: [{ fileName, mimeType, kind, emoji }] } ready to
// be inserted into sticker_packs / sticker_items.
async function importTelegramStickerPack(rawInput) {
  const name = parsePackName(rawInput);
  if (!name) {
    const err = new Error('لینک پک استیکر تلگرام معتبر نیست');
    err.code = 'INVALID_LINK';
    throw err;
  }

  const set = await callBotApi('getStickerSet', { name });
  const stickers = Array.isArray(set.stickers) ? set.stickers : [];
  if (!stickers.length) {
    const err = new Error('این پک استیکر خالیه');
    err.code = 'EMPTY_PACK';
    throw err;
  }

  const limited = stickers.slice(0, config.stickers.maxPerPack);
  const packDir = path.join(config.stickers.dir, name.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!fs.existsSync(packDir)) fs.mkdirSync(packDir, { recursive: true });

  const items = [];
  for (const sticker of limited) {
    try {
      let kind = 'image';
      let mimeType = 'image/webp';
      let fileId = sticker.file_id;
      let fallbackExt = '.webp';

      if (sticker.is_video) {
        kind = 'video';
        mimeType = 'video/webm';
        fallbackExt = '.webm';
      } else if (sticker.is_animated) {
        // .tgs isn't renderable in a plain <img>/<video> — fall back to
        // Telegram's own static preview thumbnail for this sticker.
        kind = 'animated';
        mimeType = 'image/webp';
        fallbackExt = '.webp';
        if (sticker.thumbnail && sticker.thumbnail.file_id) {
          fileId = sticker.thumbnail.file_id;
        } else if (sticker.thumb && sticker.thumb.file_id) {
          fileId = sticker.thumb.file_id;
        } else {
          // No thumbnail available at all — skip this one rather than
          // storing an unusable .tgs file.
          continue;
        }
      }

      const { buffer, remotePath } = await downloadTelegramFile(fileId);
      const ext = extFromRemotePath(remotePath, fallbackExt);
      const fileName = randomStickerFilename(ext);
      fs.writeFileSync(path.join(packDir, fileName), buffer);

      items.push({
        fileName: path.join(path.basename(packDir), fileName),
        mimeType,
        kind,
        emoji: sticker.emoji || null
      });
    } catch (e) {
      // One bad sticker in a pack shouldn't fail the whole import.
      continue;
    }
  }

  if (!items.length) {
    const err = new Error('هیچ استیکر قابل استفاده‌ای توی این پک پیدا نشد');
    err.code = 'NO_USABLE_ITEMS';
    throw err;
  }

  return {
    name,
    title: set.title || name,
    items
  };
}

module.exports = {
  parsePackName,
  importTelegramStickerPack
};
