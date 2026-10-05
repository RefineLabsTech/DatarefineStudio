@echo off
setlocal EnableExtensions
if defined DATAREFINE_ENGINE (
  "%DATAREFINE_ENGINE%" --datarefine-askpass %*
  exit /b %ERRORLEVEL%
)
if defined DATAREFINE_PYTHON if defined DATAREFINE_ROOT (
  "%DATAREFINE_PYTHON%" "%DATAREFINE_ROOT%\sidecar\auth\git_askpass.py" %*
  exit /b %ERRORLEVEL%
)
if defined DATAREFINE_PYTHON (
  "%DATAREFINE_PYTHON%" "%~dp0git_askpass.py" %*
  exit /b %ERRORLEVEL%
)
py -3 "%~dp0git_askpass.py" %*
