"""Run plugin Python: sandboxed by default, subprocess+Parquet when Trusted."""

from __future__ import annotations

import io
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

import polars as pl

from sidecar.paths import DATA_ROOT, RESOURCE_ROOT
from sidecar.plugins.loader import enabled_plugins, get_plugin

SAFE_BUILTINS = {
    "abs": abs,
    "min": min,
    "max": max,
    "sum": sum,
    "len": len,
    "range": range,
    "enumerate": enumerate,
    "zip": zip,
    "list": list,
    "dict": dict,
    "set": set,
    "tuple": tuple,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "round": round,
    "sorted": sorted,
    "print": print,
    "isinstance": isinstance,
    "type": type,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "True": True,
    "False": False,
    "None": None,
}


def _np():
    try:
        import numpy as np

        return np
    except Exception:
        return None


def _split_ref(ref: str) -> tuple[str, str]:
    ref = (ref or "").strip()
    if ":" in ref:
        a, b = ref.split(":", 1)
        return a.strip(), b.strip()
    if "." in ref and not ref.endswith(".py"):
        a, b = ref.rsplit(".", 1)
        return a.strip(), b.strip()
    return ref, ""


def _py_path(folder: Path, rel: str) -> Path:
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if rel and not rel.endswith(".py"):
        rel = f"{rel}.py"
    if not rel:
        raise ValueError("Missing python file")
    path = (folder / rel).resolve()
    root = folder.resolve()
    if root not in path.parents and path != root:
        raise ValueError("Plugin path escapes plugin folder")
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


def _sandbox_call(py_file: Path, func: str, df: pl.DataFrame, ctx: dict) -> Any:
    src = py_file.read_text(encoding="utf-8")
    env: dict[str, Any] = {
        "__builtins__": SAFE_BUILTINS,
        "__name__": "plugin",
        "pl": pl,
        "polars": pl,
        "df": df,
        "data": df,
        "ctx": ctx,
        "np": _np(),
        "re": re,
        "json": json,
        "math": math,
        "io": io,
        "unicodedata": unicodedata,
    }
    exec(compile(src, str(py_file), "exec"), env, env)  # noqa: S102
    fn = env.get(func)
    if not callable(fn):
        raise KeyError(f"Plugin has no function {func}")
    return fn(df, ctx)


def _trusted_env(store) -> dict[str, str]:
    root = RESOURCE_ROOT
    env = {k: str(v) for k, v in os.environ.items() if v is not None}
    env["DATAREFINE_ROOT"] = str(root)
    env["DATAREFINE_DATA"] = str(DATA_ROOT)
    if getattr(sys, "frozen", False):
        env["DATAREFINE_ENGINE"] = sys.executable
    else:
        env["DATAREFINE_PYTHON"] = sys.executable
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    if os.name == "nt":
        ask = root / "auth" / "git_askpass.cmd"
        if not ask.is_file():
            ask = root / "sidecar" / "auth" / "git_askpass.cmd"
    else:
        ask = root / "auth" / "git_askpass.py"
        if not ask.is_file():
            ask = root / "sidecar" / "auth" / "git_askpass.py"
    if ask.is_file():
        env["GIT_ASKPASS"] = str(ask)
    if not env.get("DISPLAY"):
        env["DISPLAY"] = ":0"
    if store is not None:
        try:
            from sidecar.auth.github import get_token, public_github

            tok = get_token(store)
            pub = public_github(store)
            user = pub.get("user") if isinstance(pub.get("user"), dict) else {}
            login = str((user or {}).get("login") or "x-access-token")
            if tok:
                env["DATAREFINE_GH_TOKEN"] = tok
                env["DATAREFINE_GH_USER"] = login
        except Exception:
            pass
    return env


