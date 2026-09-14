# SHIVAM BOT BUILDER 3.2.5 — Runtime Architecture

- **One deployment runtime:** Node.js/Express is the web/API supervisor.
- **Bot workers:** Node starts one isolated `python3 bot.py` child process per deployed Telegram bot.
- **No second host/runtime is required:** Docker installs Node + Python in the same image and Node orchestrates the Python workers.
- **Secrets:** Bot tokens are supplied to workers through the child-process environment and stored encrypted in the builder database. Tokens are never written to bot `.env` files.
- **Persistence:** Builder metadata uses SQLite; each bot has its own SQLite database under `DATA_DIR/bots/`.
- **Recovery:** heartbeat + Telegram connectivity files are checked by the Node watchdog; stale/dead workers are restarted with bounded backoff.
- **Deployment:** Render uses the Dockerfile, so both Node and Python dependencies are installed before the Node server starts.
- **Frontend:** `public/index.html` is a single-page control center with dedicated page renderers for Dashboard, Wallet, API/Payment Gateway, Products, Keys, Orders, Members, Settings, Logs, Profile, Admin Center, and other modules.
