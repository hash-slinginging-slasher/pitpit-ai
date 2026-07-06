@echo off
setlocal EnableExtensions
REM One-time setup for pitpit-ai. Installs anything not already present:
REM   - Node.js dependencies      (npm install)
REM   - the global `coder` CLI    (npm link)
REM   - GitHub CLI + auth         (winget + gh auth login) so `git push` works
REM Each step is skipped if it is already done, so re-running is safe.

cd /d "%~dp0"

echo ============================================================
echo   pitpit-ai setup
echo ============================================================

REM --- Node.js (hard prerequisite, cannot continue without it) ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo         Install the LTS build from https://nodejs.org/ and re-run setup.bat.
  goto :fail
)
for /f "delims=" %%v in ('node --version') do echo [ok] Node.js %%v

REM --- Dependencies ---
if exist "node_modules\" (
  echo [ok] Dependencies already installed.
) else (
  echo [..] Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

REM --- coder CLI (global launcher) ---
where coder >nul 2>&1
if errorlevel 1 (
  echo [..] Installing the coder CLI globally ^(npm link^)...
  call npm link
  if errorlevel 1 goto :fail
) else (
  echo [ok] coder CLI already installed.
)

REM --- GitHub CLI ---
set "GH=gh"
where gh >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\GitHub CLI\gh.exe" (
    set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
    echo [ok] GitHub CLI already installed.
  ) else (
    echo [..] Installing GitHub CLI ^(winget^)...
    winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements --silent
    if errorlevel 1 goto :fail
    set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
  )
) else (
  echo [ok] GitHub CLI already installed.
)

REM --- GitHub auth (interactive; opens a browser only if not logged in) ---
"%GH%" auth status >nul 2>&1
if errorlevel 1 (
  echo [..] Logging in to GitHub ^(a browser window will open^)...
  "%GH%" auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 goto :fail
) else (
  echo [ok] Already authenticated with GitHub.
)
"%GH%" auth setup-git

echo.
echo ============================================================
echo   Setup complete.
echo   - Run start.bat to launch the web UI (model picker).
echo   - Run `coder` inside any project directory to use the agent.
echo ============================================================
goto :end

:fail
echo.
echo [FAILED] Setup stopped due to the error above.
endlocal
exit /b 1

:end
endlocal
