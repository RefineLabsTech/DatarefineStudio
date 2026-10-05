#!/usr/bin/env python3
"""DataRefine Studio sidecar — bind /health first, heavy wheels in the background."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(os.environ.get("DATAREFINE_ROOT") or Path(__file__).resolve().parents[1]).resolve()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.paths import DATA_ROOT, ensure_data_layout  # noqa: E402

CORE = ["fastapi", "uvicorn[standard]", "python-multipart", "pydantic"]


def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def _pip(pkgs: list[str]) -> None:
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *pkgs]
    # The desktop shell has no console. Keep pip from briefly opening a
    # separate Windows console window while first-run packages are installed.
    hidden = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        subprocess.check_call(cmd, **hidden)
    except subprocess.CalledProcessError:
        print("[DataRefine] Retrying pip with --user …", flush=True)
        subprocess.check_call(cmd + ["--user"], **hidden)


def ensure_core() -> None:
    if _has("uvicorn") and _has("fastapi"):
        return
    if getattr(sys, "frozen", False):
        raise SystemExit("The bundled DataRefine engine is incomplete: FastAPI/Uvicorn is missing.")
    print(f"[DataRefine] Installing FastAPI with {sys.executable} ({sys.version.split()[0]}) …", flush=True)
    try:
        _pip(CORE)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            f"Could not install FastAPI/uvicorn.\n"
            f"Interpreter: {sys.executable} ({sys.version.split()[0]})\n"
            f"Install Python 3.11–3.14, then:\n"
            f"  py -3.12 -m pip install -r \"{ROOT / 'requirements.txt'}\"\n"
            f"({exc})"
        ) from exc
    if not (_has("uvicorn") and _has("fastapi")):
        raise SystemExit(
            f"FastAPI still missing for {sys.executable}.\n"
            f"Use Python 3.11–3.14, preferably 3.12, then:\n"
            f"  py -3.12 -m pip install -r \"{ROOT / 'requirements.txt'}\""
        )


def install_rest() -> None:
    req = ROOT / "requirements.txt"
    if _has("polars") and _has("duckdb") and _has("pyarrow"):
        return
    if getattr(sys, "frozen", False):
        raise SystemExit("The bundled DataRefine engine is incomplete: Polars, DuckDB, or PyArrow is missing.")
    if not req.is_file():
        return
    print("[DataRefine] Installing engine packages in the background …", flush=True)
    try:
        _pip(["-r", str(req)])
        print("[DataRefine] Engine packages ready.", flush=True)
    except Exception as exc:
        print(
            f"[DataRefine] Background pip failed ({exc}). "
            f"If this is Python 3.14, install 3.12 and run: py -3.12 -m pip install -r \"{req}\"",
            flush=True,
        )


def pick_port(preferred: int) -> int:
    def free(p: int) -> bool:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p))
            return True
        except OSError:
            return False
        finally:
            s.close()

    if preferred and free(preferred):
        return preferred
    for p in range(17831, 17841):
        if free(p):
            return p
    return preferred or 17831


def _plugin_runner() -> None:
    """Execute a trusted-plugin payload in the frozen engine's interpreter.

    A PyInstaller executable cannot interpret ``python -c`` like a normal
    interpreter. The desktop engine therefore re-enters itself in this small
    worker mode, retaining the existing temp-Parquet isolation for trusted
    plugins without requiring a customer Python installation.
    """
    source = sys.stdin.read()
    exec(compile(source, "<datarefine-trusted-plugin>", "exec"), {"__name__": "__main__"}, None)  # noqa: S102


def main() -> None:
    if "--datarefine-askpass" in sys.argv[1:]:
        from sidecar.auth.git_askpass import main as askpass_main

        askpass_main()
        return
    if "--datarefine-plugin-runner" in sys.argv[1:]:
        _plugin_runner()
        return
    ver = sys.version_info
    print(f"[DataRefine] {sys.executable}  Python {ver.major}.{ver.minor}.{ver.micro}", flush=True)
    if ver.major == 3 and ver.minor >= 14:
        print("[DataRefine] Python 3.14 detected; prefer 3.12 if a dependency wheel is unavailable.", flush=True)
    ensure_core()
    if getattr(sys, "frozen", False):
        # Fail before binding the port if a required native dependency was
        # accidentally omitted from the one-file build. Never run pip here.
        install_rest()
    else:
        threading.Thread(target=install_rest, name="drs-pip", daemon=True).start()

    import uvicorn  # noqa: WPS433 — imported after bootstrap

    preferred = int(os.environ.get("DATAREFINE_PORT", "17831") or "17831")
    port = pick_port(preferred)
    os.environ["DATAREFINE_PORT"] = str(port)
    try:
        ensure_data_layout()
        (DATA_ROOT / "config" / "engine-port.txt").write_text(str(port), encoding="utf-8")
    except OSError:
        pass
    print(f"[DataRefine] engine http://127.0.0.1:{port}/health", flush=True)
    uvicorn.run(
        "sidecar.api.server:app",
        host="127.0.0.1",
        port=port,
        log_level="warning",
        reload=False,
        lifespan="on",
    )


if __name__ == "__main__":
    main()
