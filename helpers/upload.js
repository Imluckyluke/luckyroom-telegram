const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const fileCrypto = require('./crypto');

if (!fs.existsSync(config.upload.dir)) {
  fs.mkdirSync(config.upload.dir, { recursive: true });
}

// Allowed extensions per category — enforced together with the MIME-type
// allowlist in fileFilterFor(), since the client-supplied MIME type alone
// can be spoofed (e.g. an .exe renamed with an image MIME type).
const EXTENSIONS_BY_CATEGORY = {
  file: new Set(['.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv']),
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']),
  voice: new Set(['.ogg', '.oga', '.mp3', '.mp4', '.m4a', '.wav', '.webm', '.aac']),
  video: new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.mkv', '.3gp'])
};

function randomFilename(originalname) {
  const ext = path.extname(originalname || '');
  const unique = crypto.randomBytes(16).toString('hex');
  return `${Date.now()}_${unique}${ext}.enc`;
}

// Plain (unencrypted) filename generator for the avatar path below — same
// shape as randomFilename() but without the ".enc" suffix, since these
// files are never run through the encrypt/decrypt pipeline.
function randomPlainFilename(originalname) {
  const ext = path.extname(originalname || '');
  const unique = crypto.randomBytes(16).toString('hex');
  return `${Date.now()}_${unique}${ext}`;
}

// Custom multer storage engine: encrypts the upload stream with AES-256-GCM
// as it's written to disk, so the plaintext file is never persisted
// unencrypted. Each file gets its own random key (envelope encryption),
// which is itself encrypted with the app's master key before being stored
// in the database (helpers/crypto.js).
class EncryptedDiskStorage {
  _handleFile(req, file, cb) {
    const fileKey = fileCrypto.generateFileKey();
    const iv = fileCrypto.generateIv();
    const cipher = fileCrypto.createCipher(fileKey, iv);
    const filename = randomFilename(file.originalname);
    const destPath = path.join(config.upload.dir, filename);
    const outStream = fs.createWriteStream(destPath);
    const hash = crypto.createHash('sha256');

    let size = 0;
    let errored = false;

    const cleanupAndFail = (err) => {
      if (errored) return;
      errored = true;
      fs.unlink(destPath, () => cb(err));
    };

    file.stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });

    file.stream.on('error', cleanupAndFail);
    cipher.on('error', cleanupAndFail);
    outStream.on('error', cleanupAndFail);

    outStream.on('finish', () => {
      if (errored) return;
      const authTag = cipher.getAuthTag();
      const wrapped = fileCrypto.wrapFileKey(fileKey);

      cb(null, {
        path: destPath,
        filename,
        size,
        checksum: hash.digest('hex'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        encryptedKey: wrapped.encryptedKey,
        keyIv: wrapped.keyIv,
        keyAuthTag: wrapped.keyAuthTag
      });
    });

    file.stream.pipe(cipher).pipe(outStream);
  }

  _removeFile(req, file, cb) {
    fs.unlink(file.path, () => cb(null));
  }
}

function fileFilterFor(categoryKey) {
  const category = config.upload.categories[categoryKey];
  return (req, file, cb) => {
    if (!category.allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error(`File type not allowed for ${categoryKey}: ${file.mimetype}`));
    }
    // The MIME type comes from the client and can be spoofed, so the file
    // extension must also match the category — cheap second barrier.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!EXTENSIONS_BY_CATEGORY[categoryKey].has(ext)) {
      return cb(new Error(`File extension not allowed for ${categoryKey}: ${ext || '(none)'}`));
    }
    cb(null, true);
  };
}

// Builds a multer instance using whatever the *current* size limit is for
// this category (settings.js — DB override from the super-admin panel, or
// the .env default). Built fresh per request (cheap) instead of once at
// startup, so a limit change from the panel takes effect immediately with
// no server restart.
function multerFor(categoryKey, maxSizeMb) {
  return multer({
    storage: new EncryptedDiskStorage(),
    fileFilter: fileFilterFor(categoryKey),
    limits: { fileSize: maxSizeMb * 1024 * 1024 }
  });
}

// Express middleware factory: POST /api/uploads/file|image|voice use this
// instead of a static multer instance.
function uploadMiddleware(categoryKey) {
  const category = config.upload.categories[categoryKey];
  return (req, res, next) => {
    // Required lazily to avoid a circular require at module-load time
    // (settings.js -> db; upload.js is required before db finishes booting
    // in some require orders).
    const { getMaxSizeMb } = require('./settings');
    const maxSizeMb = getMaxSizeMb(categoryKey);
    return multerFor(categoryKey, maxSizeMb).single(category.fieldName)(req, res, next);
  };
}

// Decrypts a stored upload record fully into memory and returns a Buffer.
// Verifies the GCM auth tag, so tampered/corrupted ciphertext throws
// instead of silently returning garbage.
//
// Backward compatibility: uploads created before encryption was added have
// no iv/auth_tag/encrypted_key (NULL after the migration) — those are
// served as plain, unencrypted bytes exactly as they were stored. Only
// newly uploaded files go through the encrypt/decrypt path.
function decryptUploadToBuffer(record) {
  if (!record.iv || !record.auth_tag || !record.encrypted_key) {
    return fs.readFileSync(record.path);
  }

  const fileKey = fileCrypto.unwrapFileKey({
    encryptedKey: record.encrypted_key,
    keyIv: record.key_iv,
    keyAuthTag: record.key_auth_tag
  });

  const decipher = fileCrypto.createDecipher(
    fileKey,
    Buffer.from(record.iv, 'base64'),
    Buffer.from(record.auth_tag, 'base64')
  );

  const encrypted = fs.readFileSync(record.path);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// Profile avatars are served directly from disk via res.sendFile() (see
// GET /api/users/:id/avatar) and are not part of the encrypted chat-file
// pipeline above, so this uses a plain multer disk storage instead of
// EncryptedDiskStorage. Reuses the "image" category's size/mime-type
// rules, but keeps the "avatar" field name the frontend actually sends.
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.upload.dir),
  filename: (req, file, cb) => cb(null, randomPlainFilename(file.originalname))
});

function avatarUploadMiddleware() {
  const { getMaxSizeMb } = require('./settings');
  const maxSizeMb = getMaxSizeMb('image');
  return multer({
    storage: avatarStorage,
    fileFilter: fileFilterFor('image'),
    limits: { fileSize: maxSizeMb * 1024 * 1024 }
  }).single('avatar');
}

module.exports = {
  uploadMiddleware,
  avatarUploadMiddleware,
  decryptUploadToBuffer
};
