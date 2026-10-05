#!/usr/bin/env python3
"""DataRefine Studio license admin + API.

Desktop apps poll GET /api/config. Turning Require License ON locks
already-shipped clients on the next poll (60s) or next launch — no new build.

  py -3.12 services/internal/policy-engine/server.py
  # then put http://HOST:8788 in config/license-api.txt
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("LICENSE_DB") or ROOT / "data.db")
HOST = os.environ.get("LICENSE_HOST") or "0.0.0.0"
PORT = int(os.environ.get("LICENSE_PORT") or 8788)
ADMIN_PASSWORD = os.environ.get("LICENSE_ADMIN_PASSWORD") or "change-me"
SECRET = os.environ.get("LICENSE_SECRET") or "datarefine-license-hmac"

DEFAULT_CONFIG = {
    "requireLicense": False,
    # Purchase settings are cloud-owned; the desktop never embeds the URL.
    "enableAiCreditPurchase": os.environ.get("ENABLE_AI_CREDIT_PURCHASE", "true").lower() in {"1", "true", "yes", "on"},
    "aiCreditPurchaseUrl": os.environ.get("AI_CREDIT_PURCHASE_URL", ""),
    "maintenance": False,
    "maintenanceMessage": "DataRefine Studio is temporarily unavailable.",
    "buyUrl": "",
    "githubUrl": "",
    "supportEmail": "",
    "latestVersion": "3.4.2",
    "minimumVersion": "3.4.2",
    "downloadUrl": "",
}

_lock = threading.Lock()
_sessions: dict[str, float] = {}



# ----- plugin marketplace catalogue (desktop: GET /api/plugins) -----
MARKET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "marketplace")
PLUGIN_META = [
    {"id": "demo-column-cleaner", "name": "Column Cleaner Pro", "version": "1.0.0",
     "description": "One-click trim, case-fold and duplicate suggestions for text columns.",
     "author": "DataRefine Labs", "downloads": 128},
    {"id": "demo-profile-chart", "name": "Profile Chart", "version": "1.0.0",
     "description": "Sidebar view with quick per-column statistic charts for the open sheet.",
     "author": "DataRefine Labs", "downloads": 64},
]

def catalog_json(host):
    """VS Code-style catalogue. sha256 computed live so installs always verify."""
    plugins = []
    for meta in PLUGIN_META:
        zp = os.path.join(MARKET_DIR, meta["id"] + ".zip")
        if not os.path.isfile(zp):
            continue
        sha = hashlib.sha256(open(zp, "rb").read()).hexdigest()
        entry = dict(meta)
        entry.update({
            "sha256": sha,
            "artifactUrl": f"http://{host}/api/plugins/artifact/{meta['id']}.zip",
            "entitled": True,
        })
        plugins.append(entry)
    return json.dumps({"ok": True, "data": {"plugins": plugins}})

def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def conn() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(DB), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    c = conn()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS keys (
            id INTEGER PRIMARY KEY,
            license_key TEXT NOT NULL UNIQUE,
            note TEXT,
            plan TEXT NOT NULL DEFAULT 'Community',
            created_at TEXT NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS ai_usage (
            license_key TEXT NOT NULL,
            calendar_month TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (license_key, calendar_month)
        );
        CREATE TABLE IF NOT EXISTS ai_usage_operations (
            operation_id TEXT PRIMARY KEY,
            license_key TEXT NOT NULL,
            calendar_month TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activations (
            id INTEGER PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            license_key TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            app_version TEXT,
            platform TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_seen TEXT,
            blocked INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    # Existing development databases predate plan-aware usage. Migrate them
    # in place without changing activation tokens or license keys.
    try:
        c.execute("ALTER TABLE keys ADD COLUMN plan TEXT NOT NULL DEFAULT 'Community'")
    except sqlite3.OperationalError:
        pass
    row = c.execute("SELECT value FROM settings WHERE key='config'").fetchone()
    if not row:
        c.execute("INSERT INTO settings(key,value) VALUES('config',?)", (json.dumps(DEFAULT_CONFIG),))
    c.commit()
    c.close()


def get_config() -> dict:
    c = conn()
    row = c.execute("SELECT value FROM settings WHERE key='config'").fetchone()
    c.close()
    data = json.loads(row["value"]) if row else dict(DEFAULT_CONFIG)
    out = dict(DEFAULT_CONFIG)
    out.update(data if isinstance(data, dict) else {})
    out["requireLicense"] = bool(out.get("requireLicense"))
    out["enableAiCreditPurchase"] = bool(out.get("enableAiCreditPurchase"))
    out["aiCreditPurchaseUrl"] = str(out.get("aiCreditPurchaseUrl") or "")
    out["maintenance"] = bool(out.get("maintenance"))
    return out


def set_config(patch: dict) -> dict:
    cur = get_config()
    for k in DEFAULT_CONFIG:
        if k in patch:
            cur[k] = patch[k]
    cur["requireLicense"] = bool(cur["requireLicense"])
    cur["maintenance"] = bool(cur["maintenance"])
    c = conn()
    c.execute("INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(cur),))
    c.commit()
    c.close()
    return cur


def new_key(note: str = "", plan: str = "Community") -> str:
    plan = normalized_plan(plan)
    raw = secrets.token_hex(8).upper()
    key = f"DRS-{raw[0:4]}-{raw[4:8]}-{raw[8:12]}-{raw[12:16]}"
    c = conn()
    c.execute(
        "INSERT INTO keys(license_key, note, plan, created_at) VALUES(?,?,?,?)",
        (key, note or "", plan, iso()),
    )
    c.commit()
    c.close()
    return key


def sign_token(payload: str) -> str:
    mac = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def public_config() -> dict:
    c = get_config()
    return {
        "requireLicense": c["requireLicense"],
        "enableAiCreditPurchase": c["enableAiCreditPurchase"],
        "aiCreditPurchaseUrl": c["aiCreditPurchaseUrl"],
        "maintenance": c["maintenance"],
        "buyUrl": c.get("buyUrl") or "",
        "githubUrl": c.get("githubUrl") or "",
        "supportEmail": c.get("supportEmail") or "",
        "latestVersion": c.get("latestVersion") or "",
        "minimumVersion": c.get("minimumVersion") or "",
        "maintenanceMessage": c.get("maintenanceMessage") or "",
        "downloadUrl": c.get("downloadUrl") or "",
    }


PROFESSIONAL_PLANS = {
    "professional monthly",
    "professional 3 months",
    "professional 6 months",
    "professional yearly",
}
COMMUNITY_LIMIT = 15
PLAN_DAYS = {
    "professional monthly": 31,
    "professional 3 months": 92,
    "professional 6 months": 184,
    "professional yearly": 365,
}


def normalized_plan(value: str | None) -> str:
    raw = " ".join(str(value or "Community").strip().replace("_", " ").replace("-", " ").split())
    aliases = {
        "professional monthly": "Professional Monthly",
        "professional 3 months": "Professional 3 Months",
        "professional 6 months": "Professional 6 Months",
        "professional yearly": "Professional Yearly",
    }
    # Accept the production wire spellings (for example
    # professional_monthly) but return one canonical product label.
    return aliases.get(raw.lower(), "Community")


def plan_is_professional(plan: str) -> bool:
    return plan.strip().lower() in PROFESSIONAL_PLANS


def entitlements_for_plan(plan: str) -> dict:
    # Community may use Cloud AI when its separate Cloud AI wallet has credits;
    # the monthly file-cleaning quota remains independent of that wallet.
    professional = plan_is_professional(plan)
    return {
        "cloudAi": True,
        "aiPlugins": professional,
        "agents": professional,
        "capabilities": ["data_cleaning", "data_profiling"] + (["advanced_features"] if professional else []),
    }


def calendar_month() -> str:
    # The server, not the desktop clock, chooses the month boundary. Deployments
    # can set TZ on the service host when their billing calendar is not UTC.
    return utcnow().strftime("%Y-%m")


def activation_for_token(token: str) -> sqlite3.Row | None:
    token = str(token or "").strip()
    if not token:
        return None
    c = conn()
    row = c.execute(
        """SELECT a.*, k.revoked AS key_revoked, k.plan AS plan
           FROM activations a JOIN keys k ON k.license_key=a.license_key
           WHERE a.token=?""",
        (token,),
    ).fetchone()
    c.close()
    if not row or int(row["blocked"]) or int(row["key_revoked"]):
        return None
    if row["expires_at"] and row["expires_at"] < iso():
        return None
    return row


def usage_payload(license_key: str, plan: str, month: str, used: int, allowed: bool | None = None) -> dict:
    unlimited = plan_is_professional(plan)
    limit = None if unlimited else COMMUNITY_LIMIT
    if allowed is None:
        allowed = unlimited or used < COMMUNITY_LIMIT
    payload = {
        "plan": plan,
        "month": month,
        "used": int(used),
        "limit": limit,
        "unlimited": unlimited,
        "allowed": bool(allowed),
        "upgradeUrl": get_config().get("buyUrl") or get_config().get("aiCreditPurchaseUrl") or "",
    }
    if not payload["allowed"]:
        payload["message"] = "Your Community plan includes 15 AI file cleanings per month. Your monthly limit has been reached."
    return payload


def ai_usage(body: dict, record: bool = False) -> tuple[int, dict]:
    token = str(body.get("activationToken") or "").strip()
    row = activation_for_token(token)
    if not row:
        return 401, {"ok": False, "error": {"code": "LICENSE_NOT_ACTIVE", "message": "License is not active."}}
    source = str(body.get("source") or "")
    if source not in {"cloud", "byok", "local"}:
        return 400, {"ok": False, "error": {"code": "VALIDATION_ERROR", "message": "Unknown AI source."}}
    operation_id = str(body.get("operationId") or "").strip()
    if not operation_id:
        return 400, {"ok": False, "error": {"code": "VALIDATION_ERROR", "message": "operationId is required."}}
    month = calendar_month()
    plan = normalized_plan(row["plan"])
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        current = c.execute(
            "SELECT used FROM ai_usage WHERE license_key=? AND calendar_month=?",
            (row["license_key"], month),
        ).fetchone()
        used = int(current["used"]) if current else 0
        if record:
            prior = c.execute(
                "SELECT operation_id FROM ai_usage_operations WHERE operation_id=?",
                (operation_id,),
            ).fetchone()
            if not prior:
                if not plan_is_professional(plan) and used >= COMMUNITY_LIMIT:
                    c.rollback()
                    return 409, {"ok": True, "data": usage_payload(row["license_key"], plan, month, used, False)}
                c.execute(
                    "INSERT INTO ai_usage_operations(operation_id, license_key, calendar_month, created_at) VALUES(?,?,?,?)",
                    (operation_id, row["license_key"], month, iso()),
                )
                c.execute(
                    """INSERT INTO ai_usage(license_key, calendar_month, used) VALUES(?,?,1)
                       ON CONFLICT(license_key, calendar_month) DO UPDATE SET used=used+1""",
                    (row["license_key"], month),
                )
                used += 1
        payload = usage_payload(row["license_key"], plan, month, used)
        c.commit()
        return 200, {"ok": True, "data": payload}
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def activate(body: dict) -> dict:
    key = str(body.get("licenseKey") or body.get("license_key") or "").strip().upper()
    machine = str(body.get("machineId") or body.get("machine_id") or "").strip()
    version = str(body.get("appVersion") or body.get("app_version") or "")
    platform = str(body.get("platform") or "")
    if not key:
        raise ValueError("License key required.")
    if not machine:
        raise ValueError("Machine ID missing.")
    c = conn()
    row = c.execute("SELECT * FROM keys WHERE license_key=?", (key,)).fetchone()
    if not row or int(row["revoked"]):
        c.close()
        raise ValueError("License key is invalid or revoked.")
    existing = c.execute(
        "SELECT * FROM activations WHERE license_key=? AND machine_id=? AND blocked=0 ORDER BY id DESC LIMIT 1",
        (key, machine),
    ).fetchone()
    plan = normalized_plan(row["plan"])
    expires = iso(utcnow() + timedelta(days=PLAN_DAYS[plan.strip().lower()])) if plan_is_professional(plan) else ""
    if existing and (not existing["expires_at"] or existing["expires_at"] >= iso()):
        c.execute("UPDATE activations SET last_seen=? WHERE id=?", (iso(), existing["id"]))
        c.commit()
        token = existing["token"]
        exp = existing["expires_at"]
        c.close()
        plan = normalized_plan(row["plan"])
        return {
            "success": True,
            "activationToken": token,
            "token": token,
            "expiresAt": exp,
            "plan": plan,
            "entitlements": entitlements_for_plan(plan),
        }
    nonce = secrets.token_urlsafe(24)
    payload = f"{machine}.{int(time.time())}.{nonce}"
    token = sign_token(payload)
    c.execute(
        """INSERT INTO activations(token, license_key, machine_id, app_version, platform, created_at, expires_at, last_seen, blocked)
           VALUES (?,?,?,?,?,?,?,?,0)""",
        (token, key, machine, version, platform, iso(), expires, iso()),
    )
    c.commit()
    c.close()
    plan = normalized_plan(row["plan"])
    return {
        "success": True,
        "activationToken": token,
        "token": token,
        "expiresAt": expires,
        "plan": plan,
        "entitlements": entitlements_for_plan(plan),
    }


def verify(token: str) -> dict:
    token = (token or "").strip()
    if not token:
        return {"ok": False, "blocked": True, "message": "Missing token."}
    c = conn()
    row = c.execute("SELECT * FROM activations WHERE token=?", (token,)).fetchone()
    if not row:
        c.close()
        return {"ok": False, "blocked": True, "message": "Unknown token."}
    if int(row["blocked"]):
        c.close()
        return {"ok": False, "blocked": True, "message": "License blocked."}
    if row["expires_at"] and row["expires_at"] < iso():
        c.close()
        return {"ok": False, "blocked": True, "message": "License expired."}
    key = c.execute("SELECT revoked, plan FROM keys WHERE license_key=?", (row["license_key"],)).fetchone()
    if not key or int(key["revoked"]):
        c.close()
        return {"ok": False, "blocked": True, "message": "License key revoked."}
    c.execute("UPDATE activations SET last_seen=? WHERE id=?", (iso(), row["id"]))
    c.commit()
    c.close()
    plan = normalized_plan(key["plan"])
    return {
        "ok": True,
        "blocked": False,
        "success": True,
        "status": "granted",
        "plan": plan,
        "expiresAt": row["expires_at"],
        "entitlements": entitlements_for_plan(plan),
    }


def admin_ok(handler: BaseHTTPRequestHandler) -> bool:
    cookie = handler.headers.get("Cookie") or ""
    for part in cookie.split(";"):
        if part.strip().startswith("drs_admin="):
            tok = part.split("=", 1)[-1].strip()
            exp = _sessions.get(tok)
            if exp and exp > time.time():
                return True
    auth = handler.headers.get("X-Admin-Password") or ""
    given = hashlib.sha256(auth.encode("utf-8")).digest()
    expect = hashlib.sha256(ADMIN_PASSWORD.encode("utf-8")).digest()
    return hmac.compare_digest(given, expect)


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    n = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(n) if n else b"{}"
    if not raw:
        return {}
    data = json.loads(raw.decode("utf-8"))
    return data if isinstance(data, dict) else {}


ADMIN_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DataRefine Studio — License admin</title>
<style>
  :root { --bg:#0f1115; --elev:#171a21; --in:#22262f; --accent:#5b8def; --text:#e8eaed; --dim:#8b919c; --border:#2a2f3a; --ok:#7fd99a; --danger:#f07178; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, Segoe UI, system-ui, sans-serif; background:radial-gradient(900px 420px at 50% 0%, rgba(91,141,239,.18), transparent 60%) var(--bg); color:var(--text); }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; display:grid; gap:16px; }
  h1 { font-size:22px; letter-spacing:-.03em; margin:0; }
  .lead { color:var(--dim); font-size:13px; line-height:1.5; }
  .card { background: color-mix(in srgb, var(--elev) 86%, transparent); border:1px solid var(--border); border-radius:20px; padding:18px; display:grid; gap:12px; backdrop-filter: blur(16px); }
  label { display:grid; gap:6px; font-size:11px; font-weight:650; color:var(--dim); }
  input, textarea { width:100%; background:var(--in); border:1px solid var(--border); border-radius:10px; color:var(--text); padding:10px 12px; font:inherit; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .sw { display:flex; align-items:center; gap:10px; font-size:14px; font-weight:650; }
  button { border:none; border-radius:10px; padding:9px 14px; font-weight:700; cursor:pointer; }
  .ok { background:var(--accent); color:#fff; }
  .ghost { background:transparent; color:var(--text); border:1px solid var(--border); }
  .danger { background:transparent; color:var(--danger); border:1px solid var(--border); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--border); }
  .pill { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:2px 7px; border-radius:99px; background:var(--in); color:var(--dim); }
  .pill.on { background: color-mix(in srgb, var(--ok) 22%, transparent); color:var(--ok); }
  .msg { font-size:12px; color:var(--ok); }
  .err { font-size:12px; color:var(--danger); }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1>License admin</h1>
    <p class="lead">Require License ON locks every DataRefine Studio that points at this server — no desktop rebuild. Clients poll <code>/api/config</code> about every 60 seconds.</p>
  </div>
  <div class="card" id="login-card">
    <label>Admin password <input id="pw" type="password" placeholder="LICENSE_ADMIN_PASSWORD"/></label>
    <button class="ok" type="button" onclick="login()">Sign in</button>
    <div class="err" id="login-err"></div>
  </div>
  <div id="app" style="display:none; display:none;"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let cfg = {};
async function api(path, opts={}) {
  const res = await fetch(path, { credentials:'include', headers:{'Content-Type':'application/json', ...(opts.headers||{})}, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.message || body.detail || res.statusText);
  return body.data ?? body;
}
async function login() {
  try {
    await api('/api/admin/login', { method:'POST', body: JSON.stringify({ password: $('pw').value }) });
    $('login-err').textContent = '';
    await load();
  } catch (e) { $('login-err').textContent = String(e.message || e); }
}
function sw(id, on) {
  return `<label class="sw"><input type="checkbox" id="${id}" ${on?'checked':''}/> ${id === 'requireLicense' ? 'Require License' : 'Maintenance'}</label>`;
}
function field(id, label, val) {
  return `<label>${label}<input id="${id}" value="${String(val||'').replaceAll('"','&quot;')}"/></label>`;
}
async function load() {
  const st = await api('/api/admin/state');
  cfg = st.config || {};
  $('login-card').style.display = 'none';
  const app = $('app');
  app.style.display = 'grid';
  app.style.gap = '16px';
  const keys = (st.keys||[]).map(k => `<tr>
    <td><code>${k.license_key}</code></td><td>${k.plan||'Community'}</td><td>${k.note||''}</td><td>${k.created_at}</td>
    <td>${k.revoked ? '<span class="pill">revoked</span>' : '<span class="pill on">live</span>'}</td>
    <td>${k.revoked ? '' : `<button class="danger" onclick="revoke('${k.license_key}')">Revoke</button>`}</td>
  </tr>`).join('');
  const acts = (st.activations||[]).map(a => `<tr>
    <td><code>${(a.machine_id||'').slice(0,12)}…</code></td>
    <td>${a.platform||''} ${a.app_version||''}</td>
    <td>${a.blocked ? '<span class="pill">blocked</span>' : '<span class="pill on">ok</span>'}</td>
    <td>${a.blocked ? '' : `<button class="danger" onclick="block('${a.token}')">Block</button>`}</td>
  </tr>`).join('');
  app.innerHTML = `
    <div class="card">
      <div class="row">${sw('requireLicense', cfg.requireLicense)} ${sw('maintenance', cfg.maintenance)}</div>
      <label>Maintenance message <textarea id="maintenanceMessage" rows="2">${cfg.maintenanceMessage||''}</textarea></label>
      ${field('buyUrl','Buy URL', cfg.buyUrl)}
      ${field('githubUrl','GitHub URL', cfg.githubUrl)}
      ${field('downloadUrl','Download URL', cfg.downloadUrl)}
      ${field('supportEmail','Support email', cfg.supportEmail)}
      <div class="row">
        ${field('latestVersion','Latest version', cfg.latestVersion)}
        ${field('minimumVersion','Minimum version', cfg.minimumVersion)}
      </div>
      <div class="row"><button class="ok" onclick="save()">Save config</button><span class="msg" id="save-msg"></span></div>
    </div>
    <div class="card">
      <div class="row"><strong>License keys</strong>
        <select id="plan" style="max-width:230px"><option>Community</option><option>Professional Monthly</option><option>Professional 3 Months</option><option>Professional 6 Months</option><option>Professional Yearly</option></select>
        <input id="note" placeholder="Note" style="max-width:240px"/>
        <button class="ok" onclick="issue()">Issue key</button>
      </div>
      <table><thead><tr><th>Key</th><th>Plan</th><th>Note</th><th>Created</th><th></th><th></th></tr></thead><tbody>${keys||'<tr><td colspan="6" class="lead">None yet</td></tr>'}</tbody></table>
    </div>
    <div class="card">
      <strong>Activations</strong>
      <table><thead><tr><th>Machine</th><th>App</th><th></th><th></th></tr></thead><tbody>${acts||'<tr><td colspan="4" class="lead">None</td></tr>'}</tbody></table>
    </div>`;
}
async function save() {
  const patch = {
    requireLicense: $('requireLicense').checked,
    maintenance: $('maintenance').checked,
    maintenanceMessage: $('maintenanceMessage').value,
    buyUrl: $('buyUrl').value.trim(),
    githubUrl: $('githubUrl').value.trim(),
    downloadUrl: $('downloadUrl').value.trim(),
    supportEmail: $('supportEmail').value.trim(),
    latestVersion: $('latestVersion').value.trim(),
    minimumVersion: $('minimumVersion').value.trim(),
  };
  await api('/api/admin/config', { method:'POST', body: JSON.stringify(patch) });
  $('save-msg').textContent = 'Saved. Desktop clients pick this up within a minute.';
}
async function issue() {
  await api('/api/admin/keys', { method:'POST', body: JSON.stringify({ note: $('note').value, plan: $('plan').value }) });
  await load();
}
async function revoke(license_key) {
  await api('/api/admin/revoke', { method:'POST', body: JSON.stringify({ licenseKey: license_key }) });
  await load();
}
async function block(token) {
  await api('/api/admin/block', { method:'POST', body: JSON.stringify({ token }) });
  await load();
}
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Password")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Credentials", "true")

    def _send(self, code: int, body, cookies: list[str] | None = None, content="application/json"):
        raw = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", content)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        for c in cookies or []:
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        q = parse_qs(u.query)
        try:
            if path in {"/", "/admin"}:
                self._send(200, ADMIN_HTML.encode("utf-8"), content="text/html; charset=utf-8")
                return
            if path == "/api/plugins":
                self._send(200, catalog_json(self.headers.get("Host") or "127.0.0.1:8787").encode("utf-8"), content="application/json")
                return
            if path.startswith("/api/plugins/artifact/"):
                name = os.path.basename(path)  # traversal-safe
                fp = os.path.join(MARKET_DIR, name)
                if os.path.isfile(fp) and name.endswith(".zip"):
                    self._send(200, open(fp, "rb").read(), content="application/zip")
                else:
                    self._send(404, b'{"ok":false}')
                return
            if path == "/api/config":
                self._send(200, public_config())
                return
            if path == "/api/verify":
                token = (q.get("token") or [""])[0]
                auth = self.headers.get("Authorization") or ""
                if auth.lower().startswith("bearer "):
                    token = auth.split(" ", 1)[1].strip()
                result = verify(token)
                if result.get("ok"):
                    self._send(200, {"ok": True, "data": result})
                else:
                    self._send(200, {"ok": False, "data": result, "message": result.get("message") or "License verification failed."})
                return
            if path == "/api/admin/state":
                if not admin_ok(self):
                    self._send(401, {"ok": False, "message": "Admin sign-in required."})
                    return
                c = conn()
                keys = [dict(r) for r in c.execute("SELECT * FROM keys ORDER BY id DESC").fetchall()]
                acts = [dict(r) for r in c.execute("SELECT * FROM activations ORDER BY id DESC LIMIT 80").fetchall()]
                c.close()
                self._send(200, {"config": get_config(), "keys": keys, "activations": acts})
                return
            self._send(404, {"ok": False, "message": "Not found"})
        except Exception as exc:
            self._send(400, {"ok": False, "message": str(exc)})

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        try:
            body = read_json(self)
            if path == "/api/activate":
                self._send(200, {"ok": True, "data": activate(body)})
                return
            if path == "/api/verify":
                token = str(body.get("activationToken") or body.get("token") or "")
                result = verify(token)
                if result.get("ok"):
                    self._send(200, {"ok": True, "data": result})
                else:
                    self._send(200, {"ok": False, "data": result, "message": result.get("message") or "License verification failed."})
                return
            if path in {"/api/ai/usage/check", "/api/ai/usage/record"}:
                status, payload = ai_usage(body, record=path.endswith("/record"))
                self._send(status, payload)
                return
            if path == "/api/admin/login":
                pw = str(body.get("password") or "")
                given = hashlib.sha256(pw.encode("utf-8")).digest()
                expect = hashlib.sha256(ADMIN_PASSWORD.encode("utf-8")).digest()
                if not hmac.compare_digest(given, expect):
                    self._send(401, {"ok": False, "message": "Wrong password."})
                    return
                tok = secrets.token_urlsafe(24)
                _sessions[tok] = time.time() + 12 * 3600
                self._send(200, {"ok": True}, cookies=[f"drs_admin={tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200"])
                return
            if not admin_ok(self):
                self._send(401, {"ok": False, "message": "Admin sign-in required."})
                return
            if path == "/api/admin/config":
                self._send(200, set_config(body))
                return
            if path == "/api/admin/keys":
                key = new_key(str(body.get("note") or ""), str(body.get("plan") or "Community"))
                self._send(200, {"licenseKey": key})
                return
            if path == "/api/admin/revoke":
                key = str(body.get("licenseKey") or body.get("license_key") or "").strip().upper()
                c = conn()
                c.execute("UPDATE keys SET revoked=1 WHERE license_key=?", (key,))
                c.commit()
                c.close()
                self._send(200, {"ok": True})
                return
            if path == "/api/admin/block":
                token = str(body.get("token") or "")
                c = conn()
                c.execute("UPDATE activations SET blocked=1 WHERE token=?", (token,))
                c.commit()
                c.close()
                self._send(200, {"ok": True})
                return
            self._send(404, {"ok": False, "message": "Not found"})
        except ValueError as exc:
            self._send(400, {"ok": False, "success": False, "message": str(exc)})
        except Exception as exc:
            self._send(400, {"ok": False, "message": str(exc)})


def main() -> None:
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"License admin http://127.0.0.1:{PORT}/admin")
    print(f"API          http://127.0.0.1:{PORT}/api/config")
    print("Default requireLicense=false (desktop works without a key).")
    print("Set LICENSE_ADMIN_PASSWORD. Point the app at this origin in config/license-api.txt")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
