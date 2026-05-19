$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$PidPath = Join-Path $Root 'state\monitor.pid'
$RunScript = Join-Path $Root 'run-monitor.ps1'

function Get-MonitorProcess {
    param(
        [Parameter(Mandatory = $true)] [int] $ProcessId,
        [Parameter(Mandatory = $true)] [string] $ExpectedScript
    )

    $escapedScript = $ExpectedScript.Replace('\', '\\')
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine.IndexOf($ExpectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $process
    }
    if ($process -and $process.CommandLine -and $process.CommandLine.IndexOf($escapedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $process
    }
    return $null
}

if (-not (Test-Path -LiteralPath $PidPath)) {
    Write-Host 'Apple Mac monitor is not running.'
    exit 0
}

$pidValue = [int] (Get-Content -LiteralPath $PidPath -Raw)
$process = Get-MonitorProcess -ProcessId $pidValue -ExpectedScript $RunScript

if ($process) {
    Stop-Process -Id $pidValue -Force
    Write-Host "Apple Mac monitor stopped. PID=$pidValue"
}
else {
    Write-Host "Stale PID file removed. PID=$pidValue is not this monitor process."
}

Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
