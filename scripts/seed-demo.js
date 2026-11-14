'use strict';

const crypto = require('node:crypto');
const config = require('../src/config');
const { openDatabase, nowIso, toJakartaIso } = require('../src/db');
const { ensureBootstrapAdmin, hashLabToken } = require('../src/auth');

function seedDemoData() {
  const db = openDatabase(config.dbPath);
  ensureBootstrapAdmin(db);

  const nowMs = Date.now();
  const now = nowIso();

  const demoLabs = [
    {
      id: 'lab-jaringan-1',
      name: 'LAB JARINGAN KOMPUTER 1',
      location: 'Gedung Sains & Teknologi Lt. 2 R.201',
      description: 'Kiosk utama praktikum jaringan & administrasi server',
      token: 'lab_demo_jaringan_1_secret_token_2026',
    },
    {
      id: 'lab-pemrograman-1',
      name: 'LAB PEMROGRAMAN & REKAYASA PERANGKAT LUNAK',
      location: 'Gedung Sains & Teknologi Lt. 2 R.204',
      description: 'Kiosk praktikum algoritma, web, dan basis data',
      token: 'lab_demo_pemrograman_1_secret_token_2026',
    },
    {
      id: 'lab-multimedia-1',
      name: 'LAB MULTIMEDIA & PENGOLAHAN CITRA',
      location: 'Gedung Sains & Teknologi Lt. 3 R.302',
      description: 'Kiosk praktikum grafik komputer & desain antarmuka',
      token: 'lab_demo_multimedia_1_secret_token_2026',
    },
  ];

  const upsertLab = db.prepare(`
    INSERT INTO labs (
      id, name, location, description, token_hash, token_hint, timezone,
      active, last_seen_at, last_sent_at, last_pending_count, last_clock_skew_sec,
      last_source_ip, last_schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Asia/Jakarta', 1, ?, ?, 0, 1, '127.0.0.1', 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      location = excluded.location,
      description = excluded.description,
      updated_at = excluded.updated_at
  `);

  for (const l of demoLabs) {
    const { tokenHash, tokenHint } = hashLabToken(l.token);
    upsertLab.run(l.id, l.name, l.location, l.description, tokenHash, tokenHint, now, now, now, now);
  }

  const students = [
    { nim: '4420231001', nama: 'BUDI SANTOSO', kelas: 'A', semester: 5 },
    { nim: '4420231002', nama: 'SITI RAHMAWATI', kelas: 'A', semester: 5 },
    { nim: '4420231003', nama: 'AHMAD FAUZI', kelas: 'B', semester: 5 },
    { nim: '4420242011', nama: 'NADIA PUTRI PRATAMA', kelas: 'A', semester: 3 },
    { nim: '4420242015', nama: 'RIZKY MAULANA', kelas: 'B', semester: 3 },
    { nim: '4420253008', nama: 'DEWI ANGGRAINI', kelas: 'C', semester: 1 },
    { nim: '4420253019', nama: 'FARHAN HIDAYAT', kelas: 'A', semester: 1 },
  ];

  const existingScans = db.prepare('SELECT COUNT(*) AS c FROM scans').get().c;
  if (existingScans === 0) {
    const insertScan = db.prepare(`
      INSERT OR IGNORE INTO scans (id, lab_id, nim, nama, kelas, semester, scanned_at, status, received_at, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatch = db.prepare(`
      INSERT INTO ingest_batches (
        id, lab_id, received_at, sent_at, record_count, accepted_count,
        duplicate_count, rejected_count, pending_count, clock_skew_sec, source_ip, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1, '127.0.0.1', 1)
    `);

    const seedTx = db.transaction(() => {
      for (let dayOffset = 5; dayOffset >= 0; dayOffset -= 1) {
        for (const lab of demoLabs) {
          const batchId = crypto.randomUUID();
          const countForLabDay = dayOffset === 0 ? 6 : 4;
          const batchTime = toJakartaIso(nowMs - dayOffset * 86400 * 1000 - 1200 * 1000);

          for (let i = 0; i < countForLabDay; i += 1) {
            const isUnknown = i === countForLabDay - 1 && dayOffset % 2 === 0;
            const student = students[(i + dayOffset) % students.length];
            const scanTime = toJakartaIso(nowMs - dayOffset * 86400 * 1000 - (countForLabDay - i) * 1800 * 1000);

            insertScan.run(
              crypto.randomUUID(),
              lab.id,
              isUnknown ? `999000${dayOffset}${i}` : student.nim,
              isUnknown ? null : student.nama,
              isUnknown ? null : student.kelas,
              isUnknown ? null : student.semester,
              scanTime,
              isUnknown ? 'not_found' : 'ok',
              batchTime,
              batchId
            );
          }

          insertBatch.run(batchId, lab.id, batchTime, batchTime, countForLabDay, countForLabDay);
        }
      }
    });
    seedTx();
  }

  const demoInventory = [
    {
      code: 'INV-JAR-001',
      name: 'Router Core MikroTik CCR2004-16G-2S+',
      category: 'Perangkat Jaringan',
      lab_id: 'lab-jaringan-1',
      quantity: 2,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
      notes: 'Rak Server Utama Baris A',
    },
    {
      code: 'INV-JAR-002',
      name: 'Switch Catalyst 2960-X 24 Port',
      category: 'Perangkat Jaringan',
      lab_id: 'lab-jaringan-1',
      quantity: 6,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
      notes: 'Meja praktikum topologi bintang',
    },
    {
      code: 'INV-JAR-003',
      name: 'LAN Tester Digital Fluke CableIQ',
      category: 'Alat Ukur',
      lab_id: 'lab-jaringan-1',
      quantity: 12,
      unit: 'buah',
      condition: 'Rusak Ringan',
      status: 'Aktif',
      notes: '2 unit perlu penggantian konektor baterai',
    },
    {
      code: 'INV-RPL-001',
      name: 'PC Workstation Core i7-13700 / 32GB RAM',
      category: 'Komputer Praktikum',
      lab_id: 'lab-pemrograman-1',
      quantity: 32,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
      notes: 'Meja Mahasiswa 01 s.d. 32',
    },
    {
      code: 'INV-RPL-002',
      name: 'UPS APC Smart-UPS 2200VA',
      category: 'Kelistrikan',
      lab_id: 'lab-pemrograman-1',
      quantity: 2,
      unit: 'unit',
      condition: 'Dalam Perbaikan',
      status: 'Aktif',
      notes: 'Kalibrasi baterai berkala',
    },
    {
      code: 'INV-MMD-001',
      name: 'Monitor Kalibrasi Warna Dell UltraSharp 27" 4K',
      category: 'Perangkat Display',
      lab_id: 'lab-multimedia-1',
      quantity: 20,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
      notes: 'Terpasang di meja desain grafis',
    },
  ];

  const insertInv = db.prepare(`
    INSERT OR IGNORE INTO inventory_items (
      id, inventory_code, name, category, lab_id, quantity, unit,
      condition, status, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of demoInventory) {
    insertInv.run(
      crypto.randomUUID(),
      item.code,
      item.name,
      item.category,
      item.lab_id,
      item.quantity,
      item.unit,
      item.condition,
      item.status,
      item.notes,
      now,
      now
    );
  }

  db.close();
  console.log('[seed] Data awal berhasil disiapkan:');
  console.log(`  - Admin Email    : ${config.adminEmail}`);
  console.log(`  - Admin Password : ${config.adminPassword}`);
  for (const l of demoLabs) {
    console.log(`  - Lab '${l.id}' token demo: ${l.token}`);
  }
}

if (require.main === module) {
  seedDemoData();
}

module.exports = { seedDemoData };
