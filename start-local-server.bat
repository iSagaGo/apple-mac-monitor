@echo off
setlocal EnableExtensions EnableDelayedExpansion

chcp 65001 >nul

set "ROOT_DIR=%~dp0"
set "SERVER_DIR=%ROOT_DIR%server"
set "ENV_FILE=%SERVER_DIR%\.env"
set "OPEN_BROWSER=1"
set "PORT=8788"

if /I "%~1"=="--no-open" set "OPEN_BROWSER=0"

echo [Apple Mac Monitor] Start local Web service
echo.

if not exist "%SERVER_DIR%\package.json" (
  echo [ERROR] server\package.json was not found. Put this bat file in the project root.
  pause
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 22 LTS or newer first.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Make sure Node.js is installed correctly.
  pause
  exit /b 1
)

if not exist "%ENV_FILE%" (
  echo [INFO] server\.env was not found. Creating a local dev .env from .env.example.
  copy /Y "%SERVER_DIR%\.env.example" "%ENV_FILE%" >nul
  set "APPLE_MONITOR_ENV_FILE=%ENV_FILE%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$path=$env:APPLE_MONITOR_ENV_FILE; $text=Get-Content -Raw -Encoding UTF8 $path; $text=$text -replace 'LOCAL_DEV_AUTH_DISABLED=false','LOCAL_DEV_AUTH_DISABLED=true'; $text=$text -replace 'PORT=8787','PORT=8788'; $text=$text -replace 'SMS_DRY_RUN=false','SMS_DRY_RUN=true'; Set-Content -Encoding UTF8 -Path $path -Value $text"
  echo [INFO] Created server\.env. Configure a separate production .env on the server.
  echo.
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  set "ENV_KEY=%%~A"
  set "ENV_VALUE=%%~B"
  if /I "!ENV_KEY!"=="PORT" if not "!ENV_VALUE!"=="" set "PORT=!ENV_VALUE!"
)

pushd "%SERVER_DIR%" >nul
if not exist "node_modules\better-sqlite3" (
  echo [INFO] Dependencies were not found. Running npm install...
  call npm install
  if errorlevel 1 (
    popd >nul
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
  echo.
)
popd >nul

set "APPLE_MONITOR_PORT=%PORT%"
call :IsPortOpen
if "%ERRORLEVEL%"=="0" (
  echo [INFO] Service is already running on 127.0.0.1:%PORT%. It will not be started again.
  goto OpenDashboard
)

echo [INFO] Starting service in a new window: http://127.0.0.1:%PORT%
start "Apple Mac Monitor Server" /D "%SERVER_DIR%" cmd.exe /k "npm start"

echo [INFO] Waiting for the service port...
for /L %%I in (1,1,30) do (
  call :IsPortOpen
  if "!ERRORLEVEL!"=="0" goto OpenDashboard
  ping -n 2 127.0.0.1 >nul
)

echo [WARN] The service port was not ready after 30 seconds. Check the server window logs.
pause
exit /b 1

:OpenDashboard
if "%OPEN_BROWSER%"=="1" (
  echo [INFO] Opening dashboard: http://127.0.0.1:%PORT%/
  start "" "http://127.0.0.1:%PORT%/"
) else (
  echo [INFO] Browser auto-open skipped.
)

echo.
echo [OK] Local Web service is ready.
echo [NOTE] Strong popup, beep, and product-page auto-open are handled by start-monitor.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3"
exit /b 0

:IsPortOpen
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$port=[int]$env:APPLE_MONITOR_PORT; $client=New-Object Net.Sockets.TcpClient; try { $async=$client.BeginConnect('127.0.0.1',$port,$null,$null); if (-not $async.AsyncWaitHandle.WaitOne(1000,$false)) { $client.Close(); exit 1 }; $client.EndConnect($async); $client.Close(); exit 0 } catch { exit 1 }"
exit /b %ERRORLEVEL%
