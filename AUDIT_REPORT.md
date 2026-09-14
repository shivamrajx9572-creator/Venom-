# SHIVAM BOT BUILDER v3.2.5 — 12-Point Audit Closure

## Release status
All twelve reported source/deployment audit findings were re-checked against the release tree.

### 1. Binary stream / source corruption
The ZIP container is intentionally binary, but every shipped source entry is a separate UTF-8 text file. Release validation rejects ZIP signatures inside source files and rejects NUL/control bytes.

### 2. ASCII/Unicode corruption
`server.js`, `bot_template.py`, `public/index.html`, and test/config files decode as UTF-8 and contain no forbidden control bytes.

### 3. Node/Python dual-stack
Node/Express is the single deployment entrypoint. It supervises one isolated Python Telegram worker per bot. Docker installs both Node and Python runtimes.

### 4. Async error handling
Express 5 promise rejection handling is supplemented by explicit `try/catch` around external OAuth/email async handlers and a centralized error middleware. Process-level `uncaughtException` and `unhandledRejection` handlers are present.

### 5. Python blocking I/O
Gateway HTTP and IMAP verification are moved off the asyncio event loop with `asyncio.to_thread`; Telegram connectivity heartbeat runs separately.

### 6. Credential handling
No bot token/API-key/password/JWT-style literal secret fallback is embedded in server or bot source. Bot tokens are encrypted at rest and injected into the worker environment only at runtime.

### 7. Environment schema
`.env.example` documents all runtime settings. It explicitly explains that `DATABASE_URL`, `JWT_SECRET`, and a global `TELEGRAM_BOT_TOKEN` are not required by this SQLite + opaque-session + per-bot-token architecture, preventing misleading undefined defaults.

### 8. Rate limiting / sanitization
API and stricter authentication throttles are installed. Input validation, CSRF protection, tenant isolation, server-side validation, public error sanitization, Telegram escaping, and frontend HTML escaping are covered by regression checks.

### 9. Docker / Render
The Docker image is Node 22 Bookworm plus Python 3/pip, installs both dependency sets, runs Node as the single entrypoint, and exposes a healthcheck. Render is configured for Docker and the persistent data disk.

### 10. Repository artifacts
`.gitignore` and `.dockerignore` exclude environment files, node modules, Python caches/bytecode, databases/logs, backups, and ZIP artifacts. No `.bak`, `.pyc`, `.env`, or nested ZIP is included in the release tree.

### 11. Frontend/API alignment
Regression checks cover the configured bot, products, payments, users, orders, wallet/config endpoints and dedicated page renderers. The UI uses the authenticated `secureApi` path rather than stale legacy endpoints.

### 12. Test isolation
`tests.js` is static/offline and does not make live Telegram/OAuth/SMTP/payment/HTTP calls. `audit_offline_tests.js` is a regression guard that rejects live network-call patterns in the suite.

## Verification performed
- Node syntax check: PASS
- Python compilation: PASS
- Frontend embedded-JS syntax check: PASS
- Existing regression suite: PASS
- Offline-test guard: PASS
- UTF-8/control-byte source scan: PASS
- Release artifact scan: PASS
- ZIP integrity test: PASS

## Important runtime boundary
External Telegram/OAuth/SMTP/payment services require valid production configuration and network access. Those external transactions cannot be truthfully simulated as live production transactions inside an offline build environment; the release instead keeps them behind explicit runtime configuration and tests the source-level wiring and failure handling.
