'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { nowIso, jakartaDateString, dayBoundsJakarta, parseIsoMs } = require('./db');
const {
  verifyPassword,
  generateLabToken,
  ensureBootstrapAdmin,
  createSession,
  getSessionFromRequest,
  destroySession,
  formatSessionCookie,
  createAuthMiddleware,
} = require('./auth');
const { recordAudit } = require('./audit');
const { createIngestHandler, LAB_ID_REGEX } = require('./ingest');
const {
  buildInventoryTemplateBuffer,
  createInventoryImportPreview,
  confirmInventoryImport,
  exportVisitLogsBuffer,
  exportInventoryBuffer,
} = require('./inventory-excel');

function computeLabHealth(lab, nowMs = Date.now()) {
  const seenMs = lab.last_seen_at ? parseIsoMs(lab.last_seen_at) : null;
  const minutesSinceSeen = seenMs !== null ? Math.max(0, Math.round((nowMs - seenMs) / 60000)) : null;

  let healthState = 'never_seen';
  if (!lab.active) {
    healthState = 'inactive';
  } else if (seenMs === null) {
    healthState = 'never_seen';
  } else if (minutesSinceSeen > config.labSilentMinutes) {
    healthState = 'silent';
  } else {
    healthState = 'online';
  }

  const silentAlert = Boolean(lab.active && seenMs !== null && minutesSinceSeen > config.labSilentMinutes);
  const backlogAlert = Boolean(lab.active && Number(lab.last_pending_count || 0) >= config.pendingBacklogWarning);
  const clockSkewAlert = Boolean(
    lab.active && Math.abs(Number(lab.last_clock_skew_sec || 0)) >= config.clockSkewAlertSeconds
  );

  return {
    health_state: healthState,
    minutes_since_seen: minutesSinceSeen,
    silent_alert: silentAlert,
    backlog_alert: backlogAlert,
    clock_skew_alert: clockSkewAlert,
  };
}

function buildKioskEnvSnippet(labId, labName, token) {
  const monitorUrl = `${config.baseUrl.replace(/\/+$/, '')}/api/lab/traffic`;
  return [
    `LAB_ID=${labId}`,
    `LAB_NAME="${labName}"`,
    `SYNC_ENABLED=true`,
    `MONITOR_URL=${monitorUrl}`,
    `MONITOR_TOKEN=${token}`,
  ].join('\n');
}

