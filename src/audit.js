'use strict';

const { nowIso } = require('./db');

function recordAudit(db, { userId = null, userEmail = null, action, target = null, detail = null, ipAddress = null }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO audit_log (user_id, user_email, action, target, detail_json, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      userId,
      userEmail,
      String(action),
      target ? String(target) : null,
      detail ? JSON.stringify(detail) : null,
      ipAddress ? String(ipAddress) : null,
      nowIso()
    );
  } catch (err) {
    console.error('[audit] gagal mencatat audit log:', err.message);
  }
}

module.exports = { recordAudit };
