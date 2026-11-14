'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');
const { applySchema } = require('./schema');

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Format Date atau epoch ms ke string ISO 8601 dengan offset +07:00 (Asia/Jakarta).
 * Contoh: "2026-11-14T13:15:00+07:00"
 */
function toJakartaIso(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  const ms = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  const shifted = new Date(ms + JAKARTA_OFFSET_MS);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+07:00`;
}

function nowIso() {
  return toJakartaIso(Date.now());
}

/**
 * Mengembalikan tanggal YYYY-MM-DD dalam zona waktu Asia/Jakarta (+07:00).
 */
function jakartaDateString(input = Date.now()) {
  return toJakartaIso(input).slice(0, 10);
}

/**
 * Mengembalikan batas awal dan akhir hari (ISO +07:00) untuk tanggal YYYY-MM-DD.
 */
function dayBoundsJakarta(dateStr = jakartaDateString()) {
  const clean = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? String(dateStr) : jakartaDateString();
  return {
    date: clean,
    startIso: `${clean}T00:00:00+07:00`,
    endIso: `${clean}T23:59:59+07:00`,
  };
}

/**
 * Normalisasi input tanggal/waktu ke ms epoch; mengembalikan null jika tidak sah.
 */
function parseIsoMs(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return null;
  const ms = Date.parse(isoStr);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Buka koneksi SQLite dengan konfigurasi WAL, foreign_keys, dan busy_timeout.
 */
function openDatabase(dbFilePath = config.dbPath) {
  const resolved = path.resolve(dbFilePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applySchema(db);
  return db;
}

module.exports = {
  openDatabase,
  nowIso,
  toJakartaIso,
  jakartaDateString,
  dayBoundsJakarta,
  parseIsoMs,
};
