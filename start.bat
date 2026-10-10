@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. https://nodejs.org adresinden kurup tekrar dene.
  pause
  exit /b 1
)
node tools\ui\server.js --open
pause
