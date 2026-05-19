$ErrorActionPreference = 'Stop'

function New-UnicodeString {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $CodePoints
    )

    return -join ($CodePoints | ForEach-Object { [char] [Convert]::ToInt32($_, 16) })
}

function Get-ProductId {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Url
    )

    try {
        $uri = [Uri] $Url
        $segments = $uri.AbsolutePath.Trim('/').Split('/')
        $productIndex = [Array]::IndexOf($segments, 'product')

        if ($productIndex -ge 0 -and $segments.Length -gt ($productIndex + 1)) {
            $parts = @($segments[$productIndex + 1])

            if ($segments.Length -gt ($productIndex + 2) -and $segments[$productIndex + 2]) {
                $parts += $segments[$productIndex + 2]
            }

            return (($parts -join '-') -replace '[^A-Za-z0-9-]', '-').Trim('-').ToLowerInvariant()
        }
    }
    catch {
        # Fall back to a URL hash below.
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Url)
        $hash = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash).Replace('-', '').Substring(0, 16)).ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-ShortHash {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        $hash = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash).Replace('-', '').Substring(0, 16)).ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-AppleAvailabilityStateKey {
    param(
        [Parameter(Mandatory = $true)]
        $Availability
    )

    $productId = [string] $Availability.ProductId
    $identity = @(
        $productId,
        [string] $Availability.Title,
        [string] $Availability.Price
    ) -join '|'

    return ('{0}-{1}' -f $productId, (Get-ShortHash -Value $identity)).Trim('-').ToLowerInvariant()
}

function ConvertTo-PlainText {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html
    )

    $text = [regex]::Replace($Html, '(?is)<script\b.*?</script>', ' ')
    $text = [regex]::Replace($text, '(?is)<style\b.*?</style>', ' ')
    $text = [regex]::Replace($text, '(?is)<[^>]+>', ' ')
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    return ([regex]::Replace($text, '\s+', ' ')).Trim()
}

function Get-MetaContent {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html,

        [Parameter(Mandatory = $true)]
        [string] $Name
    )

    $escapedName = [regex]::Escape($Name)
    $patterns = @(
        "(?is)<meta\b(?=[^>]*(?:property|name)\s*=\s*['""]$escapedName['""])(?=[^>]*content\s*=\s*['""]([^'""]+)['""])[^>]*>",
        "(?is)<meta\b(?=[^>]*content\s*=\s*['""]([^'""]+)['""])(?=[^>]*(?:property|name)\s*=\s*['""]$escapedName['""])[^>]*>"
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($Html, $pattern)

        if ($match.Success) {
            return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value).Trim()
        }
    }

    return $null
}

function Get-TitleFromHtml {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html,

        [Parameter(Mandatory = $true)]
        [string] $Url
    )

    $title = Get-MetaContent -Html $Html -Name 'og:title'

    if (-not $title) {
        $match = [regex]::Match($Html, '(?is)<title[^>]*>(.*?)</title>')

        if ($match.Success) {
            $title = ConvertTo-PlainText -Html $match.Groups[1].Value
        }
    }

    if (-not $title) {
        return $Url
    }

    return $title
}

function Get-PriceFromText {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Text
    )

    $match = [regex]::Match($Text, 'RMB\s*[0-9][0-9,]*(?:\.[0-9]+)?')

    if ($match.Success) {
        return $match.Value.Trim()
    }

    return $null
}

function Get-JsonAssignmentText {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Text,

        [Parameter(Mandatory = $true)]
        [string] $AssignmentName
    )

    $assignmentIndex = $Text.IndexOf($AssignmentName)
    if ($assignmentIndex -lt 0) {
        return $null
    }

    $equalsIndex = $Text.IndexOf('=', $assignmentIndex + $AssignmentName.Length)
    if ($equalsIndex -lt 0) {
        return $null
    }

    $startIndex = $Text.IndexOf('{', $equalsIndex)
    if ($startIndex -lt 0) {
        return $null
    }

    $depth = 0
    $inString = $false
    $escaped = $false

    for ($index = $startIndex; $index -lt $Text.Length; $index += 1) {
        $char = $Text[$index]

        if ($inString) {
            if ($escaped) {
                $escaped = $false
            }
            elseif ($char -eq '\') {
                $escaped = $true
            }
            elseif ($char -eq '"') {
                $inString = $false
            }
            continue
        }

        if ($char -eq '"') {
            $inString = $true
        }
        elseif ($char -eq '{') {
            $depth += 1
        }
        elseif ($char -eq '}') {
            $depth -= 1
            if ($depth -eq 0) {
                return $Text.Substring($startIndex, $index - $startIndex + 1)
            }
        }
    }

    return $null
}

function Get-PurchaseInfoAvailabilityStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html
    )

    $jsonText = Get-JsonAssignmentText -Text $Html -AssignmentName 'window.pageLevelData.PDPContent'
    if (-not $jsonText) {
        return $null
    }

    try {
        $pdpContent = $jsonText | ConvertFrom-Json
        $purchaseInfo = $pdpContent.purchaseInfo
    }
    catch {
        return $null
    }

    if (-not $purchaseInfo) {
        return $null
    }

    foreach ($propertyName in @('isBuyable', 'buyable')) {
        $property = $purchaseInfo.PSObject.Properties[$propertyName]
        if ($property -and $null -ne $property.Value) {
            if ([bool] $property.Value) {
                return [pscustomobject]@{
                    Status = 'available'
                    Reason = "purchaseInfo.$propertyName=true"
                }
            }

            return [pscustomobject]@{
                Status = 'unavailable'
                Reason = "purchaseInfo.$propertyName=false"
            }
        }
    }

    return $null
}

function Get-ButtonAvailabilityStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html
    )

    $match = [regex]::Match($Html, "(?is)<button\b(?=[^>]*data-autom\s*=\s*['""]add-to-cart['""])[^>]*>")
    if (-not $match.Success) {
        return $null
    }

    if ($match.Value -match '(?i)\sdisabled(?:\s|=|>)') {
        return [pscustomobject]@{
            Status = 'unavailable'
            Reason = 'add-to-cart button disabled'
        }
    }

    return [pscustomobject]@{
        Status = 'available'
        Reason = 'add-to-cart button enabled'
    }
}

function Get-StructuredAvailabilityStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html
    )

    $purchaseInfoStatus = Get-PurchaseInfoAvailabilityStatus -Html $Html
    if ($purchaseInfoStatus) {
        return $purchaseInfoStatus
    }

    $buttonStatus = Get-ButtonAvailabilityStatus -Html $Html
    if ($buttonStatus) {
        return $buttonStatus
    }

    if ($Html -match '(?i)Availability\s*\|\s*0\s*\|') {
        return [pscustomobject]@{
            Status = 'unavailable'
            Reason = 'Availability | 0 |'
        }
    }

    return $null
}

function Get-StateDateValue {
    param(
        $State,
        [Parameter(Mandatory = $true)] [string] $Name
    )

    if (-not $State) {
        return $null
    }

    $property = $State.PSObject.Properties[$Name]

    if (-not $property -or -not $property.Value) {
        return $null
    }

    return [DateTime]::Parse([string] $property.Value)
}

function Get-StateBooleanValue {
    param(
        $State,
        [Parameter(Mandatory = $true)] [string] $Name
    )

    if (-not $State) {
        return $false
    }

    $property = $State.PSObject.Properties[$Name]

    if (-not $property -or $null -eq $property.Value) {
        return $false
    }

    return [bool] $property.Value
}

