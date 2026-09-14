# SHIVAM BOT BUILDER 3.0.1 — Premium Customer-Only Bot

This build turns the control-center deployment flow into a real multi-bot runner.

## What is actually wired
- Bot Token + Telegram Owner ID -> Telegram `getMe` verification -> bot deployment.
- Each deployed bot gets its own isolated SQLite database, `.env`, Python runtime folder and log.
- The deployed bot uses the full SHIVAM STORE BOT 3.0.13 customer-only engine (`bot_template.py`), not the old demo worker.
- Telegram bot is customer-facing only: `/start`, shopping, payment/order flows and customer features are exposed. `/admin` never opens an admin panel; it shows a short website-only notice. All privileged setup/admin commands are removed from Telegram command handlers.
- Product/category/plan database is the same schema used by the real bot.
- Manual key/ID stock, atomic stock assignment and delivery lifecycle are handled by the bot engine.
- Wallet, top-up records, reseller flag, referrals, coupons, UPI/UTR flow, Gmail/IMAP verification, settings, scheduled broadcast, retries and diagnostics come from the 3.0.13 customer-only engine.
- Dashboard CRUD reads/writes the deployed bot's actual SQLite database.
- Bot Start/Stop/Restart and crash auto-restart are wired.
- Builder restart automatically brings previously-online bots back up.
- Tokens are encrypted at rest in the builder database and are never returned by the API.
- Logs and health are available from the dashboard.

## Important deployment requirement for 24x7
The builder process itself must run on an always-on server. For Render, use a persistent service and persistent disk for `/var/data`; do not rely on an ephemeral filesystem for SQLite data.

## Local
1. `npm install`
2. `pip3 install -r requirements.txt`
3. `cp .env.example .env`
4. Set a strong `BUILDER_SECRET`.
5. `npm start`
6. Open the displayed port and use **Create & Deploy Bot**.

## Render / Docker
The included `Dockerfile` installs Node + Python + the bot dependencies. The included `render.yaml` uses a persistent disk and `/api/health` health check.

## Honest limitation
No software can be honestly certified “100% bug free” without testing against the user's real Telegram bot, hosting account and payment mailbox. The package is syntax-checked and its runtime architecture is wired for real deployment, but live Telegram/Gmail/payment tests still require those external services.


## Render deployment
- This is a Node/Express Web Service and must be deployed as a server service, not a static site.
- The UI is served from `public/index.html`; `/` explicitly serves the same file.
- Docker installs Node 22 and Python 3 plus bot dependencies.
- Set `BUILDER_SECRET` in Render Environment Variables to a long random secret.
- `DATA_DIR=/var/data` is used with the persistent disk configured in `render.yaml`.
- Keep bot tokens and API credentials in server-side environment/config storage; never commit secrets to GitHub.
- The builder can keep deployed workers running while the hosting service itself is running. A free sleeping host cannot provide a true 24x7 guarantee.
