@echo off
setlocal EnableExtensions
REM Launches the OpenRouter model-picker web UI on a fixed 7000-series port.
REM If anything is already listening on that port, it is killed first so this
REM app always gets the port (avoids EADDRINUSE conflicts with other apps).

set "PORT=7000"
cd /d "%~dp0"

echo Freeing port %PORT% if in use...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo   killing PID %%p on port %PORT%
  taskkill /F /PID %%p >nul 2>&1
)

echo Opening http://localhost:%PORT% ...
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

echo Starting model picker on port %PORT% (Ctrl+C to stop)...
call npm run web

endlocal
