@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "SCRIPT=%ROOT_DIR%stop-monitor.ps1"

echo [Apple Mac Monitor] Stop local strong-alert monitor
echo.

if not exist "%SCRIPT%" (
  echo [ERROR] stop-monitor.ps1 was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

pause
exit /b %EXIT_CODE%
