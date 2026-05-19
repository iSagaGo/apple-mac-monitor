$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$StateDir = Join-Path $Root 'state'
$PidPath = Join-Path $StateDir 'monitor.pid'
$RunScript = Join-Path $Root 'run-monitor.ps1'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

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
    try {
        $existingPid = [int] (Get-Content -LiteralPath $PidPath -Raw)
        $existingProcess = Get-MonitorProcess -ProcessId $existingPid -ExpectedScript $RunScript

        if ($existingProcess) {
            Write-Host "Apple Mac monitor is already running. PID=$existingPid"
            exit 0
        }

        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
    catch {
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
}

$argumentList = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$RunScript`""
)

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WindowStyle Hidden -PassThru
Set-Content -Path $PidPath -Value $process.Id -Encoding ASCII
Write-Host "Apple Mac monitor started. PID=$($process.Id)"
