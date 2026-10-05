#!/usr/bin/env python3
"""GIT_ASKPASS / git-credential helper for DataRefine Studio.

Reads the active GitHub token from the local settings database.
Never prints the token unless Git asked for a password.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path


def _root() -> Path:
    env = (os.environ.get("DATAREFINE_DATA") or os.environ.get("DATAREFINE_ROOT") or "").strip()
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    return Path(__file__).resolve().parents[2]


def _account() -> tuple[str, str]:
    db = _root() / "config" / "datarefine.db"
    if not db.is_file():
        return "", ""
    try:
        uri = db.resolve().as_uri()
        conn = sqlite3.connect(uri + "?mode=ro", uri=True)
    except Exception:
        try:
            conn = sqlite3.connect(str(db))
        except Exception:
            return "", ""
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", ("github",)).fetchone()
    finally:
        conn.close()
    if not row:
        return "", ""
    try:
        data = json.loads(row[0])
    except Exception:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    accounts = data.get("accounts") if isinstance(data.get("accounts"), dict) else {}
    active = accounts.get(str(data.get("active") or ""))
    if not isinstance(active, dict):
        return "", ""
    user = active.get("user") if isinstance(active.get("user"), dict) else {}
    token = str(active.get("token") or "").strip()
    login = str(user.get("login") or "").strip()
    return token, login


def _credential(op: str) -> None:
    if op != "get":
        return
    host = ""
    protocol = ""
    try:
        body = sys.stdin.read()
    except Exception:
        body = ""
    for line in (body or "").splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k == "host":
            host = v.strip().lower()
        elif k == "protocol":
            protocol = v.strip().lower()
    if protocol and protocol not in {"https", "http"}:
        return
    if host not in {"github.com", "www.github.com"} and not host.endswith(".github.com"):
        return
    token, login = _account()
    if not token:
        return
    sys.stdout.write(f"username={login or 'x-access-token'}\npassword={token}\n")


def main() -> None:
    args = sys.argv[1:]
    if args and args[0] in {"get", "store", "erase"}:
        _credential(args[0])
        return
    prompt = " ".join(args).lower()
    token, login = _account()
    if "username" in prompt:
        sys.stdout.write(login or "x-access-token")
        return
    sys.stdout.write(token)


if __name__ == "__main__":
    main()
