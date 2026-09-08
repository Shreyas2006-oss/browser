@echo off
title Silence - build Windows app
cd /d "%~dp0"
echo.
echo  ============================================================
echo    Silence - build installer + portable app
echo    folder: %CD%
echo  ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [FAIL] Node.js is not installed. Get it from https://nodejs.org
  echo         then open a new window and run this again.
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo  Node: %%v

echo.
echo  === 1/2  installing dependencies (first run takes a few minutes) ===
call npm install
if errorlevel 1 ( echo  [FAIL] npm install failed - scroll up for the reason. & pause & exit /b 1 )

echo.
echo  === 2/2  building the app ===
call npm run dist
if errorlevel 1 ( echo  [FAIL] the build failed - scroll up for the reason. & pause & exit /b 1 )

echo.
echo  === done ===
if exist "%~dp0dist" (
  dir /b "%~dp0dist"
  start "" "%~dp0dist"
) else (
  echo  [i] no dist folder was produced.
)
echo.
pause
