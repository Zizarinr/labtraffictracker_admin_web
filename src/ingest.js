'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { nowIso, parseIsoMs } = require('./db');
const { verifyLabToken } = require('./auth');
const { recordAudit } = require('./audit');

const LAB_ID_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/**
 * Buat handler ingest untuk `POST /api/lab/traffic` (dan `/api/v1/ingest`).
 * Mengikuti kontrak ketat `docs/api.md` & `DESIGN.md`:
 * - Lab harus terdaftar dan aktif (tidak auto-register).
 * - Token Bearer harus cocok dengan `labs.token_hash` untuk `lab_id` tersebut.
 * - Idempoten pada `(lab_id, id)`.
 * - `accepted` WAJIB memuat id baru DAN id duplikat yang sudah ada di DB.
 */
function createIngestHandler(db) {
  // Rate limiter sederhana di memori per lab_id / IP (jendela 60 detik)
  const rateWindows = new Map();
  // Penghitung kegagalan token beruntun untuk audit/alert
  const authFailures = { total: 0, recent: [] };

  function checkRateLimit(key) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    let entry = rateWindows.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      rateWindows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > config.ingestRateLimitPerMin) {
      const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true, retryAfter: 0 };
  }

  function recordAuthFailure(ip, labId, reason) {
    const at = nowIso();
    authFailures.total += 1;
    authFailures.recent.unshift({ at, ip, labId: labId || '-', reason });
    if (authFailures.recent.length > 50) authFailures.recent.length = 50;
    recordAudit(db, {
      action: 'ingest.auth_failed',
      target: labId || 'unknown',
      detail: { reason },
      ipAddress: ip,
    });
  }

  const findLabStmt = db.prepare('SELECT * FROM labs WHERE id = ?');
  const checkScanExistsStmt = db.prepare('SELECT 1 FROM scans WHERE lab_id = ? AND id = ?');
  const insertScanStmt = db.prepare(`
    INSERT OR IGNORE INTO scans (id, lab_id, nim, nama, kelas, semester, scanned_at, status, received_at, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateLabSeenStmt = db.prepare(`
    UPDATE labs
       SET name = ?,
           last_seen_at = ?,
           last_sent_at = ?,
           last_pending_count = ?,
           last_clock_skew_sec = ?,
           last_source_ip = ?,
           last_schema_version = ?,
           updated_at = ?
     WHERE id = ?
  `);
  const insertBatchStmt = db.prepare(`
    INSERT INTO ingest_batches (
      id, lab_id, received_at, sent_at, record_count,
      accepted_count, duplicate_count, rejected_count,
      pending_count, clock_skew_sec, source_ip, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const processBatchTx = db.transaction(
    ({ lab, records, receivedAt, sentAt, reportedPendingCount, clockSkewSec, sourceIp, schemaVersion }) => {
      const batchId = crypto.randomUUID();
      const accepted = [];
      const duplicates = [];
      const rejected = [];

      for (let i = 0; i < records.length; i += 1) {
        const rec = records[i];
        if (!rec || typeof rec !== 'object') {
          rejected.push(`index:${i}`);
          continue;
        }

        const id = rec.id !== undefined && rec.id !== null ? String(rec.id).trim() : '';
        const nim = rec.nim !== undefined && rec.nim !== null ? String(rec.nim).trim() : '';
        const scannedAt = rec.scanned_at !== undefined && rec.scanned_at !== null ? String(rec.scanned_at).trim() : '';
        const status = rec.status === 'not_found' ? 'not_found' : rec.status === 'ok' ? 'ok' : '';

        if (!id || id.length > 128 || !nim || nim.length > 64 || !scannedAt || !parseIsoMs(scannedAt) || !status) {
          rejected.push(id || `index:${i}`);
          continue;
        }

        const nama = rec.nama !== undefined && rec.nama !== null && String(rec.nama).trim() !== ''
          ? String(rec.nama).trim().slice(0, 160)
          : null;
        const kelas = rec.kelas !== undefined && rec.kelas !== null && String(rec.kelas).trim() !== ''
          ? String(rec.kelas).trim().slice(0, 32)
          : null;
        const semesterRaw = rec.semester !== undefined && rec.semester !== null && rec.semester !== ''
          ? Number.parseInt(rec.semester, 10)
          : null;
        const semester = Number.isFinite(semesterRaw) ? semesterRaw : null;

        const alreadyExists = Boolean(checkScanExistsStmt.get(lab.id, id));
        if (alreadyExists) {
          duplicates.push(id);
          accepted.push(id);
        } else {
          insertScanStmt.run(id, lab.id, nim, nama, kelas, semester, scannedAt, status, receivedAt, batchId);
          accepted.push(id);
        }
      }

      const remainingPending = Math.max(0, reportedPendingCount - accepted.length);
      const displayLabName = lab.nameOverride || lab.name;
      updateLabSeenStmt.run(
        displayLabName,
        receivedAt,
        sentAt,
        remainingPending,
        clockSkewSec,
        sourceIp,
        schemaVersion,
        receivedAt,
        lab.id
      );

      insertBatchStmt.run(
        batchId,
        lab.id,
        receivedAt,
        sentAt,
        records.length,
        accepted.length,
        duplicates.length,
        rejected.length,
        reportedPendingCount,
        clockSkewSec,
        sourceIp,
        schemaVersion
      );

      return { batchId, accepted, duplicates, rejected };
    }
  );

  function handler(req, res) {
    const sourceIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const authHeader = req.get('authorization') || '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      recordAuthFailure(sourceIp, req.body?.lab_id, 'missing_bearer_header');
      res.status(401).json({ error: 'unauthorized', message: 'Header Authorization Bearer wajib disertakan.' });
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      recordAuthFailure(sourceIp, req.body?.lab_id, 'empty_bearer_token');
      res.status(401).json({ error: 'unauthorized', message: 'Token Bearer kosong.' });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'bad_request', message: 'Body harus berupa objek JSON.' });
      return;
    }

    const schemaVersion = Number(body.schema_version);
    if (schemaVersion !== 1) {
      res.status(400).json({ error: 'unsupported_schema', message: 'Hanya schema_version = 1 yang didukung.' });
      return;
    }

    const labId = typeof body.lab_id === 'string' ? body.lab_id.trim() : '';
    if (!labId || !LAB_ID_REGEX.test(labId)) {
      res.status(400).json({ error: 'invalid_lab_id', message: 'Field lab_id wajib diisi dan valid.' });
      return;
    }

    // Rate limit per lab_id
    const rate = checkRateLimit(`${labId}:${sourceIp}`);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter));
      res.status(429).json({ error: 'rate_limited', retry_after: rate.retryAfter });
      return;
    }

    const labRow = findLabStmt.get(labId);
    if (!labRow) {
      recordAuthFailure(sourceIp, labId, 'lab_not_registered');
      res.status(403).json({
        error: 'lab_not_registered',
        message: `Laboratorium '${labId}' belum terdaftar di sistem pusat.`,
      });
      return;
    }

    if (!labRow.active) {
      recordAuthFailure(sourceIp, labId, 'lab_inactive');
      res.status(403).json({
        error: 'lab_inactive',
        message: `Laboratorium '${labId}' sedang dinonaktifkan oleh administrator.`,
      });
      return;
    }

    if (!verifyLabToken(token, labRow.token_hash)) {
      recordAuthFailure(sourceIp, labId, 'token_mismatch');
      res.status(401).json({
        error: 'invalid_token',
        message: 'Token tidak sah untuk lab_id yang dikirim.',
      });
      return;
    }

    if (!Array.isArray(body.records)) {
      res.status(400).json({ error: 'invalid_records', message: 'Field records harus berupa array.' });
      return;
    }

    if (body.records.length > config.maxIngestRecords) {
      res.status(413).json({
        error: 'batch_too_large',
        message: `Ukuran batch melebihi batas maksimum (${config.maxIngestRecords} record).`,
      });
      return;
    }

    const receivedMs = Date.now();
    const receivedAt = nowIso();
    const sentAt = typeof body.sent_at === 'string' && parseIsoMs(body.sent_at) ? body.sent_at.trim() : null;
    const sentMs = sentAt ? parseIsoMs(sentAt) : null;
    const clockSkewSec = sentMs !== null ? Math.round((receivedMs - sentMs) / 1000) : 0;

    const pendingCountRaw = Number(body.pending_count);
    const reportedPendingCount = Number.isFinite(pendingCountRaw) && pendingCountRaw >= 0
      ? Math.round(pendingCountRaw)
      : body.records.length;

    const incomingLabName = typeof body.lab === 'string' && body.lab.trim() ? body.lab.trim().slice(0, 120) : null;

    const result = processBatchTx({
      lab: {
        id: labRow.id,
        name: labRow.name,
        nameOverride: incomingLabName || labRow.name,
      },
      records: body.records,
      receivedAt,
      sentAt,
      reportedPendingCount,
      clockSkewSec,
      sourceIp,
      schemaVersion,
    });

    res.status(200).json({
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected,
    });
  }

  return {
    handler,
    getAuthFailures: () => authFailures,
  };
}

module.exports = { createIngestHandler, LAB_ID_REGEX };
