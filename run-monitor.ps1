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

    $alertId = [Guid]::NewGuid().ToString('N')
    $payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) "apple-monitor-alert-$alertId.json"
    $scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "apple-monitor-alert-$alertId.ps1"

    try {
        [ordered]@{
            title   = $Title
            message = $Message
        } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $payloadPath -Encoding UTF8

        @'
param(
    [Parameter(Mandatory = $true)] [string] $PayloadPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json

$form = New-Object System.Windows.Forms.Form
$form.Text = [string] $payload.title
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Size = New-Object System.Drawing.Size(760, 300)
$form.TopMost = $true
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog

$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $false
$label.Location = New-Object System.Drawing.Point(24, 24)
$label.Size = New-Object System.Drawing.Size(696, 170)
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$label.Text = [string] $payload.message

$button = New-Object System.Windows.Forms.Button
$button.Text = 'OK'
$button.Size = New-Object System.Drawing.Size(120, 36)
$button.Location = New-Object System.Drawing.Point(600, 214)
$button.DialogResult = [System.Windows.Forms.DialogResult]::OK

$form.Controls.Add($label)
$form.Controls.Add($button)
$form.AcceptButton = $button
$form.Add_Shown({
    $form.Activate()
    $form.BringToFront()
})

[void] $form.ShowDialog()
$form.Dispose()
'@ | Set-Content -LiteralPath $scriptPath -Encoding UTF8

        Write-MonitorLog -Message 'Showing desktop notification dialog.'
        $process = Start-Process `
            -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"", "`"$payloadPath`"") `
            -WindowStyle Normal `
            -PassThru `
            -Wait

        if ($process.ExitCode -ne 0) {
            throw "Desktop notification process exited with code $($process.ExitCode)."
        }

        Write-MonitorLog -Message 'Desktop notification closed.'
    }
    catch {
        Write-MonitorLog -Level 'WARN' -Message "Desktop notification failed: $($_.Exception.Message)"
    }
    finally {
        Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
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

    if ($Config.notifications.openBrowser -and $OpenBrowser) {
        Write-MonitorLog -Message "Opening browser for $($Availability.Url)"
        Start-Process $Availability.Url
    }
    elseif ($Config.notifications.openBrowser) {
        Write-MonitorLog -Message "Browser open skipped; product page was already opened for this availability window."
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

    if ($Config.notifications.desktop) {
        Send-DesktopNotification -Title $title -Message $message
    }
}

function Get-LocalServerEventConfig {
    param(
        [Parameter(Mandatory = $true)] $Config
    )

    if (-not $Config.serverEvents -or $Config.serverEvents.enabled -eq $false) {
        return $null
    }

    $baseUrl = [string] $Config.serverEvents.baseUrl
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        $baseUrl = 'http://127.0.0.1:8788'
    }

    $token = [string] $Config.serverEvents.localScriptToken
    if ([string]::IsNullOrWhiteSpace($token)) {
        $token = [string] $env:LOCAL_SCRIPT_TOKEN
    }

    if ([string]::IsNullOrWhiteSpace($token)) {
        Write-MonitorLog -Level 'WARN' -Message 'Server local events enabled but LOCAL_SCRIPT_TOKEN is empty.'
        return $null
    }

    $timeoutSeconds = 5
    if ($Config.serverEvents.timeoutSeconds) {
        $timeoutSeconds = [int] $Config.serverEvents.timeoutSeconds
    }

    [pscustomobject]@{
        BaseUrl        = $baseUrl.TrimEnd('/')
        Token          = $token
        TimeoutSeconds = $timeoutSeconds
    }
}

function Send-LocalEventAck {
    param(
        [Parameter(Mandatory = $true)] $ServerConfig,
        [Parameter(Mandatory = $true)] [int] $EventId,
        [Parameter(Mandatory = $true)] [string] $Status,
        [string] $ErrorMessage = $null
    )

    $headers = @{ Authorization = "Bearer $($ServerConfig.Token)" }
    $body = @{ status = $Status }
    if ($ErrorMessage) {
        $body.error = $ErrorMessage
    }

    Invoke-RestMethod `
        -Method Post `
        -Uri "$($ServerConfig.BaseUrl)/api/local/events/$EventId/ack" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body ($body | ConvertTo-Json -Depth 4) `
        -TimeoutSec $ServerConfig.TimeoutSeconds | Out-Null
}

function ConvertTo-AvailabilityFromLocalEvent {
    param(
        [Parameter(Mandatory = $true)] $Event
    )

    $payload = $Event.payload
    $url = if ($payload.canonicalUrl) { [string] $payload.canonicalUrl } else { [string] $payload.url }
    $title = if ($payload.title) { [string] $payload.title } elseif ($payload.productLabel) { [string] $payload.productLabel } else { 'Apple Mac' }
    [pscustomobject]@{
        Url         = $url
        ProductId   = [string] $payload.productId
        Title       = $title
        Price       = [string] $payload.price
        IsAvailable = $true
        Reason      = "server local event $($Event.id)"
        CheckedAt   = (Get-Date).ToString('o')
    }
}

function Invoke-ServerLocalEvents {
    param(
        [Parameter(Mandatory = $true)] $Config
    )

    $serverConfig = Get-LocalServerEventConfig -Config $Config
    if (-not $serverConfig) {
        return
    }

    try {
        $headers = @{ Authorization = "Bearer $($serverConfig.Token)" }
        $response = Invoke-RestMethod `
            -Method Get `
            -Uri "$($serverConfig.BaseUrl)/api/local/events" `
            -Headers $headers `
            -TimeoutSec $serverConfig.TimeoutSeconds

        foreach ($event in @($response.events)) {
            try {
                $availability = ConvertTo-AvailabilityFromLocalEvent -Event $event
                Write-MonitorLog -Level 'ALERT' -Message ("Server local event: {0} | {1}" -f $availability.Title, $availability.Url)
                Send-Alert -Availability $availability -Config $Config -OpenBrowser $true
                Send-LocalEventAck -ServerConfig $serverConfig -EventId ([int] $event.id) -Status 'delivered'
            }
            catch {
                Write-MonitorLog -Level 'ERROR' -Message "Failed to deliver server local event $($event.id): $($_.Exception.Message)"
                try {
                    Send-LocalEventAck -ServerConfig $serverConfig -EventId ([int] $event.id) -Status 'failed' -ErrorMessage $_.Exception.Message
                }
                catch {
                    Write-MonitorLog -Level 'WARN' -Message "Failed to acknowledge server local event $($event.id): $($_.Exception.Message)"
                }
            }
        }
    }
    catch {
        Write-MonitorLog -Level 'WARN' -Message "Failed to poll server local events: $($_.Exception.Message)"
    }
}

function Invoke-MonitorCycle {
    param(
        [Parameter(Mandatory = $true)] $Config
    )

    $state = Read-AlertState
    $now = Get-Date
    $repeatAfter = [TimeSpan]::FromSeconds([int] $Config.repeatAlertAfterSeconds)

    Invoke-ServerLocalEvents -Config $Config

    foreach ($product in @($Config.products)) {
        if ($product.enabled -eq $false) {
            continue
        }

        try {
            $html = Invoke-ApplePageFetch -Url $product.url -UserAgent $Config.userAgent -TimeoutSeconds ([int] $Config.requestTimeoutSeconds)
            $availability = Get-AppleProductAvailability -Html $html -Url $product.url
            $productId = $availability.ProductId
            $stateKey = Get-AppleAvailabilityStateKey -Availability $availability
            $previous = $state[$stateKey]
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

            $state[$stateKey] = [ordered]@{
                url               = $product.url
                productId         = $productId
                stateKey          = $stateKey
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
