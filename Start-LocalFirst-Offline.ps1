$ErrorActionPreference = 'Stop'
$packages = Join-Path $PSScriptRoot 'diwan\offline-package'
$package = Get-ChildItem -LiteralPath $packages -Directory -Filter 'windows-x64-*' | Sort-Object Name -Descending | Select-Object -First 1
if (-not $package) { throw 'Build the LocalFirst Windows package first.' }
$launcher = Join-Path $package.FullName 'Start-LocalFirst-Offline.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { $launcher = Join-Path $package.FullName 'Start-Diwan-Offline.ps1' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The package has no offline launcher.' }
& $launcher
