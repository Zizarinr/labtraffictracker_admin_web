'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const config = require('../src/config');
const { startServer } = require('../server');
const { nowIso } = require('../src/db');
const { runBackup } = require('../scripts/backup');

const TMP_DIR = path.join(__dirname, '../data/_test_run');
const TEST_DB_PATH = path.join(TMP_DIR, 'test-central.db');

let srv = null;
let baseUrl = '';
let adminCookie = '';
let csrfToken = '';
let labAToken = '';
let labBToken = '';

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (adminCookie && !headers.Cookie && !headers.Authorization) {
    headers.Cookie = adminCookie;
  }
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase()) && !headers.Authorization) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  let body = options.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body,
  });

  const setCookie = res.headers.get('set-cookie');
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    json = await res.json();
  }
  return { status: res.status, body: json, res, setCookie };
}

before(async () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  srv = startServer({ port: 0, host: '127.0.0.1', dbPath: TEST_DB_PATH, quiet: true });
  const port = await srv.ready;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (srv) await srv.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test('1. Healthcheck endpoint mengembalikan status OK dan zona waktu Asia/Jakarta', async () => {
  const r = await request('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.timezone, 'Asia/Jakarta');
});

test('2. Autentikasi Admin, Pemisahan Portal /login vs /dashboard, & proteksi CSRF berfungsi dengan benar', async () => {
  // 2a. Sebelum login: akses /dashboard harus 302 redirect ke /login?next=%2Fdashboard
  const unauthDash = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
  assert.equal(unauthDash.status, 302);
  assert.equal(unauthDash.headers.get('location'), '/login?next=%2Fdashboard');

  // 2b. Sebelum login: akses /login harus 200 OK menampilkan portal login
  const loginPage = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.ok(loginHtml.includes('PORTAL AUTENTIKASI PUSAT'));

  // 2c. Login salah harus 401
  const bad = await request('/api/auth/login', {
    method: 'POST',
    body: { email: config.adminEmail, password: 'wrong-password' },
  });
  assert.equal(bad.status, 401);

  // 2d. Login benar
  const ok = await request('/api/auth/login', {
    method: 'POST',
    body: { email: config.adminEmail, password: config.adminPassword },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.setCookie);
  adminCookie = ok.setCookie.split(';')[0];
  csrfToken = ok.body.csrf_token;
  assert.ok(csrfToken);

  // 2e. Setelah login: akses /login harus otomatis 302 redirect ke /dashboard
  const authLogin = await fetch(`${baseUrl}/login`, {
    headers: { Cookie: adminCookie },
    redirect: 'manual',
  });
  assert.equal(authLogin.status, 302);
  assert.equal(authLogin.headers.get('location'), '/dashboard');

  // 2f. Setelah login: akses /dashboard dan /inventory harus 200 OK menyajikan konsol admin
  const authDash = await fetch(`${baseUrl}/dashboard`, {
    headers: { Cookie: adminCookie },
    redirect: 'manual',
  });
  assert.equal(authDash.status, 200);

  const authInv = await fetch(`${baseUrl}/inventory`, {
    headers: { Cookie: adminCookie },
    redirect: 'manual',
  });
  assert.equal(authInv.status, 200);

  // 2g. Cek /api/auth/me
  const me = await request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.email, config.adminEmail);
});

test('3. Pendaftaran Laboratorium menghasilkan token unik satu kali & menolak lab_id duplikat', async () => {
  const createA = await request('/api/laboratories', {
    method: 'POST',
    body: {
      id: 'lab-jaringan-1',
      name: 'LAB JARINGAN 1',
      location: 'Gedung A Lt. 2',
      description: 'Kiosk Jaringan',
    },
  });
  assert.equal(createA.status, 201);
  assert.ok(createA.body.token_once.startsWith('lab_'));
  assert.ok(createA.body.kiosk_env_snippet.includes('LAB_ID=lab-jaringan-1'));
  labAToken = createA.body.token_once;

  const createB = await request('/api/laboratories', {
    method: 'POST',
    body: {
      id: 'lab-pemrograman-1',
      name: 'LAB PEMROGRAMAN 1',
      location: 'Gedung A Lt. 3',
      description: 'Kiosk RPL',
    },
  });
  assert.equal(createB.status, 201);
  labBToken = createB.body.token_once;

  // Duplikat lab_id harus 409
  const dup = await request('/api/laboratories', {
    method: 'POST',
    body: { id: 'lab-jaringan-1', name: 'LAB DUP' },
  });
  assert.equal(dup.status, 409);
});

test('4. Kontrak Ingest Multi-Lab: Validasi Token, Penyimpanan, Idempotensi Duplikat di accepted, dan Isolasi Lab', async () => {
  const rec1Id = crypto.randomUUID();
  const rec2Id = crypto.randomUUID();
  const recUnknownId = crypto.randomUUID();
  const sentAt = nowIso();

  // 4a. Lab tidak terdaftar harus ditolak 403 (tidak auto-register)
  const unreg = await request('/api/lab/traffic', {
    method: 'POST',
    headers: { Authorization: `Bearer ${labAToken}` },
    body: {
      schema_version: 1,
      lab_id: 'lab-belum-terdaftar',
      lab: 'LAB ILEGAL',
      sent_at: sentAt,
      pending_count: 1,
      records: [{ id: rec1Id, nim: '4420231001', scanned_at: sentAt, status: 'ok' }],
    },
  });
  assert.equal(unreg.status, 403);

  // 4b. Token salah / milik lab lain harus ditolak 401
  const wrongToken = await request('/api/lab/traffic', {
    method: 'POST',
    headers: { Authorization: `Bearer ${labBToken}` },
    body: {
      schema_version: 1,
      lab_id: 'lab-jaringan-1',
      lab: 'LAB JARINGAN 1',
      sent_at: sentAt,
      pending_count: 1,
      records: [{ id: rec1Id, nim: '4420231001', scanned_at: sentAt, status: 'ok' }],
    },
  });
  assert.equal(wrongToken.status, 401);

  // 4c. Kirim batch valid ke Lab A (termasuk 1 record status not_found)
  const batchA = await request('/api/lab/traffic', {
    method: 'POST',
    headers: { Authorization: `Bearer ${labAToken}` },
    body: {
      schema_version: 1,
      lab_id: 'lab-jaringan-1',
      lab: 'LAB JARINGAN 1',
      sent_at: sentAt,
      pending_count: 3,
      records: [
        {
          id: rec1Id,
          nim: '4420231001',
          nama: 'BUDI SANTOSO',
          kelas: 'A',
          semester: 5,
          scanned_at: sentAt,
          status: 'ok',
        },
        {
          id: rec2Id,
          nim: '4420231002',
          nama: 'SITI RAHMAWATI',
          kelas: 'A',
          semester: 5,
          scanned_at: sentAt,
          status: 'ok',
        },
        {
          id: recUnknownId,
          nim: '99999999',
          nama: null,
          kelas: null,
          semester: null,
          scanned_at: sentAt,
          status: 'not_found',
        },
      ],
    },
  });
  assert.equal(batchA.status, 200);
  assert.equal(batchA.body.accepted.length, 3);
  assert.equal(batchA.body.duplicates.length, 0);
  assert.equal(batchA.body.rejected.length, 0);

  // 4d. Kirim ulang batch yang sama persis + 1 record baru (Uji Idempotensi)
  const rec3Id = crypto.randomUUID();
  const retryBatchA = await request('/api/lab/traffic', {
    method: 'POST',
    headers: { Authorization: `Bearer ${labAToken}` },
    body: {
      schema_version: 1,
      lab_id: 'lab-jaringan-1',
      lab: 'LAB JARINGAN 1',
      sent_at: sentAt,
      pending_count: 4,
      records: [
        { id: rec1Id, nim: '4420231001', nama: 'BUDI SANTOSO', kelas: 'A', semester: 5, scanned_at: sentAt, status: 'ok' },
        { id: rec2Id, nim: '4420231002', nama: 'SITI RAHMAWATI', kelas: 'A', semester: 5, scanned_at: sentAt, status: 'ok' },
        { id: rec3Id, nim: '4420231003', nama: 'AHMAD FAUZI', kelas: 'B', semester: 5, scanned_at: sentAt, status: 'ok' },
      ],
    },
  });
  assert.equal(retryBatchA.status, 200);
  // ATURAN EMAS: accepted wajib memuat duplikat (rec1Id, rec2Id) + baru (rec3Id) = 3
  assert.equal(retryBatchA.body.accepted.length, 3);
  assert.ok(retryBatchA.body.accepted.includes(rec1Id));
  assert.ok(retryBatchA.body.accepted.includes(rec2Id));
  assert.ok(retryBatchA.body.accepted.includes(rec3Id));
  assert.equal(retryBatchA.body.duplicates.length, 2);

  // 4e. Kirim kunjungan mahasiswa yang sama (4420231001) ke Lab B untuk uji riwayat lintas lab
  const recLabBId = crypto.randomUUID();
  const batchB = await request('/api/lab/traffic', {
    method: 'POST',
    headers: { Authorization: `Bearer ${labBToken}` },
    body: {
      schema_version: 1,
      lab_id: 'lab-pemrograman-1',
      lab: 'LAB PEMROGRAMAN 1',
      sent_at: sentAt,
      pending_count: 1,
      records: [
        {
          id: recLabBId,
          nim: '4420231001',
          nama: 'BUDI SANTOSO',
          kelas: 'A',
          semester: 5,
          scanned_at: sentAt,
          status: 'ok',
        },
      ],
    },
  });
  assert.equal(batchB.status, 200);
  assert.equal(batchB.body.accepted.length, 1);

  // Verifikasi jumlah baris di Lab A tetap 4 (tidak dobel karena retry) dan Lab B = 1
  const visitsLabA = await request('/api/visit-logs?lab_id=lab-jaringan-1');
  assert.equal(visitsLabA.body.pagination.total, 4);

  const visitsLabB = await request('/api/visit-logs?lab_id=lab-pemrograman-1');
  assert.equal(visitsLabB.body.pagination.total, 1);

  // Verifikasi riwayat lintas lab untuk NIM 4420231001 (1 di Lab A + 1 di Lab B = 2)
  const studentVisits = await request('/api/students/4420231001/visits');
  assert.equal(studentVisits.status, 200);
  assert.equal(studentVisits.body.total_visits, 2);
  assert.equal(studentVisits.body.labs_breakdown.length, 2);
});

test('5. CRUD Inventaris Manual & Validasi Kode Inventaris Unik', async () => {
  const createInv = await request('/api/inventory', {
    method: 'POST',
    body: {
      inventory_code: 'INV-TEST-001',
      name: 'Oscilloscope Digital Rigol DS1054Z',
      category: 'Alat Ukur',
      lab_id: 'lab-jaringan-1',
      quantity: 5,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
      notes: 'Lemari Besi 1',
    },
  });
  assert.equal(createInv.status, 201);
  const itemId = createInv.body.item.id;

  // Duplikat kode_inventaris harus ditolak 409
  const dupInv = await request('/api/inventory', {
    method: 'POST',
    body: {
      inventory_code: 'inv-test-001',
      name: 'Barang Duplikat',
      category: 'Alat Ukur',
      lab_id: 'lab-jaringan-1',
      quantity: 1,
      unit: 'unit',
      condition: 'Baik',
      status: 'Aktif',
    },
  });
  assert.equal(dupInv.status, 409);

  // Update inventaris
  const patchInv = await request(`/api/inventory/${itemId}`, {
    method: 'PATCH',
    body: { quantity: 8, condition: 'Rusak Ringan' },
  });
  assert.equal(patchInv.status, 200);
  assert.equal(patchInv.body.item.quantity, 8);
  assert.equal(patchInv.body.item.condition, 'Rusak Ringan');
});

test('6. Impor Excel Inventaris 2-Tahap: Unduh Template, Pratinjau Validasi per Baris, dan Konfirmasi Upsert', async () => {
  // 6a. Unduh template resmi
  const tplRes = await request('/api/inventory/template');
  assert.equal(tplRes.status, 200);
  const tplBuf = Buffer.from(await tplRes.res.arrayBuffer());
  assert.ok(tplBuf.length > 1000);

  // 6b. Susun file Excel uji berisi:
  // - Baris 1: Valid Baru (INV-XLS-001)
  // - Baris 2: Konflik Kode Existing (INV-TEST-001, sudah dibuat di test 5)
  // - Baris 3: Invalid (lab_id tidak terdaftar & jumlah negatif)
  const testRows = [
    {
      kode_inventaris: 'INV-XLS-001',
      nama_barang: 'Access Point Ubiquiti UniFi U6-Pro',
      kategori: 'Perangkat Jaringan',
      lab_id: 'lab-jaringan-1',
      jumlah: 10,
      satuan: 'unit',
      kondisi: 'Baik',
      status: 'Aktif',
      catatan: 'Impor via Excel',
    },
    {
      kode_inventaris: 'INV-TEST-001',
      nama_barang: 'Oscilloscope Digital Rigol DS1054Z (Updated via Excel)',
      kategori: 'Alat Ukur',
      lab_id: 'lab-jaringan-1',
      jumlah: 12,
      satuan: 'unit',
      kondisi: 'Baik',
      status: 'Aktif',
      catatan: 'Diperbarui dari Excel',
    },
    {
      kode_inventaris: 'INV-XLS-BAD',
      nama_barang: 'Barang Salah Lab',
      kategori: 'Lainnya',
      lab_id: 'lab-tidak-ada',
      jumlah: -3,
      satuan: 'buah',
      kondisi: 'Baik',
      status: 'Aktif',
      catatan: '',
    },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(testRows);
  XLSX.utils.book_append_sheet(wb, ws, 'Inventaris');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Kirim ke preview
  const previewRes = await request('/api/inventory/import/preview', {
    method: 'POST',
    body: {
      file_name: 'uji-impor.xlsx',
      file_base64: xlsxBuf.toString('base64'),
    },
  });
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.body.total_rows, 3);
  assert.equal(previewRes.body.new_valid_rows, 1);
  assert.equal(previewRes.body.conflict_rows, 1);
  assert.equal(previewRes.body.failed_rows, 1);

  // Pastikan sebelum confirm, INV-XLS-001 belum masuk ke DB
  const beforeConfirm = await request('/api/inventory?q=INV-XLS-001');
  assert.equal(beforeConfirm.body.pagination.total, 0);

  // 6c. Konfirmasi dengan mode upsert
  const confirmRes = await request('/api/inventory/import/confirm', {
    method: 'POST',
    body: {
      job_id: previewRes.body.job_id,
      conflict_mode: 'upsert',
    },
  });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.inserted_rows, 1);
  assert.equal(confirmRes.body.updated_rows, 1);
  assert.equal(confirmRes.body.skipped_rows, 1);

  // Pastikan INV-XLS-001 sekarang ada dan INV-TEST-001 jumlahnya terupdate jadi 12
  const afterConfirm = await request('/api/inventory?q=INV-XLS-001');
  assert.equal(afterConfirm.body.pagination.total, 1);

  const updatedExisting = await request('/api/inventory?q=INV-TEST-001');
  assert.equal(updatedExisting.body.items[0].quantity, 12);
});

test('7. Backup Database Pusat & Pemeriksaan Integritas berhasil dijalankan', async () => {
  const backupOutDir = path.join(TMP_DIR, 'backups');
  const result = await runBackup(TEST_DB_PATH, backupOutDir);
  assert.equal(result.integrity, 'ok');
  assert.equal(result.scanCount, 5);
  assert.equal(result.invCount, 2);
});
