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

REM --- Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    REM Installed but not on this session's PATH yet.
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  ) else (
    call :ensure_winget
    if errorlevel 1 goto :fail
    echo [..] Installing Node.js LTS ^(winget^)...
    winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --silent
    if errorlevel 1 goto :fail
    REM winget does not refresh PATH for the running shell; add it manually.
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  )
)
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js still not found after install. Open a new terminal and re-run setup.bat.
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
REM npm's global bin dir holds coder.cmd but is often NOT on PATH by default, so
REM `coder` would be "not recognized" in a new shell. Discover it and put it on
REM both this session's PATH and the persistent User PATH.
set "NPMDIR="
for /f "delims=" %%p in ('npm prefix -g 2^>nul') do set "NPMDIR=%%p"
if defined NPMDIR set "PATH=%NPMDIR%;%PATH%"

where coder >nul 2>&1
if errorlevel 1 (
  echo [..] Installing the coder CLI globally ^(npm link^)...
  call npm link
  if errorlevel 1 goto :fail
) else (
  echo [ok] coder CLI already installed.
)

REM Persist the npm global bin dir to the User PATH so `coder` works in new shells.
if defined NPMDIR (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:NPMDIR; $u=[Environment]::GetEnvironmentVariable('Path','User'); if (($u -split ';') -notcontains $d) { $n = if ([string]::IsNullOrEmpty($u)) { $d } else { $u.TrimEnd(';') + ';' + $d }; [Environment]::SetEnvironmentVariable('Path',$n,'User'); Write-Host ('[ok] Added ' + $d + ' to your User PATH (open a new terminal to use coder).') } else { Write-Host '[ok] npm global dir already on User PATH.' }"
)

REM --- GitHub CLI ---
set "GH=gh"
where gh >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\GitHub CLI\gh.exe" (
    set "GH=%ProgramFiles%\GitHub CLI\gh.exe"
    echo [ok] GitHub CLI already installed.
  ) else (
    call :ensure_winget
    if errorlevel 1 goto :fail
    echo [..] Installing GitHub CLI ^(winget^)...
    winget install --id GitHub.cli --source winget --accept-source-agreements --accept-package-agreements --silent
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

REM --- ensure_winget: bootstrap the App Installer (winget) if it is missing. ---
REM Fresh images like Windows Sandbox ship without winget. Download the App
REM Installer bundle and its dependencies and register them for the user.
:ensure_winget
where winget >nul 2>&1
if not errorlevel 1 exit /b 0
echo [..] winget not found. Bootstrapping App Installer ^(downloads a few packages^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $t=$env:TEMP; try { Invoke-WebRequest -Uri https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx -OutFile $t\vclibs.appx; Invoke-WebRequest -Uri https://github.com/microsoft/microsoft-ui-xaml/releases/latest/download/Microsoft.UI.Xaml.2.8.x64.appx -OutFile $t\xaml.appx; Invoke-WebRequest -Uri https://aka.ms/getwinget -OutFile $t\winget.msixbundle; Add-AppxPackage $t\vclibs.appx; Add-AppxPackage $t\xaml.appx; Add-AppxPackage $t\winget.msixbundle } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo [ERROR] Could not install winget automatically. Install "App Installer" from the Microsoft Store, then re-run setup.bat.
  exit /b 1
)
REM The winget alias lives in WindowsApps; make sure it is on this session's PATH.
set "PATH=%LOCALAPPDATA%\Microsoft\WindowsApps;%PATH%"
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] winget installed but not on PATH yet. Open a NEW terminal and re-run setup.bat.
  exit /b 1
)
echo [ok] winget is ready.
exit /b 0

:fail
echo.
echo [FAILED] Setup stopped due to the error above.
endlocal
exit /b 1

:end
endlocal
