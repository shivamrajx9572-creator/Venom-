#!/usr/bin/env python3
"""
SHIVAM STORE BOT v4.3.0 - FAMGATEWAY EDITION
FamGateway integration • Screen management • Auto-verify only
No manual UTR flow
"""

from __future__ import annotations
import asyncio, base64, json, logging, os, re, secrets, sqlite3, threading, time
import urllib.error, urllib.request, random
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from html import escape
from io import BytesIO
from pathlib import Path
from urllib.parse import urlencode, quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import qrcode
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application, CallbackQueryHandler, CommandHandler,
    ContextTypes, MessageHandler, filters,
)

# ─── FamGateway SDK ────────────────────────────────────────────────────────────
try:
    from famgateway import FamGateway, FamGatewayError
    FAMGATEWAY_AVAILABLE = True
except ImportError:
    FAMGATEWAY_AVAILABLE = False
    FamGateway = None
    FamGatewayError = Exception

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════════
BOT_VERSION = "SHIVAM STORE BOT v4.3.0"
BASE_DIR = Path(__file__).resolve().parent
VERIFY_MAX_ATTEMPTS = 6
VERIFY_DELAY_SECONDS = 10


def load_dotenv():
    env_file = BASE_DIR / ".env"
    if not env_file.exists(): return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
DB_PATH = Path(os.getenv("DB_PATH", str(BASE_DIR / "shivam_store.sqlite3")))
HEARTBEAT_PATH = os.getenv("BOT_HEARTBEAT_PATH", "").strip()
EXTERNAL_API_URL = os.getenv("EXTERNAL_API_URL", "").strip()
EXTERNAL_API_KEY = os.getenv("EXTERNAL_API_KEY", "").strip()
EXTERNAL_MASTER_KEY = os.getenv("EXTERNAL_MASTER_KEY", "").strip()
_owner_str = os.getenv("ADMIN_USER_ID", "")
OWNER_NOTIFY_CHAT = _owner_str.split(",")[0].strip() if _owner_str else ""


def resolve_timezone(name):
    try: return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == "Asia/Kolkata": return timezone(timedelta(hours=5, minutes=30), name="Asia/Kolkata")
        return timezone.utc


TIMEZONE = resolve_timezone(os.getenv("STORE_TIMEZONE", "Asia/Kolkata"))
_owner_ids = [int(x.strip()) for x in _owner_str.split(",") if x.strip().lstrip("-").isdigit()]
OWNER_USER_ID = _owner_ids[0] if _owner_ids else None
ADMIN_USER_IDS = set(_owner_ids)

CATEGORIES = [
    ("android_nonroot", "ANDROID NON ROOT", "🤖"),
    ("android_root", "ANDROID ROOT", "🔓"),
    ("iphone", "iPHONE", "🍎"),
]


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
def utc_now(): return datetime.now(timezone.utc)
def iso_now(): return utc_now().isoformat(timespec="seconds")


def display_date(value):
    if not value: return "—"
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(TIMEZONE).strftime("%d %b %Y, %I:%M %p")
    except ValueError: return str(value)


def decimal_amount(value):
    try:
        if isinstance(value, Decimal): amount = value
        else: amount = Decimal(str(value if value is not None else "0").replace(",", "").strip() or "0")
        return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError): return Decimal("0.00")


def money(value):
    amount = decimal_amount(value)
    return f"₹{amount:,.2f}".replace(".00", "")


def safe(value):
    return escape("" if value is None else str(value), quote=False)


