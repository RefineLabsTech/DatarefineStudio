"""Resource and mutable-data paths shared by source and frozen sidecar builds."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _source_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _frozen_data_root() -> Path | None:
    if not getattr(sys, "frozen", False):
        return None
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("USERPROFILE")
        return Path(base) / "DataRefine Studio" if base else None
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "DataRefine Studio"
    home = os.environ.get("HOME")
    return Path(home) / ".local" / "share" / "DataRefine Studio" if home else None


RESOURCE_ROOT = Path(os.environ.get("DATAREFINE_ROOT") or _source_root()).resolve()
DATA_ROOT = Path(os.environ.get("DATAREFINE_DATA") or _frozen_data_root() or RESOURCE_ROOT).resolve()


def resource_path(*parts: str) -> Path:
    return RESOURCE_ROOT.joinpath(*parts)


def data_path(*parts: str) -> Path:
    return DATA_ROOT.joinpath(*parts)


def ensure_data_layout() -> None:
    for rel in ("config", "sessions", "sessions/uploads", "sessions/exports", "exports", "libraries/python", "plugins/installed"):
        data_path(rel).mkdir(parents=True, exist_ok=True)
