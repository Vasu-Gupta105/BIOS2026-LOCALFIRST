param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $PSScriptRoot 'Diwan-Cloud'
$logDir = Join-Path $runtimeDir 'logs'
$appPath = Join-Path $runtimeDir 'diwan.exe'
$tunnelPath = Join-Path $PSScriptRoot '.tools\cloudflared\cloudflared.exe'
$statePath = Join-Path $runtimeDir 'state.json'
$secretPath = Join-Path $runtimeDir 'secrets.clixml'
$localUrl = 'http://127.0.0.1:8081'
foreach ($folder in @($runtimeDir, $logDir, (Join-Path $runtimeDir 'data'), (Join-Path $runtimeDir 'uploads'))) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $tunnelPath)) { throw 'Cloudflared has not been downloaded.' }
if (-not (Test-Path -LiteralPath $appPath)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.tools\diwan-cloud-check.exe') -Destination $appPath
}
if (-not (Test-Path -LiteralPath $secretPath)) {
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $passwordBytes = New-Object byte[] 18
        $secretBytes = New-Object byte[] 32
        $random.GetBytes($passwordBytes)
        $random.GetBytes($secretBytes)
        $passwordText = [BitConverter]::ToString($passwordBytes).Replace('-', '').ToLowerInvariant()
        $jwtText = [BitConverter]::ToString($secretBytes).Replace('-', '').ToLowerInvariant()
        [pscustomobject]@{
            Password = ConvertTo-SecureString $passwordText -AsPlainText -Force
            JWT = ConvertTo-SecureString $jwtText -AsPlainText -Force
        } | Export-Clixml -LiteralPath $secretPath
    } finally { $random.Dispose() }
}
$secrets = Import-Clixml -LiteralPath $secretPath
$password = [System.Net.NetworkCredential]::new('', $secrets.Password).Password
$jwt = [System.Net.NetworkCredential]::new('', $secrets.JWT).Password
$state = @{}
if (Test-Path -LiteralPath $statePath) {
    $oldState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    foreach ($property in $oldState.PSObject.Properties) { $state[$property.Name] = $property.Value }
}

$runningApp = $null
if ($state.AppPid) { $runningApp = Get-Process -Id $state.AppPid -ErrorAction SilentlyContinue }
if ($runningApp -and $runningApp.Path -ne $appPath) { $runningApp = $null }
if (-not $runningApp) {
    $config = @{
        server = @{ addr = '127.0.0.1:8081'; data_dir = './data'; uploads_dir = './uploads' }
        auth = @{ enabled = $true; password = $password }
        storage = @{ type = 'local' }
        collab = @{ builtin_rendezvous = $true }
    }
    $configPath = Join-Path $runtimeDir 'config.yaml'
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
    Push-Location $runtimeDir
    try {
        & $appPath migrate-credential -admin self -db (Join-Path $runtimeDir 'data\userauth.db')
        if ($LASTEXITCODE -ne 0) { throw 'Owner account bootstrap failed.' }
    } finally {
        $config.auth.password = ''
        $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
        Pop-Location
    }
    $envNames = @('DIWAN_JWT_SECRET', 'DEPLOY_MODE', 'GIN_MODE', 'IDENTITY_URL', 'VULOS_CP_BASE_URL', 'DATABASE_URL', 'VULOS_DATABASE_URL', 'VULOS_USERAUTH_DB')
    $savedEnvironment = @{}
    foreach ($envName in $envNames) { $savedEnvironment[$envName] = [Environment]::GetEnvironmentVariable($envName, 'Process') }
    try {
        $env:DIWAN_JWT_SECRET = $jwt
        $env:DEPLOY_MODE = 'standalone'
        $env:GIN_MODE = 'release'
        $env:IDENTITY_URL = $null
        $env:VULOS_CP_BASE_URL = $null
        $env:DATABASE_URL = $null
        $env:VULOS_DATABASE_URL = $null
        $env:VULOS_USERAUTH_DB = Join-Path $runtimeDir 'data\userauth.db'
        $runningApp = Start-Process -FilePath $appPath -WorkingDirectory $runtimeDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir 'app.stdout.log') -RedirectStandardError (Join-Path $logDir 'app.stderr.log')
    } finally {
        foreach ($envName in $envNames) { [Environment]::SetEnvironmentVariable($envName, $savedEnvironment[$envName], 'Process') }
    }
    $state.AppPid = $runningApp.Id
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($runningApp.HasExited) { throw "Diwan stopped. See $logDir\app.stderr.log" }
    try {
        $health = Invoke-RestMethod "$localUrl/healthz" -TimeoutSec 2
        $auth = Invoke-RestMethod "$localUrl/api/auth/status" -TimeoutSec 2
        if ($health.status -eq 'ok' -and $auth.enabled -eq $true) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw "The authenticated backend did not become ready. See $logDir" }