@contextmanager
def db():
    conn = sqlite3.connect(str(DB_PATH), timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        yield conn
    except Exception:
        conn.rollback(); raise
    finally: conn.close()


def ensure_column(conn, table, column, definition):
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing: conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def setting(key, default=""):
    try:
        with db() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return str(row["value"]) if row else default
    except Exception: return default


def set_setting(key, value):
    with db() as conn:
        conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
        conn.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# ⭐ SCREEN MANAGEMENT — TRACKS ALL BOT MESSAGES FOR CLEANUP
# ═══════════════════════════════════════════════════════════════════════════════
def track_msg(context, chat_id, message_id):
    """Track a bot message for later cleanup. Keeps last 25."""
    try:
        screens = context.user_data.get("screens") or []
        pair = [int(chat_id), int(message_id)]
        if pair not in screens:
            screens.append(pair)
        context.user_data["screens"] = screens[-25:]
    except Exception: pass


async def clear_all_screens(context, bot):
    """Delete every tracked bot message. Called on every state transition."""
    screens = context.user_data.get("screens") or []
    for item in screens:
        try:
            chat_id, message_id = int(item[0]), int(item[1])
            await bot.delete_message(chat_id=chat_id, message_id=message_id)
        except Exception:
            pass
    context.user_data["screens"] = []


async def send_tracked(context, chat_id, text=None, photo=None, caption=None, markup=None):
    """Send a new message/photo and auto-track it."""
    try:
        if photo is not None:
            sent = await context.bot.send_photo(chat_id=chat_id, photo=photo, caption=caption or "", reply_markup=markup, parse_mode=ParseMode.HTML)
        else:
            sent = await context.bot.send_message(chat_id=chat_id, text=text or "", reply_markup=markup, parse_mode=ParseMode.HTML)
        track_msg(context, sent.chat_id, sent.message_id)
        return sent
    except Exception as e:
        logging.exception(f"send_tracked failed: {e}")
        return None


async def edit_or_send(update, context, text, markup=None):
    """Edit the source message or send new; track the target either way."""
    q = update.callback_query
    if q and q.message:
        try:
            await q.edit_message_text(text, reply_markup=markup, parse_mode=ParseMode.HTML)
            track_msg(context, q.message.chat_id, q.message.message_id)
            return
        except Exception:
            try:
                await q.edit_message_caption(caption=text, reply_markup=markup, parse_mode=ParseMode.HTML)
                track_msg(context, q.message.chat_id, q.message.message_id)
                return
            except Exception:
                sent = await q.message.reply_text(text, reply_markup=markup, parse_mode=ParseMode.HTML)
                track_msg(context, sent.chat_id, sent.message_id)
                return
    if update.effective_message:
        sent = await update.effective_message.reply_text(text, reply_markup=markup, parse_mode=ParseMode.HTML)
        track_msg(context, sent.chat_id, sent.message_id)


async def _clear_user_screens_by_chat(context, chat_id):
    """Clear tracked screens for a specific chat (used in background jobs)."""
    screens = context.user_data.get("screens") or []
    for item in screens:
        try:
            if int(item[0]) == int(chat_id):
                await context.bot.delete_message(chat_id=int(item[0]), message_id=int(item[1]))
        except Exception: pass
    context.user_data["screens"] = [s for s in screens if int(s[0]) != int(chat_id)]


# ═══════════════════════════════════════════════════════════════════════════════
# DB INIT
# ═══════════════════════════════════════════════════════════════════════════════
def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript("""
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
        """)
        for tbl, col, defn in [
            ("plans", "remote_id", "TEXT DEFAULT ''"), ("plans", "remote_duration", "TEXT DEFAULT ''"),
            ("stock_keys", "key_type", "TEXT DEFAULT 'key'"),
            ("orders", "pending_message_chat_id", "INTEGER"), ("orders", "pending_message_id", "INTEGER"),
            ("orders", "coupon_code", "TEXT NOT NULL DEFAULT ''"), ("orders", "discount_amount", "REAL NOT NULL DEFAULT 0"),
            ("orders", "utr", "TEXT DEFAULT ''"), ("orders", "admin_note", "TEXT DEFAULT ''"),
            ("orders", "fg_order_id", "TEXT DEFAULT ''"),
            ("products", "emoji", "TEXT DEFAULT ''"), ("products", "header_text", "TEXT DEFAULT ''"),
            ("products", "sub_text", "TEXT DEFAULT ''"), ("products", "category_key", "TEXT DEFAULT ''"),
        ]:
            try: ensure_column(conn, tbl, col, defn)
            except Exception: pass
        defaults = {
            "store_name": "SHIVAM STORE", "payment_gateway_api_key": "", "payment_gateway_enabled": "1",
            "payment_gateway_provider": "famgateway",
            "payment_upi_id": "paytm.s1dw5n0@pty", "min_deposit": "10", "max_deposit": "50000",
            "referral_reward_balance": "2", "referral_reward_purchase": "2",
            "spin_min": "0.30", "spin_max": "2.00", "spin_cooldown": "24",
            "milestone_bronze": "10", "milestone_silver": "18", "milestone_gold": "28", "milestone_diamond": "35",
            "link_how_to_use": "", "link_download_files": "", "link_support": "", "link_payment_proofs": "",
            "category_android_nonroot_header": "ANDROID NON ROOT — SELECT A PRODUCT",
            "category_android_nonroot_sub": "Choose any product below to view its price and available duration plans.",
            "category_android_root_header": "ANDROID ROOT — SELECT A PRODUCT",
            "category_android_root_sub": "Choose any product below to view its price and available duration plans.",
            "category_iphone_header": "iPHONE — SELECT A PRODUCT",
            "category_iphone_sub": "Choose any product below to view its price and available duration plans.",
        }
        for k, v in defaults.items(): conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
        for key, name, emoji in CATEGORIES: conn.execute("INSERT OR IGNORE INTO categories(name, description, active) VALUES(?,?,1)", (name, key))
        conn.commit()


def upsert_user(user):
    with db() as conn:
        conn.execute("""
            INSERT INTO users(id, username, first_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, updated_at=excluded.updated_at
        """, (user.id, user.username or "", user.first_name or "", iso_now(), iso_now()))
        conn.commit()


# ═══════════════════════════════════════════════════════════════════════════════
# UI KEYBOARDS
# ═══════════════════════════════════════════════════════════════════════════════
def btn(text, cb): return InlineKeyboardButton(text, callback_data=cb)


def main_inline_kb():
    return InlineKeyboardMarkup([
        [btn("🛒  Shop Now", "shop")],
        [btn("👤  Profile", "profile"), btn("💰  Add Balance", "add_balance")],
        [btn("🔑  My Keys", "my_keys"), btn("📖  How to Use", "how_to_use")],
        [btn("📁  Download Files", "download_files"), btn("🎁  Daily Spin", "daily_spin")],
        [btn("🎀  Refer & Earn", "refer"), btn("🆘  Support", "support")],
        [btn("📤  Payment Proofs", "payment_proofs")],
    ])


def back_kb(cb="home", label="❌ Back"):
    return InlineKeyboardMarkup([[btn(label, cb)]])


# ═══════════════════════════════════════════════════════════════════════════════
# FAMGATEWAY — PAYMENT GATEWAY (Replaces VC Gateway)
# ═══════════════════════════════════════════════════════════════════════════════
_fg_client = None


def gateway_configured():
    enabled = str(setting("payment_gateway_enabled", "0")).strip().lower() in {"1", "true", "yes", "on"}
    return enabled and bool(str(setting("payment_gateway_api_key", "")).strip())


def get_fg_client():
    global _fg_client
    if not FAMGATEWAY_AVAILABLE: return None
    api_key = str(setting("payment_gateway_api_key", "")).strip()
    if not api_key: return None
    if _fg_client is None or getattr(_fg_client, "api_key", None) != api_key:
        try:
            _fg_client = FamGateway(api_key=api_key, timeout=25)
        except Exception as e:
            logging.exception(f"FamGateway init failed: {e}")
            return None
    return _fg_client


def get_upi_id(): return str(setting("payment_upi_id", "paytm.s1dw5n0@pty")).strip()


def generate_order_id():
    return "ORD" + datetime.now(TIMEZONE).strftime("%y%m%d") + "".join(secrets.choice("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(6))


def generate_upi_qr(upi_id, amount, order_no):
    if not upi_id: return None
    try:
        upi_uri = f"upi://pay?pa={quote(upi_id, safe='@._-')}&pn=Payee&am={float(amount):.2f}&cu=INR&tn={quote(order_no, safe='')}"
        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(upi_uri); qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = BytesIO(); img.save(buf, format="PNG"); buf.seek(0); buf.name = f"{order_no}.png"
        return buf
    except Exception as e:
        logging.exception(f"QR failed: {e}"); return None


IMAGE_MAGIC = (b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF")


def _qr_from_text(data, order_no):
    try:
        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(data); qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = BytesIO(); img.save(buf, format="PNG"); buf.seek(0); buf.name = f"{order_no}.png"
        return buf
    except Exception as e:
        logging.exception(f"QR from text failed: {e}"); return None


def _fetch_qr_image(qr_url, order_no):
    """Telegram often can't load gateway QR links (data URIs, SVG, protected URLs), so fetch bytes ourselves."""
    try:
        if qr_url.startswith("data:image"):
            header, _, payload = qr_url.partition(",")
            if "svg" in header: return None
            raw = base64.b64decode(payload) if ";base64" in header else payload.encode()
        elif qr_url.startswith(("http://", "https://")):
            req = urllib.request.Request(qr_url, headers={"User-Agent": "Mozilla/5.0", "Accept": "image/png,image/jpeg,image/*"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read(5 * 1024 * 1024)
        else:
            return None
        if not raw.startswith(IMAGE_MAGIC): return None
        buf = BytesIO(raw); buf.name = f"{order_no}.png"; buf.seek(0)
        return buf
    except Exception as e:
        logging.warning(f"[FAMGATEWAY] QR image fetch failed: {e}"); return None


def build_payment_qr(fg_result, amount, order_no):
    upi_intent = str(fg_result.get("upi_intent") or "").strip()
    if upi_intent.lower().startswith("upi://"):
        qr = _qr_from_text(upi_intent, order_no)
        if qr: return qr
    qr_url = str(fg_result.get("qr_url") or "").strip()
    if qr_url:
        qr = _fetch_qr_image(qr_url, order_no)
        if qr: return qr
    return generate_upi_qr(fg_result.get("upi_id") or get_upi_id(), amount, order_no)


async def send_payment_screen(context, chat_id, text, markup, fg_result, amount, order_no):
    qr = await asyncio.to_thread(build_payment_qr, fg_result, amount, order_no)
    if qr:
        try:
            return await context.bot.send_photo(chat_id=chat_id, photo=qr, caption=text, reply_markup=markup, parse_mode=ParseMode.HTML)
        except Exception as e:
            logging.exception(f"QR photo send failed: {e}")
    qr_url = str(fg_result.get("qr_url") or "")
    if qr_url.startswith(("http://", "https://")):
        try:
            return await context.bot.send_photo(chat_id=chat_id, photo=qr_url, caption=text, reply_markup=markup, parse_mode=ParseMode.HTML)
        except Exception as e:
            logging.warning(f"QR URL send failed: {e}")
    try:
        return await context.bot.send_message(chat_id=chat_id, text=text, reply_markup=markup, parse_mode=ParseMode.HTML)
    except Exception as e:
        logging.exception(f"Payment msg send failed: {e}"); return None


async def fg_create_order(amount: float, customer_name: str = ""):
    fg = get_fg_client()
    if not fg:
        return {"ok": False, "error": "FamGateway not configured"}
    try:
        order = await asyncio.to_thread(
            fg.create_order,
            amount=float(amount),
            customer_name=(customer_name or "")[:100] or None,
        )
        return {
            "ok": True,
            "order_id": str(order.order_id or ""),
            "qr_url": str(order.qr_url or ""),
            "upi_intent": str(order.upi_intent or ""),
            "checkout_url": str(order.checkout_url or ""),
            "upi_id": str(order.upi_id or ""),
            "payable_amount": float(order.payable_amount or amount),
            "expires_at_ist": str(order.expires_at_ist or ""),
        }
    except FamGatewayError as e:
        logging.error(f"[FAMGATEWAY] create_order failed: {e}")
        return {"ok": False, "error": str(e)[:200]}
    except Exception as e:
        logging.exception(f"[FAMGATEWAY] create_order exception: {e}")
        return {"ok": False, "error": "Gateway error"}


async def fg_verify_order(fg_order_id: str):
    fg = get_fg_client()
    if not fg: return {"ok": False, "status": "INVALID", "error": "Not configured"}
    if not fg_order_id: return {"ok": False, "status": "INVALID", "error": "No order id"}
    try:
        status = await asyncio.to_thread(fg.verify_order, fg_order_id)
        if status.is_paid:
            return {
                "ok": True, "status": "SUCCESS",
                "utr": str(status.utr or ""),
                "transaction_id": str(status.transaction_id or ""),
                "sender_name": str(status.sender_name or ""),
                "amount": float(status.payable_amount or 0),
            }
        if status.is_expired: return {"ok": True, "status": "EXPIRED"}
        return {"ok": True, "status": "PENDING"}
    except FamGatewayError as e:
        msg = str(e)
        logging.warning(f"[FAMGATEWAY] verify_order failed: {msg}")
        if "not found" in msg.lower(): return {"ok": True, "status": "NOT_FOUND"}
        return {"ok": False, "status": "UNKNOWN", "error": msg[:200]}
    except Exception as e:
        logging.exception(f"[FAMGATEWAY] verify_order exception: {e}")
        return {"ok": False, "status": "UNKNOWN", "error": str(e)[:200]}


async def fg_check_status(fg_order_id: str):
    fg = get_fg_client()
    if not fg: return {"ok": False, "status": "INVALID"}
    if not fg_order_id: return {"ok": False, "status": "INVALID"}
    try:
        status = await asyncio.to_thread(fg.get_status, fg_order_id)
        if status.is_paid:
            return {"ok": True, "status": "SUCCESS", "utr": str(status.utr or ""), "sender_name": str(status.sender_name or "")}
        if status.is_expired: return {"ok": True, "status": "EXPIRED"}
        return {"ok": True, "status": "PENDING"}
    except Exception as e:
        logging.warning(f"[FAMGATEWAY] get_status failed: {e}")
        return {"ok": False, "status": "UNKNOWN"}


async def fg_test_connection():
    if not FAMGATEWAY_AVAILABLE:
        return {"ok": False, "message": "FamGateway SDK not installed — run: pip install famgateway"}
    fg = get_fg_client()
    if not fg: return {"ok": False, "message": "API key not set"}
    try:
        order = await asyncio.to_thread(fg.create_order, amount=1.0, customer_name="Connection Test")
        return {
            "ok": True,
            "message": "✅ FamGateway connected! Test order created.",
            "test_order_id": str(order.order_id),
            "test_qr_url": str(order.qr_url or ""),
            "test_checkout_url": str(order.checkout_url or ""),
        }
    except FamGatewayError as e:
        return {"ok": False, "message": f"❌ {str(e)[:200]}"}
    except Exception as e:
        return {"ok": False, "message": f"❌ Connection failed: {str(e)[:200]}"}


def _find_value(obj, keys):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in keys and v is not None and str(v).strip(): return str(v).strip()
        for v in obj.values():
            r = _find_value(v, keys)
            if r: return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_value(v, keys)
            if r: return r
    return ""


def _fetch_external_key_sync(remote_id, remote_duration, api_url, api_key, master_key=""):
    if not api_url or not remote_id: return None, "Missing"
    try:
        data = {"api_key": api_key, "action": "buy", "product_id": remote_id, "duration": remote_duration or "1 Day", "android_id": "0b9b969bc2e7997b"}
        encoded = urlencode(data).encode("utf-8")
        headers = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        if master_key: headers["x-master-key"] = master_key
        req = urllib.request.Request(api_url, data=encoded, method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read(256 * 1024).decode("utf-8", errors="replace")
            try: payload = json.loads(raw)
            except Exception: payload = {"raw": raw}
            key = _find_value(payload, {"key", "license", "code", "activation_code", "product_key", "result", "data"})
            if key: return key, None
            return None, "No key"
    except Exception as e: return None, str(e)[:200]


# ═══════════════════════════════════════════════════════════════════════════════
# WELCOME
# ═══════════════════════════════════════════════════════════════════════════════
def welcome_text(user):
    store = safe(setting("store_name", "SHIVAM STORE"))
    with db() as conn:
        u = conn.execute("SELECT balance, is_reseller FROM users WHERE id=?", (user.id,)).fetchone()
    balance = money(u["balance"] if u else 0)
    role = "👑 RESELLER" if u and u["is_reseller"] else "👤 USER"
    return (
        f"🛒✨━━━━━━━━━━━━━━━✨🛒\n"
        f"   💎 <b>{store}</b> 💎\n"
        f"   ⭐ PREMIUM EDITION ⭐\n"
        f"🛒✨━━━━━━━━━━━━━━━✨🛒\n\n"
        f"👋 <b>Hello, {safe(user.first_name)}!</b>\n"
        f"🎯 <i>Your premium destination for digital products</i>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🎁 <b>WHY CHOOSE US?</b>\n\n"
        f"   🛡️  100% Genuine Products\n"
        f"   ⚡  Lightning Fast Delivery\n"
        f"   💳  Multiple Payment Options\n"
        f"   🎧  24/7 Expert Support\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"📊 <b>YOUR ACCOUNT</b>\n\n"
        f"   🆔 ID: <code>{user.id}</code>\n"
        f"   🎭 Role: {role}\n"
        f"   💰 Balance: <b>{balance}</b>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"👇 <b>Tap any button below to begin!</b>"
    )


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not user: return
    upsert_user(user)
    args = context.args or []
    if args and re.fullmatch(r"ref_?(\d+)", str(args[0])):
        try:
            m = re.fullmatch(r"ref_?(\d+)", str(args[0])); referrer = int(m.group(1))
            if referrer != user.id:
                with db() as c:
                    c.execute("INSERT OR IGNORE INTO referrals(referrer_id,referred_user_id,status,reward_amount,created_at) VALUES(?,?,'pending',0,?)", (referrer, user.id, iso_now()))
                    c.commit()
        except Exception: pass
    await clear_all_screens(context, context.bot)
    try: await update.effective_message.delete()
    except Exception: pass
    await send_tracked(context, update.effective_chat.id, text=welcome_text(user), markup=main_inline_kb())


async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await clear_all_screens(context, context.bot)
    await send_tracked(context, update.effective_chat.id, text="✅ Cancelled.", markup=main_inline_kb())


# ═══════════════════════════════════════════════════════════════════════════════
# SHOP
# ═══════════════════════════════════════════════════════════════════════════════
async def show_shop(update, context, category_key=None):
    if category_key:
        with db() as conn:
            products = conn.execute("SELECT id, name, emoji, maintenance_mode FROM products WHERE category_key=? AND active=1 ORDER BY id DESC", (category_key,)).fetchall()
        if not products:
            await edit_or_send(update, context, "📦 No products in this category yet.", back_kb("shop")); return
        header = setting(f"category_{category_key}_header", "SELECT A PRODUCT")
        sub = setting(f"category_{category_key}_sub", "Choose any product below.")
        text = (
            f"🛒 <b>{safe(header)}</b> ✨\n\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"👋 <b>Yoo {safe(update.effective_user.first_name)}!</b>\n"
            f"<i>{safe(sub)}</i>\n\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━"
        )
        kb = []
        for p in products:
            label = f"🛠️ {p['name']} 🛠️" if p["maintenance_mode"] else f"{p['emoji'] or '🛍️'} {p['name']}"
            kb.append([btn(label, f"prod:{p['id']}")])
        kb.append([btn("❌ Back", "shop")])
        await edit_or_send(update, context, text, InlineKeyboardMarkup(kb))
        return
    text = (
        f"🛒 <b>SELECT YOUR DEVICE TYPE</b> ✨\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🍎 <b>Yoo {safe(update.effective_user.first_name)}!</b>\n"
        f"<i>Pehle apna device type chunein, uske baad products dikhenge.</i>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━"
    )
    kb = []
    for key, name, emoji in CATEGORIES: kb.append([btn(f"{emoji}  {name}", f"cat:{key}")])
    kb.append([btn("❌ Back to Menu", "home")])
    await edit_or_send(update, context, text, InlineKeyboardMarkup(kb))


async def show_product(update, context, product_id):
    with db() as conn:
        product = conn.execute("SELECT * FROM products WHERE id=? AND active=1", (product_id,)).fetchone()
        plans = conn.execute("SELECT * FROM plans WHERE product_id=? AND active=1 ORDER BY id", (product_id,)).fetchall()
        u = conn.execute("SELECT is_reseller FROM users WHERE id=?", (update.effective_user.id,)).fetchone()
    if not product:
        await edit_or_send(update, context, "Product not found", back_kb("shop")); return

    if product["maintenance_mode"]:
        with db() as conn:
            notified = conn.execute("SELECT 1 FROM product_notifications WHERE user_id=? AND product_id=?",
                                    (update.effective_user.id, product_id)).fetchone()
        text = (
            f"🛠️ <b>{safe(product['name'])}</b> 🛠️\n\n"
            f"🚨 Yeh Product Abhi Maintenance Mein Hai. Jab Bhi Available Hoga, Notify Karenge ✅\n\n"
            f"👇 Notify button dabao — available hote hi turant alert milega!"
        )
        kb_rows = []
        if notified: kb_rows.append([btn("🔔 Notified! (tap to cancel)", f"notify_cancel:{product_id}")])
        else: kb_rows.append([btn("🔔 Notify Me", f"notify:{product_id}")])
        kb_rows.append([btn("🛒 Back", "shop")])
        await edit_or_send(update, context, text, InlineKeyboardMarkup(kb_rows))
        return

    if not plans:
        await edit_or_send(update, context, "No plans available", back_kb("shop")); return
    reseller = bool(u and u["is_reseller"])
    header = product["header_text"] or f"PRODUCT: {product['name']}"
    sub = product["sub_text"] or "👇 CHOOSE YOUR PLAN 👇"
    text = (
        f"✅ <b>{safe(header)}</b>\n\n"
        f"👋 <b>{safe(sub)}</b> 👋\n\n"
        f"🗓️ <i>Select your validity plan below to proceed with the secure order</i> 🍎"
    )
    kb = []
    for p in plans:
        price = p["reseller_price"] if reseller else p["customer_price"]
        kb.append([btn(f"🔗 {p['name']} — {money(price)}", f"plan:{p['id']}")])
    kb.append([btn("❌ Back to Shop", "shop")])
    await edit_or_send(update, context, text, InlineKeyboardMarkup(kb))


async def show_plan(update, context, plan_id):
    with db() as conn:
        plan = conn.execute("SELECT plans.*, products.name as product_name FROM plans JOIN products ON products.id=plans.product_id WHERE plans.id=? AND plans.active=1", (plan_id,)).fetchone()
        u = conn.execute("SELECT is_reseller, balance FROM users WHERE id=?", (update.effective_user.id,)).fetchone()
    if not plan:
        await edit_or_send(update, context, "Plan not found", back_kb("shop")); return
    reseller = bool(u and u["is_reseller"])
    price = plan["reseller_price"] if reseller else plan["customer_price"]
    balance = float(u["balance"]) if u else 0
    await confirm_order_screen(update, context, plan_id, plan, price, balance, coupon=None, discount=0)


async def confirm_order_screen(update, context, plan_id, plan, price, balance, coupon=None, discount=0, send_new=False, prefix=""):
    final_price = price - discount
    from_wallet = min(balance, final_price); remaining = final_price - from_wallet
    text = prefix
    text += (
        f"✅ <b>CONFIRM YOUR ORDER</b> ✅\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"💰 Product: <b>{safe(plan['product_name'])}</b>\n"
        f"✈️ Duration: <b>{plan['name']}</b>\n"
        f"💰 Price: <b>{money(price)}</b>\n"
    )
    if coupon:
        text += f"🎟️ Coupon: <code>{safe(coupon)}</code> (−{money(discount)})\n"
        text += f"✨ Final: <b>{money(final_price)}</b>\n"
    text += f"💳 Wallet Balance: <b>{money(balance)}</b>\n\n"
    text += f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
    text += f"🚨 <i>Secure checkout — choose a payment method below</i> 🔗"
    kb_rows = []
    if remaining <= 0:
        kb_rows.append([btn("✅ Confirm Order (Wallet)", f"confirm_wallet:{plan_id}")])
    else:
        kb_rows.append([btn(f"💳 Pay {money(remaining)} via UPI", f"pay:{plan_id}")])
    kb_rows.append([btn("🎟️ Apply Coupon Code", f"coupon_apply:{plan_id}")])
    if coupon: kb_rows.append([btn("🗑️ Remove Coupon", f"coupon_remove:{plan_id}")])
    kb_rows.append([btn("❌ Back to Shop", "shop")])
    markup = InlineKeyboardMarkup(kb_rows)

    if send_new:
        await clear_all_screens(context, context.bot)
        if update.effective_chat:
            await send_tracked(context, update.effective_chat.id, text=text, markup=markup)
    else:
        await edit_or_send(update, context, text, markup)


# ═══════════════════════════════════════════════════════════════════════════════
# COUPON
# ═══════════════════════════════════════════════════════════════════════════════
async def coupon_apply_start(update, context, plan_id):
    context.user_data["coupon_plan_id"] = plan_id
    context.user_data["flow"] = "coupon_input"
    text = (
        f"🎟️ <b>ENTER COUPON CODE</b>\n\n"
        f"👇 Type your coupon code in chat below\n\n"
        f"📝 Example: <code>SAVE10</code>"
    )
    markup = InlineKeyboardMarkup([[btn("❌ Cancel", f"plan:{plan_id}")]])
    await edit_or_send(update, context, text, markup)


def validate_coupon(code, user_id, amount):
    with db() as conn:
        c = conn.execute("SELECT * FROM coupons WHERE code=? AND active=1", (code.upper(),)).fetchone()
        if not c: return 0, "❌ Invalid coupon code", None
        if c["expires_at"]:
            try:
                exp = datetime.fromisoformat(str(c["expires_at"]).replace("Z", "+00:00"))
                if exp.tzinfo is None: exp = exp.replace(tzinfo=timezone.utc)
                if utc_now() > exp: return 0, "❌ Coupon expired", None
            except Exception: pass
        if c["max_uses"] and c["used_count"] >= c["max_uses"]: return 0, "❌ Usage limit reached", None
        if c["min_order_amount"] and amount < c["min_order_amount"]: return 0, f"❌ Min order {money(c['min_order_amount'])}", None
        used = conn.execute("SELECT COUNT(*) c FROM coupon_uses WHERE user_id=? AND coupon_id=?", (user_id, c["id"])).fetchone()["c"]
        if c["max_uses_per_user"] and used >= c["max_uses_per_user"]: return 0, "❌ Already used", None
        if c["discount_type"] == "percent": disc = float(amount) * float(c["discount_value"]) / 100
        else: disc = float(c["discount_value"])
        if c["max_discount"] and disc > float(c["max_discount"]): disc = float(c["max_discount"])
        if disc > float(amount): disc = float(amount)
        return disc, "OK", dict(c)


# ═══════════════════════════════════════════════════════════════════════════════
# QR PAYMENT — FamGateway Auto
# ═══════════════════════════════════════════════════════════════════════════════
async def do_pay(update, context, plan_id, coupon_code="", discount=0):
    user = update.effective_user
    with db() as conn:
        plan = conn.execute("SELECT plans.*, products.name as product_name FROM plans JOIN products ON products.id=plans.product_id WHERE plans.id=?", (plan_id,)).fetchone()
        u = conn.execute("SELECT is_reseller, balance FROM users WHERE id=?", (user.id,)).fetchone()
    if not plan: return
    reseller = bool(u and u["is_reseller"])
    price = plan["reseller_price"] if reseller else plan["customer_price"]
    final_price = float(price) - float(discount)
    balance = float(u["balance"]) if u else 0
    remaining = max(0, final_price - min(balance, final_price))
    order_no = generate_order_id()

    # Create local order
    with db() as conn:
        cur = conn.execute("INSERT INTO orders(order_no, user_id, plan_id, order_type, amount, original_amount, coupon_code, discount_amount, payment_method, status, created_at, expiry_at) VALUES(?,?,?,'product',?,?,?,?, 'gateway', 'pending', ?, ?)",
                           (order_no, user.id, plan_id, remaining, price, coupon_code, discount, iso_now(), (utc_now() + timedelta(minutes=5)).isoformat(timespec="seconds")))
        order_id = cur.lastrowid
        conn.commit()

    # Register with FamGateway
    customer_name = safe(user.first_name or "Customer")
    fg_result = await fg_create_order(remaining, customer_name)

    if not fg_result.get("ok"):
        logging.warning(f"FamGateway create failed: {fg_result.get('error')}")
        # Mark order cancelled
        with db() as conn:
            conn.execute("UPDATE orders SET status='cancelled', delivery_error=? WHERE id=?", (str(fg_result.get("error",""))[:200], order_id))
            conn.commit()
        await edit_or_send(update, context,
            f"⚠️ <b>Payment gateway unavailable</b>\n\n"
            f"❌ {safe(fg_result.get('error', 'Please try again later'))}\n\n"
            f"Owner को notify कर दिया गया है। कृपया बाद में प्रयास करें।",
            back_kb("shop"))
        # Notify owner
        try:
            if OWNER_NOTIFY_CHAT:
                await context.bot.send_message(int(OWNER_NOTIFY_CHAT),
                    f"⚠️ <b>FamGateway Error</b>\n\n"
                    f"Order: <code>{safe(order_no)}</code>\n"
                    f"Amount: {money(remaining)}\n"
                    f"Error: {safe(fg_result.get('error',''))[:200]}",
                    parse_mode=ParseMode.HTML)
        except Exception: pass
        return

    fg_order_id = fg_result["order_id"]
    # Save fg_order_id + expected amount
    with db() as conn:
        conn.execute("UPDATE orders SET fg_order_id=?, pending_message_chat_id=?, pending_message_id=0 WHERE id=?",
                     (fg_order_id, update.effective_chat.id, order_id))
        conn.commit()
    context.user_data["current_order_id"] = order_id

    upi_intent = fg_result.get("upi_intent", "")
    checkout_url = fg_result.get("checkout_url", "")
    qr_url = fg_result.get("qr_url", "")
    expiry_str = fg_result.get("expires_at_ist", "") or "(5 minutes)"
    actual_amount = fg_result.get("payable_amount", remaining)

    text = (
        f"📋 <b>Payment Instructions</b> 📋\n\n"
        f"• Scan the QR using any UPI app (PhonePe, GPay, Paytm, BHIM, etc.)\n"
        f"• Pay the exact amount shown below\n"
        f"• Wait 30-120 seconds after payment\n"
        f"• Then tap ✅ Verify Payment button\n\n"
        f"🧾 <b>Order ID:</b> <code>{safe(order_no)}</code>\n"
        f"✅ <b>Amount:</b> <b>{money(actual_amount)}</b>\n"
        f"⏰ <b>Expires:</b> {expiry_str}\n\n"
        f"⚠️ <i>Payment ke turant baad 'Pending' aa sakta hai — 1-2 min wait karein.</i>"
    )

    kb_rows = []
    if upi_intent: kb_rows.append([InlineKeyboardButton("📱 Open UPI App", url=upi_intent)])
    if checkout_url: kb_rows.append([InlineKeyboardButton("💳 Web Checkout", url=checkout_url)])
    kb_rows.append([btn("✅ Verify Payment", f"verify:{order_id}")])
    kb_rows.append([btn("❌ Cancel", f"cancelpay:{order_id}")])
    markup = InlineKeyboardMarkup(kb_rows)

    await clear_all_screens(context, context.bot)

    sent = await send_payment_screen(context, update.effective_chat.id, text, markup, fg_result, actual_amount, order_no)
    if sent:
        track_msg(context, sent.chat_id, sent.message_id)
        with db() as conn:
            conn.execute("UPDATE orders SET pending_message_id=? WHERE id=?", (sent.message_id, order_id))
            conn.commit()


async def do_confirm_wallet(update, context, plan_id, coupon_code="", discount=0):
    user = update.effective_user
    with db() as conn:
        plan = conn.execute("SELECT plans.*, products.name as product_name FROM plans JOIN products ON products.id=plans.product_id WHERE plans.id=?", (plan_id,)).fetchone()
        u = conn.execute("SELECT balance FROM users WHERE id=?", (user.id,)).fetchone()
    if not plan or not u: return
    price = float(plan["customer_price"]) - float(discount); balance = float(u["balance"])
    if balance < price:
        await edit_or_send(update, context, "❌ Insufficient balance", back_kb("shop")); return
    order_no = generate_order_id()
    with db() as conn:
        cur = conn.execute("INSERT INTO orders(order_no, user_id, plan_id, order_type, amount, original_amount, coupon_code, discount_amount, payment_method, status, created_at) VALUES(?,?,?,'product',?,?,?,?, 'wallet', 'pending', ?)",
                           (order_no, user.id, plan_id, price, plan["customer_price"], coupon_code, discount, iso_now()))
        order_id = cur.lastrowid; conn.commit()
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        u2 = conn.execute("SELECT balance FROM users WHERE id=?", (user.id,)).fetchone()
        before = float(u2["balance"]); after = before - price
        conn.execute("UPDATE users SET balance=?, updated_at=? WHERE id=?", (after, iso_now(), user.id))
        conn.execute("INSERT INTO wallet_transactions(user_id, order_id, type, amount, balance_before, balance_after, note, created_at) VALUES(?,?,?,?,?,?,?,?)",
                     (user.id, order_id, "purchase", price, before, after, "Wallet purchase", iso_now()))
        conn.commit()
    await fulfill_order(context, order_id)


# ═══════════════════════════════════════════════════════════════════════════════
# FULFILLMENT — CLEANS ALL SCREENS, SENDS FRESH DELIVERY
# ═══════════════════════════════════════════════════════════════════════════════
async def fulfill_order(context, order_id):
    bot = context.bot
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        order = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not order or order["status"] in ("approved", "cancelled", "expired"):
            conn.rollback(); return False
        now = iso_now()

        # Balance top-up
        if order["order_type"] == "balance":
            user = conn.execute("SELECT balance FROM users WHERE id=?", (order["user_id"],)).fetchone()
            before = float(user["balance"]); amount = float(order["topup_amount"] or order["amount"]); after = round(before + amount, 2)
            conn.execute("UPDATE users SET balance=?, updated_at=? WHERE id=?", (after, now, order["user_id"]))
            conn.execute("INSERT INTO wallet_transactions(user_id,order_id,type,amount,balance_before,balance_after,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
                         (order["user_id"], order_id, "deposit", amount, before, after, "Gateway deposit", now))
            conn.execute("UPDATE orders SET status='approved', approved_at=?, delivery_status='delivered' WHERE id=?", (now, order_id))
            conn.commit()
            msg = (
                f"⚡━━━━━━━━━━━━━━━⚡\n"
                f"  ⚡ <b>ORDER DELIVERED</b> ⚡\n"
                f"     ⭐ <b>SUCCESS</b> ⭐\n"
                f"⚡━━━━━━━━━━━━━━━⚡\n\n"
                f"💰 Amount: <b>{money(amount)}</b>\n"
                f"✅ Payment Successful\n\n"
                f"━━━━━━━━━━━━━━━\n\n"
                f"💵 New Balance: <b>{money(after)}</b>\n\n"
                f"━━━━━━━━━━━━━━━"
            )
            try:
                chat_id = order["user_id"]
                await _clear_user_screens_by_chat(context, chat_id)
                await bot.send_message(chat_id, msg, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup([[btn("🔙 BACK", "home")]]))
            except Exception as e: logging.exception(f"Balance send failed: {e}")
            return True

        # Product order
        plan = conn.execute("SELECT plans.*, products.name as product_name, products.channel_link FROM plans JOIN products ON products.id=plans.product_id WHERE plans.id=?", (order["plan_id"],)).fetchone()
        if not plan:
            conn.rollback(); return False

        key_value = None; key_id = None
        remote_id = str(plan["remote_id"] or "").strip()
        remote_duration = str(plan["remote_duration"] or "").strip()

        # Try external API first
        if EXTERNAL_API_URL and EXTERNAL_API_KEY and remote_id:
            fetched, err = await asyncio.to_thread(_fetch_external_key_sync, remote_id, remote_duration, EXTERNAL_API_URL, EXTERNAL_API_KEY, EXTERNAL_MASTER_KEY)
            if fetched:
                key_value = fetched
                cur = conn.execute("INSERT INTO stock_keys(plan_id, key_value, status, created_at, key_type) VALUES(?,?,'sold',?,'external')",
                                   (order["plan_id"], key_value, now))
                key_id = cur.lastrowid

        # Fallback: local stock
        if not key_value:
            stock = conn.execute("SELECT * FROM stock_keys WHERE plan_id=? AND status='available' ORDER BY id LIMIT 1", (order["plan_id"],)).fetchone()
            if stock:
                claimed = conn.execute("UPDATE stock_keys SET status='sold', assigned_order_id=? WHERE id=? AND status='available'", (order_id, stock["id"]))
                if claimed.rowcount == 1:
                    key_value = stock["key_value"]; key_id = stock["id"]

        # No stock available
        if not key_value:
            conn.execute("UPDATE orders SET status='payment_verified_stock_unavailable', delivery_status='failed', delivery_error='No stock' WHERE id=?", (order_id,))
            conn.commit()
            try:
                chat_id = order["user_id"]
                await _clear_user_screens_by_chat(context, chat_id)
                await bot.send_message(chat_id,
                    "✅ <b>Payment received!</b>\n\n"
                    "⚠️ Stock unavailable. Owner को notify कर दिया गया है.\n"
                    "🔄 Owner जल्द ही aapko key bhejega ya refund karega.\n\n"
                    "⏳ Usually 5-30 minutes lagta hai.",
                    parse_mode=ParseMode.HTML,
                    reply_markup=InlineKeyboardMarkup([[btn("🔙 BACK", "home")]]))
                # Notify owner
                if OWNER_NOTIFY_CHAT:
                    await bot.send_message(int(OWNER_NOTIFY_CHAT),
                        f"⚠️ <b>Stock Unavailable</b>\n\n"
                        f"Order: <code>{safe(order['order_no'])}</code>\n"
                        f"User: <code>{order['user_id']}</code>\n"
                        f"Amount: {money(order['amount'])}\n\n"
                        f"Key add karke dashboard se force-deliver kar sakte ho.",
                        parse_mode=ParseMode.HTML)
            except Exception: pass
            return True

        # Mark as approved + delivered
        expiry = utc_now() + timedelta(days=int(plan["days"] or 1))
        conn.execute("UPDATE orders SET status='approved', approved_at=?, expiry_at=?, key_id=?, delivery_status='delivered' WHERE id=?",
                     (now, expiry.isoformat(timespec="seconds"), key_id, order_id))
        if order["coupon_code"]:
            c = conn.execute("SELECT id FROM coupons WHERE code=?", (order["coupon_code"],)).fetchone()
            if c:
                conn.execute("UPDATE coupons SET used_count=used_count+1 WHERE id=?", (c["id"],))
                conn.execute("INSERT INTO coupon_uses(user_id,coupon_id,used_at) VALUES(?,?,?)", (order["user_id"], c["id"], now))
        conn.commit()

    # Build delivery message
    text = (
        f"⚡━━━━━━━━━━━━━━━━━⚡\n"
        f"  ⚡ <b>ORDER DELIVERED</b> ⚡\n"
        f"     ⭐ <b>SUCCESS</b> ⭐\n"
        f"⚡━━━━━━━━━━━━━━━━━⚡\n\n"
        f"🎮 Product: <b>{safe(plan['product_name'])}</b>\n"
        f"⏱️ Plan: <b>{safe(plan['name'])}</b>\n"
        f"💰 Amount: <b>{money(order['amount'])}</b>\n"
        f"✅ Payment Successful\n\n"
    )
    if plan["channel_link"]:
        text += f"━━━━━━━━━━━━━━━━━\n\n🔗 <b>ACCESS CHANNEL</b>\n{safe(plan['channel_link'])}\n\n"
    text += f"━━━━━━━━━━━━━━━━━\n\n🔑 <b>YOUR KEY</b>\n<code>{safe(key_value)}</code>\n\n━━━━━━━━━━━━━━━━━"

    try:
        chat_id = order["user_id"]
        # CLEAR all screens for this chat FIRST
        await _clear_user_screens_by_chat(context, chat_id)
        # Send fresh delivery message
        await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML, reply_markup=InlineKeyboardMarkup([[btn("🔙 BACK", "home")]]))
    except Exception as e:
        logging.exception(f"Send delivered failed: {e}")

    try: await reward_referral_for_order(bot, order["user_id"], order_id)
    except Exception: pass
    return True


async def reward_referral_for_order(bot, user_id, order_id):
    with db() as conn:
        ref = conn.execute("SELECT * FROM referrals WHERE referred_user_id=? AND status='pending'", (user_id,)).fetchone()
        if not ref: return
        reward_purchase = float(setting("referral_reward_purchase", "2"))
        orders_count = conn.execute("SELECT COUNT(*) c FROM orders WHERE user_id=? AND order_type='product' AND status='approved'", (user_id,)).fetchone()["c"]
        total_reward = reward_purchase if orders_count == 1 else 0
        if total_reward > 0:
            referrer = conn.execute("SELECT balance FROM users WHERE id=?", (ref["referrer_id"],)).fetchone()
            before = float(referrer["balance"]); after = round(before + total_reward, 2)
            conn.execute("UPDATE users SET balance=?, updated_at=? WHERE id=?", (after, iso_now(), ref["referrer_id"]))
            conn.execute("INSERT INTO wallet_transactions(user_id,order_id,type,amount,balance_before,balance_after,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
                         (ref["referrer_id"], order_id, "referral_reward", total_reward, before, after, "Referral reward", iso_now()))
            conn.execute("UPDATE referrals SET status='qualified', qualified_order_id=?, reward_amount=?, rewarded_at=? WHERE id=?",
                         (order_id, total_reward, iso_now(), ref["id"]))
            conn.commit()
            try:
                await bot.send_message(ref["referrer_id"],
                    f"🎉 <b>Referral Reward!</b>\n\n💰 +{money(total_reward)} credited\n👤 Your friend made first purchase!\n💼 Balance: <b>{money(after)}</b>",
                    parse_mode=ParseMode.HTML)
            except Exception: pass
            await check_referral_milestones(bot, ref["referrer_id"])


async def check_referral_milestones(bot, user_id):
    with db() as conn:
        count = conn.execute("SELECT COUNT(*) c FROM referrals WHERE referrer_id=? AND status='qualified'", (user_id,)).fetchone()["c"]
        milestones = [
            (int(setting("milestone_bronze", "10")), "🥉", "BRONZE"),
            (int(setting("milestone_silver", "18")), "🥈", "SILVER"),
            (int(setting("milestone_gold", "28")), "🥇", "GOLD"),
            (int(setting("milestone_diamond", "35")), "💎", "DIAMOND"),
        ]
        sent = []
        for target, emoji, badge in milestones:
            if count >= target:
                exists = conn.execute("SELECT 1 FROM referral_milestones WHERE user_id=? AND milestone_count=?", (user_id, target)).fetchone()
                if not exists:
                    conn.execute("INSERT INTO referral_milestones(user_id, milestone_count, badge, achieved_at) VALUES(?,?,?,?)", (user_id, target, badge, iso_now()))
                    sent.append((target, emoji, badge))
        conn.commit()
        if not sent: return
        target, emoji, badge = sent[-1]
        members = conn.execute("SELECT u.username, u.first_name FROM referrals r JOIN users u ON u.id=r.referred_user_id WHERE r.referrer_id=? AND r.status='qualified' ORDER BY r.id LIMIT ?", (user_id, target)).fetchall()
        u = conn.execute("SELECT first_name FROM users WHERE id=?", (user_id,)).fetchone()
        name = safe(u["first_name"] if u else "Friend")
    names_list = ""
    for i, m in enumerate(members, 1):
        n = m["username"] if m["username"] else m["first_name"]
        names_list += f"  {i}️⃣  @{safe(n)}\n"
    next_ms = None
    for t, e, b in milestones:
        if t > target: next_ms = t; break
    next_line = f"📊 Next Milestone: {next_ms} Referrals" if next_ms else "🏆 All Milestones Unlocked!"
    msg = (
        f"🎉 <b>CONGRATULATIONS</b> 🎉\n\n🎊 {name}, Amazing Work!\n\n"
        f"🏆 <b>MILESTONE</b> 🏆\n\n{emoji} <b>{badge}</b> {emoji}\n\n"
        f"👥 <b>{target} Referrals Completed!</b>\n\n"
        f"👥 <b>YOUR REFERRED MEMBERS:</b>\n\n{names_list}\n"
        f"🌟 You've Unlocked {badge} Status!\n\n{next_line}\n\n"
        f"💎 Thank You for Being Amazing!"
    )
    try: await bot.send_message(user_id, msg, parse_mode=ParseMode.HTML)
    except Exception: pass


# ═══════════════════════════════════════════════════════════════════════════════
# PROFILE / MY KEYS / ADD BALANCE / SPIN / REFER / LINKS
# ═══════════════════════════════════════════════════════════════════════════════
async def show_profile(update, context):
    user = update.effective_user
    with db() as conn:
        u = conn.execute("SELECT * FROM users WHERE id=?", (user.id,)).fetchone()
        orders_count = conn.execute("SELECT COUNT(*) c FROM orders WHERE user_id=? AND status='approved'", (user.id,)).fetchone()["c"]
        ref_count = conn.execute("SELECT COUNT(*) c FROM referrals WHERE referrer_id=? AND status='qualified'", (user.id,)).fetchone()["c"]
        spent = conn.execute("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE user_id=? AND status='approved' AND order_type='product'", (user.id,)).fetchone()["s"]
        keys_count = conn.execute("SELECT COUNT(*) c FROM stock_keys WHERE assigned_order_id IN (SELECT id FROM orders WHERE user_id=?)", (user.id,)).fetchone()["c"]
    joined = display_date(u["created_at"]) if u and u["created_at"] else "—"
    balance = money(u["balance"] if u else 0)
    role = "👑 RESELLER" if u and u["is_reseller"] else "👤 Regular User"
    text = (
        f"👤 <b>USER PROFILE</b>\n\n"
        f"📋 <b>PERSONAL INFO</b>\n\n"
        f"🆔 ID: <code>{user.id}</code>\n"
        f"👤 Name: {safe(user.first_name)}\n"
        f"📛 Username: @{safe(user.username or 'none')}\n"
        f"📅 Joined: {joined}\n"
        f"🎭 Type: {role}\n\n"
        f"💰 <b>WALLET STATS</b>\n\n"
        f"💵 Balance: {balance}\n"
        f"💸 Spent: {money(spent)}\n"
        f"🔑 Keys: {keys_count}\n"
        f"📦 Orders: {orders_count}\n"
        f"🤝 Referrals: {ref_count}"
    )
    kb = [[btn("🔑 My Keys", "my_keys"), btn("💰 Add Balance", "add_balance")], [btn("❌ Back", "home")]]
    await edit_or_send(update, context, text, InlineKeyboardMarkup(kb))


async def show_my_keys(update, context):
    user = update.effective_user
    with db() as conn:
        keys = conn.execute("""
            SELECT o.approved_at, o.expiry_at, sk.key_value, p.name as product_name, pl.name as plan_name
            FROM orders o
            LEFT JOIN stock_keys sk ON sk.id = o.key_id
            LEFT JOIN plans pl ON pl.id = o.plan_id
            LEFT JOIN products p ON p.id = pl.product_id
            WHERE o.user_id=? AND o.status='approved' AND o.order_type='product' AND sk.key_value IS NOT NULL
            ORDER BY o.id DESC LIMIT 20
        """, (user.id,)).fetchall()
    if not keys:
        await edit_or_send(update, context,
            "🔑 <b>MY KEYS</b>\n\n❌ You haven't purchased any keys yet.",
            InlineKeyboardMarkup([[btn("🛍️ Shop Now", "shop")], [btn("❌ Back", "home")]]))
        return
    lines = [f"🔑 <b>MY KEYS</b>\n", f"👋 Hey {safe(user.first_name)}, here are your keys!\n"]
    for k in keys:
        expiry = k["expiry_at"]; is_active = True
        if expiry:
            try:
                exp = datetime.fromisoformat(str(expiry).replace("Z", "+00:00"))
                if exp.tzinfo is None: exp = exp.replace(tzinfo=timezone.utc)
                if utc_now() > exp: is_active = False
            except: pass
        status_txt = "✅ Status: ACTIVE" if is_active else "❌ Status: EXPIRED"
        lines.append(f"📦 Product: {safe(k['product_name'] or 'N/A')}")
        lines.append(f"📌 Plan: {safe(k['plan_name'] or 'N/A')}")
        lines.append(f"🔑 Key: <code>{safe(k['key_value'])}</code>")
        lines.append(f"📅 Purchased: {display_date(k['approved_at'])}")
        lines.append(f"⏰ Expires: {display_date(expiry)}")
        lines.append(f"{status_txt}\n")
    lines.append(f"📊 Total Keys: {len(keys)}")
    await edit_or_send(update, context, "\n".join(lines), InlineKeyboardMarkup([[btn("❌ Back to Menu", "home")]]))


def balance_keypad():
    return [
        [btn("1", "bal:1"), btn("2", "bal:2"), btn("3", "bal:3")],
        [btn("4", "bal:4"), btn("5", "bal:5"), btn("6", "bal:6")],
        [btn("7", "bal:7"), btn("8", "bal:8"), btn("9", "bal:9")],
        [btn("✏️ Clear", "bal:clear"), btn("0", "bal:0"), btn("💳 Confirm", "bal:confirm")],
        [btn("❌ Back", "home")],
    ]


def balance_text(amount_str):
    return (
        f"💰 <b>ADD BALANCE</b> 💰\n\n"
        f"Amount: <b>₹{amount_str or '0'}</b>\n\n"
        f"⚡ Instant Auto-Credit\n"
        f"🚀 100% Secure UPI Payment\n"
        f"✅ Verified in Seconds\n\n"
        f"🔢 Use the keypad below\n"
        f"(Min: ₹{setting('min_deposit','10')} | Max: ₹{setting('max_deposit','50000')})"
    )


async def show_add_balance(update, context):
    context.user_data["balance_input"] = ""
    context.user_data["flow"] = "balance_keypad"
    await edit_or_send(update, context, balance_text(""), InlineKeyboardMarkup(balance_keypad()))


async def handle_balance_keypad(update, context, action):
    current = str(context.user_data.get("balance_input", ""))
    if action == "clear":
        context.user_data["balance_input"] = ""
    elif action == "confirm":
        amt = float(current) if current else 0
        min_dep = float(setting("min_deposit", "10")); max_dep = float(setting("max_deposit", "50000"))
        if amt < min_dep: return await edit_or_send(update, context, f"❌ Minimum deposit is {money(min_dep)}", InlineKeyboardMarkup(balance_keypad()))
        if amt > max_dep: return await edit_or_send(update, context, f"❌ Maximum deposit is {money(max_dep)}", InlineKeyboardMarkup(balance_keypad()))
        if not gateway_configured(): return await edit_or_send(update, context, "❌ Gateway not configured", back_kb())
        user = update.effective_user
        order_no = generate_order_id()
        with db() as conn:
            cur = conn.execute("INSERT INTO orders(order_no, user_id, order_type, amount, original_amount, topup_amount, payment_method, status, created_at, expiry_at) VALUES(?,?,'balance',?,?,?, 'gateway', 'pending', ?, ?)",
                               (order_no, user.id, amt, amt, amt, iso_now(), (utc_now() + timedelta(minutes=5)).isoformat(timespec="seconds")))
            order_id = cur.lastrowid; conn.commit()

        # Register with FamGateway
        customer_name = safe(user.first_name or "Customer")
        fg_result = await fg_create_order(amt, customer_name)
        if not fg_result.get("ok"):
            with db() as conn:
                conn.execute("UPDATE orders SET status='cancelled', delivery_error=? WHERE id=?", (str(fg_result.get("error",""))[:200], order_id))
                conn.commit()
            return await edit_or_send(update, context,
                f"⚠️ <b>Gateway Error</b>\n\n{safe(fg_result.get('error','Try again'))}",
                InlineKeyboardMarkup(balance_keypad()))

        fg_order_id = fg_result["order_id"]
        with db() as conn:
            conn.execute("UPDATE orders SET fg_order_id=?, pending_message_chat_id=?, pending_message_id=0 WHERE id=?",
                         (fg_order_id, update.effective_chat.id, order_id))
            conn.commit()

        upi_intent = fg_result.get("upi_intent", "")
        checkout_url = fg_result.get("checkout_url", "")
        qr_url = fg_result.get("qr_url", "")
        expiry_str = fg_result.get("expires_at_ist", "") or "(5 minutes)"
        actual_amount = fg_result.get("payable_amount", amt)

        text = (
            f"📋 <b>Payment Instructions</b> 📋\n\n"
            f"• Scan the QR using any UPI app\n"
            f"• Pay the exact amount shown below\n"
            f"• Wait 30-120 seconds after payment\n"
            f"• Then tap ✅ Verify Payment\n\n"
            f"🧾 <b>Order ID:</b> <code>{safe(order_no)}</code>\n"
            f"✅ <b>Amount:</b> <b>{money(actual_amount)}</b>\n"
            f"⏰ <b>Expires:</b> {expiry_str}\n\n"
            f"⚠️ <i>Payment ke turant baad 'Pending' aa sakta hai.</i>"
        )

        kb_rows = []
        if upi_intent: kb_rows.append([InlineKeyboardButton("📱 Open UPI App", url=upi_intent)])
        if checkout_url: kb_rows.append([InlineKeyboardButton("💳 Web Checkout", url=checkout_url)])
        kb_rows.append([btn("✅ Verify Payment", f"verify:{order_id}")])
        kb_rows.append([btn("❌ Cancel", f"cancelpay:{order_id}")])
        markup = InlineKeyboardMarkup(kb_rows)

        await clear_all_screens(context, context.bot)
        sent = await send_payment_screen(context, update.effective_chat.id, text, markup, fg_result, actual_amount, order_no)
        if sent:
            track_msg(context, sent.chat_id, sent.message_id)
            with db() as conn:
                conn.execute("UPDATE orders SET pending_message_id=? WHERE id=?", (sent.message_id, order_id))
                conn.commit()
        return
    else:
        if len(current) < 6:
            newv = (current + action).lstrip("0") or "0"
            context.user_data["balance_input"] = newv
    await edit_or_send(update, context, balance_text(context.user_data.get("balance_input", "")), InlineKeyboardMarkup(balance_keypad()))


async def show_daily_spin(update, context):
    user = update.effective_user; cooldown_hours = int(setting("spin_cooldown", "24"))
    with db() as conn:
        last = conn.execute("SELECT spun_at FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 1", (user.id,)).fetchone()
    can_spin = True; remaining = None
    if last:
        try:
            lt = datetime.fromisoformat(str(last["spun_at"]).replace("Z", "+00:00"))
            if lt.tzinfo is None: lt = lt.replace(tzinfo=timezone.utc)
            next_time = lt + timedelta(hours=cooldown_hours)
            if utc_now() < next_time: can_spin = False; remaining = next_time - utc_now()
        except Exception: pass
    if not can_spin:
        h = int(remaining.total_seconds() // 3600); m = int((remaining.total_seconds() % 3600) // 60); s = int(remaining.total_seconds() % 60)
        text = (
            f"🎰 <b>DAILY SPIN</b>\n\n"
            f"👋 Hello {safe(user.first_name)}!\n\n"
            f"🎯 Aap aaj ka Daily Spin pehle hi kar chuke hain!\n\n"
            f"⏰ <b>NEXT SPIN AVAILABLE IN:</b>\n\n"
            f"🕐 <b>{h:02d} H : {m:02d} M : {s:02d} S</b>\n\n"
            f"💡 Har {cooldown_hours} ghante mein 1 Spin!"
        )
        await edit_or_send(update, context, text, InlineKeyboardMarkup([[btn("❌ Back", "home")]])); return
    text = (
        f"🎰 <b>DAILY SPIN</b>\n\n"
        f"👋 Hello {safe(user.first_name)}!\n\n"
        f"🎁 Spin the wheel and win up to ₹{setting('spin_max','2.00')}!\n\n"
        f"⚡ Try your luck now!\n\n"
        f"👇 Tap the button below"
    )
    await edit_or_send(update, context, text, InlineKeyboardMarkup([[btn("🎰 SPIN NOW", "spin_now")], [btn("❌ Back", "home")]]))


async def do_spin(update, context):
    user = update.effective_user; cooldown_hours = int(setting("spin_cooldown", "24"))
    with db() as conn:
        last = conn.execute("SELECT spun_at FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 1", (user.id,)).fetchone()
    if last:
        try:
            lt = datetime.fromisoformat(str(last["spun_at"]).replace("Z", "+00:00"))
            if lt.tzinfo is None: lt = lt.replace(tzinfo=timezone.utc)
            if utc_now() < lt + timedelta(hours=cooldown_hours):
                await show_daily_spin(update, context); return
        except Exception: pass
    spin_min = float(setting("spin_min", "0.30")); spin_max = float(setting("spin_max", "2.00"))
    amount = round(random.uniform(spin_min, spin_max), 2)
    try:
        await update.callback_query.edit_message_text(f"🎰 <b>SPINNING...</b>\n\n🎲 ? ? ? 🎲", parse_mode=ParseMode.HTML)
    except Exception: pass
    await asyncio.sleep(2)
    with db() as conn:
        conn.execute("INSERT INTO spins(user_id, amount, spun_at) VALUES(?,?,?)", (user.id, amount, iso_now()))
        u = conn.execute("SELECT balance FROM users WHERE id=?", (user.id,)).fetchone()
        before = float(u["balance"]); after = round(before + amount, 2)
        conn.execute("UPDATE users SET balance=?, updated_at=? WHERE id=?", (after, iso_now(), user.id))
        conn.execute("INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,note,created_at) VALUES(?,?,?,?,?,?,?)",
                     (user.id, "spin", amount, before, after, "Daily Spin reward", iso_now()))
        conn.commit()
    text = (
        f"🎉 <b>CONGRATULATIONS!</b> 🎉\n\n"
        f"🎊 {safe(user.first_name)}!\n\n"
        f"💎 <b>YOU WON</b> 💎\n\n"
        f"💰 <b>{money(amount)}</b>\n\n"
        f"⚡ Credited Instantly!\n\n"
        f"💵 New Balance: <b>{money(after)}</b>\n\n"
        f"⏰ Come back after {cooldown_hours} hours!"
    )
    await edit_or_send(update, context, text, InlineKeyboardMarkup([[btn("❌ Back", "home")]]))


async def show_refer(update, context):
    user = update.effective_user; bot_info = await context.bot.get_me()
    link = f"https://t.me/{bot_info.username}?start=ref_{user.id}"
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM referrals WHERE referrer_id=?", (user.id,)).fetchone()["c"]
        qualified = conn.execute("SELECT COUNT(*) c FROM referrals WHERE referrer_id=? AND status='qualified'", (user.id,)).fetchone()["c"]
        earned = conn.execute("SELECT COALESCE(SUM(reward_amount),0) s FROM referrals WHERE referrer_id=?", (user.id,)).fetchone()["s"]
    rb = setting("referral_reward_balance", "2"); rp = setting("referral_reward_purchase", "2")
    text = (
        f"🎀 <b>REFER & EARN</b> 🎀\n\n"
        f"👋 Hey {safe(user.first_name)}!\n\n"
        f"💡 <b>Kaise kaam karta hai?</b>\n\n"
        f"1️⃣ Apna referral link share karein\n"
        f"2️⃣ Friend link se bot join karein\n"
        f"3️⃣ Friend pehli baar balance add kare\n   ➜ Aapko <b>₹{rb}</b> milenge!\n"
        f"4️⃣ Friend pehli baar purchase kare\n   ➜ Aapko <b>₹{rp}</b> milenge!\n\n"
        f"📊 <b>YOUR STATS</b>\n\n"
        f"👥 Total Referrals: <b>{total}</b>\n"
        f"✅ Successful: <b>{qualified}</b>\n"
        f"💰 Total Earned: <b>{money(earned)}</b>\n\n"
        f"🔗 <b>YOUR REFERRAL LINK:</b>\n<code>{safe(link)}</code>"
    )
    share_url = f"https://t.me/share/url?url={quote(link, safe='')}&text={quote('Join this amazing store!', safe='')}"
    kb = [[InlineKeyboardButton("📤 Share Link", url=share_url)], [btn("❌ Back to Menu", "home")]]
    await edit_or_send(update, context, text, InlineKeyboardMarkup(kb))


async def show_link_page(update, context, page_key):
    titles = {
        "how_to_use": ("🎓", "HOW TO USE", "Learn how to use our store", "Complete Guide Available", "📖 Open Tutorial", "link_how_to_use"),
        "download_files": ("📁", "DOWNLOAD FILES", "Download all your files here", "Resources, Guides & More", "📥 Open Files Channel", "link_download_files"),
        "support": ("🆘", "SUPPORT", "Need Help? Contact Us!", "Available: 24/7 • Fast Response", "💬 Contact Support", "link_support"),
        "payment_proofs": ("💳", "PAYMENT PROOFS", "Real Payment Proofs", "100% Trusted & Verified", "📸 View Proofs Channel", "link_payment_proofs"),
    }
    if page_key not in titles: return
    emoji, title, sub1, sub2, btn_text, setting_key = titles[page_key]
    url = setting(setting_key, "").strip()
    text = f"{emoji} <b>{title}</b>\n\n{emoji} {sub1}\n✅ {sub2}\n"
    kb_rows = []
    if url and url.startswith("http"): kb_rows.append([InlineKeyboardButton(btn_text, url=url)])
    else: text += f"\n⚠️ <i>This feature is not configured yet.</i>"
    kb_rows.append([btn("❌ Back to Menu", "home")])
    await edit_or_send(update, context, text, InlineKeyboardMarkup(kb_rows))


# ═══════════════════════════════════════════════════════════════════════════════
# TEXT HANDLER
# ═══════════════════════════════════════════════════════════════════════════════
async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_user or not update.effective_message: return
    user = update.effective_user
    upsert_user(user)
    text = update.effective_message.text.strip()

    # Coupon input flow
    if context.user_data.get("flow") == "coupon_input":
        plan_id = context.user_data.get("coupon_plan_id")
        code = text.upper()
        try: await update.effective_message.delete()
        except Exception: pass
        await clear_all_screens(context, context.bot)
        with db() as conn:
            plan = conn.execute("SELECT plans.*, products.name as product_name FROM plans JOIN products ON products.id=plans.product_id WHERE plans.id=?", (plan_id,)).fetchone()
            u = conn.execute("SELECT is_reseller, balance FROM users WHERE id=?", (user.id,)).fetchone()
        context.user_data["flow"] = None
        if not plan:
            await send_tracked(context, update.effective_chat.id, text="❌ Plan not found. Please start again from the shop.", markup=main_inline_kb())
            return
        reseller = bool(u and u["is_reseller"])
        price = plan["reseller_price"] if reseller else plan["customer_price"]
        balance = float(u["balance"]) if u else 0.0
        discount, msg, _ = validate_coupon(code, user.id, price)
        if msg != "OK":
            await confirm_order_screen(update, context, plan_id, plan, price, balance, coupon=None, discount=0, send_new=True, prefix=f"{msg}\n\n")
            return
        context.user_data["applied_coupon"] = code
        context.user_data["applied_discount"] = discount
        await confirm_order_screen(update, context, plan_id, plan, price, balance, coupon=code, discount=discount, send_new=True)
        return

    # Default — show welcome
    await clear_all_screens(context, context.bot)
    try: await update.effective_message.delete()
    except Exception: pass
    await send_tracked(context, update.effective_chat.id, text=welcome_text(user), markup=main_inline_kb())


# ═══════════════════════════════════════════════════════════════════════════════
# CALLBACK ROUTER
# ═══════════════════════════════════════════════════════════════════════════════
async def callback_router(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    try: await q.answer()
    except Exception: pass
    data = q.data or ""
    user = update.effective_user
    if user: upsert_user(user)

    if data == "home":
        await clear_all_screens(context, context.bot)
        context.user_data.clear()
        await send_tracked(context, update.effective_chat.id, text=welcome_text(user), markup=main_inline_kb())
    elif data == "shop": await show_shop(update, context)
    elif data.startswith("cat:"): await show_shop(update, context, data.split(":", 1)[1])
    elif data.startswith("prod:"): await show_product(update, context, int(data.split(":")[1]))
    elif data.startswith("plan:"): await show_plan(update, context, int(data.split(":")[1]))
    elif data.startswith("notify:"):
        pid = int(data.split(":")[1])
        with db() as conn:
            conn.execute("INSERT OR IGNORE INTO product_notifications(user_id, product_id, created_at) VALUES(?,?,?)", (user.id, pid, iso_now()))
            conn.commit()
        await show_product(update, context, pid)
    elif data.startswith("notify_cancel:"):
        pid = int(data.split(":")[1])
        with db() as conn:
            conn.execute("DELETE FROM product_notifications WHERE user_id=? AND product_id=?", (user.id, pid))
            conn.commit()
        await show_product(update, context, pid)
    elif data.startswith("pay:"):
        pid = int(data.split(":")[1])
        await do_pay(update, context, pid, context.user_data.get("applied_coupon", ""), context.user_data.get("applied_discount", 0))
    elif data.startswith("confirm_wallet:"):
        pid = int(data.split(":")[1])
        await do_confirm_wallet(update, context, pid, context.user_data.get("applied_coupon", ""), context.user_data.get("applied_discount", 0))
    elif data.startswith("coupon_apply:"): await coupon_apply_start(update, context, int(data.split(":")[1]))
    elif data.startswith("coupon_remove:"):
        pid = int(data.split(":")[1])
        context.user_data.pop("applied_coupon", None); context.user_data.pop("applied_discount", None)
        await show_plan(update, context, pid)

    # ═══════════════════════════════════════════════════════════════════
    # VERIFY PAYMENT — FamGateway Auto-Verify with retries
    # ═══════════════════════════════════════════════════════════════════
    elif data.startswith("verify:"):
        order_id = int(data.split(":")[1])
        with db() as conn:
            order = conn.execute("SELECT * FROM orders WHERE id=? AND user_id=?", (order_id, user.id)).fetchone()
        if not order: return await edit_or_send(update, context, "Order not found", back_kb())
        if order["status"] == "approved": return await edit_or_send(update, context, "✅ Already verified!", back_kb())
        if order["status"] == "cancelled": return await edit_or_send(update, context, "❌ Order was cancelled", back_kb())
        if order["payment_method"] == "wallet":
            await fulfill_order(context, order_id); return

        # Get fg_order_id
        fg_oid = str(order["fg_order_id"] or "").strip()
        if not fg_oid:
            return await edit_or_send(update, context,
                "⚠️ <b>No gateway order found</b>\n\nPlease place a new order.",
                back_kb("home"))

        # Show checking message
        try:
            await q.edit_message_text(
                f"🔄 <b>CHECKING PAYMENT STATUS...</b>\n\n"
                f"🧾 Order: <code>{safe(order['order_no'])}</code>\n"
                f"💰 Amount: <b>{money(order['amount'])}</b>\n\n"
                f"⏳ Please wait — this can take up to 1 minute.\n\n"
                f"💡 <i>UPI payments ko gateway tak pahunchne mein 30-120 seconds lag sakte hain.</i>",
                parse_mode=ParseMode.HTML,
                reply_markup=InlineKeyboardMarkup([[btn("❌ Cancel", f"cancelpay:{order_id}")]])
            )
        except Exception: pass

        last_status = "UNKNOWN"
        for attempt in range(VERIFY_MAX_ATTEMPTS):
            try:
                # Alternate: fast check first, then full verify
                if attempt % 2 == 0:
                    result = await fg_check_status(fg_oid)
                else:
                    result = await fg_verify_order(fg_oid)

                last_status = result.get("status", "UNKNOWN")

                if last_status == "SUCCESS":
                    # Save UTR if provided
                    utr = result.get("utr", "")
                    if utr:
                        with db() as conn:
                            conn.execute("UPDATE orders SET utr=? WHERE id=?", (utr, order_id))
                            conn.commit()
                    await fulfill_order(context, order_id)
                    return

                if last_status == "EXPIRED":
                    await edit_or_send(update, context,
                        f"⏰ <b>Order Expired</b>\n\n"
                        f"Ye order 5 minute mein pay nahi hua.\n"
                        f"Please naya order place karein.",
                        back_kb("shop"))
                    return

                # Continue retrying on PENDING / UNKNOWN / NOT_FOUND / FAILED
                if attempt < VERIFY_MAX_ATTEMPTS - 1:
                    await asyncio.sleep(VERIFY_DELAY_SECONDS)
                    try:
                        await q.edit_message_text(
                            f"🔄 <b>CHECKING PAYMENT...</b>\n\n"
                            f"🧾 Order: <code>{safe(order['order_no'])}</code>\n"
                            f"💰 Amount: <b>{money(order['amount'])}</b>\n"
                            f"🔎 Status: <b>{last_status}</b>\n"
                            f"⏱️ Attempt {attempt+1}/{VERIFY_MAX_ATTEMPTS}\n\n"
                            f"<i>Please wait...</i>",
                            parse_mode=ParseMode.HTML,
                            reply_markup=InlineKeyboardMarkup([[btn("❌ Cancel", f"cancelpay:{order_id}")]])
                        )
                    except Exception: pass
            except Exception as e:
                logging.exception(f"Verify attempt {attempt+1} failed: {e}")
                if attempt < VERIFY_MAX_ATTEMPTS - 1:
                    await asyncio.sleep(VERIFY_DELAY_SECONDS)

        # Final handling after all attempts
        if last_status == "SUCCESS":
            await fulfill_order(context, order_id); return

        if last_status == "PENDING":
            await edit_or_send(update, context,
                f"⏳ <b>PAYMENT PENDING</b>\n\n"
                f"🧾 Order: <code>{safe(order['order_no'])}</code>\n"
                f"💰 Amount: <b>{money(order['amount'])}</b>\n\n"
                f"✅ Aapka payment gateway tak pahunch gaya hai, lekin confirm hone mein time lag raha hai.\n\n"
                f"💡 <b>1-2 minute baad dobara try karein.</b>\n"
                f"⚡ <i>Background mein auto-verification chalti rehti hai — jaldi hi aapko key mil jayegi.</i>",
                InlineKeyboardMarkup([
                    [btn("🔄 Check Again", f"verify:{order_id}")],
                    [btn("❌ Cancel", f"cancelpay:{order_id}")],
                ]))
        elif last_status == "EXPIRED":
            await edit_or_send(update, context,
                f"⏰ <b>Order Expired</b>\n\nPlease naya order place karein.",
                back_kb("shop"))
        else:
            await edit_or_send(update, context,
                f"⏳ <b>Payment Not Confirmed Yet</b>\n\n"
                f"🧾 Order: <code>{safe(order['order_no'])}</code>\n"
                f"💰 Amount: <b>{money(order['amount'])}</b>\n"
                f"🔎 Status: <b>{last_status}</b>\n\n"
                f"<b>Possible reasons:</b>\n"
                f"• Payment gateway tak nahi pahuncha (1-2 min wait karein)\n"
                f"• Amount mismatch\n"
                f"• Network issue\n\n"
                f"💡 <i>2-3 minute baad Check Again dabayein.</i>",
                InlineKeyboardMarkup([
                    [btn("🔄 Check Again", f"verify:{order_id}")],
                    [btn("❌ Cancel", f"cancelpay:{order_id}")],
                ]))

    elif data.startswith("cancelpay:"):
        order_id = int(data.split(":")[1])
        with db() as conn:
            conn.execute("UPDATE orders SET status='cancelled' WHERE id=? AND user_id=? AND status IN ('pending','awaiting_utr')", (order_id, user.id))
            conn.commit()
        await clear_all_screens(context, context.bot)
        context.user_data.clear()
        await send_tracked(context, update.effective_chat.id, text=welcome_text(user), markup=main_inline_kb())

    elif data.startswith("bal:"): await handle_balance_keypad(update, context, data.split(":", 1)[1])
    elif data == "spin_now": await do_spin(update, context)
    elif data == "profile": await show_profile(update, context)
    elif data == "my_keys": await show_my_keys(update, context)
    elif data == "add_balance": await show_add_balance(update, context)
    elif data == "daily_spin": await show_daily_spin(update, context)
    elif data == "refer": await show_refer(update, context)
    elif data == "how_to_use": await show_link_page(update, context, "how_to_use")
    elif data == "download_files": await show_link_page(update, context, "download_files")
    elif data == "support": await show_link_page(update, context, "support")
    elif data == "payment_proofs": await show_link_page(update, context, "payment_proofs")
    else: await edit_or_send(update, context, "Unknown action", back_kb())


async def error_handler(update, context): logging.error("Update error:", exc_info=context.error)


# ═══════════════════════════════════════════════════════════════════════════════
# BACKGROUND JOBS
# ═══════════════════════════════════════════════════════════════════════════════
async def expiry_job(context):
    """Expire pending orders after their window passes."""
    with db() as c:
        c.execute("UPDATE orders SET status='expired', delivery_status='not_required' WHERE status IN ('pending','awaiting_utr') AND COALESCE(expiry_at, created_at) < ?", (iso_now(),))
        c.commit()


async def gateway_fulfillment_job(context):
    """Auto-verify pending FamGateway orders + deliver approved ones."""
    try:
        # Pending gateway orders (user hasn't pressed Verify yet)
        with db() as c:
            orders = c.execute("SELECT id, order_no, amount, fg_order_id FROM orders WHERE status='pending' AND payment_method='gateway' AND fg_order_id!='' ORDER BY id LIMIT 20").fetchall()
        for o in orders:
            try:
                result = await fg_verify_order(o["fg_order_id"])
                if result.get("ok") and result.get("status") == "SUCCESS":
                    utr = result.get("utr", "")
                    if utr:
                        with db() as c2:
                            c2.execute("UPDATE orders SET utr=? WHERE id=?", (utr, o["id"]))
                            c2.commit()
                    await fulfill_order(context, o["id"])
            except Exception as e:
                logging.error(f"Fulfill {o['order_no']}: {e}")

        # Admin-approved orders (dashboard manual delivery)
        with db() as c:
            approved = c.execute("SELECT id FROM orders WHERE status='approved_pending_delivery' ORDER BY id LIMIT 10").fetchall()
        for o in approved:
            try: await fulfill_order(context, o["id"])
            except Exception as e: logging.error(f"Deliver approved order {o['id']}: {e}")
    except Exception: logging.exception("Gateway job failed")


async def broadcast_job(context):
    """Broadcast with auto-detection of media type from URL.
    Supports: photo, video, audio, voice, document, animation."""
    try:
        with db() as c:
            rows = c.execute("SELECT * FROM scheduled_broadcasts WHERE status='scheduled' AND run_at<=? ORDER BY id LIMIT 5", (iso_now(),)).fetchall()
            for r in rows:
                c.execute("UPDATE scheduled_broadcasts SET status='processing' WHERE id=?", (r["id"],))
            c.commit()
        for r in rows:
            with db() as c:
                users = c.execute("SELECT id FROM users WHERE active=1").fetchall()
            sent = 0; errors = 0
            mt = str(r["media_type"] or "").strip().lower()
            mu = str(r["media_url"] or "").strip()
            msg_text = r["message"] or ""

            # Auto-detect media type if not specified
            if mu and not mt:
                mu_low = mu.lower().split("?")[0]
                if any(mu_low.endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"]): mt = "photo"
                elif any(mu_low.endswith(ext) for ext in [".mp4", ".mov", ".mkv", ".webm", ".avi"]): mt = "video"
                elif any(mu_low.endswith(ext) for ext in [".mp3", ".m4a", ".ogg", ".wav", ".opus"]): mt = "audio"
                elif any(mu_low.endswith(ext) for ext in [".pdf", ".zip", ".apk", ".doc", ".docx"]): mt = "document"
                else: mt = "photo"

            for u in users:
                try:
                    if mt == "photo" and mu:
                        msg = await context.bot.send_photo(chat_id=u["id"], photo=mu, caption=msg_text, parse_mode=ParseMode.HTML)
                    elif mt == "video" and mu:
                        msg = await context.bot.send_video(chat_id=u["id"], video=mu, caption=msg_text, parse_mode=ParseMode.HTML, supports_streaming=True)
                    elif mt == "audio" and mu:
                        msg = await context.bot.send_audio(chat_id=u["id"], audio=mu, caption=msg_text, parse_mode=ParseMode.HTML)
                    elif mt == "voice" and mu:
                        msg = await context.bot.send_voice(chat_id=u["id"], voice=mu, caption=msg_text)
                    elif mt == "document" and mu:
                        msg = await context.bot.send_document(chat_id=u["id"], document=mu, caption=msg_text, parse_mode=ParseMode.HTML)
                    elif mt == "animation" and mu:
                        msg = await context.bot.send_animation(chat_id=u["id"], animation=mu, caption=msg_text, parse_mode=ParseMode.HTML)
                    else:
                        msg = await context.bot.send_message(chat_id=u["id"], text=msg_text, parse_mode=ParseMode.HTML)
                    sent += 1
                    with db() as c:
                        c.execute("INSERT INTO broadcast_deliveries(broadcast_id, user_id, message_id, chat_id, delivered_at) VALUES(?,?,?,?,?)",
                                  (r["id"], u["id"], msg.message_id, msg.chat_id, iso_now()))
                        c.commit()
                except Exception as e:
                    errors += 1
                    logging.debug(f"Broadcast failed for {u['id']}: {e}")
            with db() as c:
                c.execute("UPDATE scheduled_broadcasts SET status='sent', sent_count=?, error_count=? WHERE id=?", (sent, errors, r["id"]))
                c.commit()
    except Exception: logging.exception("Broadcast job failed")


async def product_notify_job(context):
    """Notify users when a product comes out of maintenance."""
    try:
        with db() as c:
            prods = c.execute("SELECT id, name FROM products WHERE maintenance_mode=0 AND active=1").fetchall()
        for p in prods:
            with db() as c:
                subs = c.execute("SELECT user_id FROM product_notifications WHERE product_id=? AND notified=0", (p["id"],)).fetchall()
            for s in subs:
                try:
                    await context.bot.send_message(
                        s["user_id"],
                        f"🎉 <b>GOOD NEWS!</b>\n\n"
                        f"📦 Product: <b>{safe(p['name'])}</b>\n"
                        f"✅ Abhi Available Ho Gaya Hai!\n\n"
                        f"⚡ Jaldi se Buy Karen - Stock Limited Hai!",
                        parse_mode=ParseMode.HTML,
                        reply_markup=InlineKeyboardMarkup([[btn("🛍️ Shop Now", "shop")], [btn("❌ Close", "home")]])
                    )
                    with db() as c:
                        c.execute("UPDATE product_notifications SET notified=1 WHERE user_id=? AND product_id=?", (s["user_id"], p["id"]))
                        c.commit()
                except Exception: pass
    except Exception: logging.exception("Notify job failed")


def heartbeat_thread():
    p = HEARTBEAT_PATH
    if not p: return
    token = BOT_TOKEN
    connectivity = str(Path(p).with_name("telegram_heartbeat"))
    while True:
        try: Path(p).write_text(iso_now(), encoding="utf-8")
        except Exception: pass
        try:
            req = urllib.request.Request(f"https://api.telegram.org/bot{token}/getMe", method="GET", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                d = json.loads(resp.read(64 * 1024).decode("utf-8", errors="replace"))
                if d.get("ok"):
                    try: Path(connectivity).write_text(iso_now(), encoding="utf-8")
                    except Exception: pass
        except Exception: pass
        time.sleep(30)


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════
def main():
    if not BOT_TOKEN: raise SystemExit("BOT_TOKEN missing")
    if not ADMIN_USER_IDS: raise SystemExit("ADMIN_USER_ID missing")
    logging.info(f"Starting {BOT_VERSION}")
    logging.info(f"FamGateway SDK available: {FAMGATEWAY_AVAILABLE}")
    init_db()
    threading.Thread(target=heartbeat_thread, name="heartbeat", daemon=True).start()
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(callback_router))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))
    app.add_error_handler(error_handler)
    if app.job_queue:
        app.job_queue.run_repeating(expiry_job, interval=300, first=30)
        app.job_queue.run_repeating(gateway_fulfillment_job, interval=20, first=10)
        app.job_queue.run_repeating(broadcast_job, interval=30, first=15)
        app.job_queue.run_repeating(product_notify_job, interval=60, first=30)
    logging.info("Bot polling...")
    app.run_polling(drop_pending_updates=True, allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    logging.basicConfig(format="%(asctime)s | %(levelname)s | %(message)s", level=logging.INFO)
    main()
