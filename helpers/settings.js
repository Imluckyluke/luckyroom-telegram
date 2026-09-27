const db = require('../db');
const config = require('../config');

const CATEGORIES = ['file', 'image', 'voice', 'video'];
const MIN_MB = 1;
const MAX_MB = 500; // sanity ceiling so the panel can't accidentally set something absurd

function settingKey(category) {
  return `upload.maxSizeMb.${category}`;
}

// Effective limits = DB override (set from the super-admin panel) if
// present, otherwise the .env default from config/index.js. Allowed mime
// types stay env-only (not exposed as a runtime setting).
function getUploadLimits() {
  const rows = db
    .prepare(`SELECT key, value FROM settings WHERE key LIKE 'upload.maxSizeMb.%'`)
    .all();
  const overrides = {};
  rows.forEach((row) => {
    const category = row.key.split('.').pop();
    overrides[category] = JSON.parse(row.value);
  });

  const result = {};
  CATEGORIES.forEach((category) => {
    result[category] = {
      maxSizeMb:
        overrides[category] !== undefined ? overrides[category] : config.upload.categories[category].maxSizeMb,
      isDefault: overrides[category] === undefined,
      allowedMimeTypes: config.upload.categories[category].allowedMimeTypes
    };
  });
  return result;
}

function getMaxSizeMb(category) {
  return getUploadLimits()[category].maxSizeMb;
}

function setUploadLimit(category, maxSizeMb, updatedBy) {
  if (!CATEGORIES.includes(category)) {
    throw Object.assign(new Error(`category must be one of: ${CATEGORIES.join(', ')}`), { status: 400 });
  }
  const mb = Number(maxSizeMb);
  if (!Number.isFinite(mb) || mb < MIN_MB || mb > MAX_MB) {
    throw Object.assign(new Error(`maxSizeMb must be a number between ${MIN_MB} and ${MAX_MB}`), { status: 400 });
  }

  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(settingKey(category), JSON.stringify(mb), new Date().toISOString(), updatedBy || null);

  return mb;
}

// Removes the override, reverting that category back to the .env default.
function resetUploadLimit(category) {
  if (!CATEGORIES.includes(category)) {
    throw Object.assign(new Error(`category must be one of: ${CATEGORIES.join(', ')}`), { status: 400 });
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(settingKey(category));
}

module.exports = { CATEGORIES, getUploadLimits, getMaxSizeMb, setUploadLimit, resetUploadLimit };
