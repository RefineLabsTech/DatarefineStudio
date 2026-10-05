#!/usr/bin/env node
/** Start the Python engine — prefer 3.11–3.14, skip Windows Store stubs, keep /health fast. */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataRoot = path.resolve(process.env.DATAREFINE_DATA || root);
const script = path.join(root, "sidecar", "main.py");
const cacheFile = path.join(dataRoot, "config", "python-cmd.txt");

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 200 }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

function isStub(p) {
  return /\\windowsapps\\/i.test(String(p || "").replace(/\//g, "\\"));
}

function probe(cmd, extra) {
  try {
    const r = spawnSync(cmd, [...extra, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}')"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      cwd: root,
    });
    if (r.error && r.error.code === "ENOENT") return null;
    if (r.status !== 0) return null;
    const line = String(r.stdout || "").trim().split(/\r?\n/).pop() || "";
    const [ver, exe] = line.split("|");
    const minor = Number((ver || "").split(".")[1]);
    const major = Number((ver || "").split(".")[0]);
    if (major !== 3 || !exe || isStub(exe) || isStub(cmd)) return null;
    return { minor, exe: exe.trim() };
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const lines = fs.readFileSync(cacheFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    return [lines[0], lines.slice(1)];
  } catch {
    return null;
  }
}

function writeCache(cmd, extra) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, [cmd, ...extra].join("\n"));
  } catch {
    /* ignore */
  }
}

function py0p() {
  const launchers = [];
  if (process.env.SystemRoot) {
    launchers.push(path.join(process.env.SystemRoot, "py.exe"));
    launchers.push(path.join(process.env.SystemRoot, "System32", "py.exe"));
  }
  launchers.push("py");
  const out = [];
  for (const bin of launchers) {
    try {
      const r = spawnSync(bin, ["-0p"], { encoding: "utf8", timeout: 2500, windowsHide: true });
      if (r.status !== 0) continue;
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const tok = line.split(/\s+/).find((t) => /python/i.test(t) && (t.includes("\\") || t.includes("/")));
        if (tok && !isStub(tok)) out.push(tok.replace(/"/g, ""));
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

function diskPythons() {
  const vers = ["Python312", "Python311", "Python313", "Python314", "Python3.12", "Python3.11", "Python3.13", "Python3.14"];
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, "AppData", "Local", "Programs", "Python"));
  }
  if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles);
  const out = [];
  for (const ver of vers) {
    for (const r of roots) out.push(path.join(r, ver, "python.exe"));
    out.push(`C:\\${ver}\\python.exe`);
  }
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python");
  if (local && fs.existsSync(local)) {
    try {
      for (const name of fs.readdirSync(local)) {
        out.push(path.join(local, name, "python.exe"));
      }
    } catch {
      /* ignore */
    }
  }
  return out.filter((p) => {
    try {
      return fs.existsSync(p) && !isStub(p);
    } catch {
      return false;
    }
  });
}

function pick() {
  if (process.env.DATAREFINE_PYTHON) {
    const hit = probe(process.env.DATAREFINE_PYTHON, []);
    if (hit) return [hit.exe, []];
    return [process.env.DATAREFINE_PYTHON, []];
  }
  const cached = readCache();
  if (cached) {
    const hit = probe(cached[0], cached[1]);
    if (hit && hit.minor >= 11 && hit.minor <= 13) {
      writeCache(hit.exe, []);
      return [hit.exe, []];
    }
  }
  const ranked = [];
  const seen = new Set();
  const consider = (cmd, extra) => {
    const hit = probe(cmd, extra || []);
    if (!hit || hit.minor < 11 || hit.minor > 14) return;
    const key = hit.exe.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push(hit);
  };
  for (const p of [...py0p(), ...diskPythons()]) consider(p, []);
  for (const extra of [["-3.12"], ["-3.11"], ["-3.13"]]) {
    consider("py", extra);
    if (process.env.SystemRoot) consider(path.join(process.env.SystemRoot, "py.exe"), extra);
  }
  for (const bin of ["python3.12", "python3.11", "python3.13", "python3.14"]) consider(bin, []);
  ranked.sort((a, b) => {
    const order = { 12: 0, 11: 1, 13: 2, 14: 3 };
    return (order[a.minor] ?? 9) - (order[b.minor] ?? 9);
  });
  if (ranked.length) {
    writeCache(ranked[0].exe, []);
    return [ranked[0].exe, []];
  }
  for (const [cmd, extra] of [
    ["python", []],
    ["python3", []],
    ["py", ["-3"]],
  ]) {
    const hit = probe(cmd, extra);
    if (hit && hit.minor >= 11) {
      writeCache(hit.exe, []);
      return [hit.exe, []];
    }
  }
  return null;
}

async function main() {
  const preferred = Number(process.env.DATAREFINE_PORT || 17831);
  if (await portOpen(preferred)) {
    console.log(`[DataRefine] sidecar already on :${preferred}`);
    setInterval(() => {}, 1 << 30);
    return;
  }
  const picked = pick();
  if (!picked) {
    console.error(
      "Python 3.11–3.14 not found. Install from python.org (tick “Add python.exe to PATH”), then:\n  py -3.12 -m pip install -r requirements.txt",
    );
    process.exit(1);
  }
  const [cmd, extra] = picked;
  console.log(`[DataRefine] sidecar ${cmd} ${extra.join(" ")}`.trim());
  const child = spawn(cmd, [...extra, script], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      DATAREFINE_PORT: String(preferred),
      DATAREFINE_ROOT: process.env.DATAREFINE_ROOT || root,
      DATAREFINE_DATA: dataRoot,
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
    },
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

main();