def plugin_failure(plugin_id: str, command_id: str, exc: Exception) -> dict[str, Any]:
    """Normalize a plugin exception without exposing a runner traceback."""
    raw = str(exc).strip() or exc.__class__.__name__
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    candidates = [
        line
        for line in lines
        if not line.startswith("Traceback")
        and not line.startswith("File ")
        and not line.startswith("[PYI-")
    ]
    detail = candidates[-1] if candidates else raw[-500:]
    for prefix in ("ValueError: ", "RuntimeError: ", "TypeError: ", "OSError: "):
        if detail.startswith(prefix):
            detail = detail[len(prefix) :]
            break
    lower = raw.lower()
    if "getaddrinfo failed" in lower or "unable to resolve the api hostname" in lower or "name or service not known" in lower:
        kind = "network_error"
        message = "Unable to resolve the API hostname. Check the API URL, domain, network connection, DNS, and API server."
    elif "timed out" in lower or "timeout" in lower:
        kind = "timeout_error"
        message = "The API request timed out. Check the API server and your network connection."
    elif "open a dataset first" in lower:
        kind = "usage_error"
        message = "Open a dataset before running this plugin action."
    elif "api request failed with http" in lower:
        kind = "http_error"
        message = detail
    else:
        kind = "plugin_error"
        message = "Plugin command failed."
    return {
        "ok": False,
        "pluginId": plugin_id,
        "commandId": command_id,
        "error": {"type": kind, "message": message, "details": detail},
    }


def call_python_ref_safe(store, plugin_id: str, ref: str, df: pl.DataFrame, ctx: dict, command_id: str = "") -> dict[str, Any]:
    """Trusted command boundary: preserve success, contain plugin failures."""
    try:
        return {"ok": True, "result": call_python_ref(store, plugin_id, ref, df, ctx)}
    except Exception as exc:
        return plugin_failure(plugin_id, command_id, exc)


def _trusted_call(py_file: Path, func: str, df: pl.DataFrame, ctx: dict, store=None) -> Any:
    tmp = Path(tempfile.mkdtemp(prefix="drs-plug-"))
    src_pq = tmp / "in.parquet"
    dst_pq = tmp / "out.parquet"
    dst_txt = tmp / "out.txt"
    dst_bin = tmp / "out.bin"
    ctx_js = tmp / "ctx.json"
    kind_p = tmp / "kind.txt"
    df.write_parquet(src_pq)
    safe_ctx = {k: v for k, v in (ctx or {}).items() if not str(k).lower().endswith("token")}
    ctx_js.write_text(json.dumps(safe_ctx, default=str), encoding="utf-8")
    runner = (
        "import json, polars as pl, importlib.util\n"
        "from pathlib import Path\n"
        f"spec = importlib.util.spec_from_file_location('plugin', {str(py_file)!r})\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(mod)\n"
        f"df = pl.read_parquet({str(src_pq)!r})\n"
        f"ctx = json.loads(Path({str(ctx_js)!r}).read_text(encoding='utf-8'))\n"
        f"out = getattr(mod, {func!r})(df, ctx)\n"
        "if out is None:\n"
        "    out = df\n"
        "if isinstance(out, pl.DataFrame):\n"
        f"    out.write_parquet({str(dst_pq)!r})\n"
        f"    Path({str(kind_p)!r}).write_text('df')\n"
        "elif isinstance(out, bytes):\n"
        f"    Path({str(dst_bin)!r}).write_bytes(out)\n"
        f"    Path({str(kind_p)!r}).write_text('bytes')\n"
        "else:\n"
        f"    Path({str(dst_txt)!r}).write_text(str(out), encoding='utf-8')\n"
        f"    Path({str(kind_p)!r}).write_text('text')\n"
    )
    try:
        frozen_command = getattr(sys, "frozen", False)
        command = [sys.executable, "--datarefine-plugin-runner"] if frozen_command else [sys.executable, "-c", runner]
        proc = subprocess.run(
            command,
            input=runner if frozen_command else None,
            cwd=str(py_file.parent),
            capture_output=True,
            text=True,
            timeout=180,
            env=_trusted_env(store),
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "plugin failed")[-2000:])
        kind = kind_p.read_text(encoding="utf-8") if kind_p.exists() else "df"
        if kind == "text":
            return dst_txt.read_text(encoding="utf-8") if dst_txt.exists() else ""
        if kind == "bytes":
            return dst_bin.read_bytes() if dst_bin.exists() else b""
        if not dst_pq.exists():
            raise RuntimeError("Plugin did not write a frame")
        return pl.read_parquet(dst_pq)
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)


def call_python_ref(store, plugin_id: str, ref: str, df: pl.DataFrame, ctx: dict) -> Any:
    rec = get_plugin(store, plugin_id)
    if not rec.get("enabled"):
        raise KeyError("Plugin disabled")
    file_rel, func = _split_ref(ref)
    if not func:
        func = "run"
    path = _py_path(Path(rec["source"]), file_rel)
    payload = {"session_id": ctx.get("session_id"), "plugin_id": plugin_id, **(ctx or {})}
    if rec.get("trusted") and rec.get("permissions"):
        return _trusted_call(path, func, df, payload, store)
    return _sandbox_call(path, func, df, payload)


