const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../db');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/chat.db');
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(path.dirname(DB_PATH), 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function backupFilename(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `backup_${stamp}.db`;
}

// Only ever touch files that live inside BACKUP_DIR and look like ones we
// created — never let a filename from a request reach outside this folder.
function safeBackupPath(filename) {
  const base = path.basename(String(filename || ''));
  if (!/^backup_[\w.-]+\.db$/.test(base)) return null;
  const full = path.join(BACKUP_DIR, base);
  if (path.dirname(full) !== BACKUP_DIR) return null;
  return fs.existsSync(full) ? full : null;
}

// Uses SQLite's online backup API (via better-sqlite3's native .backup()),
// so this is safe to run against the live database with no downtime and
// no risk of grabbing a half-written page.
async function createBackup(userId) {
  const filename = backupFilename();
  const destPath = path.join(BACKUP_DIR, filename);
  await db.backup(destPath);
  const stat = fs.statSync(destPath);
  return {
    filename,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
    createdBy: userId || null
  };
}

function listBackups() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^backup_[\w.-]+\.db$/.test(name))
    .map((filename) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, filename));
      return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function deleteBackup(filename) {
  const full = safeBackupPath(filename);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

// Sanity-checks that a file is actually a usable SQLite database (opens
// cleanly and passes an integrity check) before we let it anywhere near
// becoming the live DB.
function assertValidSqliteFile(filePath) {
  let check;
  try {
    check = new Database(filePath, { readonly: true, fileMustExist: true });
    const row = check.pragma('integrity_check', { simple: true });
    if (row !== 'ok') throw new Error('Integrity check failed: ' + row);
    // Must at least look like this app's database.
    const hasUsers = check
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .get();
    if (!hasUsers) throw new Error('This file has no users table — not a valid backup for this app');
  } finally {
    if (check) check.close();
  }
}

// Restoring a live better-sqlite3 handle in-process is not safe (every
// module in the app holds a reference to the same open Database object,
// so we cannot just swap it out from under them). Instead: validate the
// upload, replace the on-disk file (and clear any stale -wal/-shm files
// so the next boot doesn't try to replay an old WAL against the new
// file), then require a restart so the app reopens the new file cleanly.
// Callers MUST tell the admin a restart is needed (see routes/superadmin.js).
function restoreFromFile(uploadedFilePath) {
  assertValidSqliteFile(uploadedFilePath);

  // Make sure everything currently in the WAL is flushed and the file
  // handle is quiesced as much as possible before we touch the file.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    // best-effort; proceed with the swap regardless
  }

  const preRestoreCopy = path.join(BACKUP_DIR, backupFilename());
  fs.copyFileSync(DB_PATH, preRestoreCopy); // safety net in case the upload was bad

  fs.copyFileSync(uploadedFilePath, DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = DB_PATH + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }

  return { preRestoreBackup: path.basename(preRestoreCopy) };
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  deleteBackup,
  safeBackupPath,
  restoreFromFile
};
