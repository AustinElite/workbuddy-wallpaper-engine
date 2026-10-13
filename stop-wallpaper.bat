@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  pause
  exit /b 1
)

echo Removing wallpaper and stopping the engine...
"%NODE_EXE%" "%~dp0src\cli.mjs" stop
echo.
echo Done. WorkBuddy is back to its native look.
pause
