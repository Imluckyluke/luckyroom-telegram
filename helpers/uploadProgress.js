const emitter = require('../sockets/emitter');

// Tracks bytes received for a multipart upload and emits `upload:progress`
// events to the uploading user's own socket(s), so a client can show a
// progress bar without any special client-side library. Correlated by an
// `X-Upload-Id` header the client makes up itself (e.g. a uuid).
function trackUploadProgress(req, res, next) {
  const uploadId = req.headers['x-upload-id'] || null;
  const total = parseInt(req.headers['content-length'], 10) || 0;

  if (!uploadId || !total) return next();

  let loaded = 0;
  let lastPercentSent = -1;

  req.on('data', (chunk) => {
    loaded += chunk.length;
    const percent = Math.min(100, Math.floor((loaded / total) * 100));
    // Only emit on percent changes to avoid flooding the socket.
    if (percent !== lastPercentSent) {
      lastPercentSent = percent;
      emitter.emitToUser(req.userId, 'upload:progress', { uploadId, loaded, total, percent });
    }
  });

  req.on('close', () => {
    if (lastPercentSent < 100 && req.complete === false) {
      emitter.emitToUser(req.userId, 'upload:progress', {
        uploadId,
        loaded,
        total,
        percent: lastPercentSent,
        aborted: true
      });
    }
  });

  next();
}

module.exports = trackUploadProgress;
