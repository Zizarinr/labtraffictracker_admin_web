'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { nowIso, toJakartaIso } = require('./db');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * Hash secret (password atau token lab) menggunakan scrypt + salt acak + pepper.
 */
function hashSecret(plain, usePepper = false) {
  const salt = crypto.randomBytes(16).toString('hex');
  const material = usePepper ? `${plain}:${config.tokenPepper}` : String(plain);
  const derived = crypto.scryptSync(material, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${derived.toString('hex')}`;
}

/**
 * Verifikasi secret terhadap hash scrypt dengan timingSafeEqual.
 */
function verifySecret(plain, storedHash, usePepper = false) {
  if (!plain || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!salt || !expectedHex) return false;

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const material = usePepper ? `${plain}:${config.tokenPepper}` : String(plain);
    const actualBuf = crypto.scryptSync(material, salt, expectedBuf.length, { N, r, p });
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

function hashPassword(password) {
  return hashSecret(password, false);
}

function verifyPassword(password, storedHash) {
  return verifySecret(password, storedHash, false);
}

/**
 * Buat token baru untuk laboratorium dengan prefix `lab_`.
 * Mengembalikan { token, tokenHash, tokenHint }.
 */
function generateLabToken() {
  const raw = crypto.randomBytes(24).toString('hex');
  const token = `lab_${raw}`;
  const tokenHash = hashSecret(token, true);
  const tokenHint = `${token.slice(0, 8)}...${token.slice(-4)}`;
  return { token, tokenHash, tokenHint };
}

function hashLabToken(token) {
  const clean = String(token);
  const tokenHash = hashSecret(clean, true);
  const tokenHint = clean.length >= 12 ? `${clean.slice(0, 8)}...${clean.slice(-4)}` : 'lab_***';
  return { token: clean, tokenHash, tokenHint };
}

function verifyLabToken(token, storedHash) {
  return verifySecret(token, storedHash, true);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/**
 * Pastikan minimal ada 1 akun administrator awal.
 */
function ensureBootstrapAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return null;

  const id = crypto.randomUUID();
  const now = nowIso();
  const passwordHash = hashPassword(config.adminPassword);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)
  `).run(id, config.adminName, config.adminEmail, passwordHash, now, now);

  return { id, email: config.adminEmail, name: config.adminName };
}

/**
 * Buat session baru setelah login sukses.
 */
function createSession(db, { userId, ipAddress = null, userAgent = null }) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionId = sha256Hex(rawToken);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const nowMs = Date.now();
  const expiresMs = nowMs + config.sessionTtlHours * 3600 * 1000;

  // Bersihkan session kadaluarsa
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(toJakartaIso(nowMs));

  db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, ip_address, user_agent, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    userId,
    csrfToken,
    ipAddress,
    userAgent ? String(userAgent).slice(0, 255) : null,
    toJakartaIso(expiresMs),
    toJakartaIso(nowMs)
  );

  return { rawToken, sessionId, csrfToken, expiresMs };
}

function getSessionFromRequest(db, req) {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[config.sessionCookieName];
  if (!rawToken) return null;

  const sessionId = sha256Hex(rawToken);
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.csrf_token, s.expires_at,
              u.id AS user_id, u.name, u.email, u.role, u.active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(sessionId);

  if (!row) return null;
  if (!row.active) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  const expMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expMs) || expMs < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  return {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
    },
  };
}

function destroySession(db, req) {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[config.sessionCookieName];
  if (!rawToken) return;
  const sessionId = sha256Hex(rawToken);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function formatSessionCookie(rawToken, maxAgeSeconds) {
  const parts = [
    `${config.sessionCookieName}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function createAuthMiddleware(db) {
  return function requireAdmin(req, res, next) {
    const session = getSessionFromRequest(db, req);
    if (!session) {
      res.status(401).json({ error: 'unauthenticated', message: 'Sesi login tidak valid atau telah berakhir.' });
      return;
    }

    // Validasi CSRF untuk method pengubah state
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const headerCsrf = req.get('x-csrf-token') || '';
      if (!headerCsrf || headerCsrf !== session.csrfToken) {
        res.status(403).json({ error: 'csrf_invalid', message: 'Token keamanan CSRF tidak cocok. Muat ulang halaman.' });
        return;
      }
    }

    req.auth = session;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateLabToken,
  hashLabToken,
  verifyLabToken,
  ensureBootstrapAdmin,
  createSession,
  getSessionFromRequest,
  destroySession,
  formatSessionCookie,
  createAuthMiddleware,
};
