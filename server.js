// ═══════════════════════════════════════════════════════════════════════════════
// SHIVAM BOT BUILDER — server.js  (v3.7.0)
//
// FamGateway integration + BUG fixes 1-6 + Admin tools
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');

// Plain `node server.js` does not read .env files; load them without overriding real env vars.
for (const envFile of ['.env.development.local', '.env.local', '.env']) {
  const envPath = path.join(__dirname, envFile);
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(envPath); } catch (e) { console.warn(`⚠️ Could not load ${envFile}: ${e.message}`); }
  }
}
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');
require('dotenv').config();

// ─── BUG 6 fix: safe node:sqlite import ────────────────────────────────────────
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('❌ Failed to load node:sqlite. Node.js >= 22.5.0 is required.');
  console.error('   Current Node version:', process.version);
  console.error('   Original error:', e.message);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const app = express();
app.disable('x-powered-by');

// ─── Custom CORS ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Auth-Key, X-FamGateway-Signature');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const ADMIN_KEY = process.env.BUILDER_ADMIN_KEY || '';
const ADMIN_KEY_REQUIRED = process.env.NODE_ENV === 'production' || process.env.BUILDER_REQUIRE_AUTH === '1';
const BUILDER_SECRET = process.env.BUILDER_SECRET || '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

let DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) {
  if (fs.existsSync('/var/data')) {
    DATA_DIR = '/var/data';
    console.log('✅ DATA_DIR set to /var/data (Persistent Disk)');
  } else {
    DATA_DIR = path.join(__dirname, 'data');
    console.warn('⚠️ Using ephemeral DATA_DIR');
  }
}
console.log(`📁 DATA_DIR: ${DATA_DIR}`);

if (ADMIN_KEY_REQUIRED && ADMIN_KEY.length < 16) {
  console.error('❌ BUILDER_ADMIN_KEY must be at least 16 characters.');
  process.exit(1);
}
if (ADMIN_KEY_REQUIRED && BUILDER_SECRET.length < 32) {
  console.error('❌ BUILDER_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function clientIp(req) { return String(req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim(); }
function hashText(x) { return crypto.createHash('sha256').update(String(x)).digest('hex'); }
function now() { return new Date().toISOString(); }
function intId(x) { const n = Number(x); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function safeName(x) { return String(x || '').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200); }
function finiteMoney(x) { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= 100000000 ? n : null; }
function publicError(e, fallback = 'Request failed') { return String(e?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 240) || fallback; }
function redactLog(s) {
  return String(s || '').replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,}\b/g, '[BOT_TOKEN_REDACTED]').replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]');
}
function publicBot(b) {
  return { id: b.id, name: b.name, username: b.username, owner_id: b.owner_id, created_at: b.created_at, status: b.status, uptime_started: b.uptime_started, last_error: b.last_error || '' };
}

// ─── Encryption ────────────────────────────────────────────────────────────────
function encKey() { return crypto.createHash('sha256').update(BUILDER_SECRET || 'default-secret-key-min-32-chars').digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const d = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), d.toString('base64')].join('.');
}
function decrypt(data) {
  const [ivB, tagB, dataB] = data.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString();
}

