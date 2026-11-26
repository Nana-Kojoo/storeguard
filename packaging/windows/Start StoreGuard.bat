@echo off
rem StoreGuard for Windows - double-click to start. Keep this window open while the store is trading.
setlocal EnableExtensions
title StoreGuard
cd /d "%~dp0"

if exist ".venv\.storeguard-ready" goto run

rem ---------------------------------------------------------------- first-time setup
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>nul && set "PY=python"
if not defined PY goto nopython
%PY% -c "import sys; sys.exit(sys.version_info < (3, 10))" || goto oldpython

echo.
echo   First-time setup: preparing StoreGuard on this PC.
echo   This needs the internet once and takes a minute or two.
echo.
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv || goto failed
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --quiet -r requirements-local.txt || goto failed
echo ok> ".venv\.storeguard-ready"

:run
".venv\Scripts\python.exe" run_local.py %*
if errorlevel 1 goto failed
goto :eof

:oldpython
echo.
echo   StoreGuard needs Python 3.10 or newer. The Python on this PC is too old.
goto install

:nopython
echo.
echo   StoreGuard needs Python 3.10 or newer, which is not installed on this PC.

:install
echo.
choice /C YN /M "  Install Python now with Windows Package Manager (winget)"
if errorlevel 2 goto manual
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements || goto manual
echo.
echo   Python is installed. Close this window and double-click "Start StoreGuard" again.
pause
goto :eof

:manual
echo.
echo   Download Python from https://www.python.org/downloads/
echo   During setup tick "Add python.exe to PATH", then double-click "Start StoreGuard" again.
start "" https://www.python.org/downloads/
pause
goto :eof

:failed
echo.
echo   StoreGuard could not start. Read the messages above, or see "READ ME FIRST.txt".
pause
exit /b 1
