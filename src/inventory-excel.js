'use strict';

const crypto = require('node:crypto');
const XLSX = require('xlsx');
const config = require('./config');
const { nowIso } = require('./db');

const TEMPLATE_COLUMNS = [
  'kode_inventaris',
  'nama_barang',
  'kategori',
  'lab_id',
  'jumlah',
  'satuan',
  'kondisi',
  'status',
  'catatan',
];

const VALID_IMPORT_STATUSES = ['Aktif', 'Tidak Aktif'];

/**
 * Buat file Excel (.xlsx) template resmi inventaris beserta sheet panduan & daftar lab terdaftar.
 */
function buildInventoryTemplateBuffer(db) {
  const labs = db.prepare('SELECT id, name, location, active FROM labs ORDER BY id ASC').all();
  const sampleLabId = labs.length > 0 ? labs[0].id : 'lab-jaringan-1';

  const sampleRows = [
    {
      kode_inventaris: 'INV-JAR-001',
      nama_barang: 'Switch Managed Cisco 24-Port Gigabit',
      kategori: 'Perangkat Jaringan',
      lab_id: sampleLabId,
      jumlah: 4,
      satuan: 'unit',
      kondisi: 'Baik',
      status: 'Aktif',
      catatan: 'Terpasang di rak utama baris A',
    },
    {
      kode_inventaris: 'INV-JAR-002',
      nama_barang: 'Tang Crimping RJ45 Heavy Duty',
      kategori: 'Alat Praktikum',
      lab_id: sampleLabId,
      jumlah: 15,
      satuan: 'buah',
      kondisi: 'Baik',
      status: 'Aktif',
      catatan: 'Laci alat nomor 2',
    },
  ];

  const wb = XLSX.utils.book_new();
  const wsData = XLSX.utils.json_to_sheet(sampleRows, { header: TEMPLATE_COLUMNS });
  wsData['!cols'] = [
    { wch: 18 },
    { wch: 36 },
    { wch: 22 },
    { wch: 20 },
    { wch: 10 },
    { wch: 12 },
    { wch: 18 },
    { wch: 14 },
    { wch: 34 },
  ];
  XLSX.utils.book_append_sheet(wb, wsData, 'Inventaris');

  const guideRows = [
    { Kolom: 'kode_inventaris', Wajib: 'Ya', Aturan: 'Kode unik barang, tidak boleh kosong (contoh: INV-JAR-001)' },
    { Kolom: 'nama_barang', Wajib: 'Ya', Aturan: 'Nama lengkap peralatan/barang laboratorium' },
    { Kolom: 'kategori', Wajib: 'Ya', Aturan: 'Kategori barang (contoh: Komputer, Perangkat Jaringan, Alat Ukur, Furniture)' },
    { Kolom: 'lab_id', Wajib: 'Ya', Aturan: 'Kode lab_id yang sudah terdaftar di sistem pusat' },
    { Kolom: 'jumlah', Wajib: 'Ya', Aturan: 'Bilangan bulat >= 0' },
    { Kolom: 'satuan', Wajib: 'Ya', Aturan: 'Contoh: unit, buah, set, pcs, paket' },
    { Kolom: 'kondisi', Wajib: 'Ya', Aturan: config.inventoryConditions.join(' | ') },
    { Kolom: 'status', Wajib: 'Ya', Aturan: VALID_IMPORT_STATUSES.join(' | ') },
    { Kolom: 'catatan', Wajib: 'Tidak', Aturan: 'Keterangan tambahan opsional' },
  ];

  const labGuideRows = labs.map((l) => ({
    lab_id_terdaftar: l.id,
    nama_laboratorium: l.name,
    lokasi: l.location || '-',
    status_lab: l.active ? 'Aktif' : 'Nonaktif',
  }));

  const wsGuide = XLSX.utils.json_to_sheet(guideRows);
  wsGuide['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Aturan Kolom');

  if (labGuideRows.length > 0) {
    const wsLabs = XLSX.utils.json_to_sheet(labGuideRows);
    wsLabs['!cols'] = [{ wch: 22 }, { wch: 30 }, { wch: 24 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsLabs, 'Daftar Lab Terdaftar');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Normalisasi pencocokan nilai enum secara case-insensitive.
 */
function matchEnum(input, allowedList) {
  const clean = String(input || '').trim().toLowerCase();
  if (!clean) return null;
  return allowedList.find((item) => item.toLowerCase() === clean) || null;
}

/**
 * Tahap 1 Impor Excel: Baca buffer file, validasi seluruh baris, deteksi konflik kode_inventaris,
 * dan simpan pratinjau ke tabel `import_jobs` tanpa mengubah tabel `inventory_items`.
 */
function createInventoryImportPreview(db, { buffer, fileName, userId }) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (err) {
    const error = new Error('File tidak dapat dibaca sebagai dokumen Excel (.xlsx/.xls/.csv) yang valid.');
    error.code = 'INVALID_EXCEL_FILE';
    throw error;
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    const error = new Error('File Excel tidak memiliki lembar kerja (sheet).');
    error.code = 'EMPTY_WORKBOOK';
    throw error;
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    const error = new Error('Sheet pertama tidak berisi baris data untuk diimpor.');
    error.code = 'EMPTY_SHEET';
    throw error;
  }

  if (rawRows.length > 2000) {
    const error = new Error('Maksimal 2.000 baris per satu kali unggah file Excel.');
    error.code = 'TOO_MANY_ROWS';
    throw error;
  }

  // Periksa ketersediaan kolom wajib pada header
  const firstRowKeys = Object.keys(rawRows[0] || {}).map((k) => k.trim().toLowerCase());
  const requiredHeaders = TEMPLATE_COLUMNS.filter((c) => c !== 'catatan');
  const missingHeaders = requiredHeaders.filter((reqCol) => !firstRowKeys.includes(reqCol));
  if (missingHeaders.length > 0) {
    const error = new Error(`Header kolom wajib tidak lengkap. Kolom yang belum ada: ${missingHeaders.join(', ')}`);
    error.code = 'MISSING_HEADERS';
    throw error;
  }

  const labsMap = new Map(
    db.prepare('SELECT id, name, active FROM labs').all().map((l) => [l.id.toLowerCase(), l])
  );
  const existingCodeMap = new Map(
    db
      .prepare('SELECT inventory_code, id, name, lab_id, quantity, condition, status FROM inventory_items')
      .all()
      .map((item) => [item.inventory_code.toLowerCase(), item])
  );

  const seenInFile = new Map();
  const analyzedRows = [];
  let validCount = 0;
  let failedCount = 0;
  let conflictCount = 0;

  for (let i = 0; i < rawRows.length; i += 1) {
    const rowNumber = i + 2; // Baris 1 adalah header di Excel
    const raw = rawRows[i];

    // Normalisasi key kolom ke huruf kecil
    const norm = {};
    for (const [k, v] of Object.entries(raw)) {
      norm[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
    }

    const kodeInventaris = String(norm.kode_inventaris || '').trim();
    const namaBarang = String(norm.nama_barang || '').trim();
    const kategori = String(norm.kategori || '').trim();
    const labIdInput = String(norm.lab_id || '').trim();
    const jumlahRaw = String(norm.jumlah ?? '').trim();
    const satuan = String(norm.satuan || '').trim();
    const kondisiInput = String(norm.kondisi || '').trim();
    const statusInput = String(norm.status || '').trim();
    const catatan = String(norm.catatan || '').trim();

    const errors = [];

    if (!kodeInventaris) {
      errors.push('kode_inventaris wajib diisi');
    } else if (kodeInventaris.length > 64) {
      errors.push('kode_inventaris maksimal 64 karakter');
    }

    if (!namaBarang) {
      errors.push('nama_barang wajib diisi');
    }

    if (!kategori) {
      errors.push('kategori wajib diisi');
    }

    const matchedLab = labIdInput ? labsMap.get(labIdInput.toLowerCase()) : null;
    if (!labIdInput) {
      errors.push('lab_id wajib diisi');
    } else if (!matchedLab) {
      errors.push(`lab_id '${labIdInput}' tidak terdaftar di daftar laboratorium`);
    }

    let jumlah = null;
    if (jumlahRaw === '') {
      errors.push('jumlah wajib diisi');
    } else if (!/^-?\d+$/.test(jumlahRaw)) {
      errors.push(`jumlah '${jumlahRaw}' harus berupa bilangan bulat`);
    } else {
      jumlah = Number.parseInt(jumlahRaw, 10);
      if (!Number.isFinite(jumlah) || jumlah < 0) {
        errors.push('jumlah minimal 0 (tidak boleh negatif)');
      }
    }

    if (!satuan) {
      errors.push('satuan wajib diisi (misal: unit, buah, set)');
    }

    const matchedKondisi = matchEnum(kondisiInput, config.inventoryConditions);
    if (!kondisiInput) {
      errors.push('kondisi wajib diisi');
    } else if (!matchedKondisi) {
      errors.push(`kondisi '${kondisiInput}' tidak sah (gunakan: ${config.inventoryConditions.join(', ')})`);
    }

    const matchedStatus = matchEnum(statusInput, VALID_IMPORT_STATUSES);
    if (!statusInput) {
      errors.push('status wajib diisi');
    } else if (!matchedStatus) {
      errors.push(`status '${statusInput}' tidak sah (gunakan: ${VALID_IMPORT_STATUSES.join(', ')})`);
    }

    if (kodeInventaris) {
      const codeKey = kodeInventaris.toLowerCase();
      if (seenInFile.has(codeKey)) {
        errors.push(`kode_inventaris '${kodeInventaris}' duplikat di dalam file Excel (sama dengan baris ${seenInFile.get(codeKey)})`);
      } else {
        seenInFile.set(codeKey, rowNumber);
      }
    }

    const existingItem = kodeInventaris ? existingCodeMap.get(kodeInventaris.toLowerCase()) : null;
    let rowState = 'valid';
    if (errors.length > 0) {
      rowState = 'invalid';
      failedCount += 1;
    } else if (existingItem) {
      rowState = 'conflict';
      conflictCount += 1;
      validCount += 1;
    } else {
      validCount += 1;
    }

    analyzedRows.push({
      row_number: rowNumber,
      state: rowState, // 'valid' | 'conflict' | 'invalid'
      errors,
      existing: existingItem
        ? {
            id: existingItem.id,
            inventory_code: existingItem.inventory_code,
            name: existingItem.name,
            lab_id: existingItem.lab_id,
            quantity: existingItem.quantity,
            condition: existingItem.condition,
            status: existingItem.status,
          }
        : null,
      data: {
        inventory_code: existingItem ? existingItem.inventory_code : kodeInventaris,
        name: namaBarang,
        category: kategori,
        lab_id: matchedLab ? matchedLab.id : labIdInput,
        lab_name: matchedLab ? matchedLab.name : null,
        quantity: jumlah !== null ? jumlah : 0,
        unit: satuan,
        condition: matchedKondisi || kondisiInput,
        status: matchedStatus || statusInput,
        notes: catatan,
      },
    });
  }

  const jobId = crypto.randomUUID();
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO import_jobs (
      id, file_name, imported_by, total_rows, valid_rows, failed_rows, conflict_rows,
      status, rows_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?)
  `).run(
    jobId,
    String(fileName || 'inventaris.xlsx').slice(0, 200),
    userId || null,
    analyzedRows.length,
    validCount,
    failedCount,
    conflictCount,
    JSON.stringify(analyzedRows),
    createdAt
  );

  return {
    job_id: jobId,
    file_name: fileName || 'inventaris.xlsx',
    total_rows: analyzedRows.length,
    valid_rows: validCount,
    new_valid_rows: validCount - conflictCount,
    conflict_rows: conflictCount,
    failed_rows: failedCount,
    created_at: createdAt,
    rows: analyzedRows,
  };
}

/**
 * Tahap 2 Impor Excel: Konfirmasi dan simpan job pratinjau ke database dalam 1 transaksi atomik.
 * @param {'insert_only' | 'upsert'} conflictMode
 */
function confirmInventoryImport(db, { jobId, conflictMode = 'insert_only' }) {
  if (!['insert_only', 'upsert'].includes(conflictMode)) {
    const err = new Error("Mode konflik harus 'insert_only' (Tambah saja) atau 'upsert' (Perbarui kode yang sama).");
    err.code = 'INVALID_CONFLICT_MODE';
    throw err;
  }

  const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId);
  if (!job) {
    const err = new Error('Data pratinjau impor tidak ditemukan.');
    err.code = 'JOB_NOT_FOUND';
    throw err;
  }

  if (job.status !== 'preview') {
    const err = new Error(`Job impor ini sudah berstatus '${job.status}' dan tidak dapat dieksekusi ulang.`);
    err.code = 'JOB_ALREADY_PROCESSED';
    throw err;
  }

  const rows = JSON.parse(job.rows_json || '[]');
  const actionableRows = rows.filter((r) => r.state === 'valid' || r.state === 'conflict');
  if (actionableRows.length === 0) {
    const err = new Error('Tidak ada baris valid yang dapat diimpor dari file ini.');
    err.code = 'NO_VALID_ROWS';
    throw err;
  }

  const findByCodeStmt = db.prepare('SELECT id, inventory_code FROM inventory_items WHERE LOWER(inventory_code) = LOWER(?)');
  const insertStmt = db.prepare(`
    INSERT INTO inventory_items (
      id, inventory_code, name, category, lab_id, quantity, unit,
      condition, status, notes, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const updateStmt = db.prepare(`
    UPDATE inventory_items
       SET name = ?,
           category = ?,
           lab_id = ?,
           quantity = ?,
           unit = ?,
           condition = ?,
           status = ?,
           notes = ?,
           updated_at = ?,
           deleted_at = NULL
     WHERE id = ?
  `);
  const updateJobStmt = db.prepare(`
    UPDATE import_jobs
       SET inserted_rows = ?,
           updated_rows = ?,
           skipped_rows = ?,
           conflict_mode = ?,
           status = 'confirmed',
           confirmed_at = ?
     WHERE id = ?
  `);

  const runConfirmTx = db.transaction(() => {
    const now = nowIso();
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (row.state === 'invalid') {
        skipped += 1;
        continue;
      }

      const d = row.data;
      const existing = findByCodeStmt.get(d.inventory_code);

      if (!existing) {
        insertStmt.run(
          crypto.randomUUID(),
          d.inventory_code,
          d.name,
          d.category,
          d.lab_id,
          d.quantity,
          d.unit,
          d.condition,
          d.status,
          d.notes || '',
          now,
          now
        );
        inserted += 1;
      } else if (conflictMode === 'upsert') {
        updateStmt.run(
          d.name,
          d.category,
          d.lab_id,
          d.quantity,
          d.unit,
          d.condition,
          d.status,
          d.notes || '',
          now,
          existing.id
        );
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    updateJobStmt.run(inserted, updated, skipped, conflictMode, now, job.id);
    return {
      job_id: job.id,
      file_name: job.file_name,
      conflict_mode: conflictMode,
      total_rows: rows.length,
      inserted_rows: inserted,
      updated_rows: updated,
      skipped_rows: skipped,
      failed_rows: job.failed_rows,
      confirmed_at: now,
    };
  });

  return runConfirmTx();
}

/**
 * Ekspor daftar kunjungan ke Buffer .xlsx atau .csv
 */
function exportVisitLogsBuffer(rows, format = 'xlsx') {
  const mapped = rows.map((r) => ({
    waktu_scan: r.scanned_at,
    waktu_diterima_pusat: r.received_at,
    lab_id: r.lab_id,
    nama_laboratorium: r.lab_name || r.lab_id,
    nim: r.nim,
    nama_mahasiswa: r.nama || '-',
    kelas: r.kelas || '-',
    semester: r.semester ?? '-',
    status_scan: r.status === 'ok' ? 'Terdaftar (OK)' : 'Tidak Dikenal (Not Found)',
    source_record_id: r.id,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(mapped);
  ws['!cols'] = [
    { wch: 26 },
    { wch: 26 },
    { wch: 18 },
    { wch: 26 },
    { wch: 16 },
    { wch: 28 },
    { wch: 10 },
    { wch: 10 },
    { wch: 24 },
    { wch: 38 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Data Kunjungan');

  if (format === 'csv') {
    return Buffer.from(XLSX.utils.sheet_to_csv(ws), 'utf8');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Ekspor daftar inventaris ke Buffer .xlsx atau .csv
 */
function exportInventoryBuffer(rows, format = 'xlsx') {
  const mapped = rows.map((r) => ({
    kode_inventaris: r.inventory_code,
    nama_barang: r.name,
    kategori: r.category,
    lab_id: r.lab_id,
    nama_laboratorium: r.lab_name || r.lab_id,
    jumlah: r.quantity,
    satuan: r.unit,
    kondisi: r.condition,
    status: r.status,
    catatan: r.notes || '',
    diperbarui_pada: r.updated_at,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(mapped);
  ws['!cols'] = [
    { wch: 18 },
    { wch: 34 },
    { wch: 20 },
    { wch: 18 },
    { wch: 26 },
    { wch: 10 },
    { wch: 12 },
    { wch: 18 },
    { wch: 14 },
    { wch: 30 },
    { wch: 26 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Inventaris');

  if (format === 'csv') {
    return Buffer.from(XLSX.utils.sheet_to_csv(ws), 'utf8');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  TEMPLATE_COLUMNS,
  buildInventoryTemplateBuffer,
  createInventoryImportPreview,
  confirmInventoryImport,
  exportVisitLogsBuffer,
  exportInventoryBuffer,
};