Write-Output 'Authenticated backend ready on 127.0.0.1:8081.'

$runningTunnel = $null
if ($state.TunnelPid) { $runningTunnel = Get-Process -Id $state.TunnelPid -ErrorAction SilentlyContinue }
if ($runningTunnel -and $runningTunnel.Path -ne $tunnelPath) { $runningTunnel = $null }
if (-not $runningTunnel) {
    $runningTunnel = Start-Process -FilePath $tunnelPath -ArgumentList @('tunnel', '--url', $localUrl, '--protocol', 'http2', '--no-autoupdate') `
        -WorkingDirectory $runtimeDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'tunnel.stdout.log') -RedirectStandardError (Join-Path $logDir 'tunnel.stderr.log')
    $state.TunnelPid = $runningTunnel.Id
    $state.BackendUrl = $null
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}
for ($attempt = 0; $attempt -lt 90; $attempt++) {
    if ($runningTunnel.HasExited) { throw "Cloudflare Tunnel stopped. See $logDir\tunnel.stderr.log" }
    $tunnelLog = Get-Content -LiteralPath (Join-Path $logDir 'tunnel.stderr.log') -Raw -ErrorAction SilentlyContinue
    if ($tunnelLog -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $state.BackendUrl = $Matches[0]
        break
    }
    Start-Sleep -Milliseconds 500
}
if (-not $state.BackendUrl) { throw "Cloudflare did not return a public URL. See $logDir" }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Output "Cloudflare backend: $($state.BackendUrl)"

if ($Publish) {
    $backendReady = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        try {
            if ((Invoke-RestMethod "$($state.BackendUrl)/healthz" -TimeoutSec 5).status -eq 'ok') { $backendReady = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $backendReady) { throw 'The public Cloudflare endpoint is not responding yet.' }
    $repoDir = Join-Path $PSScriptRoot 'diwan'
    $prepareOutput = & node (Join-Path $repoDir 'scripts\prepare-vercel.mjs') $state.BackendUrl
    if ($LASTEXITCODE -ne 0) { throw 'Vercel bundle preparation failed.' }
    $bundleDir = ($prepareOutput | Select-String '^Vercel upload directory: ').Line.Substring('Vercel upload directory: '.Length)
    if (-not $bundleDir) { throw 'The bundle directory was not returned.' }
    New-Item -ItemType Directory -Path (Join-Path $bundleDir '.vercel') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.tools\vercel-diwan\.vercel\project.json') -Destination (Join-Path $bundleDir '.vercel\project.json')
    $state.BundleDir = $bundleDir
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $deployOutput = & vercel.cmd deploy --prod --yes --scope coffee-code --cwd $bundleDir
    if ($LASTEXITCODE -ne 0) { throw 'Vercel deployment failed.' }
    $deployOutput | Write-Output
    $deployText = $deployOutput -join "`n"
    $jsonStart = $deployText.IndexOf('{')
    $jsonEnd = $deployText.LastIndexOf('}')
    if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) {
        $deployment = $deployText.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json
        if ($deployment.deployment.productionUrl) {
            $state.PublicUrl = $deployment.deployment.productionUrl
            $state.DeploymentId = $deployment.deployment.id
            $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        }
    }
}
