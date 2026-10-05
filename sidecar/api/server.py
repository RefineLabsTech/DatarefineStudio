"""FastAPI sidecar — never send full frames as JSON."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from sidecar.paths import DATA_ROOT, ensure_data_layout

ensure_data_layout()
_STORE = None
_MGR = None


def get_store():
    global _STORE, _MGR
    if _STORE is None:
        from sidecar.database.store import Store
        from sidecar.engine.session import SessionManager

        _STORE = Store(DATA_ROOT / "config" / "datarefine.db")
        _MGR = SessionManager(_STORE)
    return _STORE


def get_mgr():
    get_store()
    return _MGR


def _gh():
    from sidecar.auth import github as g

    return g

app = FastAPI(title="DataRefine Studio Sidecar", version="3.4.2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_engine():
    import threading

    threading.Thread(target=get_mgr, name="drs-engine", daemon=True).start()


@app.on_event("shutdown")
def _flush_current():
    mgr = _MGR
    if not mgr:
        return
    for sess in list(mgr.sessions.values()):
        try:
            mgr._persist(sess, frame=True)
        except Exception:
            pass


class OpenBody(BaseModel):
    path: str
    row_limit: int = 10000
    force: bool = False


class DbBody(BaseModel):
    kind: str
    config: dict[str, Any] = Field(default_factory=dict)
    query: str
    row_limit: int = 10000


class WorkspaceBody(BaseModel):
    sql: str | None = None
    javascript: str | None = None
    python: str | None = None
    column_rules: dict[str, str] | None = None


class RenameBody(BaseModel):
    label: str = ""


class UndoToBody(BaseModel):
    index: int = 0


class ViewportQuery(BaseModel):
    offset: int = 0
    limit: int = 80


class EditBody(BaseModel):
    row: int
    column: str
    value: Any = None


class SchemaBody(BaseModel):
    column: str
    patch: dict[str, Any]


class DropColsBody(BaseModel):
    columns: list[str] = Field(default_factory=list)


class AddColBody(BaseModel):
    name: str = ""
    type: str = "Text"
    after: str | None = None


class TemplateApply(BaseModel):
    mapping: list[dict[str, Any]]


class CodeBody(BaseModel):
    code: str = ""
    sql: str = ""
    javascript: str = ""
    python: str = ""
    rules: list[dict[str, Any]] = Field(default_factory=list)


class ExportBody(BaseModel):
    fmt: str = "csv"
    dest: str
    options: dict[str, Any] = Field(default_factory=dict)


class SettingsBody(BaseModel):
    values: dict[str, Any]


class RuleBody(BaseModel):
    id: int | None = None
    name: str
    kind: str
    body: str
    description: str = ""
    category: str = "general"
    tags: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict)


class AIBody(BaseModel):
    step: str = "structural"
    language: str = ""
    settings: dict[str, Any] = Field(default_factory=dict)
    extra: str = ""
    columns: list[str] = Field(default_factory=list)
    rows: list[int] = Field(default_factory=list)
    prompt: str | None = None
    threshold: float = 0.0
    apply: bool = False
    use_llm: bool = False
    operations: list[dict[str, Any]] = Field(default_factory=list)


class SearchBody(BaseModel):
    find: str
    replace: str = ""
    column: str | None = None
    regex: bool = False
    do_replace: bool = False


class TemplateBody(BaseModel):
    name: str
    description: str = ""
    mapping: list[dict[str, Any]] = Field(default_factory=list)


class RestoreBody(BaseModel):
    version_id: int


class DbTestBody(BaseModel):
    kind: str
    config: dict[str, Any] = Field(default_factory=dict)


class PushBody(BaseModel):
    kind: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    table: str
    mode: str = "replace"
    schema_name: str = ""


class GithubTokenBody(BaseModel):
    token: str


class GithubDevicePoll(BaseModel):
    device_id: str


class GithubClientBody(BaseModel):
    client_id: str


class GithubSwitchBody(BaseModel):
    account_id: str


class GithubSignOutBody(BaseModel):
    account_id: str = ""


class PluginEnableBody(BaseModel):
    enabled: bool = True
    trust: bool = False


class PluginPathBody(BaseModel):
    path: str


class PluginCmdBody(BaseModel):
    plugin_id: str
    command_id: str
    extra: dict[str, Any] = Field(default_factory=dict)


def _ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def _plugin_ok(data: Any) -> dict:
    """Keep normalized plugin failures at the API boundary."""
    if isinstance(data, dict) and data.get("ok") is False and isinstance(data.get("error"), dict):
        return data
    return _ok(data)


def _fail(exc: Exception, status: int = 400):
    raise HTTPException(status_code=status, detail=str(exc))


@app.get("/health")
def health():
    return {"ok": True, "name": "DataRefine Studio", "version": "3.4.2"}


@app.get("/runtime")
def runtime():
    """Interpreter + installed packages so the editor can import what Terminal pip/npm installed."""
    import sys

    pkgs: list[dict[str, str]] = []
    try:
        import importlib.metadata as md

        for dist in md.distributions():
            try:
                name = (dist.metadata.get("Name") if dist.metadata else None) or getattr(dist, "name", "") or ""
            except Exception:
                name = getattr(dist, "name", "") or ""
            name = str(name).strip()
            if not name:
                continue
            pkgs.append(
                {
                    "name": name,
                    "version": str(getattr(dist, "version", "") or ""),
                    "import": name.replace("-", "_"),
                }
            )
        pkgs.sort(key=lambda r: r["name"].lower())
    except Exception:
        pkgs = []
    node: list[dict[str, str]] = []
    nm = DATA_ROOT / "libraries" / "node_modules"
    if nm.is_dir():
        try:
            for p in sorted(nm.iterdir(), key=lambda x: x.name.lower()):
                if p.name.startswith("."):
                    continue
                if p.name.startswith("@") and p.is_dir():
                    for c in sorted(p.iterdir(), key=lambda x: x.name.lower()):
                        if c.name.startswith("."):
                            continue
                        node.append({"name": f"{p.name}/{c.name}"})
                else:
                    node.append({"name": p.name})
        except OSError:
            pass
    return _ok(
        {
            "python": sys.executable,
            "version": f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}",
            "packages": pkgs[:500],
            "node_modules": node[:400],
            "libraries": str(DATA_ROOT / "libraries"),
        }
    )


@app.get("/crash")
def crash_state():
    from sidecar.engine.persist import peek

    return _ok({"unfinished": get_store().unfinished_sessions(), **peek()})


@app.get("/session/peek")
def session_peek():
    """Cheap restore probe — no polars import, answers while the engine warms up."""
    from sidecar.engine.persist import peek, should_restore

    info = peek()
    mgr = _MGR
    dirty = 0
    if mgr is not None:
        sid = str(info.get("session_id") or "")
        live = mgr.sessions.get(sid) if sid else None
        dirty = int(live.dirty) if live else int(any(s.dirty for s in mgr.sessions.values()))
    return _ok({"restorable": bool(should_restore(None)), "dirty": dirty, **info})


@app.get("/session/resume")
def resume_session():
    try:
        sess = get_mgr().resume()
        if not sess:
            return _ok({"restored": False})
        from sidecar.engine.persist import resume_payload

        return _ok(resume_payload(sess))
    except Exception as exc:
        return _ok({"restored": False, "error": str(exc)})


@app.get("/sessions")
def list_sessions():
    try:
        return _ok(get_mgr().list_sessions())
    except Exception as exc:
        _fail(exc)


@app.get("/sessions/disk")
def disk_sessions():
    import os

    out = []
    root = DATA_ROOT / "sessions"
    if root.is_dir():
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name in {"current", "uploads"}:
                continue
            files = [f for f in d.rglob("*.parquet")]
            if not files:
                continue
            bytes_total = sum(f.stat().st_size for f in files)
            latest = max(f.stat().st_mtime for f in files)
            meta: dict = {}
            mp = d / "meta.json"
            if mp.is_file():
                import json as _json

                try:
                    meta = _json.loads(mp.read_text(encoding="utf-8")) or {}
                except Exception:
                    meta = {}
            src = str(meta.get("source") or "")
            out.append(
                {
                    "session_id": d.name,
                    "label": str(meta.get("label") or "") or (Path(src).name if src else d.name),
                    "exported": bool(meta.get("exported")),
                    "closed": bool(meta.get("closed")),
                    "snapshots": len(files),
                    "bytes": bytes_total,
                    "latest": datetime.fromtimestamp(latest).isoformat(timespec="seconds"),
                }
            )
    return _ok(out)


@app.post("/sessions/disk/{sid}/restore")
def restore_disk_session(sid: str):
    try:
        sess = get_mgr().restore_disk(sid)
    except Exception as exc:
        return _fail(exc)
    return _ok(
        {
            "session_id": sess.id,
            "label": sess.label or Path(sess.source).name or sess.id,
            "rows": sess.height(),
            "cols": sess.df.width,
        }
    )


@app.delete("/sessions/disk/{sid}")
def delete_disk_session(sid: str):
    import shutil

    target = DATA_ROOT / "sessions" / sid
    if target.is_dir() and sid not in {"current", "uploads"}:
        shutil.rmtree(target, ignore_errors=True)
        try:
            get_store().purge_versions(sid)
        except Exception:
            pass
    return _ok({"deleted": sid})


@app.post("/session/{sid}/rename")
def rename_session(sid: str, body: RenameBody):
    try:
        return _ok(get_mgr().rename(sid, body.label))
    except Exception as exc:
        _fail(exc)


@app.delete("/session/{sid}")
def delete_session(sid: str):
    try:
        return _ok(get_mgr().delete_session(sid))
    except Exception as exc:
        _fail(exc)


@app.get("/session/{sid}/workspace")
def get_workspace(sid: str):
    try:
        return _ok(get_mgr().workspace_get(sid))
    except Exception as exc:
        _fail(exc)


@app.get("/session/{sid}/history")
def session_history(sid: str):
    try:
        return _ok(get_mgr().history(sid))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/undo_to")
def session_undo_to(sid: str, body: UndoToBody):
    try:
        return _ok(get_mgr().undo_to(sid, body.index))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/workspace")
def save_workspace(sid: str, body: WorkspaceBody):
    try:
        return _ok(get_mgr().update_workspace(sid, body.model_dump()))
    except Exception as exc:
        _fail(exc)


@app.post("/session/open")
def open_file(body: OpenBody):
    try:
        sess = get_mgr().open_file(body.path, body.row_limit, force=body.force)
        return _ok({"session_id": sess.id, "rows": sess.height(), "columns": sess.columns(), "source": sess.source})
    except Exception as exc:
        _fail(exc)


@app.post("/session/upload")
async def upload(file: UploadFile = File(...), row_limit: int = Form(10000)):
    dest = DATA_ROOT / "sessions" / "uploads"
    dest.mkdir(parents=True, exist_ok=True)
    name = Path(file.filename or "upload.csv").name or "upload.csv"
    path = dest / name
    path.write_bytes(await file.read())
    try:
        sess = get_mgr().open_file(str(path), int(row_limit))
        return _ok({"session_id": sess.id, "rows": sess.height(), "columns": sess.columns(), "source": sess.source})
    except Exception as exc:
        _fail(exc)


@app.post("/session/database")
def open_db(body: DbBody):
    try:
        sess = get_mgr().open_database(body.kind, body.config, body.query, body.row_limit)
        return _ok({"session_id": sess.id, "rows": sess.height(), "columns": sess.columns(), "source": sess.source})
    except Exception as exc:
        _fail(exc)


@app.post("/session/db/test")
def db_test(body: DbTestBody):
    try:
        from sidecar.engine.dbio import test_connection

        return _ok(test_connection(body.kind, body.config))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/push")
def push_db(sid: str, body: PushBody):
    try:
        return _ok(
            get_mgr().push_to_db(sid, body.kind, body.config, body.table, body.mode, body.schema_name)
        )
    except Exception as exc:
        _fail(exc)


@app.get("/session/{sid}/viewport")
def viewport(sid: str, offset: int = 0, limit: int = 80):
    try:
        return _ok(get_mgr().viewport(sid, offset, limit))
    except Exception as exc:
        _fail(exc, 404)


@app.get("/session/{sid}/profile")
def profile(sid: str):
    try:
        return _ok(get_mgr().profile(sid))
    except Exception as exc:
        _fail(exc, 404)


@app.get("/session/{sid}/metrics")
def metrics(sid: str):
    try:
        return _ok(get_mgr().metrics(sid))
    except Exception as exc:
        _fail(exc, 404)


@app.get("/session/{sid}/logs")
def logs(sid: str):
    try:
        return _ok(get_mgr().get(sid).logs)
    except Exception as exc:
        _fail(exc, 404)


@app.get("/session/{sid}/lineage")
def lineage(sid: str):
    return _ok(get_store().lineage(sid))


@app.get("/session/{sid}/versions")
def versions(sid: str):
    return _ok(get_store().versions(sid))


@app.post("/session/{sid}/edit")
def edit(sid: str, body: EditBody):
    try:
        get_mgr().edit_cell(sid, body.row, body.column, body.value)
        return _ok({"edited": True})
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/schema")
def schema(sid: str, body: SchemaBody):
    try:
        return _ok(get_mgr().update_schema(sid, body.column, body.patch))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/columns/drop")
def drop_columns(sid: str, body: DropColsBody):
    try:
        return _ok(get_mgr().drop_columns(sid, body.columns))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/columns/add")
def add_column(sid: str, body: AddColBody):
    try:
        return _ok(get_mgr().add_column(sid, body.name, body.type, body.after))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/schema/template")
def apply_template(sid: str, body: TemplateApply):
    try:
        return _ok(get_mgr().apply_template(sid, body.mapping))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/rules")
def rules(sid: str, body: CodeBody):
    try:
        return _ok(get_mgr().run_rules(sid, body.rules))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/sql")
def sql(sid: str, body: CodeBody):
    try:
        return _ok(get_mgr().run_sql(sid, body.sql or body.code))
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/javascript")
def javascript(sid: str, body: CodeBody):
    try:
        return _ok(get_mgr().run_js(sid, body.javascript or body.code))
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/python")
def python_stage(sid: str, body: CodeBody):
    try:
        return _ok(get_mgr().run_python(sid, body.python or body.code))
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/pipeline")
def pipeline(sid: str, body: CodeBody):
    try:
        return _ok(get_mgr().run_pipeline(sid, body.model_dump()))
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/search")
def search(sid: str, body: SearchBody):
    try:
        return _ok(get_mgr().search_replace(sid, body.find, body.replace, body.column, body.regex, body.do_replace))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/export")
def export(sid: str, body: ExportBody):
    try:
        path = get_mgr().export(sid, body.fmt, body.dest, body.options)
        return _ok({"path": path})
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/undo")
def undo(sid: str):
    try:
        return _ok(get_mgr().undo(sid))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/redo")
def redo(sid: str):
    try:
        return _ok(get_mgr().redo(sid))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/restore")
def restore(sid: str, body: RestoreBody):
    try:
        return _ok(get_mgr().restore_version(sid, body.version_id))
    except Exception as exc:
        _fail(exc)


@app.get("/session/{sid}/report")
def cleaning_report(sid: str, fmt: str = "json"):
    try:
        data = get_mgr().cleaning_report(sid)
        fmt = (fmt or "json").lower()
        if fmt in {"pdf", "report", "report-pdf"}:
            dest = DATA_ROOT / "sessions" / "exports" / f"{sid}-cleaning-report.pdf"
            dest.parent.mkdir(parents=True, exist_ok=True)
            from sidecar.exporters.report import write_cleaning_report

            path = write_cleaning_report(data, str(dest))
            return FileResponse(path, filename="cleaning-report.pdf", media_type="application/pdf")
        return _ok(data)
    except Exception as exc:
        _fail(exc, 404)


_MEDIA = {
    "csv": "text/csv",
    "pdf": "application/pdf",
    "tsv": "text/tab-separated-values",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "json": "application/json",
    "ndjson": "application/x-ndjson",
    "jsonl": "application/x-ndjson",
    "parquet": "application/octet-stream",
    "feather": "application/octet-stream",
    "html": "text/html",
}


@app.get("/session/{sid}/download")
def download(sid: str, fmt: str = "csv", headers: bool = True):
    try:
        fmt = (fmt or "csv").lower().lstrip(".")
        dest = DATA_ROOT / "sessions" / "exports" / f"{sid}-download.{fmt}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        path = get_mgr().export(sid, fmt, str(dest), {"headers": headers})
        return FileResponse(
            path,
            filename=f"clean.{fmt}",
            media_type=_MEDIA.get(fmt, "application/octet-stream"),
        )
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/ai")
def ai_step(sid: str, body: AIBody):
    try:
        stored = get_store().get_setting("ai", {}) or {}
        settings = {**stored, **(body.settings or {})}
        if body.operations:
            thr = body.threshold if body.threshold > 1 else body.threshold
            if thr > 1:
                thr = thr / 100.0
            return _ok(get_mgr().apply_ai_ops(sid, body.operations, threshold=thr))
        sess = get_mgr().get(sid)
        if body.step == "code":
            from sidecar.ai.providers import complete

            if body.language and body.language not in {"python", "sql", "javascript"}:
                raise ValueError("Unsupported editor language.")
            prompt = (body.prompt or body.extra or "").strip()
            if not prompt:
                raise ValueError("Code generation prompt is empty.")
            text = complete(settings, prompt)
            return _ok({"raw": text, "code": text, "wrote": False})
        cols = [c for c in body.columns if c in sess.columns()] or sess.columns()
        sample = get_mgr().viewport(sid, 0, 12)["rows"]
        prompts = settings.get("prompts") if isinstance(settings.get("prompts"), dict) else {}
        from sidecar.plugins.loader import contributed_ui
        from sidecar.ai.providers import DEFAULT_PROMPTS, cleaning_prompt, complete, parse_proposals

        plug_ai = contributed_ui(get_store()).get("aiPrompts") or {}
        template = body.prompt or prompts.get(body.step) or plug_ai.get(body.step) or DEFAULT_PROMPTS.get(body.step)
        prompt = cleaning_prompt(body.step, cols, sample, extra=body.extra, template=template)
        text = complete(settings, prompt)
        proposals = parse_proposals(text)
        result: dict[str, Any] = {"raw": text, "proposals": proposals, "prompt": prompt, "wrote": False}
        if body.apply and proposals:
            thr = body.threshold
            if thr > 1:
                thr = thr / 100.0
            applied = get_mgr().apply_ai_ops(sid, proposals, threshold=thr)
            result.update(applied)
        return _ok(result)
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/ai/preview")
def ai_preview(sid: str, body: AIBody | None = None):
    try:
        payload = body.model_dump() if body else {}
        return _ok(get_mgr().preview_ai(sid, payload))
    except Exception as exc:
        _fail(exc, 422)


@app.post("/session/{sid}/ai/apply")
def ai_apply(sid: str, body: AIBody):
    try:
        thr = body.threshold
        if thr > 1:
            thr = thr / 100.0
        return _ok(get_mgr().apply_ai_ops(sid, body.operations, threshold=thr))
    except Exception as exc:
        _fail(exc, 422)


@app.get("/recents")
def recents():
    return _ok(get_store().recents())


@app.get("/settings")
def get_settings():
    defaults = {
        "theme": "dark",
        "row_limit": 10000,
        "autosave_sec": 60,
        "memory_limit_mb": 4096,
        "default_schema": "infer",
        "ai": {"provider": "ollama", "model": "llama3.1", "temperature": 0.2, "accept_confidence": 0.95},
    }
    defaults.update(get_store().all_settings())
    defaults["github"] = _gh().public_github(get_store())
    return _ok(defaults)


@app.post("/settings")
def set_settings(body: SettingsBody):
    values = dict(body.values or {})
    if "github" in values:
        incoming = values["github"] if isinstance(values["github"], dict) else {}
        current = get_store().get_setting("github", {}) or {}
        if isinstance(current, dict) and current.get("token") and not incoming.get("token"):
            incoming = {**incoming, "token": current["token"], "user": incoming.get("user") or current.get("user")}
        values["github"] = incoming
    for k, v in values.items():
        get_store().set_setting(k, v)
    return _ok(True)


@app.get("/library/rules")
def list_rules(kind: str | None = None):
    try:
        from sidecar.plugins.loader import contributed_rules

        rows = get_store().rules(kind)
        extra = []
        for rule in contributed_rules(get_store(), kind):
            extra.append(
                {
                    "id": f"plugin:{rule.get('plugin')}:{rule.get('name')}",
                    "name": rule.get("name"),
                    "kind": rule.get("kind") or "plugin",
                    "body": rule.get("body") or rule.get("python") or "",
                    "description": rule.get("description") or "",
                    "category": rule.get("category") or "plugin",
                    "tags": ["plugin"],
                    "parameters": {
                        **(rule.get("parameters") or {}),
                        "plugin": rule.get("plugin"),
                        "python": rule.get("python"),
                    },
                    "plugin": rule.get("plugin"),
                    "python": rule.get("python"),
                }
            )
        return _ok(rows + extra)
    except Exception as exc:
        _fail(exc)


@app.post("/library/rules")
def add_rule(body: RuleBody):
    rid = get_store().save_rule(**body.model_dump())
    return _ok({"id": rid})


@app.delete("/library/rules/{rid}")
def delete_rule(rid: int):
    try:
        get_store().delete_rule(rid)
        return _ok(True)
    except Exception as exc:
        _fail(exc)


@app.get("/library/templates")
def list_templates():
    from sidecar.schemas.catalog import catalog_templates

    builtin = catalog_templates()
    names = {t.get("name") for t in builtin}
    user = []
    for t in get_store().templates():
        if t.get("name") in names:
            continue
        user.append({**t, "builtin": False})
    return _ok(builtin + user)


@app.post("/library/templates")
def add_template(body: TemplateBody):
    tid = get_store().save_template(body.name, body.mapping, body.description)
    return _ok({"id": tid})


@app.get("/auth/github")
def github_me():
    return _ok(_gh().public_github(get_store()))


@app.post("/auth/github/client")
def github_client(body: GithubClientBody):
    try:
        return _ok(_gh().save_client_id(get_store(), body.client_id))
    except Exception as exc:
        _fail(exc)


@app.post("/auth/github/token")
def github_token(body: GithubTokenBody):
    try:
        return _ok(_gh().sign_in_token(get_store(), body.token))
    except Exception as exc:
        _fail(exc)


@app.post("/auth/github/switch")
def github_switch(body: GithubSwitchBody):
    try:
        return _ok(_gh().switch_account(get_store(), body.account_id))
    except Exception as exc:
        _fail(exc)


@app.post("/auth/github/signout")
def github_signout(body: GithubSignOutBody | None = None):
    aid = (body.account_id if body else "") or None
    return _ok(_gh().sign_out(get_store(), aid))


@app.post("/auth/github/device/start")
def github_device_start():
    try:
        return _ok(_gh().start_device(get_store()))
    except Exception as exc:
        _fail(exc)


@app.post("/auth/github/device/poll")
def github_device_poll(body: GithubDevicePoll):
    try:
        return _ok(_gh().poll_device(get_store(), body.device_id))
    except Exception as exc:
        _fail(exc)


@app.get("/plugins")
def plugins_list():
    from sidecar.plugins.loader import list_plugins

    return _ok(list_plugins(get_store()))


@app.get("/plugins/ui")
def plugins_ui():
    from sidecar.plugins.loader import contributed_ui

    return _ok(contributed_ui(get_store()))


@app.post("/plugins/install")
async def plugins_install(file: UploadFile = File(...)):
    from sidecar.plugins.loader import install_from_bytes

    try:
        data = await file.read()
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("Plugin zip too large (20 MB max)")
        return _ok(install_from_bytes(get_store(), data, file.filename or "plugin.zip"))
    except Exception as exc:
        _fail(exc)


@app.post("/plugins/install-path")
def plugins_install_path(body: PluginPathBody):
    from sidecar.plugins.loader import install_from_path

    try:
        return _ok(install_from_path(get_store(), body.path))
    except Exception as exc:
        _fail(exc)


@app.post("/plugins/{pid}/enable")
def plugins_enable(pid: str, body: PluginEnableBody):
    from sidecar.plugins.loader import set_enabled

    try:
        return _ok(set_enabled(get_store(), pid, body.enabled, trust=body.trust))
    except Exception as exc:
        _fail(exc)


@app.delete("/plugins/{pid}")
def plugins_unload(pid: str):
    from sidecar.plugins.loader import uninstall

    try:
        return _ok(uninstall(get_store(), pid))
    except Exception as exc:
        _fail(exc)


@app.post("/session/{sid}/plugin-command")
def plugin_command(sid: str, body: PluginCmdBody):
    try:
        return _plugin_ok(get_mgr().run_plugin_command(sid, body.plugin_id, body.command_id, body.extra))
    except Exception as exc:
        _fail(exc)


@app.post("/plugins/command")
def plugins_command(body: PluginCmdBody):
    try:
        return _plugin_ok(get_mgr().run_plugin_command(None, body.plugin_id, body.command_id, body.extra))
    except Exception as exc:
        _fail(exc)



