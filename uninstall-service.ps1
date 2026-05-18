$ErrorActionPreference = 'Stop'

$TaskName = 'AppleMacStockMonitor'
$ShortcutName = 'AppleMacStockMonitor.lnk'
$Root = $PSScriptRoot

& (Join-Path $Root 'stop-monitor.ps1')

try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Scheduled task removed: $TaskName"
}
catch {
    Write-Host "Scheduled task was not present: $TaskName"
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName

if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Startup shortcut removed: $shortcutPath"
}