function Get-AppleAlertDecision {
    param(
        [Parameter(Mandatory = $true)] [bool] $IsAvailable,
        $PreviousState,
        [Parameter(Mandatory = $true)] [DateTime] $Now,
        [Parameter(Mandatory = $true)] [TimeSpan] $RepeatAfter,
        [bool] $OpenBrowserEnabled = $true,
        [bool] $NoNotify = $false
    )

    $previousWasAvailable = Get-StateBooleanValue -State $PreviousState -Name 'lastAvailable'
    $lastAlertAt = Get-StateDateValue -State $PreviousState -Name 'lastAlertAt'
    $lastBrowserOpenAt = Get-StateDateValue -State $PreviousState -Name 'lastBrowserOpenAt'

    if (-not $lastBrowserOpenAt -and $previousWasAvailable -and $lastAlertAt) {
        $lastBrowserOpenAt = $lastAlertAt
    }

    if (-not $IsAvailable) {
        return [pscustomobject]@{
            ShouldAlert       = $false
            ShouldOpenBrowser = $false
            LastAlertAt       = $lastAlertAt
            LastBrowserOpenAt = $null
        }
    }

    $becameAvailable = -not $previousWasAvailable
    $repeatDue = -not $lastAlertAt -or (($Now - $lastAlertAt) -ge $RepeatAfter)
    $shouldAlert = $becameAvailable -or $repeatDue
    $shouldOpenBrowser = $shouldAlert -and $OpenBrowserEnabled -and -not $lastBrowserOpenAt

    if ($shouldAlert -and -not $NoNotify) {
        $lastAlertAt = $Now
    }

    if ($shouldOpenBrowser -and -not $NoNotify) {
        $lastBrowserOpenAt = $Now
    }

    return [pscustomobject]@{
        ShouldAlert       = $shouldAlert
        ShouldOpenBrowser = $shouldOpenBrowser
        LastAlertAt       = $lastAlertAt
        LastBrowserOpenAt = $lastBrowserOpenAt
    }
}

function Get-AppleProductAvailability {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Html,

        [Parameter(Mandatory = $true)]
        [string] $Url
    )

    $plainText = ConvertTo-PlainText -Html $Html
    $searchText = "$Html $plainText"
    $structuredStatus = Get-StructuredAvailabilityStatus -Html $Html

    $availableSignals = @(
        (New-UnicodeString @('6DFB', '52A0', '5230', '8D2D', '7269', '888B')),
        (New-UnicodeString @('52A0', '5165', '8D2D', '7269', '888B')),
        'Add to Bag',
        'Add to Cart'
    )

    $unavailableSignals = @(
        (New-UnicodeString @('76EE', '524D', '7F3A', '8D27')),
        (New-UnicodeString @('552E', '7F44')),
        (New-UnicodeString @('6682', '65E0', '4F9B', '5E94')),
        (New-UnicodeString @('65E0', '8D27')),
        (New-UnicodeString @('5DF2', '552E', '5B8C')),
        'Out of stock',
        'Currently unavailable',
        'Unavailable',
        'Sold Out'
    )

    $availableHits = @()
    $unavailableHits = @()
    $isAvailable = $false
    $reasonParts = @()

    if ($structuredStatus) {
        $isAvailable = $structuredStatus.Status -eq 'available'
        $reasonParts += $structuredStatus.Reason
    }
    else {
        $availableHits = @($availableSignals | Where-Object { $searchText.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        $unavailableHits = @($unavailableSignals | Where-Object { $searchText.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })

        $isAvailable = ($availableHits.Count -gt 0 -and $unavailableHits.Count -eq 0)

        if ($availableHits.Count -gt 0) {
            $reasonParts += "available signal: $($availableHits -join ', ')"
        }

        if ($unavailableHits.Count -gt 0) {
            $reasonParts += "unavailable signal: $($unavailableHits -join ', ')"
        }

        if ($reasonParts.Count -eq 0) {
            $reasonParts += 'no known availability signal found'
        }
    }

    [pscustomobject]@{
        Url                = $Url
        ProductId          = Get-ProductId -Url $Url
        Title              = Get-TitleFromHtml -Html $Html -Url $Url
        Price              = Get-PriceFromText -Text $plainText
        IsAvailable        = $isAvailable
        Reason             = $reasonParts -join '; '
        AvailableSignals   = $availableHits
        UnavailableSignals = $unavailableHits
        CheckedAt          = (Get-Date).ToString('o')
    }
}

Export-ModuleMember -Function Get-AppleProductAvailability, Get-ProductId, Get-AppleAlertDecision, Get-AppleAvailabilityStateKey
