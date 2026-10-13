@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Please install Node.js 18+ and retry.
  pause
  exit /b 1
)

echo ==========================================
echo  WorkBuddy Wallpaper Engine
echo ==========================================
echo.
echo WorkBuddy will be CLOSED and reopened in debug
echo mode, then the wallpaper engine is started.
echo.
echo Please save your work inside WorkBuddy first.
echo.
pause

"%NODE_EXE%" "%~dp0scripts\start-detached.mjs" %*

echo.
echo Engine log: "%USERPROFILE%\.workbuddy-wallpaper-engine\engine.log"
echo A "Wallpaper" button should now appear at the
echo bottom-right corner inside WorkBuddy.
echo.
pause
