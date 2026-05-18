@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0"
set "SCRIPT=%ROOT_DIR%start-monitor.ps1"

echo [Apple Mac Monitor] Start local strong-alert monitor
echo.

if not exist "%SCRIPT%" (
  echo [ERROR] start-monitor.ps1 was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [NOTE] This starts only the Windows local monitor:
echo        desktop notification, beep, and product-page auto-open.
echo        It does not start the Web dashboard, Telegram, or SMS service.
echo.
echo [TIP] Run status-local-monitor.bat to check whether it is running.

pause
exit /b %EXIT_CODE%
