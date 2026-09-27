// Wrap async route handlers so thrown errors / rejected promises
// are forwarded to Express's error-handling middleware instead of
// crashing the process or hanging the request.
//
// Usage: router.get('/x', asyncHandler(async (req, res) => { ... }))
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
