# PyInstaller one-file build for the local FastAPI engine.
# The application resource/data directories are supplied by package-windows.ps1;
# this executable contains Python, FastAPI, Polars, DuckDB, and DataRefine code.
from pathlib import Path

from PyInstaller.building.build_main import Analysis, EXE, PYZ
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

ROOT = Path(SPEC).resolve().parents[1]

hiddenimports = sorted(set(
    collect_submodules("sidecar")
    + collect_submodules("uvicorn")
    + collect_submodules("fastapi")
    + collect_submodules("polars")
    + collect_submodules("duckdb")
))

datas = []
for package in ("pydantic", "fastapi", "uvicorn", "dateparser", "babel", "pycountry"):
    try:
        datas.extend(collect_data_files(package))
        datas.extend(copy_metadata(package))
    except Exception:
        # Optional package metadata/data is harmless when unavailable; imports
        # remain covered by the normal analysis and hidden-import lists.
        pass

a = Analysis(
    [str(ROOT / "sidecar" / "main.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="datarefine-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # The Tauri launcher redirects stdout/stderr to the sidecar log and hides
    # the child process with CREATE_NO_WINDOW. Keep real stdio for Uvicorn.
    console=True,
    disable_windowed_traceback=True,
    icon=str(ROOT / "src-tauri" / "icons" / "icon.ico"),
)
