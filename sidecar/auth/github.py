"""GitHub identity for DataRefine Studio.

Device authorization needs an OAuth App client id with Device Flow enabled.
A personal access token always works without registering an app.
Access tokens stay in the local SQLite settings store and are never returned to the UI.
Multiple accounts can be saved and switched on this machine.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

import httpx

DEVICE_CODE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
DEFAULT_SCOPE = "read:user repo"

_PENDING: dict[str, dict[str, Any]] = {}


def _headers_json() -> dict[str, str]:
    return {"Accept": "application/json", "User-Agent": "DataRefine-Studio"}


def _api_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "DataRefine-Studio",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _profile(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user.get("id"),
        "login": user.get("login"),
        "name": user.get("name") or user.get("login"),
        "avatar_url": user.get("avatar_url") or "",
        "html_url": user.get("html_url") or "",
    }


def _key(user: dict[str, Any]) -> str:
    if user.get("id") is not None:
        return str(user["id"])
    return str(user.get("login") or "").strip().lower()


def _public_user(entry: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    user = entry.get("user")
    if not isinstance(user, dict) or not user.get("login"):
        return None
    return {
        "id": user.get("id"),
        "login": user.get("login"),
        "name": user.get("name") or user.get("login"),
        "avatar_url": user.get("avatar_url") or "",
        "html_url": user.get("html_url") or "",
    }


def _load(store) -> dict[str, Any]:
    raw = store.get_setting("github", {}) or {}
    if not isinstance(raw, dict):
        raw = {}
    accounts = raw.get("accounts")
    if not isinstance(accounts, dict):
        accounts = {}
    migrated = False
    if raw.get("token") and isinstance(raw.get("user"), dict) and raw["user"].get("login"):
        key = _key(raw["user"])
        if key and key not in accounts:
            accounts[key] = {
                "token": raw.get("token"),
                "user": _profile(raw["user"]),
                "method": raw.get("method") or "",
                "scope": raw.get("scope") or "",
            }
            migrated = True
        if not raw.get("active"):
            raw["active"] = key
            migrated = True
        raw.pop("token", None)
        raw.pop("user", None)
        raw.pop("method", None)
        raw.pop("scope", None)
        migrated = True
    raw["accounts"] = accounts
    active = str(raw.get("active") or "")
    if active not in accounts:
        raw["active"] = next(iter(accounts), "")
        migrated = True
    if migrated:
        store.set_setting("github", raw)
    return raw


def _write(store, data: dict[str, Any]) -> dict[str, Any]:
    store.set_setting("github", data)
    return public_github(store)


def public_github(store) -> dict[str, Any]:
    data = _load(store)
    accounts = data.get("accounts") or {}
    active_id = str(data.get("active") or "")
    active = accounts.get(active_id) if isinstance(accounts.get(active_id), dict) else None
    listed: list[dict[str, Any]] = []
    for key, entry in accounts.items():
        user = _public_user(entry if isinstance(entry, dict) else None)
        if not user:
            continue
        listed.append({**user, "account_id": str(key), "active": str(key) == active_id})
    user = _public_user(active)
    token = str((active or {}).get("token") or "")
    return {
        "client_id": str(data.get("client_id") or ""),
        "signed_in": bool(token and user),
        "has_token": bool(token),
        "user": user,
        "scope": str((active or {}).get("scope") or ""),
        "method": str((active or {}).get("method") or ""),
        "active_id": active_id,
        "accounts": listed,
    }


def get_token(store) -> str:
    data = _load(store)
    accounts = data.get("accounts") or {}
    active = accounts.get(str(data.get("active") or ""))
    if not isinstance(active, dict):
        return ""
    return str(active.get("token") or "")


def plugin_identity(store) -> dict[str, Any]:
    """Public GitHub identity for plugin ctx. Never includes the token."""
    pub = public_github(store)
    user = pub.get("user") if isinstance(pub.get("user"), dict) else {}
    return {
        "github_signed_in": bool(pub.get("signed_in")),
        "github_login": str((user or {}).get("login") or ""),
        "github_name": str((user or {}).get("name") or ""),
        "github_html_url": str((user or {}).get("html_url") or ""),
        "github_avatar_url": str((user or {}).get("avatar_url") or ""),
        "github_scope": str(pub.get("scope") or ""),
    }


def save_client_id(store, client_id: str) -> dict[str, Any]:
    data = _load(store)
    data["client_id"] = str(client_id or "").strip()
    return _write(store, data)


def _save_session(store, token: str, user: dict[str, Any], method: str, scope: str = "") -> dict[str, Any]:
    data = _load(store)
    profile = _profile(user)
    key = _key(profile)
    if not key:
        raise RuntimeError("GitHub did not return a user profile.")
    accounts = data.get("accounts") if isinstance(data.get("accounts"), dict) else {}
    accounts[key] = {"token": token, "user": profile, "method": method, "scope": scope}
    data["accounts"] = accounts
    data["active"] = key
    return _write(store, data)


def fetch_user(token: str) -> dict[str, Any]:
    with httpx.Client(timeout=20.0) as client:
        res = client.get(USER_URL, headers=_api_headers(token))
    if res.status_code == 401:
        raise RuntimeError("GitHub token rejected. Sign in again.")
    if res.status_code >= 400:
        raise RuntimeError(f"GitHub user lookup failed (HTTP {res.status_code})")
    data = res.json()
    if not isinstance(data, dict) or not data.get("login"):
        raise RuntimeError("GitHub did not return a user profile.")
    return data


def sign_in_token(store, token: str) -> dict[str, Any]:
    token = (token or "").strip()
    if not token:
        raise ValueError("Paste a GitHub personal access token.")
    user = fetch_user(token)
    return _save_session(store, token, user, "pat")


def switch_account(store, account_id: str) -> dict[str, Any]:
    data = _load(store)
    accounts = data.get("accounts") or {}
    target = str(account_id or "").strip()
    if target not in accounts:
        for key, entry in accounts.items():
            user = (entry or {}).get("user") if isinstance(entry, dict) else {}
            if not isinstance(user, dict):
                continue
            if str(user.get("login") or "") == target or str(user.get("id") or "") == target:
                target = str(key)
                break
        else:
            raise ValueError("That GitHub account is not saved on this machine.")
    data["active"] = target
    return _write(store, data)


def sign_out(store, account_id: str | None = None) -> dict[str, Any]:
    data = _load(store)
    accounts = dict(data.get("accounts") or {})
    target = str(account_id or data.get("active") or "").strip()
    if target:
        accounts.pop(target, None)
        drop: list[str] = []
        for key, entry in accounts.items():
            user = (entry or {}).get("user") if isinstance(entry, dict) else {}
            if isinstance(user, dict) and (str(user.get("login") or "") == target or str(user.get("id") or "") == target):
                drop.append(key)
        for key in drop:
            accounts.pop(key, None)
    data["accounts"] = accounts
    if str(data.get("active") or "") not in accounts:
        data["active"] = next(iter(accounts), "")
    return _write(store, data)


def start_device(store, scope: str = DEFAULT_SCOPE) -> dict[str, Any]:
    data = _load(store)
    client_id = str(data.get("client_id") or "").strip()
    if not client_id:
        raise RuntimeError(
            "Set a GitHub OAuth Client ID in Settings (GitHub → Developer settings → OAuth Apps → enable Device Flow), "
            "or sign in with a personal access token."
        )
    with httpx.Client(timeout=20.0) as client:
        res = client.post(
            DEVICE_CODE_URL,
            data={"client_id": client_id, "scope": scope or DEFAULT_SCOPE},
            headers=_headers_json(),
        )
    body = res.json() if res.content else {}
    if res.status_code >= 400 or body.get("error"):
        raise RuntimeError(body.get("error_description") or body.get("error") or f"GitHub device start failed (HTTP {res.status_code})")
    device_id = uuid.uuid4().hex
    interval = int(body.get("interval") or 5)
    expires_in = int(body.get("expires_in") or 900)
    _PENDING[device_id] = {
        "device_code": body.get("device_code"),
        "client_id": client_id,
        "scope": scope or DEFAULT_SCOPE,
        "interval": interval,
        "expires_at": time.time() + expires_in,
    }
    return {
        "device_id": device_id,
        "user_code": body.get("user_code"),
        "verification_uri": body.get("verification_uri") or "https://github.com/login/device",
        "verification_uri_complete": body.get("verification_uri_complete") or "",
        "interval": interval,
        "expires_in": expires_in,
    }


def poll_device(store, device_id: str) -> dict[str, Any]:
    pending = _PENDING.get(device_id)
    if not pending:
        return {"status": "expired", "message": "Sign-in session not found. Start again."}
    if time.time() > float(pending.get("expires_at") or 0):
        _PENDING.pop(device_id, None)
        return {"status": "expired", "message": "Code expired. Start again."}
    with httpx.Client(timeout=20.0) as client:
        res = client.post(
            TOKEN_URL,
            data={
                "client_id": pending["client_id"],
                "device_code": pending["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers=_headers_json(),
        )
    body = res.json() if res.content else {}
    err = str(body.get("error") or "")
    if err == "authorization_pending":
        return {"status": "pending"}
    if err == "slow_down":
        return {"status": "pending", "interval": int(pending.get("interval") or 5) + 5}
    if err in {"expired_token", "access_denied"}:
        _PENDING.pop(device_id, None)
        return {"status": "denied" if err == "access_denied" else "expired", "message": body.get("error_description") or err}
    if body.get("access_token"):
        token = str(body["access_token"])
        user = fetch_user(token)
        _PENDING.pop(device_id, None)
        public = _save_session(store, token, user, "device", str(body.get("scope") or pending.get("scope") or ""))
        return {"status": "ok", "github": public}
    if res.status_code >= 400:
        return {"status": "error", "message": body.get("error_description") or body.get("error") or f"HTTP {res.status_code}"}
    return {"status": "pending"}
