const config = require('../config');

// Reads page/limit query params and returns { limit, page, offset }.
function paginationParams(query = {}, opts = {}) {
  const defaultLimit = opts.defaultLimit || config.pagination.defaultLimit;
  const maxLimit = opts.maxLimit || config.pagination.maxLimit;

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  return { limit, page, offset };
}

module.exports = { paginationParams };
