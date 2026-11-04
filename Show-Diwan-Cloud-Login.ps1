$ErrorActionPreference = 'Stop'
$secrets = Import-Clixml -LiteralPath (Join-Path $PSScriptRoot 'Diwan-Cloud\secrets.clixml')
Write-Host 'Diwan cloud login password:'
Write-Host ([System.Net.NetworkCredential]::new('', $secrets.Password).Password)
Write-Host ''
Read-Host 'Press Enter to close'
