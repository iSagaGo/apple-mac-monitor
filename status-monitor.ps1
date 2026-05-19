$ErrorActionPreference = 'Stop'

$TaskName = 'AppleMacStockMonitor'
$ShortcutName = 'AppleMacStockMonitor.lnk'
$Root = $PSScriptRoot
$PidPath = Join-Path $Root 'state\monitor.pid'
$LogDir = Join-Path $Root 'logs'
$RunScript = Join-Path $Root 'run-monitor.ps1'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName

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

if (Test-Path -LiteralPath $PidPath) {
    $pidValue = [int] (Get-Content -LiteralPath $PidPath -Raw)
    $process = Get-MonitorProcess -ProcessId $pidValue -ExpectedScript $RunScript

    if ($process) {
        Write-Host "Process: running (PID=$pidValue)"
    }
    else {
        Write-Host "Process: stale PID file or PID belongs to another process (PID=$pidValue)"
    }
}
else {
    Write-Host 'Process: not running'
}

try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Host "Scheduled task: $($task.State)"
}
catch {
    Write-Host 'Scheduled task: not installed'
}

if (Test-Path -LiteralPath $ShortcutPath) {
    Write-Host "Startup shortcut: installed ($ShortcutPath)"
}
else {
    Write-Host 'Startup shortcut: not installed'
}

$latestLog = Get-ChildItem -LiteralPath $LogDir -Filter 'monitor-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($latestLog) {
    Write-Host "Latest log: $($latestLog.FullName)"
    Get-Content -LiteralPath $latestLog.FullName -Tail 10
}
else {
    Write-Host 'Latest log: none'
}
