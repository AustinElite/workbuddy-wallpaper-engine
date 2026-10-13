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
echo  WorkBuddy Wallpaper Engine - Install as Skill
echo ==========================================
echo.
echo This copies the package into:
echo   %%USERPROFILE%%\.workbuddy-ai\skills\workbuddy-wallpaper-engine
echo.
echo So WorkBuddy can load it as a skill, and you can
echo just ask the AI to "switch my wallpaper".
echo.
pause

"%NODE_EXE%" "%~dp0scripts\skill.mjs" install %*

echo.
pause
