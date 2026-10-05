"""Git-style dataset snapshots (Parquet + schema JSON)."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sidecar.engine.session import Session


def snapshot(store, sess: "Session", root: Path, name: str = "") -> int:
    root = Path(root)
    dest_dir = root / sess.id
    dest_dir.mkdir(parents=True, exist_ok=True)
    try:
        import json as _json
        from datetime import datetime as _dt

        (dest_dir / "meta.json").write_text(
            _json.dumps(
                {
                    "id": sess.id,
                    "source": sess.source,
                    "label": sess.label,
                    "created_at": sess.created_at,
                    "exported": bool(sess.exported),
                    "saved_at": _dt.now().isoformat(timespec="seconds"),
                }
            ),
            encoding="utf-8",
        )
    except Exception:
        pass
    n = len(store.versions(sess.id)) + 1
    path = dest_dir / f"v{n:04d}.parquet"
    try:
        sess.df.write_parquet(path)
    except Exception:
        path = dest_dir / f"v{n:04d}.csv"
        sess.df.write_csv(path)
    import json

    return store.add_version(
        sess.id,
        str(path),
        json.dumps(list(sess.schema.values())),
        name=name or f"v{n}",
    )