function createApp(db) {
  ensureBootstrapAdmin(db);

  const app = express();
  app.disable('x-powered-by');

  // Security headers dasar
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Body parser JSON (batas 5MB untuk menampung payload base64 file Excel saat preview impor)
  app.use(express.json({ limit: '5mb' }));

  const ingest = createIngestHandler(db);
  const requireAdmin = createAuthMiddleware(db);

  // ---------------- HEALTHCHECK ----------------
  function healthResponse(req, res) {
    const dbOk = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
    res.status(dbOk ? 200 : 500).json({
      ok: dbOk,
      service: 'lab_admin_monitor',
      version: '1.0.0',
      timezone: config.timezone,
      now: nowIso(),
    });
  }
  app.get('/healthz', healthResponse);
  app.get('/api/health', healthResponse);

  // ---------------- INGEST API (KIOSK -> PUSAT) ----------------
  app.post('/api/lab/traffic', ingest.handler);
  app.post('/api/v1/ingest', ingest.handler);

  // ---------------- AUTH API ----------------
  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    if (!email || !password) {
      res.status(400).json({ error: 'validation_error', message: 'Email dan password wajib diisi.' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      recordAudit(db, {
        userEmail: email,
        action: 'auth.login_failed',
        target: email,
        ipAddress: ip,
      });
      res.status(401).json({ error: 'invalid_credentials', message: 'Email atau password tidak sesuai.' });
      return;
    }

    const session = createSession(db, {
      userId: user.id,
      ipAddress: ip,
      userAgent: req.get('user-agent'),
    });

    const maxAgeSec = config.sessionTtlHours * 3600;
    res.set('Set-Cookie', formatSessionCookie(session.rawToken, maxAgeSec));

    recordAudit(db, {
      userId: user.id,
      userEmail: user.email,
      action: 'auth.login_success',
      target: user.email,
      ipAddress: ip,
    });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      csrf_token: session.csrfToken,
      expires_at: session.expiresMs,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = getSessionFromRequest(db, req);
    destroySession(db, req);
    res.set('Set-Cookie', formatSessionCookie('', 0));
    if (session) {
      recordAudit(db, {
        userId: session.user.id,
        userEmail: session.user.email,
        action: 'auth.logout',
        target: session.user.email,
        ipAddress: req.ip,
      });
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const session = getSessionFromRequest(db, req);
    if (!session) {
      res.status(200).json({ authenticated: false, user: null });
      return;
    }
    res.json({
      authenticated: true,
      user: session.user,
      csrf_token: session.csrfToken,
      system: {
        base_url: config.baseUrl,
        ingest_url: `${config.baseUrl.replace(/\/+$/, '')}/api/lab/traffic`,
        timezone: config.timezone,
        lab_silent_minutes: config.labSilentMinutes,
        clock_skew_alert_seconds: config.clockSkewAlertSeconds,
        pending_backlog_warning: config.pendingBacklogWarning,
        inventory_conditions: config.inventoryConditions,
        inventory_statuses: config.inventoryStatuses,
      },
    });
  });

  // ---------------- DASHBOARD & OVERVIEW ----------------
  app.get('/api/dashboard/summary', requireAdmin, (req, res) => {
    const todayStr = jakartaDateString();
    const todayBounds = dayBoundsJakarta(todayStr);

    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))
      ? String(req.query.from)
      : todayStr;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))
      ? String(req.query.to)
      : todayStr;
    const filterLabId = req.query.lab_id ? String(req.query.lab_id).trim() : '';

    const rangeStartIso = `${fromDate}T00:00:00+07:00`;
    const rangeEndIso = `${toDate}T23:59:59+07:00`;

    // Statistik hari ini
    const todaySqlFilter = filterLabId ? 'AND lab_id = ?' : '';
    const todayParams = filterLabId
      ? [todayBounds.startIso, todayBounds.endIso, filterLabId]
      : [todayBounds.startIso, todayBounds.endIso];

    const todayRow = db
      .prepare(
        `SELECT COUNT(*) AS total_scans,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_scans,
                SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS not_found_scans,
                COUNT(DISTINCT CASE WHEN status = 'ok' THEN nim END) AS unique_students
           FROM scans
          WHERE scanned_at >= ? AND scanned_at <= ? ${todaySqlFilter}`
      )
      .get(...todayParams);

    // Statistik rentang terpilih
    const rangeParams = filterLabId
      ? [rangeStartIso, rangeEndIso, filterLabId]
      : [rangeStartIso, rangeEndIso];
    const rangeRow = db
      .prepare(
        `SELECT COUNT(*) AS total_scans,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_scans,
                SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS not_found_scans,
                COUNT(DISTINCT CASE WHEN status = 'ok' THEN nim END) AS unique_students
           FROM scans
          WHERE scanned_at >= ? AND scanned_at <= ? ${todaySqlFilter}`
      )
      .get(...rangeParams);

    // Ringkasan inventaris
    const invRow = db
      .prepare(
        `SELECT COUNT(*) AS total_items,
                COALESCE(SUM(quantity), 0) AS total_units,
                SUM(CASE WHEN condition = 'Baik' THEN 1 ELSE 0 END) AS baik_count,
                SUM(CASE WHEN condition = 'Rusak Ringan' THEN 1 ELSE 0 END) AS rusak_ringan_count,
                SUM(CASE WHEN condition = 'Rusak Berat' THEN 1 ELSE 0 END) AS rusak_berat_count,
                SUM(CASE WHEN condition = 'Dalam Perbaikan' THEN 1 ELSE 0 END) AS perbaikan_count
           FROM inventory_items
          WHERE status != 'Arsip' AND deleted_at IS NULL
            ${filterLabId ? 'AND lab_id = ?' : ''}`
      )
      .get(...(filterLabId ? [filterLabId] : []));

    // Daftar lab & metrik kesehatan tiap lab
    const allLabs = db
      .prepare(
        `SELECT l.*,
                (SELECT COUNT(*) FROM scans s WHERE s.lab_id = l.id AND s.scanned_at >= ? AND s.scanned_at <= ?) AS today_scans,
                (SELECT COUNT(*) FROM scans s WHERE s.lab_id = l.id) AS total_scans,
                (SELECT COUNT(*) FROM inventory_items i WHERE i.lab_id = l.id AND i.status != 'Arsip' AND i.deleted_at IS NULL) AS inventory_count
           FROM labs l
          ORDER BY l.active DESC, l.id ASC`
      )
      .all(todayBounds.startIso, todayBounds.endIso);

    const nowMs = Date.now();
    const alerts = [];
    const labsHealth = allLabs.map((l) => {
      const h = computeLabHealth(l, nowMs);
      if (h.silent_alert) {
        alerts.push({
          type: 'lab_silent',
          severity: 'warning',
          lab_id: l.id,
          lab_name: l.name,
          message: `${l.name} (${l.id}) belum mengirim data selama ${h.minutes_since_seen} menit.`,
          at: l.last_seen_at,
        });
      }
      if (h.backlog_alert) {
        alerts.push({
          type: 'high_backlog',
          severity: 'warning',
          lab_id: l.id,
          lab_name: l.name,
          message: `${l.name} (${l.id}) memiliki antrean lokal ${l.last_pending_count} scan belum tersinkron.`,
          at: l.last_seen_at,
        });
      }
      if (h.clock_skew_alert) {
        alerts.push({
          type: 'clock_skew',
          severity: 'danger',
          lab_id: l.id,
          lab_name: l.name,
          message: `Selisih jam PC ${l.name} (${l.id}) sebesar ${l.last_clock_skew_sec} detik (> ${config.clockSkewAlertSeconds}s). Periksa sinkronisasi NTP.`,
          at: l.last_seen_at,
        });
      }
      return {
        id: l.id,
        name: l.name,
        location: l.location,
        active: Boolean(l.active),
        today_scans: l.today_scans || 0,
        total_scans: l.total_scans || 0,
        inventory_count: l.inventory_count || 0,
        last_seen_at: l.last_seen_at,
        last_sent_at: l.last_sent_at,
        last_pending_count: l.last_pending_count || 0,
        last_clock_skew_sec: l.last_clock_skew_sec || 0,
        last_source_ip: l.last_source_ip,
        ...h,
      };
    });

    const authFailures = ingest.getAuthFailures();
    if (authFailures.recent.length > 0) {
      const latestFail = authFailures.recent[0];
      alerts.push({
        type: 'auth_failure',
        severity: 'danger',
        lab_id: latestFail.labId,
        lab_name: latestFail.labId,
        message: `Terdapat ${authFailures.total} penolakan autentikasi ingest (terakhir: ${latestFail.reason} dari IP ${latestFail.ip}).`,
        at: latestFail.at,
      });
    }

    // Tren 7 hari terakhir
    const dailyTrend = [];
    for (let d = 6; d >= 0; d -= 1) {
      const dateStr = jakartaDateString(nowMs - d * 86400 * 1000);
      const bounds = dayBoundsJakarta(dateStr);
      const params = filterLabId ? [bounds.startIso, bounds.endIso, filterLabId] : [bounds.startIso, bounds.endIso];
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                  SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) AS not_found_count
             FROM scans
            WHERE scanned_at >= ? AND scanned_at <= ? ${todaySqlFilter}`
        )
        .get(...params);

      dailyTrend.push({
        date: dateStr,
        total: counts.total || 0,
        ok: counts.ok_count || 0,
        not_found: counts.not_found_count || 0,
      });
    }

    // Distribusi jam hari ini (00..23)
    const hourlyRows = db
      .prepare(
        `SELECT SUBSTR(scanned_at, 12, 2) AS hour_str,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count
           FROM scans
          WHERE scanned_at >= ? AND scanned_at <= ? ${todaySqlFilter}
          GROUP BY hour_str`
      )
      .all(...todayParams);
    const hourlyMap = new Map(hourlyRows.map((r) => [r.hour_str, r]));
    const hourlyTrend = [];
    for (let h = 0; h < 24; h += 1) {
      const key = String(h).padStart(2, '0');
      const found = hourlyMap.get(key);
      hourlyTrend.push({
        hour: `${key}:00`,
        total: found ? found.total : 0,
        ok: found ? found.ok_count || 0 : 0,
      });
    }

    // Live feed 50 scan terakhir
    const liveFeed = db
      .prepare(
        `SELECT s.id, s.lab_id, l.name AS lab_name, s.nim, s.nama, s.kelas, s.semester,
                s.scanned_at, s.received_at, s.status
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
          ${filterLabId ? 'WHERE s.lab_id = ?' : ''}
          ORDER BY s.scanned_at DESC, s.received_at DESC
          LIMIT 50`
      )
      .all(...(filterLabId ? [filterLabId] : []));

    res.json({
      server_time: nowIso(),
      today_stats: {
        date: todayStr,
        total_scans: todayRow.total_scans || 0,
        ok_scans: todayRow.ok_scans || 0,
        not_found_scans: todayRow.not_found_scans || 0,
        unique_students: todayRow.unique_students || 0,
      },
      range_stats: {
        from: fromDate,
        to: toDate,
        total_scans: rangeRow.total_scans || 0,
        ok_scans: rangeRow.ok_scans || 0,
        not_found_scans: rangeRow.not_found_scans || 0,
        unique_students: rangeRow.unique_students || 0,
      },
      inventory_summary: {
        total_items: invRow.total_items || 0,
        total_units: invRow.total_units || 0,
        baik_count: invRow.baik_count || 0,
        rusak_ringan_count: invRow.rusak_ringan_count || 0,
        rusak_berat_count: invRow.rusak_berat_count || 0,
        perbaikan_count: invRow.perbaikan_count || 0,
      },
      labs_summary: {
        total_labs: labsHealth.length,
        active_labs: labsHealth.filter((l) => l.active).length,
        online_labs: labsHealth.filter((l) => l.health_state === 'online').length,
        silent_labs: labsHealth.filter((l) => l.health_state === 'silent').length,
      },
      labs_health: labsHealth,
      alerts,
      daily_trend: dailyTrend,
      hourly_trend: hourlyTrend,
      live_feed: liveFeed,
    });
  });

  // ---------------- VISIT LOGS (DATA KUNJUNGAN) ----------------
  function buildVisitFilterQuery(query) {
    const clauses = [];
    const params = [];

    if (query.from && /^\d{4}-\d{2}-\d{2}$/.test(String(query.from))) {
      clauses.push('s.scanned_at >= ?');
      params.push(`${query.from}T00:00:00+07:00`);
    }
    if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) {
      clauses.push('s.scanned_at <= ?');
      params.push(`${query.to}T23:59:59+07:00`);
    }
    if (query.lab_id && String(query.lab_id).trim()) {
      clauses.push('s.lab_id = ?');
      params.push(String(query.lab_id).trim());
    }
    if (query.status && ['ok', 'not_found'].includes(String(query.status))) {
      clauses.push('s.status = ?');
      params.push(String(query.status));
    }
    if (query.kelas && String(query.kelas).trim()) {
      clauses.push('LOWER(s.kelas) = LOWER(?)');
      params.push(String(query.kelas).trim());
    }
    if (query.semester !== undefined && query.semester !== '') {
      const sem = Number.parseInt(query.semester, 10);
      if (Number.isFinite(sem)) {
        clauses.push('s.semester = ?');
        params.push(sem);
      }
    }
    if (query.q && String(query.q).trim()) {
      const like = `%${String(query.q).trim()}%`;
      clauses.push('(s.nim LIKE ? OR COALESCE(s.nama, \'\') LIKE ? OR s.id LIKE ?)');
      params.push(like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { whereSql, params };
  }

  app.get('/api/visit-logs', requireAdmin, (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const { whereSql, params } = buildVisitFilterQuery(req.query);

    const countRow = db
      .prepare(`SELECT COUNT(*) AS total FROM scans s ${whereSql}`)
      .get(...params);

    const rows = db
      .prepare(
        `SELECT s.id, s.lab_id, l.name AS lab_name, l.location AS lab_location,
                s.nim, s.nama, s.kelas, s.semester,
                s.scanned_at, s.received_at, s.status, s.batch_id
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
           ${whereSql}
          ORDER BY s.scanned_at DESC, s.received_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    res.json({
      items: rows,
      pagination: {
        page,
        limit,
        total: countRow.total || 0,
        total_pages: Math.max(1, Math.ceil((countRow.total || 0) / limit)),
      },
    });
  });

  app.get('/api/visit-logs/export', requireAdmin, (req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const { whereSql, params } = buildVisitFilterQuery(req.query);

    const rows = db
      .prepare(
        `SELECT s.id, s.lab_id, l.name AS lab_name, s.nim, s.nama, s.kelas, s.semester,
                s.scanned_at, s.received_at, s.status
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
           ${whereSql}
          ORDER BY s.scanned_at DESC
          LIMIT 10000`
      )
      .all(...params);

    const buf = exportVisitLogsBuffer(rows, format);
    const dateTag = jakartaDateString();

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'visit_logs.export',
      target: format,
      detail: { row_count: rows.length, filters: req.query },
      ipAddress: req.ip,
    });

    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="data-kunjungan-lab-${dateTag}.csv"`);
    } else {
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="data-kunjungan-lab-${dateTag}.xlsx"`);
    }
    res.send(buf);
  });

  app.get('/api/visit-logs/:labId/:id', requireAdmin, (req, res) => {
    const labId = String(req.params.labId || '').trim();
    const id = String(req.params.id || '').trim();

    const row = db
      .prepare(
        `SELECT s.*, l.name AS lab_name, l.location AS lab_location,
                b.sent_at AS batch_sent_at, b.record_count AS batch_record_count,
                b.duplicate_count AS batch_duplicate_count, b.source_ip AS batch_source_ip,
                b.clock_skew_sec AS batch_clock_skew_sec
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
           LEFT JOIN ingest_batches b ON b.id = s.batch_id
          WHERE s.lab_id = ? AND s.id = ?`
      )
      .get(labId, id);

    if (!row) {
      res.status(404).json({ error: 'not_found', message: 'Catatan kunjungan tidak ditemukan.' });
      return;
    }

    const recentByStudent = db
      .prepare(
        `SELECT s.id, s.lab_id, l.name AS lab_name, s.scanned_at, s.received_at, s.status
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
          WHERE s.nim = ?
          ORDER BY s.scanned_at DESC
          LIMIT 15`
      )
      .all(row.nim);

    res.json({
      visit: row,
      student_recent_visits: recentByStudent,
    });
  });

  app.get('/api/students/:nim/visits', requireAdmin, (req, res) => {
    const nim = String(req.params.nim || '').trim();
    const visits = db
      .prepare(
        `SELECT s.id, s.lab_id, l.name AS lab_name, s.nim, s.nama, s.kelas, s.semester,
                s.scanned_at, s.received_at, s.status
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
          WHERE s.nim = ?
          ORDER BY s.scanned_at DESC
          LIMIT 100`
      )
      .all(nim);

    const byLab = db
      .prepare(
        `SELECT s.lab_id, l.name AS lab_name, COUNT(*) AS visit_count, MAX(s.scanned_at) AS last_visit_at
           FROM scans s
           LEFT JOIN labs l ON l.id = s.lab_id
          WHERE s.nim = ?
          GROUP BY s.lab_id
          ORDER BY visit_count DESC`
      )
      .all(nim);

    const latestProfile = visits.find((v) => v.nama) || visits[0] || null;

    res.json({
      nim,
      student: latestProfile
        ? {
            nim,
            nama: latestProfile.nama,
            kelas: latestProfile.kelas,
            semester: latestProfile.semester,
          }
        : { nim, nama: null, kelas: null, semester: null },
      total_visits: visits.length,
      labs_breakdown: byLab,
      visits,
    });
  });

  // ---------------- LABORATORIES & TOKEN MANAGEMENT ----------------
  app.get('/api/laboratories', requireAdmin, (req, res) => {
    const todayBounds = dayBoundsJakarta();
    const rows = db
      .prepare(
        `SELECT l.id, l.name, l.location, l.description, l.token_hint, l.timezone,
                l.active, l.last_seen_at, l.last_sent_at, l.last_pending_count,
                l.last_clock_skew_sec, l.last_source_ip, l.created_at, l.updated_at,
                (SELECT COUNT(*) FROM scans s WHERE s.lab_id = l.id) AS total_scans,
                (SELECT COUNT(*) FROM scans s WHERE s.lab_id = l.id AND s.scanned_at >= ? AND s.scanned_at <= ?) AS today_scans,
                (SELECT COUNT(*) FROM inventory_items i WHERE i.lab_id = l.id AND i.status != 'Arsip' AND i.deleted_at IS NULL) AS inventory_count,
                (SELECT COUNT(*) FROM ingest_batches b WHERE b.lab_id = l.id) AS total_batches
           FROM labs l
          ORDER BY l.active DESC, l.id ASC`
      )
      .all(todayBounds.startIso, todayBounds.endIso);

    const nowMs = Date.now();
    const items = rows.map((r) => ({
      ...r,
      active: Boolean(r.active),
      ...computeLabHealth(r, nowMs),
    }));

    res.json({ items });
  });

  app.post('/api/laboratories', requireAdmin, (req, res) => {
    const id = String(req.body?.id || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const location = String(req.body?.location || '').trim();
    const description = String(req.body?.description || '').trim();

    if (!id || !LAB_ID_REGEX.test(id)) {
      res.status(400).json({
        error: 'invalid_lab_id',
        message: 'lab_id wajib berupa huruf kecil/angka/strip (contoh: lab-jaringan-1).',
      });
      return;
    }

    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'Nama laboratorium wajib diisi.' });
      return;
    }

    const exists = db.prepare('SELECT 1 FROM labs WHERE id = ?').get(id);
    if (exists) {
      res.status(409).json({
        error: 'duplicate_lab_id',
        message: `Laboratorium dengan lab_id '${id}' sudah terdaftar.`,
      });
      return;
    }

    const { token, tokenHash, tokenHint } = generateLabToken();
    const now = nowIso();

    db.prepare(`
      INSERT INTO labs (
        id, name, location, description, token_hash, token_hint, timezone, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, location, description, tokenHash, tokenHint, config.timezone, now, now);

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'lab.create',
      target: id,
      detail: { name, location, token_hint: tokenHint },
      ipAddress: req.ip,
    });

    res.status(201).json({
      laboratory: {
        id,
        name,
        location,
        description,
        token_hint: tokenHint,
        timezone: config.timezone,
        active: true,
        created_at: now,
      },
      token_once: token,
      kiosk_env_snippet: buildKioskEnvSnippet(id, name, token),
    });
  });

  app.get('/api/laboratories/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const lab = db
      .prepare(
        `SELECT id, name, location, description, token_hint, timezone, active,
                last_seen_at, last_sent_at, last_pending_count, last_clock_skew_sec,
                last_source_ip, last_schema_version, created_at, updated_at
           FROM labs WHERE id = ?`
      )
      .get(id);

    if (!lab) {
      res.status(404).json({ error: 'not_found', message: 'Laboratorium tidak ditemukan.' });
      return;
    }

    const recentBatches = db
      .prepare(
        `SELECT * FROM ingest_batches
          WHERE lab_id = ?
          ORDER BY received_at DESC
          LIMIT 20`
      )
      .all(id);

    res.json({
      laboratory: {
        ...lab,
        active: Boolean(lab.active),
        ...computeLabHealth(lab),
      },
      recent_batches: recentBatches,
    });
  });

  app.patch('/api/laboratories/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT * FROM labs WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: 'Laboratorium tidak ditemukan.' });
      return;
    }

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const location = req.body?.location !== undefined ? String(req.body.location).trim() : existing.location;
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : existing.description;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

    if (!name) {
      res.status(400).json({ error: 'invalid_name', message: 'Nama laboratorium tidak boleh kosong.' });
      return;
    }

    const now = nowIso();
    db.prepare(`
      UPDATE labs
         SET name = ?, location = ?, description = ?, active = ?, updated_at = ?
       WHERE id = ?
    `).run(name, location, description, active, now, id);

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'lab.update',
      target: id,
      detail: { name, location, active: Boolean(active) },
      ipAddress: req.ip,
    });

    res.json({
      laboratory: {
        id,
        name,
        location,
        description,
        token_hint: existing.token_hint,
        active: Boolean(active),
        updated_at: now,
      },
    });
  });

  app.post('/api/laboratories/:id/rotate-token', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT * FROM labs WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: 'Laboratorium tidak ditemukan.' });
      return;
    }

    const { token, tokenHash, tokenHint } = generateLabToken();
    const now = nowIso();

    db.prepare('UPDATE labs SET token_hash = ?, token_hint = ?, updated_at = ? WHERE id = ?').run(
      tokenHash,
      tokenHint,
      now,
      id
    );

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'lab.rotate_token',
      target: id,
      detail: { token_hint: tokenHint },
      ipAddress: req.ip,
    });

    res.json({
      lab_id: id,
      lab_name: existing.name,
      token_hint: tokenHint,
      token_once: token,
      kiosk_env_snippet: buildKioskEnvSnippet(id, existing.name, token),
      rotated_at: now,
    });
  });

  // ---------------- INVENTORY CRUD ----------------
  function buildInventoryFilterQuery(query) {
    const clauses = [];
    const params = [];

    if (query.include_archived !== 'true') {
      clauses.push("i.status != 'Arsip' AND i.deleted_at IS NULL");
    }
    if (query.lab_id && String(query.lab_id).trim()) {
      clauses.push('i.lab_id = ?');
      params.push(String(query.lab_id).trim());
    }
    if (query.category && String(query.category).trim()) {
      clauses.push('LOWER(i.category) = LOWER(?)');
      params.push(String(query.category).trim());
    }
    if (query.condition && config.inventoryConditions.includes(String(query.condition))) {
      clauses.push('i.condition = ?');
      params.push(String(query.condition));
    }
    if (query.status && config.inventoryStatuses.includes(String(query.status))) {
      clauses.push('i.status = ?');
      params.push(String(query.status));
    }
    if (query.q && String(query.q).trim()) {
      const like = `%${String(query.q).trim()}%`;
      clauses.push('(i.inventory_code LIKE ? OR i.name LIKE ? OR i.category LIKE ? OR i.notes LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return { whereSql, params };
  }

  app.get('/api/inventory', requireAdmin, (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const { whereSql, params } = buildInventoryFilterQuery(req.query);

    const countRow = db
      .prepare(`SELECT COUNT(*) AS total FROM inventory_items i ${whereSql}`)
      .get(...params);

    const rows = db
      .prepare(
        `SELECT i.*, l.name AS lab_name
           FROM inventory_items i
           LEFT JOIN labs l ON l.id = i.lab_id
           ${whereSql}
          ORDER BY i.updated_at DESC, i.inventory_code ASC
          LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const categories = db
      .prepare(
        `SELECT DISTINCT category FROM inventory_items WHERE status != 'Arsip' AND deleted_at IS NULL ORDER BY category ASC`
      )
      .all()
      .map((r) => r.category);

    res.json({
      items: rows,
      categories,
      pagination: {
        page,
        limit,
        total: countRow.total || 0,
        total_pages: Math.max(1, Math.ceil((countRow.total || 0) / limit)),
      },
    });
  });

  app.get('/api/inventory/export', requireAdmin, (req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const { whereSql, params } = buildInventoryFilterQuery(req.query);

    const rows = db
      .prepare(
        `SELECT i.*, l.name AS lab_name
           FROM inventory_items i
           LEFT JOIN labs l ON l.id = i.lab_id
           ${whereSql}
          ORDER BY i.inventory_code ASC
          LIMIT 10000`
      )
      .all(...params);

    const buf = exportInventoryBuffer(rows, format);
    const dateTag = jakartaDateString();

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'inventory.export',
      target: format,
      detail: { row_count: rows.length },
      ipAddress: req.ip,
    });

    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="inventaris-lab-${dateTag}.csv"`);
    } else {
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="inventaris-lab-${dateTag}.xlsx"`);
    }
    res.send(buf);
  });

  app.post('/api/inventory', requireAdmin, (req, res) => {
    const inventoryCode = String(req.body?.inventory_code || req.body?.kode_inventaris || '').trim();
    const name = String(req.body?.name || req.body?.nama_barang || '').trim();
    const category = String(req.body?.category || req.body?.kategori || '').trim();
    const labId = String(req.body?.lab_id || '').trim();
    const quantityRaw = req.body?.quantity ?? req.body?.jumlah;
    const unit = String(req.body?.unit || req.body?.satuan || '').trim();
    const condition = String(req.body?.condition || req.body?.kondisi || 'Baik').trim();
    const status = String(req.body?.status || 'Aktif').trim();
    const notes = String(req.body?.notes || req.body?.catatan || '').trim();

    if (!inventoryCode || !name || !category || !labId || !unit) {
      res.status(400).json({
        error: 'validation_error',
        message: 'Kode inventaris, nama barang, kategori, laboratorium, dan satuan wajib diisi.',
      });
      return;
    }

    const quantity = Number.parseInt(quantityRaw, 10);
    if (!Number.isFinite(quantity) || quantity < 0 || String(quantity) !== String(quantityRaw).trim()) {
      res.status(400).json({ error: 'invalid_quantity', message: 'Jumlah barang harus berupa bilangan bulat >= 0.' });
      return;
    }

    if (!config.inventoryConditions.includes(condition)) {
      res.status(400).json({
        error: 'invalid_condition',
        message: `Kondisi harus salah satu dari: ${config.inventoryConditions.join(', ')}`,
      });
      return;
    }

    if (!config.inventoryStatuses.includes(status)) {
      res.status(400).json({
        error: 'invalid_status',
        message: `Status harus salah satu dari: ${config.inventoryStatuses.join(', ')}`,
      });
      return;
    }

    const labExists = db.prepare('SELECT id, name FROM labs WHERE id = ?').get(labId);
    if (!labExists) {
      res.status(400).json({
        error: 'invalid_lab_id',
        message: `Laboratorium '${labId}' tidak terdaftar.`,
      });
      return;
    }

    const dup = db
      .prepare('SELECT id FROM inventory_items WHERE LOWER(inventory_code) = LOWER(?)')
      .get(inventoryCode);
    if (dup) {
      res.status(409).json({
        error: 'duplicate_inventory_code',
        message: `Kode inventaris '${inventoryCode}' sudah digunakan.`,
      });
      return;
    }

    const id = crypto.randomUUID();
    const now = nowIso();

    db.prepare(`
      INSERT INTO inventory_items (
        id, inventory_code, name, category, lab_id, quantity, unit,
        condition, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, inventoryCode, name, category, labId, quantity, unit, condition, status, notes, now, now);

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'inventory.create',
      target: inventoryCode,
      detail: { id, name, lab_id: labId, quantity, condition },
      ipAddress: req.ip,
    });

    const created = db
      .prepare(
        `SELECT i.*, l.name AS lab_name
           FROM inventory_items i
           LEFT JOIN labs l ON l.id = i.lab_id
          WHERE i.id = ?`
      )
      .get(id);

    res.status(201).json({ item: created });
  });

  app.get('/api/inventory/template', requireAdmin, (req, res) => {
    const buf = buildInventoryTemplateBuffer(db);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="template-impor-inventaris-lab.xlsx"');
    res.send(buf);
  });

  app.post(
    '/api/inventory/import/preview',
    requireAdmin,
    express.raw({
      type: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
        'application/octet-stream',
      ],
      limit: '5mb',
    }),
    (req, res) => {
      let buffer = null;
      let fileName = req.get('x-file-name') || 'inventaris.xlsx';

      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        buffer = req.body;
      } else if (req.body && typeof req.body === 'object' && typeof req.body.file_base64 === 'string') {
        fileName = req.body.file_name || fileName;
        buffer = Buffer.from(req.body.file_base64, 'base64');
      }

      if (!buffer || buffer.length === 0) {
        res.status(400).json({
          error: 'empty_file',
          message: 'File Excel belum dipilih atau kosong.',
        });
        return;
      }

      try {
        const preview = createInventoryImportPreview(db, {
          buffer,
          fileName,
          userId: req.auth.user.id,
        });

        recordAudit(db, {
          userId: req.auth.user.id,
          userEmail: req.auth.user.email,
          action: 'inventory.import_preview',
          target: preview.job_id,
          detail: {
            file_name: preview.file_name,
            total_rows: preview.total_rows,
            valid_rows: preview.valid_rows,
            conflict_rows: preview.conflict_rows,
            failed_rows: preview.failed_rows,
          },
          ipAddress: req.ip,
        });

        res.json(preview);
      } catch (err) {
        res.status(400).json({
          error: err.code || 'import_preview_error',
          message: err.message || 'Gagal memvalidasi file Excel.',
        });
      }
    }
  );

  app.post('/api/inventory/import/confirm', requireAdmin, (req, res) => {
    const jobId = String(req.body?.job_id || '').trim();
    const conflictMode = String(req.body?.conflict_mode || 'insert_only').trim();

    if (!jobId) {
      res.status(400).json({ error: 'missing_job_id', message: 'job_id wajib disertakan.' });
      return;
    }

    try {
      const summary = confirmInventoryImport(db, { jobId, conflictMode });

      recordAudit(db, {
        userId: req.auth.user.id,
        userEmail: req.auth.user.email,
        action: 'inventory.import_confirm',
        target: jobId,
        detail: summary,
        ipAddress: req.ip,
      });

      res.json(summary);
    } catch (err) {
      const status = err.code === 'JOB_NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        error: err.code || 'import_confirm_error',
        message: err.message || 'Gagal mengonfirmasi impor inventaris.',
      });
    }
  });

  app.get('/api/inventory/imports', requireAdmin, (req, res) => {
    const jobs = db
      .prepare(
        `SELECT j.id, j.file_name, j.imported_by, u.email AS imported_by_email,
                j.total_rows, j.valid_rows, j.failed_rows, j.conflict_rows,
                j.inserted_rows, j.updated_rows, j.skipped_rows,
                j.conflict_mode, j.status, j.created_at, j.confirmed_at
           FROM import_jobs j
           LEFT JOIN users u ON u.id = j.imported_by
          ORDER BY j.created_at DESC
          LIMIT 30`
      )
      .all();

    res.json({ items: jobs });
  });

  app.get('/api/inventory/imports/:id', requireAdmin, (req, res) => {
    const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(String(req.params.id || ''));
    if (!job) {
      res.status(404).json({ error: 'not_found', message: 'Job impor tidak ditemukan.' });
      return;
    }
    res.json({
      ...job,
      rows: JSON.parse(job.rows_json || '[]'),
      rows_json: undefined,
    });
  });

  app.get('/api/inventory/:id', requireAdmin, (req, res) => {
    const item = db
      .prepare(
        `SELECT i.*, l.name AS lab_name
           FROM inventory_items i
           LEFT JOIN labs l ON l.id = i.lab_id
          WHERE i.id = ?`
      )
      .get(String(req.params.id || ''));

    if (!item) {
      res.status(404).json({ error: 'not_found', message: 'Item inventaris tidak ditemukan.' });
      return;
    }
    res.json({ item });
  });

  app.patch('/api/inventory/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: 'Item inventaris tidak ditemukan.' });
      return;
    }

    const inventoryCode = req.body?.inventory_code !== undefined
      ? String(req.body.inventory_code).trim()
      : existing.inventory_code;
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const category = req.body?.category !== undefined ? String(req.body.category).trim() : existing.category;
    const labId = req.body?.lab_id !== undefined ? String(req.body.lab_id).trim() : existing.lab_id;
    const quantity = req.body?.quantity !== undefined ? Number.parseInt(req.body.quantity, 10) : existing.quantity;
    const unit = req.body?.unit !== undefined ? String(req.body.unit).trim() : existing.unit;
    const condition = req.body?.condition !== undefined ? String(req.body.condition).trim() : existing.condition;
    const status = req.body?.status !== undefined ? String(req.body.status).trim() : existing.status;
    const notes = req.body?.notes !== undefined ? String(req.body.notes).trim() : existing.notes;

    if (!inventoryCode || !name || !category || !labId || !unit) {
      res.status(400).json({ error: 'validation_error', message: 'Field wajib inventaris tidak boleh kosong.' });
      return;
    }

    if (!Number.isFinite(quantity) || quantity < 0) {
      res.status(400).json({ error: 'invalid_quantity', message: 'Jumlah barang minimal 0.' });
      return;
    }

    if (!config.inventoryConditions.includes(condition)) {
      res.status(400).json({ error: 'invalid_condition', message: 'Kondisi barang tidak valid.' });
      return;
    }

    if (!config.inventoryStatuses.includes(status)) {
      res.status(400).json({ error: 'invalid_status', message: 'Status barang tidak valid.' });
      return;
    }

    const labExists = db.prepare('SELECT 1 FROM labs WHERE id = ?').get(labId);
    if (!labExists) {
      res.status(400).json({ error: 'invalid_lab_id', message: `Laboratorium '${labId}' tidak terdaftar.` });
      return;
    }

    const dup = db
      .prepare('SELECT id FROM inventory_items WHERE LOWER(inventory_code) = LOWER(?) AND id != ?')
      .get(inventoryCode, id);
    if (dup) {
      res.status(409).json({
        error: 'duplicate_inventory_code',
        message: `Kode inventaris '${inventoryCode}' sudah digunakan item lain.`,
      });
      return;
    }

    const now = nowIso();
    const deletedAt = status === 'Arsip' ? existing.deleted_at || now : null;

    db.prepare(`
      UPDATE inventory_items
         SET inventory_code = ?, name = ?, category = ?, lab_id = ?, quantity = ?,
             unit = ?, condition = ?, status = ?, notes = ?, updated_at = ?, deleted_at = ?
       WHERE id = ?
    `).run(inventoryCode, name, category, labId, quantity, unit, condition, status, notes, now, deletedAt, id);

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'inventory.update',
      target: inventoryCode,
      detail: { id, name, lab_id: labId, quantity, condition, status },
      ipAddress: req.ip,
    });

    const updated = db
      .prepare(
        `SELECT i.*, l.name AS lab_name
           FROM inventory_items i
           LEFT JOIN labs l ON l.id = i.lab_id
          WHERE i.id = ?`
      )
      .get(id);

    res.json({ item: updated });
  });

  app.delete('/api/inventory/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'not_found', message: 'Item inventaris tidak ditemukan.' });
      return;
    }

    const now = nowIso();
    db.prepare("UPDATE inventory_items SET status = 'Arsip', deleted_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      id
    );

    recordAudit(db, {
      userId: req.auth.user.id,
      userEmail: req.auth.user.email,
      action: 'inventory.archive',
      target: existing.inventory_code,
      detail: { id, name: existing.name },
      ipAddress: req.ip,
    });

    res.json({ ok: true, id, status: 'Arsip' });
  });

  // ---------------- AUDIT LOG & INGEST BATCHES ----------------
  app.get('/api/audit-logs', requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const logs = db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((l) => ({
        ...l,
        detail: l.detail_json ? JSON.parse(l.detail_json) : null,
        detail_json: undefined,
      }));

    const batches = db
      .prepare(
        `SELECT b.*, l.name AS lab_name
           FROM ingest_batches b
           LEFT JOIN labs l ON l.id = b.lab_id
          ORDER BY b.received_at DESC
          LIMIT 50`
      )
      .all();

    res.json({ audit_logs: logs, ingest_batches: batches });
  });

  // ---------------- ROUTE HALAMAN PORTAL LOGIN & KONSOL DASHBOARD ----------------
  const publicDir = path.join(config.rootDir, 'public');
  const ADMIN_PAGE_ROUTES = ['/dashboard', '/visits', '/laboratories', '/inventory', '/import-audit'];

  // Root '/' mengarahkan ke /dashboard jika sudah login, atau /login jika belum
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = getSessionFromRequest(db, req);
    if (session) {
      res.redirect(302, '/dashboard');
      return;
    }
    res.redirect(302, '/login');
  });

  // Portal Login (/login): jika sudah login, langsung arahkan ke /dashboard
  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = getSessionFromRequest(db, req);
    if (session) {
      const nextParam = String(req.query.next || '');
      const target = ADMIN_PAGE_ROUTES.includes(nextParam) ? nextParam : '/dashboard';
      res.redirect(302, target);
      return;
    }
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  // Halaman Konsol Admin Terproteksi Server
  app.get(ADMIN_PAGE_ROUTES, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = getSessionFromRequest(db, req);
    if (!session) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.path)}`);
      return;
    }
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // Cegah akses langsung ke file template HTML mentah
  app.get(['/login.html', '/dashboard.html', '/index.html'], (req, res) => {
    res.redirect(302, '/');
  });

  // Asset statis (CSS, JS) tanpa auto-index
  app.use(express.static(publicDir, { index: false }));

  // Fallback untuk route yang tidak dikenal
  app.use((req, res, _next) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'not_found', message: 'Endpoint API tidak ditemukan.' });
      return;
    }
    const session = getSessionFromRequest(db, req);
    res.redirect(302, session ? '/dashboard' : '/login');
  });

  // Error handler global
  app.use((err, req, res, _next) => {
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Ukuran request melebihi batas maksimum.' });
      return;
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      res.status(400).json({ error: 'invalid_json', message: 'Format JSON tidak valid.' });
      return;
    }
    console.error('[server error]', err);
    res.status(500).json({ error: 'internal_server_error', message: 'Terjadi kesalahan internal pada server.' });
  });

  return app;
}

module.exports = { createApp };
