@echo off
chcp 65001 >nul
title Silence - upgrade installer
set SRC=%~dp0
set DST=C:\Users\rshre\Desktop\silence

echo.
echo  Silence Pro installer  (v2.0)
echo  Source : %SRC%
echo  Target : %DST%
echo.

if not exist "%DST%\main.js" (
  echo  ERROR: no main.js found in %DST%
  echo  Fix the DST path in this .bat, then run it again.
  pause
  exit /b 1
)

taskkill /F /IM electron.exe /T >nul 2>&1
echo  [1/4] closing any running Silence... done

echo  [2/4] copying files...
copy /Y "%SRC%main.js"                      "%DST%\" >nul
copy /Y "%SRC%index.html"                   "%DST%\" >nul
copy /Y "%SRC%package.json"                 "%DST%\" >nul
copy /Y "%SRC%silence-core.js"              "%DST%\" >nul
copy /Y "%SRC%silence-pro-core.js"          "%DST%\" >nul
copy /Y "%SRC%silence-plus.js"              "%DST%\" >nul
copy /Y "%SRC%silence-plus.css"             "%DST%\" >nul
copy /Y "%SRC%silence-pro.js"               "%DST%\" >nul
copy /Y "%SRC%silence-pro.css"              "%DST%\" >nul
copy /Y "%SRC%gesture-preload.js"           "%DST%\" >nul
copy /Y "%SRC%check-silence.js"             "%DST%\" >nul
copy /Y "%SRC%store.html"                   "%DST%\" >nul
copy /Y "%SRC%store-preload.js"             "%DST%\" >nul
copy /Y "%SRC%extension-store-backend.js"   "%DST%\" >nul
copy /Y "%SRC%catalog.json"                 "%DST%\" >nul
echo        done

cd /d "%DST%"
echo  [3/4] npm install (ad blocker + extension APIs)...
call npm install
echo        done

echo  [4/4] verifying...
node check-silence.js

echo.
echo  Starting Silence...
call npm start
pause