function tg(token, method, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    }, (x) => { let s = ''; x.on('data', d => s += d); x.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('Telegram timeout')));
    r.write(data); r.end();
  });
}
function validToken(t) { return /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(String(t || '')); }
function validOwner(x) { return /^\d{5,20}$/.test(String(x || '')); }

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════
const rate = new Map();
setInterval(() => { const c = Date.now() - 120000; for (const [k, v] of rate) if (v.t < c) rate.delete(k); }, 60000).unref();
function rateLimit(max, windowMs, prefix) {
  return (req, res, next) => {
    const k = prefix + ':' + clientIp(req), nowMs = Date.now();
    const x = rate.get(k) || { t: nowMs, n: 0 };
    if (nowMs - x.t > windowMs) { x.t = nowMs; x.n = 0; }
    x.n++; rate.set(k, x);
    if (x.n > max) return res.status(429).json({ ok: false, message: 'Too many requests' });
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDER DATABASE
// ═══════════════════════════════════════════════════════════════════════════════
const BOT_DIR = path.join(DATA_DIR, 'bots');
fs.mkdirSync(BOT_DIR, { recursive: true });

const builderDb = new DatabaseSync(path.join(DATA_DIR, 'builder.sqlite'));
builderDb.exec('PRAGMA journal_mode=WAL;');
builderDb.exec(`
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1,
  bot_quota INTEGER DEFAULT 2,
  bot_used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS auth_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  device_fingerprint TEXT,
  created_at TEXT NOT NULL,
  first_used_at TEXT,
  last_used_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  FOREIGN KEY(seller_id) REFERENCES sellers(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  uptime_started TEXT,
  last_error TEXT DEFAULT '',
  db_path TEXT NOT NULL,
  seller_id INTEGER,
  gateway_callback_secret TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS saas_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  days INTEGER NOT NULL,
  max_bots INTEGER NOT NULL,
  max_products_per_bot INTEGER NOT NULL,
  max_stock_keys_per_bot INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_api_settings (
  bot_id INTEGER PRIMARY KEY,
  api_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  master_key TEXT DEFAULT '',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_bots_seller_id ON bots(seller_id);
CREATE INDEX IF NOT EXISTS idx_auth_keys_hash ON auth_keys(key_hash);
`);

const seedPlans = [
  ['3 Days', 3, 1, 25, 500, 99],
  ['1 Month', 30, 3, 100, 2000, 299],
  ['3 Months', 90, 10, 500, 10000, 699],
  ['12 Months', 365, 50, 2000, 50000, 1499]
];
for (const z of seedPlans) {
  try { builderDb.prepare('INSERT OR IGNORE INTO saas_plans(name, days, max_bots, max_products_per_bot, max_stock_keys_per_bot, price, active, created_at) VALUES(?,?,?,?,?,?,1,?)').run(z[0], z[1], z[2], z[3], z[4], z[5], now()); } catch {}
}

try {
  const cols = builderDb.prepare('PRAGMA table_info(bots)').all().map(x => x.name);
  if (!cols.includes('seller_id')) builderDb.exec('ALTER TABLE bots ADD COLUMN seller_id INTEGER');
  if (!cols.includes('gateway_callback_secret')) builderDb.exec("ALTER TABLE bots ADD COLUMN gateway_callback_secret TEXT DEFAULT ''");
  for (const b of builderDb.prepare("SELECT id FROM bots WHERE gateway_callback_secret IS NULL OR gateway_callback_secret=''").all()) {
    builderDb.prepare('UPDATE bots SET gateway_callback_secret=? WHERE id=?').run(crypto.randomBytes(24).toString('hex'), b.id);
  }
} catch (e) { console.error('Migration error:', e.message); }

// ═══════════════════════════════════════════════════════════════════════════════
// BOT DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function getBot(id) { return builderDb.prepare('SELECT * FROM bots WHERE id=?').get(Number(id)); }
function dbFor(bot) { return new DatabaseSync(bot.db_path); }
function rows(bot, sql, args = []) { const d = dbFor(bot); try { return d.prepare(sql).all(...args); } finally { d.close(); } }
function run(bot, sql, args = []) { const d = dbFor(bot); try { return d.prepare(sql).run(...args); } finally { d.close(); } }
function one(bot, sql, args = []) { const d = dbFor(bot); try { return d.prepare(sql).get(...args); } finally { d.close(); } }

// ─── BUG 4 fix: Ensure bot DB has all required tables ──────────────────────────
function ensureBotSchema(bot) {
  try {
    const dir = path.dirname(bot.db_path);
    fs.mkdirSync(dir, { recursive: true });
    const d = new DatabaseSync(bot.db_path);
    try {
      d.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', balance REAL NOT NULL DEFAULT 0, is_reseller INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', channel_link TEXT NOT NULL DEFAULT '', emoji TEXT DEFAULT '', header_text TEXT DEFAULT '', sub_text TEXT DEFAULT '', category_key TEXT DEFAULT '', maintenance_mode INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', days INTEGER NOT NULL, customer_price REAL NOT NULL, reseller_price REAL NOT NULL, remote_id TEXT DEFAULT '', remote_duration TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS stock_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, key_value TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available', assigned_order_id INTEGER, created_at TEXT NOT NULL, key_type TEXT DEFAULT 'key');
        CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, plan_id INTEGER, order_type TEXT NOT NULL DEFAULT 'product', amount REAL NOT NULL, original_amount REAL NOT NULL, topup_amount REAL NOT NULL DEFAULT 0, coupon_code TEXT NOT NULL DEFAULT '', discount_amount REAL NOT NULL DEFAULT 0, payment_method TEXT NOT NULL DEFAULT 'gateway', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, approved_at TEXT, expiry_at TEXT, key_id INTEGER, delivery_status TEXT NOT NULL DEFAULT 'not_required', delivery_error TEXT NOT NULL DEFAULT '', pending_message_chat_id INTEGER, pending_message_id INTEGER, utr TEXT DEFAULT '', admin_note TEXT DEFAULT '', fg_order_id TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, order_id INTEGER, type TEXT NOT NULL, amount REAL NOT NULL, balance_before REAL NOT NULL, balance_after REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scheduled_broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, media_type TEXT DEFAULT '', media_url TEXT DEFAULT '', run_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, deleted INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS broadcast_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id INTEGER NOT NULL, user_id INTEGER NOT NULL, message_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, delivered_at TEXT NOT NULL, deleted INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS payment_events (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, order_id INTEGER NOT NULL, event_type TEXT NOT NULL, received_at TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', UNIQUE(provider, provider_event_id));
        CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER NOT NULL, referred_user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', qualified_order_id INTEGER, reward_amount REAL NOT NULL DEFAULT 0, rewarded_at TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS referral_milestones (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, milestone_count INTEGER NOT NULL, badge TEXT NOT NULL, achieved_at TEXT NOT NULL, UNIQUE(user_id, milestone_count));
        CREATE TABLE IF NOT EXISTS spins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, spun_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, discount_type TEXT NOT NULL DEFAULT 'percent', discount_value REAL NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 0, max_uses_per_user INTEGER NOT NULL DEFAULT 1, min_order_amount REAL NOT NULL DEFAULT 0, max_discount REAL NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS coupon_uses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, coupon_id INTEGER NOT NULL, used_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS product_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL, created_at TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, product_id));
      `);
      // Ensure the extra columns exist (for older DBs)
      const cols = d.prepare("PRAGMA table_info(orders)").all().map(x => x.name);
      if (!cols.includes('utr')) d.exec("ALTER TABLE orders ADD COLUMN utr TEXT DEFAULT ''");
      if (!cols.includes('admin_note')) d.exec("ALTER TABLE orders ADD COLUMN admin_note TEXT DEFAULT ''");
      if (!cols.includes('fg_order_id')) d.exec("ALTER TABLE orders ADD COLUMN fg_order_id TEXT DEFAULT ''");
    } finally { d.close(); }
    return true;
  } catch (e) {
    console.error(`ensureBotSchema(${bot.id}) failed:`, e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
function isAdmin(req) { return req.authMode === 'admin' || req.user?.role === 'admin'; }
function getDeviceFingerprint(req) {
  return hashText((req.headers['user-agent'] || '') + '|' + clientIp(req) + '|' + (req.headers['accept-language'] || ''));
}
function generateUserKey() { return 'USR-' + crypto.randomBytes(16).toString('hex').toUpperCase(); }

function validateKeyAndDevice(req, rawKey) {
  const keyHash = hashText(rawKey);
  const row = builderDb.prepare(`
    SELECT ak.*, s.id as seller_id, s.role, s.username, s.active
    FROM auth_keys ak JOIN sellers s ON s.id = ak.seller_id
    WHERE ak.key_hash = ? AND ak.active = 1 AND s.active = 1
  `).get(keyHash);
  if (!row) return null;
  const fp = getDeviceFingerprint(req);
  if (!row.device_fingerprint) {
    builderDb.prepare('UPDATE auth_keys SET device_fingerprint=?, first_used_at=? WHERE id=?').run(fp, now(), row.id);
    return { ...row, device_fingerprint: fp };
  }
  if (row.device_fingerprint !== fp) return null;
  builderDb.prepare('UPDATE auth_keys SET last_used_at=? WHERE id=?').run(now(), row.id);
  return row;
}

function newSession(sellerId, role = 'user') {
  const raw = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  builderDb.prepare('INSERT INTO sessions(seller_id, token_hash, csrf_hash, role, created_at, expires_at) VALUES(?,?,?,?,?,?)')
    .run(sellerId, hashText(raw), hashText(csrf), role, now(), new Date(Date.now() + 7 * 86400000).toISOString());
  return { raw, csrf };
}
function sessionFrom(req) {
  const raw = String((req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sb_session=')) || '').slice(11);
  if (!raw) return null;
  const row = builderDb.prepare(`SELECT s.*, a.username, a.role, a.active FROM sessions s JOIN sellers a ON a.id = s.seller_id WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND a.active=1`).get(hashText(raw), now());
  if (!row) return null;
  return { id: row.seller_id, username: row.username, role: row.role, csrfHash: row.csrf_hash };
}
function cookieForSession(sess) {
  return `sb_session=${sess.raw}; Path=/; HttpOnly; SameSite=Strict${ADMIN_KEY_REQUIRED ? '; Secure' : ''}; Max-Age=604800`;
}

function auth(req, res, next) {
  const publicPaths = ['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/me'];
  if (publicPaths.includes(req.path) || (req.method === 'GET' && req.path === '/') || req.path.startsWith('/api/famgateway/webhook/')) return next();
  if (!req.path.startsWith('/api/')) return next();

  const u = sessionFrom(req);
  if (u) {
    req.user = u;
    req.authMode = u.role === 'admin' ? 'admin' : 'user';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = String(req.headers['x-csrf-token'] || '');
      if (!csrf || hashText(csrf) !== u.csrfHash) return res.status(403).json({ ok: false, message: 'CSRF failed' });
    }
    return next();
  }

  const rawKey = String(req.headers['x-auth-key'] || '');
  if (rawKey) {
    if (ADMIN_KEY && rawKey === ADMIN_KEY) {
      let admin = builderDb.prepare("SELECT * FROM sellers WHERE role='admin' AND active=1 LIMIT 1").get();
      if (!admin) {
        const id = builderDb.prepare("INSERT INTO sellers(username, role, active, created_at) VALUES('admin','admin',1,?)").run(now()).lastInsertRowid;
        admin = builderDb.prepare('SELECT * FROM sellers WHERE id=?').get(id);
      }
      req.user = { id: admin.id, username: admin.username, role: 'admin' };
      req.authMode = 'admin';
      return next();
    }
    const kd = validateKeyAndDevice(req, rawKey);
    if (kd) {
      req.user = { id: kd.seller_id, username: kd.username || 'user', role: kd.role || 'user' };
      req.authMode = 'user';
      return next();
    }
  }
  return res.status(401).json({ ok: false, message: 'Auth required' });
}

function accessibleBot(req, id) {
  const b = getBot(id);
  if (!b) return null;
  if (isAdmin(req)) return b;
  return b.seller_id && Number(b.seller_id) === Number(req.user.id) ? b : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════
const children = new Map();
const childGeneration = new Map();
const restartState = new Map();
const STARTUP_GRACE_MS = 180000;
const HEARTBEAT_STALE_MS = 150000;
const py = process.env.PYTHON_BIN || [
  path.join(__dirname, '.venv', 'bin', 'python'),
  '/vercel/share/pyenv/bin/python',
].find(p => fs.existsSync(p)) || 'python3';
console.log(`🐍 Python runtime: ${py}`);

function startBot(id) {
  console.log(`[startBot] Starting bot ${id}`);
  const bot = getBot(id);
  if (!bot) return false;
  const existing = children.get(id);
  if (existing && existing.exitCode === null) return true;
  if (existing) children.delete(id);

  const dir = path.dirname(bot.db_path);
  fs.mkdirSync(dir, { recursive: true });

  // BUG 4 fix: ensure schema exists before spawning Python
  ensureBotSchema(bot);

  const templatePath = path.join(__dirname, 'bot_template.py');
  const botPyPath = path.join(dir, 'bot.py');
  if (!fs.existsSync(templatePath)) { console.error('❌ bot_template.py missing'); return false; }
  try { fs.copyFileSync(templatePath, botPyPath); } catch (e) { console.error('Copy failed:', e.message); return false; }

  const token = decrypt(bot.token_enc);
  const base = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const callbackUrl = base ? `${base}/api/famgateway/webhook/${id}` : '';

  const apiSettings = builderDb.prepare('SELECT * FROM bot_api_settings WHERE bot_id=?').get(id);
  const env = {
    ...process.env,
    BOT_TOKEN: token,
    ADMIN_USER_ID: String(bot.owner_id),
    DB_PATH: bot.db_path,
    STORE_TIMEZONE: 'Asia/Kolkata',
    BOT_HEARTBEAT_PATH: path.join(dir, 'heartbeat'),
    GATEWAY_CALLBACK_URL: callbackUrl,
    FAMGATEWAY_WEBHOOK_URL: callbackUrl,
    PYTHONUNBUFFERED: '1',
    BUILDER_BOT_ID: String(id),
  };
  if (apiSettings) {
    env.EXTERNAL_API_URL = apiSettings.api_url || '';
    env.EXTERNAL_API_KEY = apiSettings.api_key || '';
    env.EXTERNAL_MASTER_KEY = apiSettings.master_key || '';
  }

  const generation = crypto.randomBytes(8).toString('hex');
  childGeneration.set(id, generation);
  const child = spawn(py, ['bot.py'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (err) => console.error(`Spawn error bot ${id}:`, err.message));

  const logFile = path.join(dir, 'bot.log');
  const MAX_LOG = 2 * 1024 * 1024;
  const append = (d) => {
    try {
      fs.appendFileSync(logFile, redactLog(d));
      const st = fs.statSync(logFile);
      if (st.size > MAX_LOG) {
        const buf = fs.readFileSync(logFile);
        fs.writeFileSync(logFile, buf.subarray(Math.max(0, buf.length - MAX_LOG)));
      }
    } catch {}
  };
  child.stdout.on('data', d => { const s = d.toString().trim(); if (s) console.log(`[Bot ${id}] ${s}`); append(s + '\n'); });
  child.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) console.error(`[Bot ${id} ERR] ${s}`);
    append(redactLog(s) + '\n');
    try { builderDb.prepare('UPDATE bots SET last_error=? WHERE id=?').run(redactLog(s).slice(-1500), id); } catch {}
  });

  child.on('exit', (code, signal) => {
    const current = childGeneration.get(id) === generation && children.get(id) === child;
    if (current) children.delete(id);
    if (!current) return;
    const b = builderDb.prepare('SELECT status FROM bots WHERE id=?').get(id);
    const shouldRestart = Boolean(b && b.status === 'online');
    builderDb.prepare("UPDATE bots SET status='offline', last_error=? WHERE id=?").run(`Exited (code=${code})`.slice(0, 1500), id);
    if (shouldRestart) setTimeout(() => {
      try {
        const l = builderDb.prepare('SELECT status FROM bots WHERE id=?').get(id);
        if (l && l.status === 'offline') startBot(id);
      } catch {}
    }, 3000);
  });

  children.set(id, child);
  builderDb.prepare("UPDATE bots SET status='online', uptime_started=?, last_error='' WHERE id=?").run(now(), id);
  restartState.set(id, { startedAt: Date.now(), attempt: 0, nextAt: 0 });
  return true;
}

function stopBot(id) {
  const c = children.get(id);
  if (c) { c.kill('SIGTERM'); children.delete(id); }
  builderDb.prepare("UPDATE bots SET status='offline' WHERE id=?").run(id);
  return true;
}
function restartBot(id) { stopBot(id); return startBot(id); }

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════
// JSON parser with raw body capture for webhook signature verification
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.includes('/api/famgateway/webhook/')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use((req, res, next) => { if (!req.path.startsWith('/api/')) return next(); return rateLimit(300, 60000, 'api')(req, res, next); });
app.use((req, res, next) => { if (!req.path.startsWith('/api/auth/')) return next(); return rateLimit(15, 60000, 'auth')(req, res, next); });
app.use(auth);
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════════════════
// API: HEALTH
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  let free = null;
  try { const st = fs.statfsSync(DATA_DIR); free = Number(st.bavail) * Number(st.bsize); } catch {}
  res.json({
    ok: true,
    status: 'online',
    bots: children.size,
    time: now(),
    storage_free_mb: free === null ? null : Math.floor(free / 1048576),
    data_dir: DATA_DIR,
    version: '3.7.0',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: AUTH
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', (req, res) => {
  const rawKey = String(req.body?.key || '').trim();
  if (!rawKey) return res.status(400).json({ ok: false, message: 'Key required' });

  if (ADMIN_KEY && rawKey === ADMIN_KEY) {
    let admin = builderDb.prepare("SELECT * FROM sellers WHERE role='admin' AND active=1 LIMIT 1").get();
    if (!admin) {
      const id = builderDb.prepare("INSERT INTO sellers(username, role, active, created_at) VALUES('admin','admin',1,?)").run(now()).lastInsertRowid;
      admin = builderDb.prepare('SELECT * FROM sellers WHERE id=?').get(id);
    }
    const sess = newSession(admin.id, 'admin');
    res.setHeader('Set-Cookie', cookieForSession(sess));
    return res.json({ ok: true, user: { id: admin.id, username: admin.username, role: 'admin' }, csrf: sess.csrf });
  }

  const kd = validateKeyAndDevice(req, rawKey);
  if (kd) {
    builderDb.prepare('UPDATE sellers SET last_login=? WHERE id=?').run(now(), kd.seller_id);
    const sess = newSession(kd.seller_id, kd.role || 'user');
    res.setHeader('Set-Cookie', cookieForSession(sess));
    const user = builderDb.prepare('SELECT id, username, role FROM sellers WHERE id=?').get(kd.seller_id);
    return res.json({ ok: true, user, csrf: sess.csrf });
  }
  return res.status(401).json({ ok: false, message: 'Invalid key' });
});

app.post('/api/auth/logout', (req, res) => {
  const cookie = String((req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sb_session=')) || '').slice(11);
  if (cookie) { try { builderDb.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(now(), hashText(cookie)); } catch {} }
  res.setHeader('Set-Cookie', 'sb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, message: 'Not auth' });
  const raw = crypto.randomBytes(24).toString('base64url');
  const cookie = String((req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sb_session=')) || '').slice(11);
  if (cookie) { try { builderDb.prepare('UPDATE sessions SET csrf_hash=? WHERE token_hash=? AND revoked_at IS NULL').run(hashText(raw), hashText(cookie)); } catch {} }
  const user = builderDb.prepare('SELECT id, username, role, bot_quota, bot_used FROM sellers WHERE id=?').get(req.user.id);
  res.json({ ok: true, user, csrf: raw });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: ADMIN KEYS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/keys', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, message: 'Admin only' });
  const keys = builderDb.prepare(`SELECT ak.*, s.username, s.role FROM auth_keys ak JOIN sellers s ON s.id=ak.seller_id ORDER BY ak.id DESC`).all();
  res.json({ ok: true, keys });
});

app.post('/api/admin/keys', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, message: 'Admin only' });
  const { key, userId, username, botQuota } = req.body || {};
  let rawKey = key || generateUserKey();
  if (key && builderDb.prepare('SELECT id FROM auth_keys WHERE key_hash=?').get(hashText(key))) return res.status(409).json({ ok: false, message: 'Key exists' });

  let targetId = userId;
  if (!targetId && username) {
    const ex = builderDb.prepare('SELECT id FROM sellers WHERE username=?').get(safeName(username));
    if (ex) targetId = ex.id;
    else {
      const quota = Math.min(Math.max(Number(botQuota) || 2, 0), 100);
      targetId = builderDb.prepare("INSERT INTO sellers(username, role, active, bot_quota, bot_used, created_at) VALUES(?, 'user', 1, ?, 0, ?)").run(safeName(username), quota, now()).lastInsertRowid;
    }
  }
  if (!targetId) targetId = req.user.id;

  builderDb.prepare('INSERT INTO auth_keys(seller_id, key_hash, created_at, created_by) VALUES(?,?,?,?)').run(targetId, hashText(rawKey), now(), req.user.id);
  res.json({ ok: true, key: rawKey });
});

app.put('/api/admin/keys/:id/status', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, message: 'Admin only' });
  const id = intId(req.params.id); if (!id) return res.status(400).json({ ok: false, message: 'Bad ID' });
  builderDb.prepare('UPDATE auth_keys SET active=? WHERE id=?').run(Number(req.body?.active ? 1 : 0), id);
  res.json({ ok: true });
});

app.delete('/api/admin/keys/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, message: 'Admin only' });
  const id = intId(req.params.id); if (!id) return res.status(400).json({ ok: false, message: 'Bad ID' });
  builderDb.prepare('DELETE FROM auth_keys WHERE id=?').run(id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: BOTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/bots', (req, res) => {
  const sql = isAdmin(req) ? 'SELECT * FROM bots ORDER BY id DESC' : 'SELECT * FROM bots WHERE seller_id=? ORDER BY id DESC';
  const data = isAdmin(req) ? builderDb.prepare(sql).all() : builderDb.prepare(sql).all(req.user.id);
  res.json({ ok: true, bots: data.map(publicBot) });
});

app.post('/api/bots/deploy', async (req, res) => {
  const templatePath = path.join(__dirname, 'bot_template.py');
  if (!fs.existsSync(templatePath)) return res.status(500).json({ ok: false, message: 'bot_template.py missing' });

  if (!isAdmin(req)) {
    const seller = builderDb.prepare('SELECT bot_quota, bot_used FROM sellers WHERE id=?').get(req.user.id);
    if (!seller || seller.bot_used >= seller.bot_quota) return res.status(403).json({ ok: false, message: `Bot limit reached (Max ${seller?.bot_quota || 0})` });
  }

  const { token, ownerId, name } = req.body || {};
  if (!validToken(token) || !validOwner(ownerId)) return res.status(400).json({ ok: false, message: 'Invalid token/owner' });

  try {
    const x = await tg(token, 'getMe');
    if (!x.ok) return res.status(400).json({ ok: false, message: x.description || 'Token invalid' });
    if (builderDb.prepare('SELECT id FROM bots WHERE username=?').get(x.result.username)) return res.status(409).json({ ok: false, message: 'Already deployed' });

    const callbackSecret = crypto.randomBytes(24).toString('hex');
    const sellerId = isAdmin(req) ? (req.body?.seller_id || req.user.id) : req.user.id;

    const id = builderDb.prepare(`INSERT INTO bots(name, username, owner_id, token_enc, created_at, status, db_path, seller_id, gateway_callback_secret) VALUES(?,?,?,?,?,'offline',?,?,?)`).run(
      safeName(name) || safeName(x.result.first_name) || 'SHIVAM STORE',
      x.result.username, String(ownerId), encrypt(token), now(),
      path.join(BOT_DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, 'shivam_store.sqlite3'),
      sellerId, callbackSecret
    ).lastInsertRowid;

    if (!isAdmin(req)) builderDb.prepare('UPDATE sellers SET bot_used = bot_used + 1 WHERE id=?').run(sellerId);

    const started = startBot(id);
    if (!started) { builderDb.prepare('DELETE FROM bots WHERE id=?').run(id); return res.status(503).json({ ok: false, message: 'Bot failed to start' }); }

    const bot = getBot(id);
    res.json({ ok: true, bot: { id, username: x.result.username, name: bot.name, owner_id: bot.owner_id, status: 'online' } });
  } catch (e) { res.status(500).json({ ok: false, message: publicError(e) }); }
});

app.post('/api/bots/validate', async (req, res) => {
  const { token } = req.body || {};
  if (!validToken(token)) return res.status(400).json({ ok: false, message: 'Invalid token format' });
  try {
    const x = await tg(token, 'getMe');
    if (!x.ok) return res.status(400).json({ ok: false, message: x.description || 'Token invalid' });
    res.json({ ok: true, bot: { username: x.result.username, first_name: x.result.first_name, id: x.result.id } });
  } catch (e) { res.status(500).json({ ok: false, message: publicError(e) }); }
});

app.post('/api/bots/:id/:action', (req, res) => {
  const id = intId(req.params.id); if (!id) return res.status(400).json({ ok: false, message: 'Bad ID' });
  if (!accessibleBot(req, id)) return res.status(404).json({ ok: false, message: 'Not found' });
  const action = req.params.action;
  if (action === 'start') startBot(id);
  else if (action === 'stop') stopBot(id);
  else if (action === 'restart') restartBot(id);
  else return res.status(400).json({ ok: false, message: 'Unknown action' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════��══���═════════════════════════════
// API: BOT API SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/bot/:id/api-settings', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  const s = builderDb.prepare('SELECT * FROM bot_api_settings WHERE bot_id=?').get(b.id);
  res.json({ ok: true, settings: s || { bot_id: b.id, api_url: '', api_key: '', master_key: '' } });
});

app.put('/api/bot/:id/api-settings', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  const { api_url, api_key, master_key } = req.body || {};
  builderDb.prepare(`INSERT INTO bot_api_settings(bot_id, api_url, api_key, master_key, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET api_url=excluded.api_url, api_key=excluded.api_key, master_key=excluded.master_key, updated_at=excluded.updated_at`)
    .run(b.id, String(api_url || '').slice(0, 500), String(api_key || '').slice(0, 500), String(master_key || '').slice(0, 500), now());
  res.json({ ok: true });
});

app.post('/api/bot/:id/api-test', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  const s = builderDb.prepare('SELECT * FROM bot_api_settings WHERE bot_id=?').get(b.id);
  if (!s || !s.api_url) return res.status(400).json({ ok: false, message: 'API URL not set' });
  try {
    const u = new URL(s.api_url);
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', timeout: 10000, headers: { Accept: 'application/json' } }, (resp) => res.json({ ok: true, status: 'Connected', http_status: resp.statusCode }));
    r.on('error', e => res.status(502).json({ ok: false, message: 'Connection failed: ' + e.message }));
    r.on('timeout', () => { r.destroy(); res.status(504).json({ ok: false, message: 'Timeout' }); });
    r.end();
  } catch (e) { res.status(400).json({ ok: false, message: 'Invalid URL' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: BOT DATA (Dashboard Summary)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/summary/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  try {
    ensureBotSchema(b);
    const s = {
      members: Number(one(b, 'SELECT COUNT(*) c FROM users').c || 0),
      products: Number(one(b, 'SELECT COUNT(*) c FROM products WHERE active=1').c || 0),
      keys: Number(one(b, "SELECT COUNT(*) c FROM stock_keys WHERE status='available'").c || 0),
      orders: Number(one(b, 'SELECT COUNT(*) c FROM orders').c || 0),
      delivered: Number(one(b, "SELECT COUNT(*) c FROM orders WHERE delivery_status='delivered'").c || 0),
      revenue: Number(one(b, "SELECT COALESCE(SUM(amount),0) x FROM orders WHERE status='approved' AND order_type='product'").x || 0),
      topups: Number(one(b, "SELECT COALESCE(SUM(amount),0) x FROM wallet_transactions WHERE type IN ('deposit','topup') AND amount>0").x || 0),
      pending: Number(one(b, "SELECT COUNT(*) c FROM orders WHERE status='pending'").c || 0),
    };
    res.json({ ok: true, bot: publicBot(b), stats: s });
  } catch (e) {
    res.json({ ok: true, bot: publicBot(b), stats: { members: 0, products: 0, keys: 0, orders: 0, delivered: 0, revenue: 0, topups: 0, pending: 0 } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════
function defaultCategory(b) {
  let c = one(b, 'SELECT * FROM categories ORDER BY id LIMIT 1');
  if (!c) { run(b, "INSERT INTO categories(name, description, active) VALUES('General','Default',1)"); c = one(b, 'SELECT * FROM categories ORDER BY id LIMIT 1'); }
  return c.id;
}

app.get('/api/products/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  try {
    ensureBotSchema(b);
    const ps = rows(b, `SELECT p.*, COUNT(pl.id) plan_count, (SELECT COUNT(*) FROM stock_keys sk JOIN plans spl ON spl.id=sk.plan_id WHERE spl.product_id=p.id AND sk.status='available') stock FROM products p LEFT JOIN plans pl ON pl.product_id=p.id GROUP BY p.id ORDER BY p.id DESC`);
    res.json({ ok: true, products: ps.map(p => ({ ...p, status: p.active ? 'active' : 'disabled', maintenance: p.maintenance_mode })) });
  } catch { res.json({ ok: true, products: [] }); }
});

app.post('/api/products/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const x = req.body || {};
  let d;
  try {
    const cat = x.category_id || defaultCategory(b);
    d = new DatabaseSync(b.db_path);
    d.exec('BEGIN IMMEDIATE');
    const productName = safeName(x.name);
    if (!productName) throw new Error('Name required');
    const p = d.prepare('INSERT INTO products(category_id, name, description, channel_link, emoji, category_key, maintenance_mode, active, created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      cat, productName, String(x.description || '').slice(0, 5000), String(x.channel_link || '').slice(0, 1000),
      String(x.emoji || '').slice(0, 50),
      String(x.category_key || 'android_nonroot').slice(0, 50),
      Number(x.maintenance ? 1 : 0), 1, now()
    );
    for (const pl of (x.plans || [])) {
      d.prepare('INSERT INTO plans(product_id, name, description, days, customer_price, reseller_price, active, remote_id, remote_duration) VALUES(?,?,?,?,?,?,1,?,?)').run(
        p.lastInsertRowid, String(pl.name || 'Plan').slice(0, 100), String(pl.description || ''),
        Number(pl.days || 0), finiteMoney(pl.price) || 0, finiteMoney(pl.reseller_price) || 0,
        String(pl.remote_id || '').slice(0, 200), String(pl.remote_duration || '').slice(0, 100)
      );
    }
    d.exec('COMMIT'); d.close();
    res.json({ ok: true });
  } catch (e) { try { d?.exec('ROLLBACK'); } catch {} try { d?.close(); } catch {} res.status(400).json({ ok: false, message: e.message }); }
});

app.put('/api/products/:botId/:productId', (req, res) => {
  const x = req.body || {};
  const botId = intId(req.params.botId), productId = intId(req.params.productId);
  const b = accessibleBot(req, botId); if (!b || !productId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  try {
    run(b, `UPDATE products SET name=COALESCE(?,name), description=COALESCE(?,description), channel_link=COALESCE(?,channel_link), emoji=COALESCE(?,emoji), category_key=COALESCE(?,category_key), active=COALESCE(?,active), maintenance_mode=COALESCE(?,maintenance_mode) WHERE id=?`, [
      x.name == null ? null : safeName(x.name),
      x.description == null ? null : String(x.description).slice(0, 5000),
      x.channel_link == null ? null : String(x.channel_link).slice(0, 1000),
      x.emoji == null ? null : String(x.emoji).slice(0, 50),
      x.category_key == null ? null : String(x.category_key).slice(0, 50),
      x.status === 'disabled' ? 0 : (x.status === 'active' ? 1 : null),
      x.maintenance == null ? null : (Number(x.maintenance) ? 1 : 0),
      productId
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.delete('/api/products/:botId/:productId', (req, res) => {
  const botId = intId(req.params.botId), productId = intId(req.params.productId);
  const b = accessibleBot(req, botId); if (!b || !productId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  run(b, 'UPDATE products SET active=0 WHERE id=?', [productId]);
  res.json({ ok: true });
});

app.post('/api/products/:botId/:productId/maintenance', (req, res) => {
  const botId = intId(req.params.botId), productId = intId(req.params.productId);
  const b = accessibleBot(req, botId); if (!b || !productId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  const p = one(b, 'SELECT id, maintenance_mode FROM products WHERE id=?', [productId]);
  if (!p) return res.status(404).json({ ok: false, message: 'Not found' });
  const enabled = req.body?.enabled === undefined ? !Number(p.maintenance_mode) : Boolean(Number(req.body.enabled));
  run(b, 'UPDATE products SET maintenance_mode=? WHERE id=?', [enabled ? 1 : 0, productId]);
  res.json({ ok: true, maintenance: enabled });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: DISPLAY TEXT (Bulk Update Product Headers)
// ═══════════════════════════════════════════════════════════════════════════════
app.put('/api/display-text/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id);
  if (!b) return res.status(404).json({ ok: false, message: 'Bot not found' });
  ensureBotSchema(b);
  const products = req.body?.products;
  if (!Array.isArray(products)) return res.status(400).json({ ok: false, message: 'products array required' });

  const d = new DatabaseSync(b.db_path);
  try {
    d.exec('BEGIN IMMEDIATE');
    for (const p of products) {
      const pid = intId(p.id);
      if (!pid) continue;
      d.prepare('UPDATE products SET header_text=?, sub_text=? WHERE id=?')
        .run(String(p.header_text || '').slice(0, 500), String(p.sub_text || '').slice(0, 500), pid);
    }
    d.exec('COMMIT');
    d.close();
    res.json({ ok: true, updated: products.length });
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    try { d.close(); } catch {}
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: PLANS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/plans/:id', (req, res) => {
  const botId = Number(req.query.bot_id || req.headers['x-bot-id'] || 0);
  const b = accessibleBot(req, botId); if (!b) return res.status(400).json({ ok: false, message: 'bot_id required' });
  ensureBotSchema(b);
  try { res.json({ ok: true, plans: rows(b, 'SELECT * FROM plans WHERE product_id=? ORDER BY id', [req.params.id]) }); } catch { res.json({ ok: true, plans: [] }); }
});

app.post('/api/plans/:id', (req, res) => {
  const b = accessibleBot(req, intId(req.body?.bot_id || req.headers['x-bot-id']));
  if (!b) return res.status(400).json({ ok: false, message: 'bot_id required' });
  ensureBotSchema(b);
  const x = req.body || {}, productId = intId(req.params.id);
  if (!productId) return res.status(400).json({ ok: false, message: 'Bad ID' });
  run(b, 'INSERT INTO plans(product_id, name, description, days, customer_price, reseller_price, active, remote_id, remote_duration) VALUES(?,?,?,?,?,?,1,?,?)', [
    productId, safeName(x.name || 'Plan'), String(x.description || ''), Number(x.days || 0),
    finiteMoney(x.price) || 0, finiteMoney(x.reseller_price) || 0,
    String(x.remote_id || '').slice(0, 200), String(x.remote_duration || '').slice(0, 100)
  ]);
  res.json({ ok: true });
});

app.put('/api/plans/:botId/:planId', (req, res) => {
  const botId = intId(req.params.botId);
  const planId = intId(req.params.planId);
  const b = accessibleBot(req, botId);
  if (!b || !planId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  const x = req.body || {};
  try {
    run(b, `UPDATE plans SET name=COALESCE(?,name), description=COALESCE(?,description), days=COALESCE(?,days), customer_price=COALESCE(?,customer_price), reseller_price=COALESCE(?,reseller_price), remote_id=COALESCE(?,remote_id), remote_duration=COALESCE(?,remote_duration), active=COALESCE(?,active) WHERE id=?`, [
      x.name == null ? null : safeName(x.name),
      x.description == null ? null : String(x.description).slice(0, 5000),
      x.days == null ? null : Math.max(0, Math.floor(Number(x.days))),
      x.price == null ? null : finiteMoney(x.price),
      x.reseller_price == null ? null : finiteMoney(x.reseller_price),
      x.remote_id == null ? null : String(x.remote_id).slice(0, 200),
      x.remote_duration == null ? null : String(x.remote_duration).slice(0, 100),
      x.active == null ? null : Number(x.active ? 1 : 0),
      planId
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.delete('/api/plans/:botId/:planId', (req, res) => {
  const botId = intId(req.params.botId);
  const planId = intId(req.params.planId);
  const b = accessibleBot(req, botId);
  if (!b || !planId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  try {
    const stockCount = one(b, 'SELECT COUNT(*) c FROM stock_keys WHERE plan_id=?', [planId]).c || 0;
    if (Number(stockCount) > 0) {
      run(b, 'UPDATE plans SET active=0 WHERE id=?', [planId]);
      return res.json({ ok: true, message: 'Plan deactivated (has stock)', soft_delete: true });
    }
    run(b, 'DELETE FROM plans WHERE id=?', [planId]);
    res.json({ ok: true, message: 'Plan deleted' });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: KEYS / STOCK
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/keys/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const keyType = String(req.query.type || 'key');
  try {
    res.json({ ok: true, keys: rows(b, `SELECT sk.*, p.name product, pl.name plan FROM stock_keys sk LEFT JOIN plans pl ON pl.id=sk.plan_id LEFT JOIN products p ON p.id=pl.product_id WHERE sk.key_type=? ORDER BY sk.id DESC LIMIT 500`, [keyType]) });
  } catch { res.json({ ok: true, keys: [] }); }
});

app.post('/api/keys/:id/bulk', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const list = String(req.body?.keys || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ ok: false, message: 'No keys' });
  const planId = Number(req.body?.plan_id || 0);
  const keyType = String(req.body?.key_type || 'key');
  const plans = rows(b, 'SELECT id FROM plans WHERE id=?', [planId]);
  if (!plans.length) return res.status(400).json({ ok: false, message: 'Bad plan' });
  let added = 0;
  const d = new DatabaseSync(b.db_path);
  try {
    d.exec('BEGIN IMMEDIATE');
    for (const v of list) {
      try {
        d.prepare('INSERT INTO stock_keys(plan_id, key_value, status, created_at, key_type) VALUES(?,?,?,?,?)').run(plans[0].id, v.slice(0, 500), 'available', now(), keyType);
        added++;
      } catch {}
    }
    d.exec('COMMIT'); d.close();
    res.json({ ok: true, added });
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} try { d.close(); } catch {} res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: PRODUCT LINKS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/product-links/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const bot = getBot(b.id);
  try {
    const products = rows(b, 'SELECT id, name, active, maintenance_mode FROM products ORDER BY id');
    res.json({
      ok: true,
      links: products.map(p => ({
        id: p.id,
        name: p.name,
        status: p.maintenance_mode ? 'Maintenance' : (p.active ? 'Active' : 'Disabled'),
        link: `https://t.me/${bot?.username || 'unknown'}?start=buy_${p.id}`,
      })),
    });
  } catch { res.json({ ok: true, links: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: DELIVERY LOGS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/delivery-logs/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const search = String(req.query.search || '').trim().toLowerCase();
  try {
    let query = `SELECT o.id, o.order_no, o.user_id, o.amount, o.created_at, u.username, u.first_name, p.name as product_name, pl.name as plan_name, sk.key_value as delivered_key, o.delivery_status, o.status FROM orders o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN plans pl ON pl.id=o.plan_id LEFT JOIN products p ON p.id=pl.product_id LEFT JOIN stock_keys sk ON sk.id=o.key_id WHERE o.delivery_status IN ('delivered','pending','failed')`;
    const args = [];
    if (search) {
      query += ` AND (CAST(o.user_id AS TEXT) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(p.name) LIKE ? OR LOWER(sk.key_value) LIKE ?)`;
      const s = '%' + search + '%';
      args.push(s, s, s, s);
    }
    query += ' ORDER BY o.id DESC LIMIT 200';
    res.json({ ok: true, logs: rows(b, query, args) });
  } catch { res.json({ ok: true, logs: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: MEMBERS (BUG 1 FIX: uses u.id, not telegram_id)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/users/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try {
    res.json({
      ok: true,
      users: rows(b, `SELECT u.id, u.username, u.first_name, u.balance, u.is_reseller, u.created_at, (SELECT COUNT(*) FROM orders WHERE user_id=u.id AND status='approved') as orders_count, (SELECT COUNT(*) FROM referrals WHERE referrer_id=u.id AND status='qualified') as referrals_count FROM users u ORDER BY u.id DESC LIMIT 1000`)
    });
  } catch { res.json({ ok: true, users: [] }); }
});

// ─── BUG 2 FIX: wallet adjust uses `id`, not `telegram_id` ─────────────────────
app.post('/api/wallet/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const x = req.body || {}, amt = finiteMoney(x.amount);
  const userId = String(x.telegram_id || x.user_id || '').trim();
  if (!userId || !/^\d+$/.test(userId) || !Number.isFinite(amt) || amt === 0)
    return res.status(400).json({ ok: false, message: 'Bad input' });
  const d = new DatabaseSync(b.db_path);
  try {
    d.exec('BEGIN IMMEDIATE');
    const u = d.prepare('SELECT * FROM users WHERE id=?').get(Number(userId));
    if (!u) { d.exec('ROLLBACK'); d.close(); return res.status(404).json({ ok: false, message: 'User not found' }); }
    const before = Number(u.balance), after = before + amt;
    d.prepare('UPDATE users SET balance=?, updated_at=? WHERE id=?').run(after, now(), u.id);
    d.prepare('INSERT INTO wallet_transactions(user_id, type, amount, balance_before, balance_after, note, created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, amt > 0 ? 'admin_credit' : 'admin_debit', amt, before, after, String(x.reason || 'Admin'), now());
    d.exec('COMMIT'); d.close();
    res.json({ ok: true, balance: after });
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} try { d.close(); } catch {} res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: RESELLERS (make/remove reseller)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/resellers/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try {
    const resellers = rows(b, `SELECT u.*, (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions WHERE user_id=u.id AND type='deposit' AND created_at >= date('now','localtime')) as deposited_today FROM users u WHERE u.is_reseller=1 ORDER BY u.id DESC`);
    const stats = {
      total: resellers.length,
      total_balance: resellers.reduce((s, r) => s + Number(r.balance || 0), 0),
      deposited_today: resellers.reduce((s, r) => s + Number(r.deposited_today || 0), 0),
      sold_today: 0,
    };
    res.json({ ok: true, resellers, stats });
  } catch { res.json({ ok: true, resellers: [], stats: { total: 0, total_balance: 0, deposited_today: 0, sold_today: 0 } }); }
});

// Make or remove reseller
app.post('/api/resellers/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id);
  const uid = Number(req.body?.user_id);
  const makeReseller = req.body?.is_reseller === undefined ? 1 : (Number(req.body.is_reseller) ? 1 : 0);
  if (!b || !Number.isInteger(uid)) return res.status(400).json({ ok: false, message: 'Bad input' });
  ensureBotSchema(b);
  try {
    run(b, 'UPDATE users SET is_reseller=?, updated_at=? WHERE id=?', [makeReseller, now(), uid]);
    res.json({ ok: true, is_reseller: makeReseller });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: TOP-UPS (balance orders only)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/payments/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try {
    res.json({
      ok: true,
      payments: rows(b, `SELECT o.*, u.username, u.first_name FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.order_type='balance' ORDER BY o.id DESC LIMIT 200`)
    });
  } catch { res.json({ ok: true, payments: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: PRODUCT ORDERS (BUG 3 FIX)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/orders/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try {
    const orders = rows(b, `
      SELECT o.*, u.username, u.first_name,
             p.name as product_name, pl.name as plan_name
      FROM orders o
      LEFT JOIN users u ON u.id=o.user_id
      LEFT JOIN plans pl ON pl.id=o.plan_id
      LEFT JOIN products p ON p.id=pl.product_id
      WHERE o.order_type='product'
      ORDER BY o.id DESC LIMIT 200
    `);
    res.json({ ok: true, orders });
  } catch { res.json({ ok: true, orders: [] }); }
});

// ─── Admin: Cancel an order ────────────────────────────────────────────────────
app.post('/api/orders/:botId/:orderId/cancel', (req, res) => {
  const botId = intId(req.params.botId), orderId = intId(req.params.orderId);
  const b = accessibleBot(req, botId);
  if (!b || !orderId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  try {
    run(b, "UPDATE orders SET status='cancelled', admin_note=? WHERE id=? AND status NOT IN ('approved')", [String(req.body?.reason || 'Cancelled by admin').slice(0, 500), orderId]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ─── Admin: Force-deliver a stuck order (with optional key) ───────────────────
app.post('/api/orders/:botId/:orderId/force-deliver', (req, res) => {
  const botId = intId(req.params.botId), orderId = intId(req.params.orderId);
  const b = accessibleBot(req, botId);
  if (!b || !orderId) return res.status(400).json({ ok: false, message: 'Bad IDs' });
  ensureBotSchema(b);
  const customKey = String(req.body?.key || '').trim().slice(0, 500);
  try {
    const order = one(b, 'SELECT * FROM orders WHERE id=?', [orderId]);
    if (!order) return res.status(404).json({ ok: false, message: 'Order not found' });
    if (order.status === 'approved') return res.json({ ok: true, message: 'Already delivered' });

    const d = new DatabaseSync(b.db_path);
    try {
      d.exec('BEGIN IMMEDIATE');
      let keyValue = customKey;
      let keyId = null;

      // If custom key provided, insert it as sold
      if (keyValue) {
        const cur = d.prepare("INSERT INTO stock_keys(plan_id, key_value, status, assigned_order_id, created_at, key_type) VALUES(?,?,?,?,?,?)")
          .run(order.plan_id, keyValue, 'sold', orderId, now(), 'manual');
        keyId = cur.lastInsertRowid;
      } else {
        // Try to claim available stock
        const stock = d.prepare("SELECT * FROM stock_keys WHERE plan_id=? AND status='available' ORDER BY id LIMIT 1").get(order.plan_id);
        if (stock) {
          const claimed = d.prepare("UPDATE stock_keys SET status='sold', assigned_order_id=? WHERE id=? AND status='available'").run(orderId, stock.id);
          if (claimed.changes === 1) { keyValue = stock.key_value; keyId = stock.id; }
        }
      }

      if (!keyValue) {
        d.exec('ROLLBACK'); d.close();
        return res.status(400).json({ ok: false, message: 'No stock available — provide a custom key' });
      }

      const expiry = new Date(Date.now() + (30 * 24 * 3600 * 1000)).toISOString();
      d.prepare("UPDATE orders SET status='approved', approved_at=?, expiry_at=?, key_id=?, delivery_status='delivered', delivery_error='' WHERE id=?")
        .run(now(), expiry, keyId, orderId);
      d.prepare("UPDATE orders SET admin_note=? WHERE id=?")
        .run(`${order.admin_note || ''}\n[Force-delivered at ${now()}]`.trim(), orderId);
      d.exec('COMMIT');
      d.close();
      res.json({ ok: true, message: 'Order marked delivered — bot will send key shortly', key: keyValue });
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch {}
      try { d.close(); } catch {}
      throw e;
    }
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: BROADCAST
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/broadcasts/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try { res.json({ ok: true, broadcasts: rows(b, 'SELECT * FROM scheduled_broadcasts ORDER BY id DESC LIMIT 50') }); } catch { res.json({ ok: true, broadcasts: [] }); }
});

app.post('/api/broadcast/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id);
  const text = String(req.body?.text || '').trim();
  const mediaType = String(req.body?.media_type || '').trim();
  const mediaUrl = String(req.body?.media_url || '').trim();
  if (!b || !text) return res.status(400).json({ ok: false, message: 'Message required' });
  ensureBotSchema(b);
  try {
    run(b, "INSERT INTO scheduled_broadcasts(message, media_type, media_url, run_at, created_at, status) VALUES(?,?,?,?,?,'scheduled')", [text, mediaType, mediaUrl, now(), now()]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.delete('/api/broadcast/:id/:broadcastId/delete-from-chats', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const broadcastId = intId(req.params.broadcastId); if (!broadcastId) return res.status(400).json({ ok: false, message: 'Bad ID' });
  run(b, "UPDATE scheduled_broadcasts SET status='deleting' WHERE id=?", [broadcastId]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: COUPONS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/coupons/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try { res.json({ ok: true, coupons: rows(b, 'SELECT * FROM coupons ORDER BY id DESC') }); } catch { res.json({ ok: true, coupons: [] }); }
});

app.post('/api/coupons/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const x = req.body || {};
  const code = String(x.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9_-]{3,30}$/.test(code)) return res.status(400).json({ ok: false, message: 'Bad code' });
  const type = String(x.discount_type || 'percent').toLowerCase();
  if (!['percent', 'fixed'].includes(type)) return res.status(400).json({ ok: false, message: 'Bad type' });
  const value = finiteMoney(x.discount_value);
  if (value === null || value <= 0) return res.status(400).json({ ok: false, message: 'Bad value' });
  try {
    run(b, "INSERT INTO coupons(code, discount_type, discount_value, max_uses, max_uses_per_user, min_order_amount, max_discount, expires_at, active) VALUES(?,?,?,?,?,?,?,?,1)", [
      code, type, value,
      Math.max(0, Math.floor(Number(x.max_uses || 0))),
      Math.max(0, Math.floor(Number(x.max_uses_per_user || 1))),
      finiteMoney(x.min_order_amount) || 0,
      finiteMoney(x.max_discount) || 0,
      String(x.expires_at || '').slice(0, 30),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message || 'Code exists' }); }
});

app.put('/api/coupons/:id/:couponId', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const cid = intId(req.params.couponId); if (!cid) return res.status(400).json({ ok: false, message: 'Bad ID' });
  const x = req.body || {};
  try {
    run(b, `UPDATE coupons SET active=COALESCE(?,active), max_uses=COALESCE(?,max_uses), expires_at=COALESCE(?,expires_at) WHERE id=?`, [
      x.active === undefined ? null : Number(x.active ? 1 : 0),
      x.max_uses === undefined ? null : Math.max(0, Math.floor(Number(x.max_uses))),
      x.expires_at === undefined ? null : String(x.expires_at || '').slice(0, 30),
      cid
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.delete('/api/coupons/:id/:couponId', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const cid = intId(req.params.couponId); if (!cid) return res.status(400).json({ ok: false, message: 'Bad ID' });
  run(b, 'DELETE FROM coupons WHERE id=?', [cid]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: STORE SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/config/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  try { res.json({ ok: true, settings: rows(b, 'SELECT key, value FROM settings ORDER BY key') }); } catch { res.json({ ok: true, settings: [] }); }
});

app.put('/api/config/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  ensureBotSchema(b);
  const d = new DatabaseSync(b.db_path);
  try {
    d.exec('BEGIN IMMEDIATE');
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(k)) continue;
      d.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? '').slice(0, 5000));
    }
    d.exec('COMMIT'); d.close();
    res.json({ ok: true });
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} try { d.close(); } catch {} res.status(400).json({ ok: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: FAMGATEWAY — TEST CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/gateway/test/:id', async (req, res) => {
  const b = accessibleBot(req, req.params.id);
  if (!b) return res.status(404).json({ ok: false, message: 'Bot not found' });
  ensureBotSchema(b);

  const apiRow = one(b, "SELECT value FROM settings WHERE key='payment_gateway_api_key'");
  const apiKey = apiRow ? String(apiRow.value || '').trim() : '';
  if (!apiKey) return res.json({ ok: false, message: 'API key not set — save settings first' });

  try {
    const url = `https://famgateway.in/api/qr.php?api_key=${encodeURIComponent(apiKey)}&amount=1.00&customer_name=${encodeURIComponent('Connection Test')}`;

    const result = await new Promise((resolve) => {
      const u = new URL(url);
      const r = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 15000,
        headers: { 'Accept': 'application/json', 'User-Agent': 'SHIVAM-BOT/3.7.0' },
      }, (resp) => {
        let raw = '';
        resp.on('data', d => raw += d);
        resp.on('end', () => resolve({ status: resp.statusCode, raw }));
      });
      r.on('error', e => resolve({ status: 0, raw: '', error: e.message }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, raw: '', error: 'Timeout' }); });
      r.end();
    });

    if (result.status === 0) {
      return res.json({ ok: false, message: `Connection failed: ${result.error || 'Network error'}` });
    }

    let payload = null;
    try { payload = JSON.parse(result.raw); } catch {}
    const status = String((payload && (payload.status || payload.error)) || '').toLowerCase();

    if (result.status === 401 || status === 'unauthorized') {
      return res.json({ ok: false, message: 'Invalid API key — FamGateway ने reject किया' });
    }
    if (result.status >= 400) {
      return res.json({ ok: false, message: `HTTP ${result.status}: ${(result.raw || '').slice(0, 150)}` });
    }

    const data = (payload && payload.data) || {};
    const orderId = String(data.order_id || '').trim();
    if (!orderId) {
      return res.json({ ok: false, message: `Gateway returned unknown format: ${(result.raw || '').slice(0, 150)}` });
    }

    res.json({
      ok: true,
      message: `FamGateway connected successfully. Test order created for ₹1.`,
      test_order_id: orderId,
      test_qr_url: String(data.qr_url || '').trim(),
      test_checkout_url: String(data.checkout_url || '').trim(),
    });
  } catch (e) {
    res.json({ ok: false, message: `Test failed: ${publicError(e)}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: FAMGATEWAY — LOGS VIEWER
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/gateway/logs/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id);
  if (!b) return res.status(404).json({ ok: false, message: 'Bot not found' });
  ensureBotSchema(b);
  try {
    // Return recent gateway-related settings (debug logs saved by bot)
    const logs = rows(b, `SELECT key, value FROM settings WHERE key LIKE 'last_gateway_%' ORDER BY key DESC LIMIT 30`);
    // Also return recent orders with fg_order_id for status
    const recentOrders = rows(b, `
      SELECT id, order_no, fg_order_id, amount, status, utr, delivery_status, created_at, admin_note
      FROM orders
      WHERE payment_method='gateway' AND fg_order_id!=''
      ORDER BY id DESC LIMIT 30
    `);
    res.json({ ok: true, logs, recent_orders: recentOrders });
  } catch (e) { res.json({ ok: true, logs: [], recent_orders: [] }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: FAMGATEWAY WEBHOOK (HMAC-SHA256 signed)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/famgateway/webhook/:botId', async (req, res) => {
  const botId = intId(req.params.botId);
  const b = getBot(botId);
  if (!b) return res.status(404).json({ ok: false, message: 'Bot not found' });

  ensureBotSchema(b);
  const apiRow = one(b, "SELECT value FROM settings WHERE key='payment_gateway_api_key'");
  const apiKey = apiRow ? String(apiRow.value || '').trim() : '';
  if (!apiKey) return res.status(400).json({ ok: false, message: 'Gateway not configured' });

  // Verify signature
  const signature = String(req.headers['x-famgateway-signature'] || '').trim();
  const rawBody = req.rawBody;
  if (!signature || !rawBody) return res.status(400).json({ ok: false, message: 'Missing signature or body' });

  try {
    const computed = crypto.createHmac('sha256', apiKey).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'utf8');
    const comBuf = Buffer.from(computed, 'utf8');
    if (sigBuf.length !== comBuf.length || !crypto.timingSafeEqual(sigBuf, comBuf)) {
      console.warn(`[FamGateway Webhook] Invalid signature for bot ${botId}`);
      return res.status(401).json({ ok: false, message: 'Invalid signature' });
    }
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Signature check failed' });
  }

  let payload = {};
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ ok: false, message: 'Invalid JSON' }); }

  const event = String(payload.event || '').trim();
  const fgOrderId = String(payload.order_id || '').trim();
  const utr = String(payload.utr || '').trim();
  const amount = payload.amount;
  const senderName = String(payload.sender_name || '').trim();

  console.log(`[FamGateway Webhook] bot=${botId} event=${event} fg_order=${fgOrderId} utr=${utr} amount=${amount}`);

  if (event !== 'payment.success' || !fgOrderId) {
    return res.json({ ok: true, received: true, ignored: true });
  }

  // Find our order by fg_order_id
  let order = one(b, "SELECT * FROM orders WHERE fg_order_id=? AND status IN ('pending','awaiting_utr') ORDER BY id DESC LIMIT 1", [fgOrderId]);
  if (!order) {
    // Fallback: search by amount
    order = one(b, "SELECT * FROM orders WHERE status IN ('pending','awaiting_utr') AND ABS(amount - ?) < 0.01 ORDER BY id DESC LIMIT 1", [Number(amount) || 0]);
  }

  if (!order) {
    console.warn(`[FamGateway Webhook] No matching order for fg_order=${fgOrderId} amount=${amount}`);
    return res.json({ ok: true, received: true, matched: false });
  }

  // Save event + mark order as paid (bot's background job will deliver)
  const d = dbFor(b);
  try {
    d.exec('BEGIN IMMEDIATE');
    try {
      d.prepare("INSERT INTO payment_events(provider, provider_event_id, order_id, event_type, received_at, details) VALUES(?,?,?,?,?,?)")
        .run('famgateway', `${fgOrderId}:${utr || ''}`, order.id, 'webhook', now(), JSON.stringify(payload).slice(0, 2000));
    } catch (dupErr) {
      d.exec('COMMIT');
      d.close();
      return res.json({ ok: true, received: true, duplicate: true });
    }
    d.prepare("UPDATE orders SET status='pending', utr=COALESCE(NULLIF(?,''), utr), payment_method='gateway' WHERE id=? AND status IN ('pending','awaiting_utr')")
      .run(utr, order.id);
    d.exec('COMMIT');
    console.log(`[FamGateway Webhook] Order ${order.order_no} (id=${order.id}) marked paid — bot will deliver shortly`);
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch {}
    console.error('[FamGateway Webhook] DB update failed:', e.message);
    d.close();
    return res.status(500).json({ ok: false, message: 'DB error' });
  }
  d.close();

  res.json({ ok: true, received: true, matched: true, order_id: order.order_no });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: GATEWAY CALLBACK URL (kept for compat — now points to famgateway webhook)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/gateway/callback-url/:id', (req, res) => {
  const b = accessibleBot(req, req.params.id); if (!b) return res.status(404).json({ ok: false, message: 'Not found' });
  const base = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!base) return res.status(503).json({ ok: false, message: 'PUBLIC_BASE_URL not set' });
  res.json({ ok: true, callback_url: `${base}/api/famgateway/webhook/${b.id}` });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT + SPA CATCH-ALL
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(f)) return res.status(500).send('Frontend missing');
  res.sendFile(f);
});
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const f = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(f)) return res.status(500).send('Frontend missing');
  res.sendFile(f);
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP: Restore Bots
// ═══════════════════════════════════════════════════════════════════════════════
console.log('🔄 Restoring bots...');
const allBots = builderDb.prepare('SELECT id, username FROM bots').all();
for (const b of allBots) {
  try { startBot(b.id); }
  catch (e) {
    console.error(`Failed bot ${b.id}:`, e.message);
    builderDb.prepare('UPDATE bots SET status=?, last_error=? WHERE id=?').run('offline', e.message, b.id);
  }
}
console.log(`✅ Restored ${allBots.length} bots`);

// ═══════════════════════════════════════════════════════════════════════════════
// WATCHDOG
// ═══════════════════════════════════════════════════════════════════════════════
setInterval(() => {
  for (const b of builderDb.prepare('SELECT id, status, db_path, uptime_started FROM bots').all()) {
    if (b.status !== 'online') continue;
    const c = children.get(b.id);
    const state = restartState.get(b.id) || { startedAt: Date.now(), attempt: 0, nextAt: 0 };
    const inGrace = Date.now() - state.startedAt < STARTUP_GRACE_MS;
    const dir = path.dirname(b.db_path);
    const hb = path.join(dir, 'heartbeat');
    const thb = path.join(dir, 'telegram_heartbeat');
    let stale = false, telegramStale = false;
    try { stale = Date.now() - fs.statSync(hb).mtimeMs > HEARTBEAT_STALE_MS; } catch { stale = !inGrace; }
    try { telegramStale = Date.now() - fs.statSync(thb).mtimeMs > HEARTBEAT_STALE_MS; } catch { telegramStale = !inGrace; }
    const dead = !c || c.exitCode !== null;
    if ((dead || stale || telegramStale) && !inGrace) {
      if (c && c.exitCode === null) { try { c.kill('SIGTERM'); } catch {} }
      if (c === children.get(b.id)) children.delete(b.id);
      if (Date.now() < state.nextAt) continue;
      const attempt = Math.min((state.attempt || 0) + 1, 8);
      const delay = Math.min(3000 * Math.pow(2, attempt - 1), 60000);
      restartState.set(b.id, { startedAt: Date.now(), attempt, nextAt: Date.now() + delay });
      setTimeout(() => {
        try {
          const l = builderDb.prepare('SELECT status FROM bots WHERE id=?').get(b.id);
          if (l && l.status === 'online') startBot(b.id);
        } catch {}
      }, delay).unref();
    }
  }
}, 15000).unref();

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL SELF-PING
// ═══════════════════════════════════════════════════════════════════════════════
setInterval(() => {
  try {
    const port = process.env.PORT || 3000;
    const r = require('http').request(`http://localhost:${port}/api/health`, { timeout: 5000 }, (x) => { x.on('data', () => {}); x.on('end', () => {}); });
    r.on('error', () => {}); r.end();
  } catch {}
}, 300000).unref();

// ═══════════════════════════════════════════════════════════════════════════════
// LOG ROTATION
// ═══════════════════════════════════════════════════════════════════════════════
setInterval(() => {
  try {
    for (const b of builderDb.prepare('SELECT db_path FROM bots').all()) {
      const f = path.join(path.dirname(b.db_path), 'bot.log');
      try {
        const st = fs.statSync(f);
        if (st.size > 2 * 1024 * 1024) {
          const buf = fs.readFileSync(f);
          fs.writeFileSync(f, buf.subarray(Math.max(0, buf.length - 2 * 1024 * 1024)));
        }
      } catch {}
    }
  } catch {}
}, 300000).unref();

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('HTTP_ERROR', publicError(err));
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ ok: false, message: status === 500 ? 'Internal server error' : publicError(err) });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 SHIVAM BOT BUILDER running on port ${PORT}`);
  console.log(`📁 DATA_DIR: ${DATA_DIR}`);
  console.log(`🤖 Active bots: ${children.size}`);
  console.log(`💎 FamGateway webhook: /api/famgateway/webhook/:botId`);
});

function shutdown() {
  console.log('Shutting down...');
  for (const [, c] of children) { try { c.kill('SIGTERM'); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', e => console.error('UNCAUGHT_EXCEPTION', e));
process.on('unhandledRejection', e => console.error('UNHANDLED_REJECTION', e));
