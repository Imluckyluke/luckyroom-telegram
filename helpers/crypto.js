const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV size for GCM

// Resolves the master key (used only to encrypt/decrypt each file's own
// random key — "envelope encryption") into a 32-byte Buffer. Accepts hex
// or base64 in the env var. Falls back to deriving one from JWT_SECRET so
// the app still runs out of the box, but a real UPLOAD_ENCRYPTION_KEY
// should always be set in production.
function masterKey() {
  const raw = config.upload.encryptionKey;
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
    return crypto.createHash('sha256').update(raw).digest();
  }
  const fallback = config.jwt.secret || 'insecure-default-key';
  return crypto.createHash('sha256').update(`upload-master:${fallback}`).digest();
}

// Encrypts a random per-file key with the master key. Returns the pieces
// needed to decrypt it later, all base64 so they can sit in SQLite columns.
function wrapFileKey(fileKey) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedKey: encrypted.toString('base64'),
    keyIv: iv.toString('base64'),
    keyAuthTag: authTag.toString('base64')
  };
}

// Reverses wrapFileKey to recover the original per-file key.
function unwrapFileKey({ encryptedKey, keyIv, keyAuthTag }) {
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(keyIv, 'base64'));
  decipher.setAuthTag(Buffer.from(keyAuthTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedKey, 'base64')),
    decipher.final()
  ]);
}

function generateFileKey() {
  return crypto.randomBytes(32);
}

function generateIv() {
  return crypto.randomBytes(IV_LENGTH);
}

function createCipher(fileKey, iv) {
  return crypto.createCipheriv(ALGO, fileKey, iv);
}

function createDecipher(fileKey, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGO, fileKey, iv);
  decipher.setAuthTag(authTag);
  return decipher;
}

module.exports = {
  ALGO,
  IV_LENGTH,
  wrapFileKey,
  unwrapFileKey,
  generateFileKey,
  generateIv,
  createCipher,
  createDecipher
};
