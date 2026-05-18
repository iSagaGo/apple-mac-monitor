$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$PidPath = Join-Path $Root 'state\monitor.pid'

if (-not (Test-Path -LiteralPath $PidPath)) {
    Write-Host 'Apple Mac monitor is not running.'
    exit 0
}

$pidValue = [int] (Get-Content -LiteralPath $PidPath -Raw)
$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue

if ($process) {
    Stop-Process -Id $pidValue -Force
    Write-Host "Apple Mac monitor stopped. PID=$pidValue"
}
else {
    Write-Host "Stale PID file removed. PID=$pidValue was not running."
}

Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
