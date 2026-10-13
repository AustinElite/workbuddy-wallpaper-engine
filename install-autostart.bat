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
echo  WorkBuddy Wallpaper Engine - Autostart
echo ==========================================
echo.
echo This will:
echo   1^) set the user environment variable
echo      WORKBUDDY_REMOTE_DEBUGGING_PORT
echo      (WorkBuddy officially reads it and adds
echo       the CDP debug port by itself)
echo   2^) make the wallpaper engine start at logon
echo.
echo After this, opening WorkBuddy always brings
echo the wallpaper automatically - no more scripts.
echo.
echo NEXT STEP (takes effect immediately, no logoff):
echo   1^) close the WorkBuddy running right now
echo   2^) reopen it from the Desktop / Start Menu
echo      shortcut - the debug port is baked into it
echo.
pause

"%NODE_EXE%" "%~dp0scripts\autostart.mjs" install %*

echo.
pause
