"""Crash-safe flush — parquet after a handful of edits or a few seconds."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sidecar.engine.session import Session


class Wal:
    def __init__(self, store) -> None:
        self.store = store
        self._last_flush = time.time()

    def maybe_flush(self, sess: "Session") -> None:
        now = time.time()
        if sess.dirty >= 12 or (sess.dirty and now - self._last_flush >= 5):
            self.flush(sess)

    def flush(self, sess: "Session") -> None:
        from sidecar.engine.persist import save_current

        try:
            save_current(sess, frame=True)
        except Exception:
            return
        sess.dirty = 0
        self._last_flush = time.time()

    def unfinished(self) -> list[str]:
        from sidecar.engine.persist import peek

        info = peek()
        sid = str(info.get("session_id") or "")
        return [sid] if sid and not info.get("exported") else []
