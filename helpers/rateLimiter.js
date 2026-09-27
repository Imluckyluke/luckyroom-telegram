// Lightweight, dependency-free rate limiter (fixed-window per key, default
// key = client IP). Functionally the same idea as express-rate-limit's
// standard config, kept in-house so there's no extra npm dependency.
//
// Sets the usual RateLimit-* headers and replies 429 with retryAfter (in
// seconds) once a key goes over its limit within the current window.

const store = new Map(); // key -> { count, resetAt }

function getClientIp(req) {
  return (
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// Periodic sweep so the Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * @param {object} opts
 * @param {number} opts.windowMs - length of the fixed window
 * @param {number} opts.max - max requests allowed per key per window
 * @param {string} [opts.name] - used as a prefix so different limiters don't share buckets
 * @param {(req) => string} [opts.keyGenerator] - defaults to client IP
 * @param {string} [opts.message]
 */
function createRateLimiter({ windowMs, max, name = 'default', keyGenerator, message }) {
  return function rateLimiter(req, res, next) {
    const identity = (keyGenerator ? keyGenerator(req) : getClientIp(req)) || 'unknown';
    const key = `${name}:${identity}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: message || 'Too many requests, please try again later',
        retryAfterSeconds
      });
    }

    next();
  };
}

module.exports = { createRateLimiter };
