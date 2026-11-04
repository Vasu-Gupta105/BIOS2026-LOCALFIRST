$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:8768'
$metadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'web\.diwan-offline.json') -Raw | ConvertFrom-Json
if ($metadata.experimental -ne $true) { throw 'This launcher requires the separate experimental relay package.' }
$ready = $false
try {
    $health = Invoke-RestMethod "$url/healthz" -TimeoutSec 2
    $ready = $health.server -eq 'diwan-offline' -and $health.cache_version -eq $metadata.cacheVersion -and $health.native_version -eq $metadata.nativeVersion
    if (-not $ready) { throw 'Another version is using experimental port 8768. Save and close that experimental server before continuing.' }
} catch [System.Net.WebException] {}
if (-not $ready) {
    $secureCode = Read-Host 'Enter the Android phone DRL1- relay access code (input is hidden)' -AsSecureString
    $codePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode)
    $previousCode = $env:DIWAN_EXPERIMENTAL_RELAY_CODE
    try {
        $relayCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($codePointer)
        if ($relayCode -notmatch '^DRL1-[A-Za-z0-9_-]{43}$') { throw 'Enter the complete DRL1- relay code. The DBT1- document invitation belongs in the app later.' }
        $env:DIWAN_EXPERIMENTAL_RELAY_CODE = $relayCode
        $app = Start-Process -FilePath (Join-Path $PSScriptRoot 'diwan-relay-experiment.exe') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    } finally {
        $env:DIWAN_EXPERIMENTAL_RELAY_CODE = $previousCode
        $relayCode = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($codePointer)
        $secureCode.Dispose()
    }
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ($app.HasExited) { throw 'The experimental server stopped. Check its package and relay code.' }
        try { $health=Invoke-RestMethod "$url/healthz" -TimeoutSec 1; if ($health.cache_version -eq $metadata.cacheVersion -and $health.native_version -eq $metadata.nativeVersion) { $ready=$true; break } } catch {}
        Start-Sleep -Milliseconds 250
    }
}
if (-not $ready) { throw 'The experimental app did not start.' }
Start-Process "$url/api/offline-launch"
