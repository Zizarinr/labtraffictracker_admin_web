'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../src/config');
const { openDatabase, toJakartaIso } = require('../src/db');

async function runBackup(sourceDbPath = config.dbPath, targetDir = config.backupDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const stamp = toJakartaIso().replace(/[:+]/g, '-').slice(0, 19);
  const backupFile = path.join(targetDir, `central-backup-${stamp}.db`);

  const db = openDatabase(sourceDbPath);
  try {
    // Checkpoint WAL sebelum melakukan online backup
    db.pragma('wal_checkpoint(PASSIVE)');
    await db.backup(backupFile);
  } finally {
    db.close();
  }

  // Verifikasi integritas file hasil backup
  const verifyDb = new Database(backupFile, { readonly: true });
  let integrity = 'failed';
  let scanCount = 0;
  let invCount = 0;
  try {
    integrity = verifyDb.pragma('integrity_check', { simple: true });
    scanCount = verifyDb.prepare('SELECT COUNT(*) AS c FROM scans').get().c;
    invCount = verifyDb.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c;
  } finally {
    verifyDb.close();
  }

  if (integrity !== 'ok') {
    throw new Error(`Integritas file backup tidak valid: ${integrity}`);
  }

  console.log(`[backup] SUKSES -> ${backupFile}`);
  console.log(`[backup] Integritas: ${integrity} | scans=${scanCount} | inventory=${invCount}`);
  return { backupFile, integrity, scanCount, invCount };
}

if (require.main === module) {
  runBackup().catch((err) => {
    console.error(`[backup] GAGAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runBackup };
