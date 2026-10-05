"""Stage 4 — Polars / PyArrow / NumPy. Any package installed for this interpreter is importable."""

from __future__ import annotations

import builtins as py_builtins
import io
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from sidecar.paths import DATA_ROOT

USER_PY = DATA_ROOT / "libraries" / "python"


def _is_effective(code: str) -> bool:
    for ln in (code or "").splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            return True
    return False


def _engine():
    try:
        import polars as pl
    except ImportError as exc:
        raise RuntimeError(
            "Polars is not installed for this Python.\n"
            "Windows (Python 3.11–3.14; prefer 3.12 if a wheel is unavailable):\n"
            "  py -3.12 -m pip install -r requirements.txt\n"
            "  py -3.11 -m pip install -r requirements.txt\n"
            f"({exc})"
        ) from exc
    try:
        import numpy as np
    except ImportError:
        np = None
    try:
        import pyarrow as pa
    except ImportError:
        pa = None
    return pl, np, pa


def _ensure_user_path() -> None:
    try:
        USER_PY.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    loc = str(USER_PY)
    if loc not in sys.path:
        sys.path.insert(0, loc)


def _import_hint(exc: BaseException) -> str:
    name = getattr(exc, "name", None) or ""
    if not name:
        msg = str(exc)
        if "No module named" in msg:
            name = msg.rsplit(" ", 1)[-1].strip(" '\"")
    if not name:
        return ""
    return (
        f"\n\nPackage {name!r} is not installed for this engine.\n"
        f"In Terminal (same interpreter):\n"
        f"  pip install {name}\n"
        f"Interpreter: {sys.executable}\n"
        f"User target (optional): pip install --target libraries/python {name}"
    )


def run_python(df: Any, code: str, columns: list[str] | None = None) -> tuple[Any, dict[str, Any]]:
    code = (code or "").strip()
    if not code or not _is_effective(code):
        raise ValueError(
            "Python stage has no code to run. Uncomment the example or write Polars that assigns back to `df`."
        )
    _ensure_user_path()
    pl, np, pa = _engine()
    t0 = time.perf_counter()
    printed: list[str] = []

    def _print(*args: Any, **kwargs: Any) -> None:
        buf = io.StringIO()
        kwargs = dict(kwargs)
        kwargs["file"] = buf
        py_builtins.print(*args, **kwargs)
        text = buf.getvalue().rstrip("\n")
        if text:
            printed.append(text)

    def _no_input(*_a: Any, **_k: Any) -> str:
        raise RuntimeError("input() is disabled in the Python stage (it would freeze the engine).")

    def _no_exit(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("exit()/quit() is disabled in the Python stage.")

    ns = {k: getattr(py_builtins, k) for k in dir(py_builtins) if not k.startswith("_")}
    ns["print"] = _print
    ns["input"] = _no_input
    ns["exit"] = _no_exit
    ns["quit"] = _no_exit
    ns["__import__"] = py_builtins.__import__
    ns["open"] = py_builtins.open
    ns["exec"] = py_builtins.exec
    ns["eval"] = py_builtins.eval
    ns["compile"] = py_builtins.compile

    env: dict[str, Any] = {
        "__builtins__": ns,
        "__name__": "__datarefine__",
        "__import__": py_builtins.__import__,
        "pl": pl,
        "polars": pl,
        "df": df,
        "data": df,
        "sys": sys,
        "columns": [c for c in (columns or []) if c in getattr(df, "columns", [])] or list(getattr(df, "columns", [])),
    }
    if np is not None:
        env["np"] = np
        env["numpy"] = np
    if pa is not None:
        env["pa"] = pa
        env["pyarrow"] = pa
    for mod in ("datetime", "re", "json", "math", "collections", "itertools", "functools", "decimal", "unicodedata"):
        try:
            env[mod] = __import__(mod)
        except Exception:
            pass
    try:
        import rapidfuzz
        from rapidfuzz import fuzz, process

        env["rapidfuzz"] = rapidfuzz
        env["fuzz"] = fuzz
        env["process"] = process
    except Exception:
        pass

    try:
        exec(compile(code, "<python-stage>", "exec"), env, env)  # noqa: S102
        out = env.get("df", df)
        if not isinstance(out, pl.DataFrame):
            if pa is not None and isinstance(out, pa.Table):
                out = pl.from_arrow(out)
            else:
                raise TypeError("Python stage must assign a Polars DataFrame to `df`.")
        runtime = (time.perf_counter() - t0) * 1000
        return out, {
            "runtime_ms": round(runtime, 2),
            "rows": out.height,
            "columns": out.width,
            "engine": "polars",
            "prints": printed,
            "python": sys.executable,
        }
    except ImportError as exc:
        raise RuntimeError(f"{exc}{_import_hint(exc)}\n\n{traceback.format_exc()}") from exc
    except Exception as exc:
        extra = _import_hint(exc) if isinstance(exc, ModuleNotFoundError) else ""
        raise RuntimeError(f"{exc}{extra}\n\n{traceback.format_exc()}") from exc
