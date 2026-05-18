param(
    [switch] $Once,
    [switch] $NoNotify
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$ConfigPath = Join-Path $Root 'config\products.json'
$ModulePath = Join-Path $Root 'src\AppleStockMonitor.psm1'
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$PidPath = Join-Path $StateDir 'monitor.pid'
$StatePath = Join-Path $StateDir 'alert-state.json'

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
Set-Content -Path $PidPath -Value $PID -Encoding ASCII
Import-Module $ModulePath -Force

function Get-LogPath {
    Join-Path $LogDir ("monitor-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
}

function Write-MonitorLog {
    param(
        [Parameter(Mandatory = $true)] [string] $Message,
        [string] $Level = 'INFO'
    )

    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $Message
    Add-Content -Path (Get-LogPath) -Value $line -Encoding UTF8
}

function Read-MonitorConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Config file not found: $ConfigPath"
    }

    Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Read-AlertState {
    if (-not (Test-Path -LiteralPath $StatePath)) {
        return @{}
    }

    $raw = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{}
    }

    $json = $raw | ConvertFrom-Json
    $state = @{}

    foreach ($property in $json.PSObject.Properties) {
        $state[$property.Name] = $property.Value
    }

    return $state
}

function Write-AlertState {
    param(
        [Parameter(Mandatory = $true)] [hashtable] $State
    )

    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Invoke-ApplePageFetch {
    param(
        [Parameter(Mandatory = $true)] [string] $Url,
        [Parameter(Mandatory = $true)] [string] $UserAgent,
        [Parameter(Mandatory = $true)] [int] $TimeoutSeconds
    )

    $curl = Get-Command curl.exe -ErrorAction Stop
    $tempPath = [System.IO.Path]::GetTempFileName()

    try {
        $curlOutput = & $curl.Source -L -sS --compressed --max-time $TimeoutSeconds -A $UserAgent -o $tempPath $Url 2>&1

        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe exited with $LASTEXITCODE. $curlOutput"
        }

        return [System.IO.File]::ReadAllText($tempPath, [System.Text.Encoding]::UTF8)
    }
    finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Send-DesktopNotification {
    param(
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [string] $Message
    )

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
        $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $notifyIcon.BalloonTipTitle = $Title
        $notifyIcon.BalloonTipText = $Message
        $notifyIcon.Visible = $true
        $notifyIcon.ShowBalloonTip(10000)
        Start-Sleep -Seconds 8
        $notifyIcon.Dispose()
    }
    catch {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $shell.Popup($Message, 10, $Title, 64) | Out-Null
        }
        catch {
            Write-MonitorLog -Level 'WARN' -Message "Desktop notification failed: $($_.Exception.Message)"
        }
    }
}

function Send-Alert {
    param(
        [Parameter(Mandatory = $true)] $Availability,
        [Parameter(Mandatory = $true)] $Config,
        [bool] $OpenBrowser = $false
    )

    $title = 'Apple refurbished Mac is available'
    $price = if ($Availability.Price) { $Availability.Price } else { 'price unknown' }
    $message = "$($Availability.Title) | $price | $($Availability.Url)"

    if ($NoNotify) {
        Write-MonitorLog -Message "Notification suppressed by -NoNotify: $message"
        return
    }

    if ($Config.notifications.desktop) {
        Send-DesktopNotification -Title $title -Message $message
    }

    if ($Config.notifications.beep) {
        try {
            [console]::Beep(1100, 250)
            Start-Sleep -Milliseconds 120
            [console]::Beep(1350, 250)
            Start-Sleep -Milliseconds 120
            [console]::Beep(1600, 350)
        }
        catch {
            Write-MonitorLog -Level 'WARN' -Message "Beep failed: $($_.Exception.Message)"
        }
    }

    if ($Config.notifications.openBrowser -and $OpenBrowser) {
        Write-MonitorLog -Message "Opening browser for $($Availability.Url)"
        Start-Process $Availability.Url
    }
    elseif ($Config.notifications.openBrowser) {
        Write-MonitorLog -Message "Browser open skipped; product page was already opened for this availability window."
    }
}

function Invoke-MonitorCycle {
    param(
        [Parameter(Mandatory = $true)] $Config
    )

    $state = Read-AlertState
    $now = Get-Date
    $repeatAfter = [TimeSpan]::FromSeconds([int] $Config.repeatAlertAfterSeconds)

    foreach ($product in @($Config.products)) {
        if ($product.enabled -eq $false) {
            continue
        }

        try {
            $html = Invoke-ApplePageFetch -Url $product.url -UserAgent $Config.userAgent -TimeoutSeconds ([int] $Config.requestTimeoutSeconds)
            $availability = Get-AppleProductAvailability -Html $html -Url $product.url
            $productId = $availability.ProductId
            $previous = $state[$productId]
            $decision = Get-AppleAlertDecision `
                -IsAvailable ([bool] $availability.IsAvailable) `
                -PreviousState $previous `
                -Now $now `
                -RepeatAfter $repeatAfter `
                -OpenBrowserEnabled ([bool] $Config.notifications.openBrowser) `
                -NoNotify ([bool] $NoNotify)

            Write-MonitorLog -Message ("Checked {0}: available={1}; price={2}; reason={3}" -f $product.url, $availability.IsAvailable, $availability.Price, $availability.Reason)

            if ($decision.ShouldAlert) {
                Write-MonitorLog -Level 'ALERT' -Message ("Available: {0} | {1} | {2}" -f $availability.Title, $availability.Price, $availability.Url)
                Send-Alert -Availability $availability -Config $Config -OpenBrowser ([bool] $decision.ShouldOpenBrowser)
            }

            $state[$productId] = [ordered]@{
                url               = $product.url
                title             = $availability.Title
                price             = $availability.Price
                lastAvailable     = $availability.IsAvailable
                lastReason        = $availability.Reason
                lastCheckedAt     = $now.ToString('o')
                lastAlertAt       = if ($decision.LastAlertAt) { $decision.LastAlertAt.ToString('o') } else { $null }
                lastBrowserOpenAt = if ($decision.LastBrowserOpenAt) { $decision.LastBrowserOpenAt.ToString('o') } else { $null }
            }
        }
        catch {
            Write-MonitorLog -Level 'ERROR' -Message ("Failed to check {0}: {1}" -f $product.url, $_.Exception.Message)
        }
    }

    Write-AlertState -State $state
}

try {
    Write-MonitorLog -Message "Monitor started. PID=$PID Once=$Once NoNotify=$NoNotify"

    do {
        $config = Read-MonitorConfig
        Invoke-MonitorCycle -Config $config

        if (-not $Once) {
            Start-Sleep -Seconds ([int] $config.intervalSeconds)
        }
    }
    while (-not $Once)
}
finally {
    Write-MonitorLog -Message "Monitor stopped. PID=$PID"

    try {
        $pidFromFile = if (Test-Path -LiteralPath $PidPath) { [int] (Get-Content -LiteralPath $PidPath -Raw) } else { $null }

        if ($pidFromFile -eq $PID) {
            Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
        }
    }
    catch {
        # Best-effort cleanup only.
    }
}
