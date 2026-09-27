// Optional response helpers for new routes. Existing routes keep their
// current response shape untouched; this is available for new features.
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, message, status = 400, extra = {}) {
  return res.status(status).json({ success: false, error: message, ...extra });
}

module.exports = { ok, fail };
