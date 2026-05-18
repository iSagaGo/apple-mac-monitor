$ErrorActionPreference = 'Stop'

$TaskName = 'AppleMacStockMonitor'
$ShortcutName = 'AppleMacStockMonitor.lnk'
$Root = $PSScriptRoot
$StartScript = Join-Path $Root 'start-monitor.ps1'
$PowerShellPath = (Get-Command powershell.exe).Source
$TaskArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
$InstallMode = $null

function Get-ShortFilePath {
    param(
        [Parameter(Mandatory = $true)] [string] $Path
    )

    try {
        $fso = New-Object -ComObject Scripting.FileSystemObject
        return $fso.GetFile($Path).ShortPath
    }
    catch {
        return $Path
    }
}

function Install-StartupShortcut {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupDir $ShortcutName
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $PowerShellPath
    $shortcut.Arguments = $TaskArguments
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Checks Apple China refurbished Mac inventory every 10 seconds and alerts when available.'
    $shortcut.Save()
    Write-Host "Startup shortcut installed: $shortcutPath"
}

try {
    $action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $TaskArguments -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Checks Apple China refurbished Mac inventory every 10 seconds and alerts when available.' -Force | Out-Null
    $InstallMode = 'scheduled task'
}
catch {
    Write-Host "Register-ScheduledTask failed, falling back to schtasks.exe: $($_.Exception.Message)"
    $shortPowerShellPath = Get-ShortFilePath -Path $PowerShellPath
    $shortStartScript = Get-ShortFilePath -Path $StartScript
    $taskRun = "$shortPowerShellPath -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $shortStartScript"
    $schtasksArgs = @('/Create', '/TN', $TaskName, '/SC', 'ONLOGON', '/TR', $taskRun, '/F')
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    try {
        $schtasksOutput = & schtasks.exe @schtasksArgs 2>&1
        $schtasksExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($schtasksExitCode -ne 0) {
        Write-Host "schtasks.exe failed with exit code $schtasksExitCode; using Startup shortcut fallback. $schtasksOutput"
        Install-StartupShortcut
        $InstallMode = 'startup shortcut'
    }
    else {
        $InstallMode = 'scheduled task'
    }
}

& (Join-Path $Root 'start-monitor.ps1')
Write-Host "Persistence installed via $InstallMode."
