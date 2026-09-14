# Source Integrity & Audit Closure

This package is a ZIP distribution containing a normal text source tree. The ZIP container itself is binary by definition; its entries are not binary source streams.

The following files are required to be UTF-8 text and are checked for ZIP signatures, NUL/control bytes, and UTF-8 decoding before release:
- server.js
- bot_template.py
- public/index.html
- tests.js
- Dockerfile
- .env.example
- .gitignore
- .dockerignore
- render.yaml
- package.json

The deployment model is intentionally single-entrypoint: Node/Express starts first and supervises isolated Python Telegram worker processes. The Docker image installs both runtimes.

The test suite is offline-safe and must not make live Telegram, OAuth, SMTP, payment-gateway, or arbitrary HTTP calls. External integrations are exercised only by the deployed runtime when configured.