def _as_frame(out: Any, df: pl.DataFrame) -> pl.DataFrame:
    if out is None:
        return df
    if isinstance(out, pl.DataFrame):
        return out
    raise TypeError("Plugin must return a Polars DataFrame")


def run_python_ref(store, plugin_id: str, ref: str, df: pl.DataFrame, ctx: dict) -> pl.DataFrame:
    return _as_frame(call_python_ref(store, plugin_id, ref, df, ctx), df)


def apply_hooks(store, hook: str, df: pl.DataFrame, ctx: dict) -> tuple[pl.DataFrame, list[str]]:
    notes: list[str] = []
    out = df
    for rec in enabled_plugins(store):
        hooks = (rec.get("contributes") or {}).get("hooks") or {}
        ref = hooks.get(hook)
        if not ref:
            continue
        try:
            nxt = run_python_ref(store, rec["id"], str(ref), out, {**ctx, "hook": hook})
            out = nxt
            notes.append(f"{rec['id']} {hook}")
        except Exception as exc:
            notes.append(f"{rec['id']} {hook} failed: {exc}")
    return out, notes


def try_ingest(store, path: str, n_rows: int | None) -> pl.DataFrame | None:
    ext = Path(path).suffix.lower()
    text = ""
    try:
        p = Path(path)
        if p.is_file() and p.stat().st_size <= 8 * 1024 * 1024:
            text = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        text = ""
    for rec in enabled_plugins(store):
        for ing in (rec.get("contributes") or {}).get("ingest") or []:
            if not isinstance(ing, dict):
                continue
            exts = []
            for x in ing.get("extensions") or []:
                s = str(x).lower()
                exts.append(s if s.startswith(".") else f".{s}")
            if ext not in exts:
                continue
            ref = ing.get("python") or ing.get("function") or ""
            fn = ing.get("function") or "load"
            if ":" not in str(ref) and ing.get("python"):
                ref = f"{ing.get('python')}:{fn}"
            try:
                dummy = pl.DataFrame()
                out = call_python_ref(
                    store,
                    rec["id"],
                    str(ref),
                    dummy,
                    {"path": path, "n_rows": n_rows, "text": text, "ext": ext},
                )
                if isinstance(out, pl.DataFrame) and out.width:
                    return out.head(n_rows) if n_rows and n_rows > 0 else out
                if isinstance(out, pl.DataFrame):
                    return out
            except Exception:
                continue
    return None


def find_exporter(store, fmt: str) -> dict | None:
    fmt = (fmt or "").lower().lstrip(".")
    for rec in enabled_plugins(store):
        for ex in (rec.get("contributes") or {}).get("exporters") or []:
            if not isinstance(ex, dict):
                continue
            ident = str(ex.get("id") or "").lower()
            ext = str(ex.get("ext") or "").lower().lstrip(".")
            if fmt in {ident, ext}:
                return {**ex, "extension_id": rec["id"]}
    return None


def run_exporter(store, hit: dict, df: pl.DataFrame, dest: str, options: dict) -> str:
    pid = hit.get("extension_id")
    ref = hit.get("python") or ""
    fn = hit.get("function") or "export"
    if ":" not in str(ref):
        ref = f"{ref}:{fn}"
    path = Path(dest)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = call_python_ref(
        store,
        str(pid),
        str(ref),
        df,
        {"dest": dest, "options": options or {}, "fmt": hit.get("ext") or hit.get("id")},
    )
    if isinstance(out, str):
        path.write_text(out, encoding="utf-8")
    elif isinstance(out, (bytes, bytearray)):
        path.write_bytes(bytes(out))
    elif isinstance(out, pl.DataFrame):
        from sidecar.exporters.export import export_frame

        export_frame(out, str(hit.get("ext") or "csv"), dest, options or {})
    elif out is None and not path.exists():
        raise RuntimeError("Plugin exporter returned nothing")
    return dest


def run_command_python(store, plugin_id: str, cmd: dict, df: pl.DataFrame, ctx: dict) -> pl.DataFrame:
    ref = cmd.get("python") or ""
    fn = cmd.get("function") or "run"
    if ":" not in str(ref):
        ref = f"{ref}:{fn}"
    return run_python_ref(store, plugin_id, str(ref), df, ctx)


def list_exporters(store) -> list[dict]:
    from sidecar.plugins.loader import contributed_ui

    return contributed_ui(store).get("exporters") or []
