@echo off
title Silence - reset app profile
setlocal enabledelayedexpansion

echo.
echo  ============================================================
echo    Reset the Silence profile so the next build starts clean
echo  ============================================================
echo.

rem --- timestamp: yyyyMMdd-HHmmss (locale independent) ---
set "STAMP="
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>nul`) do set "STAMP=%%i"
if not defined STAMP set "STAMP=%RANDOM%%RANDOM%"

set "MOVED=0"

if exist "%APPDATA%\Silence" (
  move "%APPDATA%\Silence" "%APPDATA%\Silence-backup-%STAMP%" >nul
  if errorlevel 1 (
    echo  [FAIL] could not move %%APPDATA%%\Silence
  ) else (
    echo  [OK] %%APPDATA%%\Silence  --^>  Silence-backup-%STAMP%
    set "MOVED=1"
  )
) else (
  echo  [i] %%APPDATA%%\Silence not found - already clean.
)

if exist "%LOCALAPPDATA%\Silence" (
  move "%LOCALAPPDATA%\Silence" "%LOCALAPPDATA%\Silence-backup-%STAMP%" >nul
  if not errorlevel 1 echo  [OK] %%LOCALAPPDATA%%\Silence  --^>  Silence-backup-%STAMP%
)

if exist "%APPDATA%\Silence-App" (
  move "%APPDATA%\Silence-App" "%APPDATA%\Silence-App-backup-%STAMP%" >nul
  if not errorlevel 1 echo  [OK] %%APPDATA%%\Silence-App  --^>  Silence-App-backup-%STAMP%
)

echo.
if "%MOVED%"=="1" (
  echo  Your old data is safe in %%APPDATA%%\Silence-backup-%STAMP%
  echo  To restore it later, delete %%APPDATA%%\Silence and rename the backup back.
) else (
  echo  Nothing to move.
)
echo.
pause
