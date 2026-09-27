// Manually applies pending migrations.
// Useful on shared hosting where you have shell/cron access but don't
// necessarily want to restart the whole app just to migrate the DB.
require('../db'); // requiring db/index.js already runs pending migrations
console.log('[migrate] up to date');
