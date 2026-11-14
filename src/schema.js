'use strict';

/**
 * Skema Database Pusat (SQLite WAL)
 * Menggabungkan spesifikasi DESIGN.md & brief-penyempurnaan-website-utama-laboratorium.md:
 * - users & sessions: Autentikasi Administrator (1 role MVP, siap diperluas)
 * - labs: Identitas laboratorium/kiosk, token hash, status kesehatan sinkronisasi
 * - scans (visit_logs): Data kunjungan mahasiswa, idempoten pada (lab_id, id)
 * - ingest_batches: Audit penerimaan batch dari Lab Scan KTM
 * - inventory_items: Data inventaris peralatan laboratorium
 * - import_jobs: Pratinjau (preview) dan konfirmasi impor Excel inventaris
 * - audit_log: Catatan jejak aktivitas penting
 */
function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token  TEXT NOT NULL,
      ip_address  TEXT,
      user_agent  TEXT,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS labs (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      location              TEXT NOT NULL DEFAULT '',
      description           TEXT NOT NULL DEFAULT '',
      token_hash            TEXT NOT NULL,
      token_hint            TEXT NOT NULL DEFAULT '',
      timezone              TEXT NOT NULL DEFAULT 'Asia/Jakarta',
      active                INTEGER NOT NULL DEFAULT 1,
      last_seen_at          TEXT,
      last_sent_at          TEXT,
      last_pending_count    INTEGER NOT NULL DEFAULT 0,
      last_clock_skew_sec   INTEGER NOT NULL DEFAULT 0,
      last_source_ip        TEXT,
      last_schema_version   INTEGER,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scans (
      id           TEXT NOT NULL,
      lab_id       TEXT NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
      nim          TEXT NOT NULL,
      nama         TEXT,
      kelas        TEXT,
      semester     INTEGER,
      scanned_at   TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('ok', 'not_found')),
      received_at  TEXT NOT NULL,
      batch_id     TEXT,
      PRIMARY KEY (lab_id, id)
    );

    CREATE INDEX IF NOT EXISTS scans_scanned_at_idx  ON scans (scanned_at DESC);
    CREATE INDEX IF NOT EXISTS scans_lab_scanned_idx ON scans (lab_id, scanned_at DESC);
    CREATE INDEX IF NOT EXISTS scans_nim_idx         ON scans (nim);
    CREATE INDEX IF NOT EXISTS scans_status_idx      ON scans (status);

    CREATE TABLE IF NOT EXISTS ingest_batches (
      id              TEXT PRIMARY KEY,
      lab_id          TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      received_at     TEXT NOT NULL,
      sent_at         TEXT,
      record_count    INTEGER NOT NULL,
      accepted_count  INTEGER NOT NULL,
      duplicate_count INTEGER NOT NULL,
      rejected_count  INTEGER NOT NULL,
      pending_count   INTEGER,
      clock_skew_sec  INTEGER,
      source_ip       TEXT,
      schema_version  INTEGER
    );

    CREATE INDEX IF NOT EXISTS ingest_batches_lab_idx ON ingest_batches (lab_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS ingest_batches_rec_idx ON ingest_batches (received_at DESC);

    CREATE TABLE IF NOT EXISTS inventory_items (
      id             TEXT PRIMARY KEY,
      inventory_code TEXT UNIQUE NOT NULL,
      name           TEXT NOT NULL,
      category       TEXT NOT NULL,
      lab_id         TEXT NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
      quantity       INTEGER NOT NULL CHECK (quantity >= 0),
      unit           TEXT NOT NULL,
      condition      TEXT NOT NULL CHECK (condition IN ('Baik', 'Rusak Ringan', 'Rusak Berat', 'Dalam Perbaikan')),
      status         TEXT NOT NULL CHECK (status IN ('Aktif', 'Tidak Aktif', 'Arsip')),
      notes          TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS inventory_lab_idx       ON inventory_items (lab_id);
    CREATE INDEX IF NOT EXISTS inventory_category_idx  ON inventory_items (category);
    CREATE INDEX IF NOT EXISTS inventory_condition_idx ON inventory_items (condition);
    CREATE INDEX IF NOT EXISTS inventory_status_idx    ON inventory_items (status);

    CREATE TABLE IF NOT EXISTS import_jobs (
      id            TEXT PRIMARY KEY,
      file_name     TEXT NOT NULL,
      imported_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      total_rows    INTEGER NOT NULL DEFAULT 0,
      valid_rows    INTEGER NOT NULL DEFAULT 0,
      failed_rows   INTEGER NOT NULL DEFAULT 0,
      conflict_rows INTEGER NOT NULL DEFAULT 0,
      inserted_rows INTEGER NOT NULL DEFAULT 0,
      updated_rows  INTEGER NOT NULL DEFAULT 0,
      skipped_rows  INTEGER NOT NULL DEFAULT 0,
      conflict_mode TEXT,
      status        TEXT NOT NULL CHECK (status IN ('preview', 'confirmed', 'cancelled')),
      rows_json     TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      confirmed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS import_jobs_created_idx ON import_jobs (created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT,
      user_email  TEXT,
      action      TEXT NOT NULL,
      target      TEXT,
      detail_json TEXT,
      ip_address  TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_log_action_idx  ON audit_log (action);
  `);
}

module.exports = { applySchema };
