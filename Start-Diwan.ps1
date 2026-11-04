$ErrorActionPreference = 'Stop'
$repoDir = Join-Path $PSScriptRoot 'diwan'
$appPath = Join-Path $repoDir 'diwan.exe'
$appUrl = 'http://127.0.0.1:8080'
$logDir = Join-Path $repoDir 'logs'

if (-not (Test-Path -LiteralPath $appPath)) {
    throw "Diwan has not been built. Expected $appPath"
}

$isRunning = $false
try {
    $health = Invoke-RestMethod "$appUrl/healthz" -TimeoutSec 2
    $version = Invoke-RestMethod "$appUrl/version" -TimeoutSec 2
    $isRunning = $health.status -eq 'ok' -and $null -ne $version.version
} catch {}

if (-not $isRunning) {
    $configPath = Join-Path $repoDir 'windows.local'
    if (-not (Test-Path -LiteralPath $configPath)) {
        Copy-Item -LiteralPath (Join-Path $repoDir 'windows.local.example') -Destination $configPath
    }
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $appProcess = Start-Process -FilePath $appPath -ArgumentList @('-config', 'windows.local') `
        -WorkingDirectory $repoDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'diwan.stdout.log') `
        -RedirectStandardError (Join-Path $logDir 'diwan.stderr.log')
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($appProcess.HasExited) {
            throw "Diwan stopped. See $logDir\diwan.stderr.log"
        }
        try {
            $health = Invoke-RestMethod "$appUrl/healthz" -TimeoutSec 1
            if ($health.status -eq 'ok') { $isRunning = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $isRunning) { throw "Diwan did not become ready. See $logDir" }
}

Write-Host "Diwan is running at $appUrl"
Start-Process $appUrl
