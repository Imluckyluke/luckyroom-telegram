const crypto = require('crypto');
const config = require('../config');

// Stateless signed tokens: "<uploadId>.<expiresAtMs>.<hmac>". Anyone
// holding the token can fetch that one file until it expires, without
// needing to send an Authorization header — useful for sharing a link
// (e.g. pasting it into a browser) without exposing the JWT.
function sign(uploadId, expiresAtMs) {
  const payload = `${uploadId}.${expiresAtMs}`;
  return crypto.createHmac('sha256', config.upload.linkSecret).update(payload).digest('hex');
}

function createDownloadToken(uploadId, ttlMinutes = config.upload.linkTtlMinutes) {
  const expiresAtMs = Date.now() + ttlMinutes * 60 * 1000;
  const signature = sign(uploadId, expiresAtMs);
  return {
    token: `${uploadId}.${expiresAtMs}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

// Returns the uploadId (number) if the token is valid, unexpired, and
// matches the requested uploadId; otherwise null.
function verifyDownloadToken(token, expectedUploadId) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [uploadIdStr, expiresAtMsStr, signature] = parts;
  if (String(expectedUploadId) !== uploadIdStr) return null;

  const expiresAtMs = Number(expiresAtMsStr);
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null;

  const expectedSignature = sign(uploadIdStr, expiresAtMs);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return Number(uploadIdStr);
}

module.exports = { createDownloadToken, verifyDownloadToken };
