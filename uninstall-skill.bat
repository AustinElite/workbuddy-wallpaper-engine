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
echo  WorkBuddy Wallpaper Engine - Remove Skill
echo ==========================================
echo.
echo This removes the skill from:
echo   %%USERPROFILE%%\.workbuddy-ai\skills\workbuddy-wallpaper-engine
echo.
echo It does NOT disable autostart. For a full cleanup,
echo run uninstall-autostart.bat as well.
echo.
pause

"%NODE_EXE%" "%~dp0scripts\skill.mjs" uninstall %*

echo.
pause
