@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "STOP_SCRIPT=%ROOT_DIR%stop-monitor.ps1"
set "START_SCRIPT=%ROOT_DIR%start-monitor.ps1"

echo [Apple Mac Monitor] Restart local strong-alert monitor
echo.

if not exist "%STOP_SCRIPT%" (
  echo [ERROR] stop-monitor.ps1 was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

if not exist "%START_SCRIPT%" (
  echo [ERROR] start-monitor.ps1 was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%STOP_SCRIPT%"
if errorlevel 1 (
  echo [ERROR] Stop step failed.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%START_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [TIP] Run status-local-monitor.bat to check whether it is running.

pause
exit /b %EXIT_CODE%
