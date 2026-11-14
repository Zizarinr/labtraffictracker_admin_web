'use strict';

require('dotenv').config({ quiet: true });
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function intEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const port = intEnv('PORT', 4000);
const host = process.env.HOST || '127.0.0.1';

module.exports = {
  rootDir: ROOT_DIR,
  port,
  host,
  baseUrl: process.env.BASE_URL || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
  timezone: process.env.APP_TIMEZONE || 'Asia/Jakarta',
  dbPath: path.resolve(ROOT_DIR, process.env.DB_PATH || 'data/central.db'),
  backupDir: path.resolve(ROOT_DIR, process.env.BACKUP_DIR || 'backups'),
  logDir: path.resolve(ROOT_DIR, process.env.LOG_DIR || 'logs'),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'lab_central_sid',
  sessionTtlHours: intEnv('SESSION_TTL_HOURS', 24),
  tokenPepper: process.env.TOKEN_PEPPER || 'lab-central-default-pepper-change-in-prod',
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@lab.kampus.ac.id').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'AdminLab!2026',
  adminName: process.env.ADMIN_NAME || 'Administrator Utama',
  labSilentMinutes: intEnv('LAB_SILENT_MINUTES', 15),
  clockSkewAlertSeconds: intEnv('CLOCK_SKEW_ALERT_SECONDS', 300),
  pendingBacklogWarning: intEnv('PENDING_BACKLOG_WARNING', 50),
  ingestRateLimitPerMin: intEnv('INGEST_RATE_LIMIT_PER_MIN', 120),
  maxIngestRecords: intEnv('MAX_INGEST_RECORDS', 500),
  inventoryConditions: ['Baik', 'Rusak Ringan', 'Rusak Berat', 'Dalam Perbaikan'],
  inventoryStatuses: ['Aktif', 'Tidak Aktif', 'Arsip'],
};
