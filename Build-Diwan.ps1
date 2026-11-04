$ErrorActionPreference = 'Stop'
$repoDir = Join-Path $PSScriptRoot 'diwan'
$portableGo = Join-Path $PSScriptRoot '.tools\go\bin\go.exe'
$goCommand = if (Test-Path -LiteralPath $portableGo) { $portableGo } else { 'go.exe' }

Push-Location (Join-Path $repoDir 'web')
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
    & npm.cmd run build:frontend
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
} finally { Pop-Location }

Push-Location $repoDir
$previousCgo = $env:CGO_ENABLED
try {
    $env:CGO_ENABLED = '0'
    & $goCommand build -trimpath -ldflags '-s -w -X main.Version=local' -o diwan.exe .
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed' }
} finally {
    $env:CGO_ENABLED = $previousCgo
    Pop-Location
}

Write-Host 'Build complete. Run Start-Diwan.cmd to open Diwan.'
