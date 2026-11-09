@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or later from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\playwright (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:4180 in your browser.
node server.mjs
pause
