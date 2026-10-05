"""Stage 3 — JavaScript transforms via Node (V8) in row batches.

`require()` loads packages from libraries/node_modules (npm install --prefix libraries).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import polars as pl

from sidecar.paths import DATA_ROOT, RESOURCE_ROOT

ROOT = RESOURCE_ROOT
USER_ROOT = DATA_ROOT

WORKER = r"""
const fs = require('fs');
const path = require('path');
const Module = require('module');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = process.env.DATAREFINE_DATA || process.env.DATAREFINE_ROOT || process.cwd();
const libDir = path.join(root, 'libraries');
const userRequire = Module.createRequire(path.join(libDir, 'package.json'));
function req(id) {
  try {
    return userRequire(id);
  } catch (first) {
    const m = new Module(path.join(libDir, 'shim.js'));
    m.filename = path.join(libDir, 'shim.js');
    m.paths = Module._nodeModulePaths(libDir).concat(Module._nodeModulePaths(root));
    try {
      return m.require(id);
    } catch (second) {
      const err = new Error(
        (second && second.message) || String(second) +
        '\nInstall in Terminal: npm install --prefix libraries ' + String(id)
      );
      throw err;
    }
  }
}
const rows = input.rows;
const columns = input.columns;
const code = input.code;
const fn = new Function('row', 'rows', 'columns', 'require', 'module', 'exports', code + '\n;return row;');
const out = rows.map((row) => {
  const rec = {};
  columns.forEach((c, i) => rec[c] = row[i]);
  const result = fn(rec, rows, columns, req, { exports: {} }, {}) || rec;
  return columns.map((c) => (result[c] === undefined ? rec[c] : result[c]));
});
process.stdout.write(JSON.stringify({ rows: out }));
"""


def run_javascript(df: pl.DataFrame, code: str, batch: int = 5000) -> tuple[pl.DataFrame, dict[str, Any]]:
    code = (code or "").strip()
    if not code:
        raise ValueError("JavaScript is empty.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for the JavaScript engine (V8).")
    lib = USER_ROOT / "libraries"
    try:
        lib.mkdir(parents=True, exist_ok=True)
        pkg = lib / "package.json"
        if not pkg.is_file():
            pkg.write_text(
                '{"name":"datarefine-user-libs","private":true}\n',
                encoding="utf-8",
            )
    except OSError:
        pass
    t0 = time.perf_counter()
    columns = df.columns
    chunks: list[pl.DataFrame] = []
    n = df.height
    script = Path(tempfile.gettempdir()) / "datarefine_js_worker.js"
    script.write_text(WORKER, encoding="utf-8")
    env = os.environ.copy()
    env["DATAREFINE_ROOT"] = str(ROOT)
    env["DATAREFINE_DATA"] = str(USER_ROOT)
    env["NODE_PATH"] = str(lib / "node_modules")
    for start in range(0, max(n, 1), batch):
        part = df.slice(start, batch)
        payload = {
            "columns": columns,
            "code": code,
            "rows": [[_js_cell(v) for v in rec] for rec in part.iter_rows()] if part.height else [],
        }
        proc = subprocess.run(
            [node, str(script)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
            cwd=str(USER_ROOT),
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr[-2000:] or "JavaScript worker failed.")
        body = json.loads(proc.stdout or "{}")
        rows = body.get("rows") or []
        if rows:
            chunks.append(pl.DataFrame({c: [r[i] for r in rows] for i, c in enumerate(columns)}))
        elif part.height == 0:
            chunks.append(part)
    out = pl.concat(chunks) if chunks else df
    runtime = (time.perf_counter() - t0) * 1000
    return out, {
        "runtime_ms": round(runtime, 2),
        "rows": out.height,
        "columns": out.width,
        "engine": "v8",
    }


def _js_cell(v: Any):
    if v is None:
        return None
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)
