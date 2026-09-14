const assert = require('assert');
const fs = require('fs');
const source = fs.readFileSync('tests.js','utf8');
// Regression guard: tests.js must never perform live external integrations.
for (const re of [
  /\bfetch\s*\(/,
  /\baxios\s*\(/,
  /https\.request\s*\(/,
  /http\.request\s*\(/,
  /createTransport\s*\(/,
  /execFileSync\([^\n]*curl/,
  /execFileSync\([^\n]*wget/
]) assert(!re.test(source), `tests.js contains a live external call pattern: ${re}`);
console.log('PASS: tests.js is offline-safe; no live HTTP/Telegram/OAuth/SMTP/payment calls');
