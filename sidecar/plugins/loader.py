"""Install / enable / unload DataRefine plugins from zip or folder."""

from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

from sidecar.paths import DATA_ROOT, RESOURCE_ROOT

ROOT = RESOURCE_ROOT
# Bundled plugins/catalogue are read-only resources. User-installed plugins and
# their enable/trust state live outside Program Files.
PLUGINS_DIR = ROOT / "plugins"
INSTALLED_DIR = DATA_ROOT / "plugins" / "installed"

MANIFEST_NAMES = ("datarefine.plugin.json", "datarefine.extension.json", "package.json")
ID_OK = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$")
PRIV = {"python.import", "python.fs", "python.network", "python.subprocess"}


def _state(store) -> dict:
    raw = store.get_setting("plugins", {}) or {}
    return raw if isinstance(raw, dict) else {}


def _save_state(store, state: dict) -> None:
    store.set_setting("plugins", state)


def _read_manifest(folder: Path) -> dict | None:
    for name in MANIFEST_NAMES:
        p = folder / name
        if p.is_file():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None
            if not isinstance(data, dict):
                return None
            if name == "package.json" and not (
                data.get("engines", {}).get("datarefine")
                or data.get("contributes")
                or data.get("datarefine")
            ):
                return None
            return data
    return None


def _plugin_id(manifest: dict, folder: Path) -> str:
    raw = str(manifest.get("name") or manifest.get("id") or folder.name).strip()
    raw = raw.replace("/", ".").replace(" ", "-")
    if not ID_OK.match(raw):
        raise ValueError(f"Invalid plugin id: {raw}")
    return raw


def _levels(contrib: dict) -> list[str]:
    levels = []
    ui_keys = ("commands", "themes", "statusBar", "snippets", "completions", "views", "menus", "ai")
    core_keys = ("hooks", "rules", "exporters", "ingest")
    if any(contrib.get(k) for k in ui_keys):
        levels.append("ui")
    if any(contrib.get(k) for k in core_keys) or any(
        isinstance(c, dict) and c.get("python") for c in (contrib.get("commands") or [])
    ):
        levels.append("core")
    return levels or ["ui"]


def _permissions(manifest: dict) -> list[str]:
    raw = manifest.get("permissions") or []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for p in raw:
        s = str(p).strip()
        if s in PRIV:
            out.append(s)
    return out


def _record(folder: Path, manifest: dict, state: dict, bundled: bool) -> dict:
    pid = _plugin_id(manifest, folder)
    st = state.get(pid) if isinstance(state.get(pid), dict) else {}
    contrib = manifest.get("contributes") or {}
    if not isinstance(contrib, dict):
        contrib = {}
    perms = _permissions(manifest)
    enabled = bool(st.get("enabled", True)) if not perms else bool(st.get("enabled", False))
    trusted = bool(st.get("trusted", False))
    display = str(manifest.get("displayName") or manifest.get("display_name") or pid)
    icon = ""
    for v in contrib.get("views") or []:
        if isinstance(v, dict) and v.get("icon"):
            icon = str(v.get("icon"))
            break
    return {
        "id": pid,
        "name": pid,
        "displayName": display,
        "icon": icon,
        "publisher": str(manifest.get("publisher") or manifest.get("author") or ""),
        "version": str(manifest.get("version") or "0.0.0"),
        "description": str(manifest.get("description") or ""),
        "enabled": enabled,
        "bundled": bundled,
        "trusted": trusted,
        "needsTrust": bool(perms) and not trusted,
        "permissions": perms,
        "source": str(folder),
        "levels": _levels(contrib),
        "contributes": contrib,
        "command_count": len(contrib.get("commands") or []),
        "hook_count": len(contrib.get("hooks") or {}),
        "rule_count": len(contrib.get("rules") or []),
    }


