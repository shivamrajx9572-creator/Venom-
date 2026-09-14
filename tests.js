#!/usr/bin/env node
/**
 * SHIVAM BOT BUILDER — Offline Test Suite
 * v3.7.0 (server) / v4.3.0 (bot)
 * 
 * Runs syntax + structural checks ONLY. Never makes live network calls.
 * Tests reflect the ACTUAL codebase — FamGateway integration, no manual UTR.
 */

process.chdir(__dirname);

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

let passed = 0;
let failed = 0;
function ok(msg) { passed++; console.log('  ✅', msg); }
function fail(msg) { failed++; console.error('  ❌', msg); }

console.log('\n🧪 SHIVAM BOT BUILDER — Offline Test Suite\n');
console.log('   Server: v3.7.0 | Bot: v4.3.0 (FamGateway Edition)\n');

// ═══════════════════════════════════════════════════════════════════════
// 1. REQUIRED FILES
// ═══════════════════════════════════════════════════════════════════════
console.log('📁 Required files...');
const requiredFiles = [
  'server.js',
  'bot_template.py',
  'public/index.html',
  'package.json',
  'requirements.txt',
  'render.yaml',
  'Dockerfile',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  'AUDIT_REPORT.md',
  'ARCHITECTURE.md',
  'SOURCE_INTEGRITY.md',
];
for (const f of requiredFiles) {
  try {
    assert(fs.existsSync(f), `missing ${f}`);
    ok(`${f} present`);
  } catch (e) { fail(e.message); }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. SYNTAX CHECKS
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🔍 Syntax checks...');
try {
  cp.execFileSync(process.execPath, ['--check', 'server.js'], { stdio: 'pipe' });
  ok('server.js syntax OK');
} catch (e) { fail('server.js syntax error: ' + e.message); }

try {
  cp.execFileSync('python3', ['-m', 'py_compile', 'bot_template.py'], { stdio: 'pipe' });
  ok('bot_template.py compiles OK');
} catch (e) { fail('bot_template.py compile error: ' + e.message); }

// Extract inline <script> from HTML and syntax-check it
try {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert(scripts.length > 0, 'no <script> blocks found in public/index.html');
  const tmpFile = '/tmp/shivam-ui-check.js';
  fs.writeFileSync(tmpFile, scripts.join('\n'));
  cp.execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  fs.unlinkSync(tmpFile);
  ok(`public/index.html inline JS syntax OK (${scripts.length} block(s))`);
} catch (e) { fail('public/index.html JS syntax error: ' + e.message); }

// ═══════════════════════════════════════════════════════════════════════
// 3. OFFLINE-SAFE — No live network calls in this file
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🛡️  Offline safety...');
const selfSource = fs.readFileSync(__filename, 'utf8');
const codeWithoutComments = selfSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const liveCallPatterns = [
  /\bfetch\s*\(/,
  /\baxios\s*\(/,
  /https\.request\s*\(/,
  /http\.request\s*\(/,
  /\bnodemailer\b/,
  /createTransport\s*\(/,
];
let hasLive = false;
for (const re of liveCallPatterns) {
  if (re.test(codeWithoutComments)) { hasLive = true; break; }
}
if (hasLive) fail('tests.js contains a live network call pattern');
else ok('tests.js contains no live network calls');

// ═══════════════════════════════════════════════════════════════════════
// 4. SERVER.JS — Structural checks
// ═══════════════════════════════════════════════════════════════════════
console.log('\n⚙️  server.js structure...');
const server = fs.readFileSync('server.js', 'utf8');

const requiredServerFeatures = [
  ["const express = require('express')", 'Express imported'],
  ["require('node:sqlite')", 'node:sqlite imported'],
  ["require('child_process')", 'child_process imported'],
  ['DatabaseSync', 'DatabaseSync class used'],
  ['function startBot(', 'startBot() defined'],
  ['function stopBot(', 'stopBot() defined'],
  ['function restartBot(', 'restartBot() defined'],
  ['function ensureBotSchema(', 'ensureBotSchema() defined (BUG 4 fix)'],
  ['function publicBot(', 'publicBot() sanitizer defined'],
  ['function encrypt(', 'encrypt() defined'],
  ['function decrypt(', 'decrypt() defined'],
  ["app.listen(PORT, '0.0.0.0'", 'binds on 0.0.0.0'],
  ['uncaughtException', 'uncaughtException handler present'],
  ['unhandledRejection', 'unhandledRejection handler present'],
  ['X-Content-Type-Options', 'security headers set'],
  ['function rateLimit(', 'rate limiting present'],
  ["spawn(py, ['bot.py']", 'Python worker spawn wired'],
  ['crypto.timingSafeEqual', 'timing-safe signature check present'],
  ['crypto.createHmac', 'HMAC used for webhook signature'],
];
for (const [needle, label] of requiredServerFeatures) {
  if (server.includes(needle)) ok(label);
  else fail(label + ' — not found');
}

// ═══════════════════════════════════════════════════════════════════════
// 5. SERVER.JS — Real API endpoints
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🌐 server.js API endpoints...');
const endpoints = [
  ["app.get('/api/health'", 'GET /api/health'],
  ["app.post('/api/auth/login'", 'POST /api/auth/login'],
  ["app.post('/api/auth/logout'", 'POST /api/auth/logout'],
  ["app.get('/api/auth/me'", 'GET /api/auth/me'],
  ["app.get('/api/bots'", 'GET /api/bots'],
  ["app.post('/api/bots/deploy'", 'POST /api/bots/deploy'],
  ["app.post('/api/bots/validate'", 'POST /api/bots/validate'],
  ["app.post('/api/bots/:id/:action'", 'POST /api/bots/:id/:action'],
  ["app.get('/api/summary/:id'", 'GET /api/summary/:id'],
  ["app.get('/api/products/:id'", 'GET /api/products/:id'],
  ["app.post('/api/products/:id'", 'POST /api/products/:id'],
  ["app.get('/api/plans/:id'", 'GET /api/plans/:id'],
  ["app.get('/api/keys/:id'", 'GET /api/keys/:id'],
  ["app.post('/api/keys/:id/bulk'", 'POST /api/keys/:id/bulk'],
  ["app.get('/api/users/:id'", 'GET /api/users/:id'],
  ["app.post('/api/wallet/:id'", 'POST /api/wallet/:id'],
  ["app.get('/api/payments/:id'", 'GET /api/payments/:id (top-ups)'],
  ["app.get('/api/orders/:id'", 'GET /api/orders/:id (product orders)'],
  ["app.post('/api/resellers/:id'", 'POST /api/resellers/:id (make/remove reseller)'],
  ["/api/orders/:botId/:orderId/cancel", 'Cancel order endpoint'],
  ["/api/orders/:botId/:orderId/force-deliver", 'Force deliver endpoint'],
  ["app.get('/api/broadcasts/:id'", 'GET /api/broadcasts/:id'],
  ["app.post('/api/broadcast/:id'", 'POST /api/broadcast/:id'],
  ["app.get('/api/coupons/:id'", 'GET /api/coupons/:id'],
  ["app.post('/api/coupons/:id'", 'POST /api/coupons/:id'],
  ["app.get('/api/config/:id'", 'GET /api/config/:id'],
  ["app.put('/api/config/:id'", 'PUT /api/config/:id'],
  ["/api/gateway/test/:id", 'FamGateway test endpoint'],
  ["/api/gateway/logs/:id", 'FamGateway logs endpoint'],
  ["/api/famgateway/webhook/:botId", 'FamGateway webhook endpoint'],
];
for (const [needle, label] of endpoints) {
  if (server.includes(needle)) ok(label);
  else fail(label + ' — not found');
}

// ═══════════════════════════════════════════════════════════════════════
// 6. BUG FIX VERIFICATION
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🐛 Bug fix verification...');

// BUG 1 + 2: /api/users and /api/wallet must NOT use telegram_id in SQL
if (server.match(/FROM users WHERE telegram_id=/i) || server.match(/FROM users WHERE telegram_id\s*=/i)) {
  fail('BUG 1/2 REGRESSED: telegram_id column used in a query');
} else {
  ok('BUG 1/2 fixed: no `telegram_id` query (uses users.id)');
}

// BUG 3: /api/orders/:id endpoint exists
if (server.includes("app.get('/api/orders/:id'")) {
  ok('BUG 3 fixed: /api/orders/:id exists for product orders');
} else {
  fail('BUG 3 REGRESSED: /api/orders/:id missing');
}

// BUG 4: ensureBotSchema function exists and is called in multiple routes
const ensureCalls = (server.match(/ensureBotSchema\(b\)/g) || []).length;
if (server.includes('function ensureBotSchema(') && ensureCalls >= 5) {
  ok(`BUG 4 fixed: ensureBotSchema() defined and called ${ensureCalls} times`);
} else {
  fail(`BUG 4 REGRESSED: ensureBotSchema() missing or under-used (${ensureCalls} calls)`);
}

// BUG 6: node:sqlite import wrapped in try/catch
if (server.match(/try\s*\{[\s\S]{0,250}require\(['"]node:sqlite['"]\)[\s\S]{0,250}\}\s*catch/)) {
  ok('BUG 6 fixed: node:sqlite import wrapped in try/catch');
} else {
  fail('BUG 6 REGRESSED: node:sqlite import not guarded');
}

// Dead nodemailer require removed
if (server.match(/require\(['"]nodemailer['"]\)/)) {
  fail('nodemailer still required but dependency removed from package.json');
} else {
  ok('dead nodemailer require removed');
}

// Webhook signature verification
if (server.includes('x-famgateway-signature') || server.includes('X-FamGateway-Signature')) {
  ok('FamGateway webhook signature header checked');
} else {
  fail('FamGateway webhook signature header check missing');
}

// Raw body capture for signature verification
if (server.includes('req.rawBody')) {
  ok('raw body captured for webhook signature verification');
} else {
  fail('raw body capture for webhook missing');
}

// VC Gateway removed
if (server.includes('vcgatewaypro.com')) {
  fail('VC Gateway URL still referenced (should be removed)');
} else {
  ok('VC Gateway references removed');
}

// ═══════════════════════════════════════════════════════════════════════
// 7. BOT_TEMPLATE.PY — Structural checks
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🤖 bot_template.py structure...');
const bot = fs.readFileSync('bot_template.py', 'utf8');

const requiredBotFeatures = [
  ['def init_db()', 'init_db() defined'],
  ['def gateway_configured()', 'gateway_configured() defined'],
  ['def get_fg_client()', 'get_fg_client() defined'],
  ['async def fg_create_order(', 'fg_create_order() defined'],
  ['async def fg_verify_order(', 'fg_verify_order() defined'],
  ['async def fg_check_status(', 'fg_check_status() defined'],
  ['async def fg_test_connection(', 'fg_test_connection() defined'],
  ['async def fulfill_order(', 'fulfill_order() defined'],
  ['async def do_pay(', 'do_pay() defined'],
  ['async def do_confirm_wallet(', 'do_confirm_wallet() defined'],
  ['async def confirm_order_screen(', 'confirm_order_screen() defined'],
  ['async def coupon_apply_start(', 'coupon_apply_start() defined'],
  ['async def text_handler(', 'text_handler() defined'],
  ['async def callback_router(', 'callback_router() defined'],
  ['def heartbeat_thread()', 'heartbeat_thread() defined'],
  ['BOT_HEARTBEAT_PATH', 'heartbeat env var wired'],
  ['telegram_heartbeat', 'telegram connectivity file wired'],
  ['Application.builder().token(BOT_TOKEN).build()', 'PTB Application built'],
  ['def track_msg(', 'track_msg() screen tracking defined'],
  ['async def clear_all_screens(', 'clear_all_screens() defined'],
  ['async def send_tracked(', 'send_tracked() defined'],
  ['async def _clear_user_screens_by_chat(', '_clear_user_screens_by_chat() defined'],
];
for (const [needle, label] of requiredBotFeatures) {
  if (bot.includes(needle)) ok(label);
  else fail(label + ' — not found');
}

// FamGateway import
if (bot.includes('from famgateway import') && bot.includes('FAMGATEWAY_AVAILABLE')) {
  ok('FamGateway SDK import (with fallback flag)');
} else {
  fail('FamGateway SDK import missing');
}

// Screen cleanup BUG 5 fix: coupon flow deletes old message + uses send_new
if (bot.includes('send_new=True') && bot.includes('await update.effective_message.delete()')) {
  ok('BUG 5 fixed: coupon flow deletes old message + sends fresh');
} else {
  fail('BUG 5 REGRESSED: coupon flow message stacking still present');
}

// Manual UTR flow must be REMOVED
if (bot.includes('manual_utr_start') || bot.includes('flow") == "utr_input"')) {
  fail('Manual UTR flow still present (should be removed — FamGateway only)');
} else {
  ok('manual UTR flow removed (FamGateway only)');
}

// VC Gateway references removed
if (bot.includes('vcgatewaypro.com') || bot.includes('_build_gateway_url') || bot.includes('verify_gateway_payment(')) {
  fail('VC Gateway functions still present');
} else {
  ok('VC Gateway functions removed');
}

// Broadcast media auto-detect
if (bot.includes('Auto-detect media type') || bot.includes('.mp4') || bot.includes('send_video')) {
  ok('broadcast media auto-detect (video/audio/photo/document)');
} else {
  fail('broadcast media auto-detect missing');
}

// send_video, send_audio, send_document present
if (bot.includes('send_video') && bot.includes('send_audio') && bot.includes('send_document')) {
  ok('broadcast supports video, audio, document');
} else {
  fail('broadcast media types incomplete');
}

// fg_order_id column referenced
if (bot.includes('fg_order_id')) {
  ok('fg_order_id column used (FamGateway order tracking)');
} else {
  fail('fg_order_id column missing');
}

// ═══════════════════════════════════════════════════════════════════════
// 8. FRONTEND (public/index.html) — UI markers
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🎨 public/index.html UI markers...');
const html = fs.readFileSync('public/index.html', 'utf8');

const uiMarkers = [
  'SHIVAM BOT BUILDER',
  'loginScreen',
  'id="app"',
  'id="view"',
  'id="drawer"',
  'id="modal"',
  'id="toast"',
  'id="cmdk"',
  'function doLogin',
  'function go(',
  'function api(',
  'function esc(',
  'logo-orb',
  'orb-core',
];
for (const m of uiMarkers) {
  if (html.includes(m)) ok(`UI marker: ${m}`);
  else fail(`UI marker missing: ${m}`);
}

// FamGateway page (not VC Gateway)
if (html.includes('FamGateway Integration')) ok('FamGateway page present');
else fail('FamGateway page missing');
if (html.includes('vcgatewaypro') || html.includes('VC Gateway (Pro)')) fail('VC Gateway UI still present');
else ok('VC Gateway UI removed');

// Members page has Make Reseller button
if (html.includes('Make Reseller') && html.includes('toggleReseller')) {
  ok('Members page has Make Reseller button');
} else {
  fail('Make Reseller button missing');
}

// Pending Orders page
if (html.includes('Pending Orders') && html.includes('forceDeliver')) {
  ok('Pending Orders page with force-deliver');
} else {
  fail('Pending Orders page missing');
}

// Broadcast media preview
if (html.includes('previewMedia') && html.includes('media-preview')) {
  ok('Broadcast media auto-detect preview');
} else {
  fail('Broadcast media preview missing');
}

// Gateway logs viewer
if (html.includes('loadGatewayLogs') && html.includes('gatewayLogs')) {
  ok('Gateway debug logs viewer');
} else {
  fail('Gateway logs viewer missing');
}

// Gateway test connection
if (html.includes('testGatewayConnection') && html.includes('Test Connection')) {
  ok('Gateway Test Connection button');
} else {
  fail('Gateway Test Connection button missing');
}

// No manual UTR in UI
if (html.includes('Enter UTR') || html.includes('manual_utr')) {
  fail('Manual UTR UI still present');
} else {
  ok('manual UTR UI removed');
}

// Frontend calls /api/orders/:id
if (html.includes('/api/orders/')) ok('frontend calls /api/orders/:id');
else fail('frontend does not call /api/orders/:id');

// Frontend sends user_id (not telegram_id)
if (html.includes('user_id:userId') || html.includes('user_id: userId')) {
  ok('frontend sends user_id for wallet/reseller');
} else {
  fail('frontend may still send telegram_id');
}

// Login page max-width (medium size)
if (html.includes('max-width:400px') && html.includes('.login-wrap')) {
  ok('login page has medium size (max-width 400px)');
} else {
  fail('login page medium-size constraint missing');
}

// ═══════════════════════════════════════════════════════════════════════
// 9. SOURCE INTEGRITY — No control bytes, no embedded credentials
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🔒 Source integrity...');
const sourceFiles = [
  'server.js', 'bot_template.py', 'public/index.html',
  'tests.js', 'package.json', 'requirements.txt',
  'render.yaml', 'Dockerfile', '.env.example',
];
for (const f of sourceFiles) {
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const hasControl = [...buf].some(x => x === 0 || (x >= 1 && x <= 8) || x === 11 || x === 12 || (x >= 14 && x <= 31));
  if (hasControl) fail(`${f}: contains forbidden control bytes`);
  else ok(`${f}: clean UTF-8, no control bytes`);
}

// No hardcoded credential fallbacks
const credPattern = /(?:BOT_TOKEN|TELEGRAM_BOT_TOKEN|JWT_SECRET|BUILDER_SECRET|API_KEY)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/;
if (credPattern.test(server)) fail('hardcoded credential-like literal in server.js');
else ok('no hardcoded credentials in server.js');
if (credPattern.test(bot)) fail('hardcoded credential-like literal in bot_template.py');
else ok('no hardcoded credentials in bot_template.py');

// ═══════════════════════════════════════════════════════════════════════
// 10. PACKAGE.JSON
// ═══════════════════════════════════════════════════════════════════════
console.log('\n📦 package.json...');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.version === '3.6.0' || pkg.version === '3.7.0' || pkg.version === '3.6.1') {
  ok(`version = ${pkg.version}`);
} else {
  fail(`unexpected version: ${pkg.version}`);
}
if (pkg.dependencies && pkg.dependencies.express) ok('express dependency present');
else fail('express dependency missing');
if (pkg.dependencies && pkg.dependencies.nodemailer) fail('nodemailer dependency still declared (should be removed)');
else ok('nodemailer dependency removed');
if (pkg.engines && pkg.engines.node && /22\.[5-9]|2[3-9]/.test(pkg.engines.node)) {
  ok(`node engine = ${pkg.engines.node}`);
} else {
  fail(`node engine should be >=22.5.0 (found: ${pkg.engines?.node})`);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. RENDER.YAML
// ═══════════════════════════════════════════════════════════════════════
console.log('\n☁️  render.yaml...');
const render = fs.readFileSync('render.yaml', 'utf8');
const renderKeys = ['BUILDER_SECRET', 'BUILDER_ADMIN_KEY', 'DATA_DIR', 'NODE_ENV', 'PORT'];
for (const k of renderKeys) {
  if (render.includes(k)) ok(`render env: ${k}`);
  else fail(`render env missing: ${k}`);
}
if (render.includes('sync: false') && (render.match(/sync: false/g) || []).length >= 3) {
  ok('secrets marked sync:false');
} else {
  fail('secrets not properly marked in render.yaml');
}
if (render.includes('/var/data')) ok('DATA_DIR uses /var/data persistent disk');
else fail('DATA_DIR should be /var/data for Render persistent disk');

// ═══════════════════════════════════════════════════════════════════════
// 12. DOCKERFILE
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🐳 Dockerfile...');
const docker = fs.readFileSync('Dockerfile', 'utf8');
if (docker.includes('python3') && docker.includes('python3-pip')) ok('Python runtime installed');
else fail('Dockerfile missing Python runtime');
if (docker.includes('CMD ["node","server.js"]') || docker.includes("CMD ['node','server.js']")) ok('Node is entrypoint');
else fail('Dockerfile CMD must run node server.js');
if (docker.includes('HEALTHCHECK')) ok('HEALTHCHECK present');
else fail('Dockerfile missing HEALTHCHECK');

// ═══════════════════════════════════════════════════════════════════════
// 13. IGNORE RULES
// ═══════════════════════════════════════════════════════════════════════
console.log('\n📋 Ignore rules...');
const gi = fs.readFileSync('.gitignore', 'utf8');
for (const m of ['.env', 'node_modules', '*.py[cod]', '__pycache__', '*.sqlite', '*.log']) {
  if (gi.includes(m)) ok(`.gitignore covers ${m}`);
  else fail(`.gitignore missing: ${m}`);
}
const di = fs.readFileSync('.dockerignore', 'utf8');
for (const m of ['.env', 'node_modules', '__pycache__', '*.zip']) {
  if (di.includes(m)) ok(`.dockerignore covers ${m}`);
  else fail(`.dockerignore missing: ${m}`);
}

// ═══════════════════════════════════════════════════════════════════════
// 14. NO STRAY ARTIFACTS
// ═══════════════════════════════════════════════════════════════════════
console.log('\n🧹 Stray artifacts...');
const strayPatterns = ['.bak', '.pyc', '.swp', '~'];
const rootFiles = fs.readdirSync('.').filter(f => !f.startsWith('.'));
for (const f of rootFiles) {
  if (strayPatterns.some(p => f.endsWith(p))) fail(`stray artifact: ${f}`);
}
if (fs.existsSync('__pycache__')) fail('__pycache__ directory should not ship');
else ok('no __pycache__ in tree');
if (rootFiles.includes('index.html')) fail('root index.html duplicate must not exist');
else ok('no duplicate root index.html');

// ═══════════════════════════════════════════════════════════════════════
// 15. REQUIREMENTS.TXT
// ═══════════════════════════════════════════════════════════════════════
console.log('\n📋 requirements.txt...');
const req = fs.readFileSync('requirements.txt', 'utf8');
if (req.includes('famgateway')) ok('famgateway listed');
else fail('famgateway not in requirements.txt');
if (req.includes('python-telegram-bot')) ok('python-telegram-bot listed');
else fail('python-telegram-bot not in requirements.txt');
if (req.includes('qrcode') && req.includes('pillow')) ok('qrcode + pillow listed');
else fail('qrcode or pillow missing');

// ═══════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log('═'.repeat(64) + '\n');

if (failed > 0) {
  console.error('❌ Some checks failed. Review the errors above.\n');
  process.exit(1);
}

console.log('✅ All checks passed. Source is offline-safe and structurally sound.\n');
process.exit(0);