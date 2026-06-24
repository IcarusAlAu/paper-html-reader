@echo off
setlocal
cd /d "%~dp0"

echo Paper HTML Reader
echo Working folder: %CD%
echo.

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting local reader at http://127.0.0.1:5177
start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5177'"
call npm run dev -- --port 5177

pause