def iter_plugin_dirs() -> list[tuple[Path, bool]]:
    out: list[tuple[Path, bool]] = []
    if PLUGINS_DIR.is_dir():
        for child in sorted(PLUGINS_DIR.iterdir()):
            if child.name in {"installed", "__pycache__"} or not child.is_dir():
                continue
            if _read_manifest(child):
                out.append((child, True))
    if INSTALLED_DIR.is_dir():
        for child in sorted(INSTALLED_DIR.iterdir()):
            if child.is_dir() and _read_manifest(child):
                out.append((child, False))
    return out


def list_plugins(store) -> list[dict]:
    state = _state(store)
    rows = []
    seen = set()
    for folder, bundled in iter_plugin_dirs():
        man = _read_manifest(folder)
        if not man:
            continue
        try:
            rec = _record(folder, man, state, bundled)
        except ValueError:
            continue
        if rec["id"] in seen:
            continue
        seen.add(rec["id"])
        rows.append(rec)
    return rows


def get_plugin(store, pid: str) -> dict:
    for rec in list_plugins(store):
        if rec["id"] == pid:
            return rec
    raise KeyError(pid)


def enabled_plugins(store) -> list[dict]:
    return [p for p in list_plugins(store) if p.get("enabled")]


def set_enabled(store, pid: str, enabled: bool, trust: bool = False) -> dict:
    rec = get_plugin(store, pid)
    state = _state(store)
    cur = dict(state.get(pid) or {})
    cur["enabled"] = bool(enabled)
    if trust:
        cur["trusted"] = True
    if rec.get("permissions") and enabled and not cur.get("trusted"):
        raise ValueError("This plugin needs Trust (Extensions) before it can run with extra Python permissions.")
    state[pid] = cur
    _save_state(store, state)
    return get_plugin(store, pid)


def uninstall(store, pid: str) -> dict:
    rec = get_plugin(store, pid)
    if rec.get("bundled"):
        # bundled: just disable
        return set_enabled(store, pid, False)
    folder = Path(rec["source"])
    if INSTALLED_DIR in folder.parents or folder.parent == INSTALLED_DIR:
        shutil.rmtree(folder, ignore_errors=True)
    state = _state(store)
    state.pop(pid, None)
    _save_state(store, state)
    return {"ok": True, "id": pid, "removed": True}


def _copy_tree(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)


def _find_root(extracted: Path) -> Path:
    if _read_manifest(extracted):
        return extracted
    kids = [p for p in extracted.iterdir() if p.is_dir() and not p.name.startswith(".")]
    if len(kids) == 1 and _read_manifest(kids[0]):
        return kids[0]
    for p in extracted.rglob("*"):
        if p.is_file() and p.name in MANIFEST_NAMES and _read_manifest(p.parent):
            return p.parent
    raise ValueError("No DataRefine plugin manifest (package.json / datarefine.plugin.json). Not a VS Code / Chrome / npm package.")


def install_from_path(store, path: str) -> dict:
    src = Path(path).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(str(src))
    if src.suffix.lower() == ".vsix":
        raise ValueError("VS Code .vsix files are not DataRefine plugins.")
    if src.is_file() and src.suffix.lower() == ".zip":
        return install_from_bytes(store, src.read_bytes(), src.name)
    if not src.is_dir():
        raise ValueError("Import a plugin folder or .zip")
    man = _read_manifest(src)
    if not man:
        raise ValueError("Folder is missing datarefine.plugin.json or a DataRefine package.json")
    pid = _plugin_id(man, src)
    INSTALLED_DIR.mkdir(parents=True, exist_ok=True)
    dest = INSTALLED_DIR / pid
    _copy_tree(src, dest)
    state = _state(store)
    perms = _permissions(man)
    state[pid] = {"enabled": not perms, "trusted": False}
    _save_state(store, state)
    return get_plugin(store, pid)


