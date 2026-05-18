@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "SCRIPT=%ROOT_DIR%status-monitor.ps1"

echo [Apple Mac Monitor] Local strong-alert monitor status
echo.

if not exist "%SCRIPT%" (
  echo [ERROR] status-monitor.ps1 was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

pause
exit /b %EXIT_CODE%
