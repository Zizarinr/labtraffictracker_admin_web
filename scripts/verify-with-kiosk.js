'use strict';

/**
 * Verifikasi integrasi langsung antara worker `traffic_tracker/src/sync.js`
 * dengan server pusat `lab_admin_monitor`.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { startServer } = require('../server');
const { hashLabToken } = require('../src/auth');
const { nowIso } = require('../src/db');

const KIOSK_ROOT = path.resolve(__dirname, '../../traffic_tracker');

async function verifyWithKioskWorker() {
  const tmpDir = path.join(__dirname, `../data/_verify_kiosk_${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(tmpDir, { recursive: true });

  const centralDbPath = path.join(tmpDir, 'central.db');
  const serverInstance = startServer({ port: 0, host: '127.0.0.1', dbPath: centralDbPath, quiet: true });
  const port = await serverInstance.ready;
  const ingestUrl = `http://127.0.0.1:${port}/api/lab/traffic`;

  const labToken = 'lab_verify_kiosk_token_12345';
  const { tokenHash, tokenHint } = hashLabToken(labToken);
  const now = nowIso();

  serverInstance.db
    .prepare(
      `INSERT INTO labs (id, name, location, description, token_hash, token_hint, timezone, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Asia/Jakarta', 1, ?, ?)`
    )
    .run('lab-uji-kiosk', 'LAB UJI KIOSK', 'Gedung A', 'Uji E2E', tokenHash, tokenHint, now, now);

  try {
    const syncModulePath = path.join(KIOSK_ROOT, 'src/sync.js');
    const schemaModulePath = path.join(KIOSK_ROOT, 'src/schema.js');

    if (fs.existsSync(syncModulePath) && fs.existsSync(schemaModulePath)) {
      const { createSyncWorker } = require(syncModulePath);
      const { applySchema: applyKioskSchema } = require(schemaModulePath);

      const kioskDbPath = path.join(tmpDir, 'kiosk.db');
      const kioskDb = new Database(kioskDbPath);
      applyKioskSchema(kioskDb);

      // Masukkan 5 scan ke DB lokal kiosk (4 ok, 1 not_found)
      const insertKioskScan = kioskDb.prepare(`
        INSERT INTO scan_log (id, nim, nama, kelas, semester, scanned_at, status, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      for (let i = 1; i <= 5; i += 1) {
        insertKioskScan.run(
          crypto.randomUUID(),
          `442023900${i}`,
          i === 5 ? null : `MAHASISWA UJI ${i}`,
          i === 5 ? null : 'A',
          i === 5 ? null : 3,
          nowIso(),
          i === 5 ? 'not_found' : 'ok'
        );
      }

      const worker = createSyncWorker({
        db: kioskDb,
        cfg: {
          labId: 'lab-uji-kiosk',
          labName: 'LAB UJI KIOSK',
          monitorUrl: ingestUrl,
          monitorToken: labToken,
          syncIntervalSeconds: 60,
          syncBatchSize: 100,
          syncTimeoutSeconds: 5,
        },
        logger: { write: (msg) => console.log(`  [kiosk-worker] ${msg}`), close: () => {} },
      });

      await worker.runCycle();
      worker.stop();

      const pendingInKiosk = kioskDb.prepare('SELECT COUNT(*) AS c FROM scan_log WHERE synced = 0').get().c;
      const storedInCentral = serverInstance.db
        .prepare("SELECT COUNT(*) AS c FROM scans WHERE lab_id = 'lab-uji-kiosk'")
        .get().c;

      kioskDb.close();

      if (pendingInKiosk !== 0 || storedInCentral !== 5) {
        throw new Error(`Ketidakcocokan sinkronisasi: pendingInKiosk=${pendingInKiosk}, storedInCentral=${storedInCentral}`);
      }

      console.log('[verify:kiosk] LULUS — Worker asli traffic_tracker berhasil mengirim 5 scan dan menandai synced=1.');
    } else {
      console.log('[verify:kiosk] Folder traffic_tracker tidak ditemukan, melewati uji worker eksternal.');
    }
  } finally {
    await serverInstance.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore Windows file lock delay */
    }
  }
}

if (require.main === module) {
  verifyWithKioskWorker().catch((err) => {
    console.error(`[verify:kiosk] GAGAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verifyWithKioskWorker };