def install_from_bytes(store, data: bytes, filename: str = "plugin.zip") -> dict:
    name = (filename or "plugin.zip").lower()
    if name.endswith(".vsix"):
        raise ValueError("VS Code .vsix files are not DataRefine plugins.")
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="drs-plug-"))
    zpath = tmp / "in.zip"
    zpath.write_bytes(data)
    extract = tmp / "out"
    extract.mkdir()
    try:
        with zipfile.ZipFile(zpath) as zf:
            for info in zf.infolist():
                if info.filename.startswith("/") or ".." in Path(info.filename).parts:
                    raise ValueError("Zip contains unsafe paths")
            zf.extractall(extract)
    except zipfile.BadZipFile as exc:
        raise ValueError("Not a valid zip") from exc
    root = _find_root(extract)
    man = _read_manifest(root)
    if not man:
        raise ValueError("Zip is not a DataRefine plugin")
    pid = _plugin_id(man, root)
    INSTALLED_DIR.mkdir(parents=True, exist_ok=True)
    dest = INSTALLED_DIR / pid
    _copy_tree(root, dest)
    shutil.rmtree(tmp, ignore_errors=True)
    state = _state(store)
    perms = _permissions(man)
    state[pid] = {"enabled": not perms, "trusted": False}
    _save_state(store, state)
    return get_plugin(store, pid)


def contributed_ui(store) -> dict:
    commands, themes, status, snippets, views, exporters, ingest, ai_steps = [], [], [], [], [], [], [], []
    ai_prompts: dict[str, str] = {}
    for rec in enabled_plugins(store):
        c = rec.get("contributes") or {}
        ext = rec["displayName"]
        eid = rec["id"]
        for cmd in c.get("commands") or []:
            if isinstance(cmd, dict) and cmd.get("id"):
                commands.append({**cmd, "extension_id": eid, "extension": ext})
        for th in c.get("themes") or []:
            if isinstance(th, dict) and th.get("id"):
                themes.append({**th, "extension_id": eid, "extension": ext})
        for st in c.get("statusBar") or []:
            if isinstance(st, dict) and st.get("text"):
                status.append({**st, "extension_id": eid, "extension": ext})
        for sn in (c.get("snippets") or []) + (c.get("completions") or []):
            if isinstance(sn, dict) and sn.get("insertText"):
                snippets.append({**sn, "extension_id": eid, "extension": ext, "language": sn.get("language") or "python"})
        for v in c.get("views") or []:
            if isinstance(v, dict) and v.get("id"):
                views.append({**v, "extension_id": eid, "extension": ext})
        for ex in c.get("exporters") or []:
            if isinstance(ex, dict) and (ex.get("id") or ex.get("ext")):
                exporters.append({**ex, "extension_id": eid, "extension": ext})
        for ing in c.get("ingest") or []:
            if isinstance(ing, dict):
                ingest.append({**ing, "extension_id": eid, "extension": ext})
        ai = c.get("ai") or {}
        if isinstance(ai, dict):
            for k, val in (ai.get("prompts") or {}).items():
                if isinstance(val, str) and k not in ai_prompts:
                    ai_prompts[k] = val
            for st in ai.get("steps") or []:
                if isinstance(st, dict) and st.get("id"):
                    ai_steps.append({**st, "extension_id": eid, "extension": ext})
    return {
        "commands": commands,
        "themes": themes,
        "statusBar": status,
        "snippets": snippets,
        "views": views,
        "exporters": exporters,
        "ingest": ingest,
        "aiSteps": ai_steps,
        "aiPrompts": ai_prompts,
    }


def contributed_rules(store, kind: str | None = None) -> list[dict]:
    out = []
    for rec in enabled_plugins(store):
        for rule in (rec.get("contributes") or {}).get("rules") or []:
            if not isinstance(rule, dict):
                continue
            if kind and str(rule.get("kind") or "").lower() != str(kind).lower():
                continue
            out.append({**rule, "plugin": rec["id"]})
    return out
