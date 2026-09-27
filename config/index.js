require('dotenv').config();
const path = require('path');

function splitList(value, fallback) {
  return (value || fallback)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Per-category limits: each kind of upload (generic file, image, voice
// note) gets its own allowed mime types and max size, enforced server-side
// regardless of what the client claims.
const upload = {
  dir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(__dirname, '..', 'uploads'),

  // Master key for encrypting files at rest (envelope encryption: each
  // file gets its own random key, which is itself encrypted with this
  // master key). Must be a 32-byte value, hex or base64 encoded.
  encryptionKey: process.env.UPLOAD_ENCRYPTION_KEY || null,

  // Secure, time-limited download links.
  linkSecret: process.env.UPLOAD_LINK_SECRET || process.env.JWT_SECRET,
  linkTtlMinutes: parseInt(process.env.UPLOAD_LINK_TTL_MINUTES, 10) || 15,

  categories: {
    file: {
      fieldName: 'file',
      maxSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 20,
      allowedMimeTypes: splitList(
        process.env.FILE_ALLOWED_TYPES,
        'application/pdf,application/zip,application/msword,' +
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
          'application/vnd.ms-excel,' +
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
          'text/plain,text/csv'
      )
    },
    image: {
      fieldName: 'image',
      maxSizeMb: parseInt(process.env.MAX_IMAGE_SIZE_MB, 10) || 10,
      allowedMimeTypes: splitList(
        process.env.IMAGE_ALLOWED_TYPES,
        'image/png,image/jpeg,image/jpg,image/gif,image/webp'
      )
    },
    voice: {
      fieldName: 'voice',
      maxSizeMb: parseInt(process.env.MAX_VOICE_SIZE_MB, 10) || 15,
      allowedMimeTypes: splitList(
        process.env.VOICE_ALLOWED_TYPES,
        'audio/ogg,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/webm,audio/aac'
      )
    },
    video: {
      fieldName: 'video',
      maxSizeMb: parseInt(process.env.MAX_VIDEO_SIZE_MB, 10) || 100,
      allowedMimeTypes: splitList(
        process.env.VIDEO_ALLOWED_TYPES,
        'video/mp4,video/webm,video/ogg,video/quicktime,video/x-matroska,video/3gpp'
      )
    }
  }
};

// Telegram sticker-pack import (helpers/stickerImport.js). Needs a bot
// token from @BotFather — only used server-side to call the Bot API
// (getStickerSet / getFile) and to download the actual sticker files.
const stickers = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  dir: process.env.STICKERS_DIR
    ? path.resolve(process.env.STICKERS_DIR)
    : path.join(upload.dir, 'stickers'),
  maxPerPack: parseInt(process.env.MAX_STICKERS_PER_PACK, 10) || 200
};

module.exports = {
  port: parseInt(process.env.PORT, 10) || 4000,
  corsOrigin: process.env.CORS_ORIGIN || '*',

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  db: {
    path: process.env.DB_PATH || './data/chat.db'
  },

  upload,

  stickers,

  pagination: {
    defaultLimit: parseInt(process.env.DEFAULT_PAGE_SIZE, 10) || 20,
    maxLimit: parseInt(process.env.MAX_PAGE_SIZE, 10) || 100
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
    toConsole: (process.env.LOG_TO_CONSOLE || 'true') === 'true'
  },

  otp: {
    ttlMinutes: parseInt(process.env.OTP_TTL_MINUTES, 10) || 5,
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5,
    resendSeconds: parseInt(process.env.OTP_RESEND_SECONDS, 10) || 60
  },

  // Standard, IP-based request throttling (helpers/rateLimiter.js).
  rateLimit: {
    // General API traffic: generous, just there to stop abusive scraping/flooding.
    standard: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300
    },
    // Sensitive auth endpoints (login/register/password recovery): tighter,
    // per IP, to slow down credential stuffing / brute forcing.
    auth: {
      windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20
    }
  },

  // Per-account lockout, independent of IP, so a distributed brute force
  // (many IPs, one target account) still gets stopped.
  accountLock: {
    maxFailedAttempts: parseInt(process.env.ACCOUNT_LOCK_MAX_ATTEMPTS, 10) || 5,
    lockMinutes: parseInt(process.env.ACCOUNT_LOCK_MINUTES, 10) || 15
  }
};
