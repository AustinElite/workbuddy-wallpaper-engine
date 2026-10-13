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

echo ==========================================
echo  WorkBuddy Wallpaper Engine - Remove autostart
echo ==========================================
echo.
echo This will:
echo   1^) delete the logon autostart entry
echo   2^) clear WORKBUDDY_REMOTE_DEBUGGING_PORT
echo   3^) remove the wallpaper and stop the engine
echo.
pause

"%NODE_EXE%" "%~dp0scripts\autostart.mjs" uninstall %*

echo.
pause
