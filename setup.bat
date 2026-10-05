@echo off
cd /d "%~dp0"
echo Installing DataRefine Studio Python engine (3.11-3.13 only, not 3.14)...
py -3.12 -m pip install -r requirements.txt
if errorlevel 1 py -3.11 -m pip install -r requirements.txt
if errorlevel 1 py -3.13 -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Python 3.11-3.13 not found or pip failed.
  echo Install Python 3.12 from https://www.python.org/downloads/
  echo Tick "Add python.exe to PATH", then run this file again:
  echo   py -3.12 -m pip install -r requirements.txt
  echo Do not use Python 3.14 — Polars wheels are often missing.
)
echo.
echo Done. Start with:  npm run tauri dev
pause
