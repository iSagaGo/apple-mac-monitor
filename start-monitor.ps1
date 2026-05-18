$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$StateDir = Join-Path $Root 'state'
$PidPath = Join-Path $StateDir 'monitor.pid'
$RunScript = Join-Path $Root 'run-monitor.ps1'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

if (Test-Path -LiteralPath $PidPath) {
    try {
        $existingPid = [int] (Get-Content -LiteralPath $PidPath -Raw)
        $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue

        if ($existingProcess) {
            Write-Host "Apple Mac monitor is already running. PID=$existingPid"
            exit 0
        }
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
