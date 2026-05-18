$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $repoRoot 'src\AppleStockMonitor.psm1'
Import-Module $modulePath -Force

$script:Failures = 0

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)] $Actual,
        [Parameter(Mandatory = $true)] $Expected,
        [Parameter(Mandatory = $true)] [string] $Message
    )

    if ($Actual -ne $Expected) {
        $script:Failures += 1
        Write-Host "FAIL: $Message"
        Write-Host "  Expected: $Expected"
        Write-Host "  Actual:   $Actual"
        return
    }

    Write-Host "PASS: $Message"
}

function Assert-Match {
    param(
        [Parameter(Mandatory = $true)] [string] $Actual,
        [Parameter(Mandatory = $true)] [string] $Pattern,
        [Parameter(Mandatory = $true)] [string] $Message
    )

    if ($Actual -notmatch $Pattern) {
        $script:Failures += 1
        Write-Host "FAIL: $Message"
        Write-Host "  Expected pattern: $Pattern"
        Write-Host "  Actual:           $Actual"
        return
    }

    Write-Host "PASS: $Message"
}

function New-TestUnicodeString {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $CodePoints
    )

    return -join ($CodePoints | ForEach-Object { [char] [Convert]::ToInt32($_, 16) })
}

$addToBag = New-TestUnicodeString @('6DFB', '52A0', '5230', '8D2D', '7269', '888B')
$currentlyOutOfStock = New-TestUnicodeString @('76EE', '524D', '7F3A', '8D27')

$availableHtml = @"
<html>
  <head>
    <meta property="og:title" content="Refurbished Mac Studio Apple M3 Ultra">
  </head>
  <body>
    <span>RMB 92,399</span>
    <button>$addToBag</button>
  </body>
</html>
"@

$unavailableHtml = @"
<html>
  <head>
    <title>Refurbished Mac Studio - Apple</title>
  </head>
  <body>
    <p>$currentlyOutOfStock</p>
  </body>
</html>
"@

$structuredUnavailableHtml = @"
<html>
  <head>
    <meta property="og:title" content="Refurbished Mac Studio Apple M3 Ultra">
  </head>
  <body>
    <script>
      window.pageLevelData.PDPContent = {"purchaseInfo":{"isBuyable":false,"buyable":false,"price":{"currentPrice":{"amount":"RMB 92,399","raw_amount":"92399.00"}}}};
    </script>
    <button>$addToBag</button>
  </body>
</html>
"@

$available = Get-AppleProductAvailability -Html $availableHtml -Url 'https://www.apple.com.cn/shop/product/g1cepch/a'
Assert-Equal $available.IsAvailable $true 'detects available product when add-to-bag text is present'
Assert-Equal $available.Title 'Refurbished Mac Studio Apple M3 Ultra' 'extracts product title from Open Graph metadata'
Assert-Equal $available.Price 'RMB 92,399' 'extracts RMB price'
Assert-Match $available.Reason $addToBag 'records the availability reason'

$unavailable = Get-AppleProductAvailability -Html $unavailableHtml -Url 'https://www.apple.com.cn/shop/product/g1cepch/a'
Assert-Equal $unavailable.IsAvailable $false 'detects unavailable product when sold-out text is present'
Assert-Match $unavailable.Reason $currentlyOutOfStock 'records the unavailable reason'

$structuredUnavailable = Get-AppleProductAvailability -Html $structuredUnavailableHtml -Url 'https://www.apple.com.cn/shop/product/g1cepch/a'
Assert-Equal $structuredUnavailable.IsAvailable $false 'uses purchaseInfo buyable false before add-to-bag text'
Assert-Match $structuredUnavailable.Reason 'purchaseInfo' 'records structured purchaseInfo reason'

$id = Get-ProductId -Url 'https://www.apple.com.cn/shop/product/g1cepch/a'
Assert-Equal $id 'g1cepch-a' 'creates stable product id from Apple product URL'

$now = [DateTime]::Parse('2026-05-18T18:30:00+08:00')
$repeatAfter = [TimeSpan]::FromSeconds(60)

$firstDecision = Get-AppleAlertDecision `
    -IsAvailable $true `
    -PreviousState $null `
    -Now $now `
    -RepeatAfter $repeatAfter `
    -OpenBrowserEnabled $true
Assert-Equal $firstDecision.ShouldAlert $true 'alerts when product is first seen as available'
Assert-Equal $firstDecision.ShouldOpenBrowser $true 'opens browser on first available alert'

$previousAvailableState = [pscustomobject]@{
    lastAvailable    = $true
    lastAlertAt      = $now.AddSeconds(-90).ToString('o')
    lastBrowserOpenAt = $now.AddSeconds(-90).ToString('o')
}
$repeatDecision = Get-AppleAlertDecision `
    -IsAvailable $true `
    -PreviousState $previousAvailableState `
    -Now $now `
    -RepeatAfter $repeatAfter `
    -OpenBrowserEnabled $true
Assert-Equal $repeatDecision.ShouldAlert $true 'allows repeated audible notifications while still available'
Assert-Equal $repeatDecision.ShouldOpenBrowser $false 'does not reopen browser while the same availability window continues'

$oldStateWithoutBrowserMarker = [pscustomobject]@{
    lastAvailable = $true
    lastAlertAt   = $now.AddSeconds(-90).ToString('o')
}
$migrationDecision = Get-AppleAlertDecision `
    -IsAvailable $true `
    -PreviousState $oldStateWithoutBrowserMarker `
    -Now $now `
    -RepeatAfter $repeatAfter `
    -OpenBrowserEnabled $true
Assert-Equal $migrationDecision.ShouldOpenBrowser $false 'treats existing available state as already opened when upgrading from old state files'

$previousUnavailableState = [pscustomobject]@{
    lastAvailable     = $false
    lastAlertAt       = $now.AddSeconds(-20).ToString('o')
    lastBrowserOpenAt = $null
}
$restockDecision = Get-AppleAlertDecision `
    -IsAvailable $true `
    -PreviousState $previousUnavailableState `
    -Now $now `
    -RepeatAfter $repeatAfter `
    -OpenBrowserEnabled $true
Assert-Equal $restockDecision.ShouldAlert $true 'alerts immediately when availability returns after being unavailable'
Assert-Equal $restockDecision.ShouldOpenBrowser $true 'opens browser again for a new availability window'

if ($script:Failures -gt 0) {
    throw "$script:Failures test(s) failed"
}

Write-Host 'All tests passed'
