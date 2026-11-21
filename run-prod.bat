@echo off
rem Runs the production build of the TTS app on port 3080 and restarts it if
rem it ever stops. Close this window to stop the server.
rem
rem   run-prod.bat          start the server (builds first if there is no build)
rem   run-prod.bat build    rebuild after code changes, then start
cd /d "%~dp0"
title TTS server (port 3080)
set NEXT_DIST_DIR=.next-prod
set NODE_ENV=production

if /i "%1"=="build" goto build
if not exist ".next-prod\BUILD_ID" goto build
goto loop

:build
echo Building...
call npx next build
if errorlevel 1 (
  echo.
  echo Build failed. Fix the errors above and run this file again.
  pause
  exit /b 1
)

:loop
call npx next start -p 3080
echo.
echo [server stopped, restarting in 3 s - close this window to quit]
timeout /t 3 /nobreak >nul
goto loop
