$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$archive = [IO.Path]::GetFullPath((Join-Path (Split-Path $workspace -Parent) 'W-Archives')).TrimEnd('\')
if ($archive.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase) -or $archive -eq $workspace) { throw 'The archive must be outside the working folder.' }
$indexPath = Join-Path $workspace 'Diwan-Archives.json'
$index = if (Test-Path -LiteralPath $indexPath) { Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ archiveRoot=$archive; relocations=@(); maintenanceChanges=@() } }
if ($index.PSObject.Properties.Name -contains 'indexPath') { $index = Get-Content -LiteralPath $index.indexPath -Raw | ConvertFrom-Json }
if ($index.archiveRoot -ne $archive) { throw 'An existing archive index points to a different location.' }
New-Item -ItemType Directory -Path $archive -Force | Out-Null

function Assert-Source([string]$path) {
    $full = [IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Source escapes workspace: $full" }
    return $full
}
function Assert-Destination([string]$path) {
    $full = [IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($archive + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Destination escapes archive: $full" }
    return $full
}
function Manifest([string]$path) {
    $item = Get-Item -LiteralPath $path
    if (-not $item.PSIsContainer) { return @([pscustomobject]@{ path=''; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }) }
    $prefix = $item.FullName.TrimEnd('\') + '\'
    return @(Get-ChildItem -LiteralPath $path -File -Recurse -Force | ForEach-Object { [pscustomobject]@{ path=$_.FullName.Substring($prefix.Length); bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } } | Sort-Object path)
}
function Write-Index {
    [pscustomobject]@{ archiveRoot=$archive; indexPath=(Join-Path $archive 'index.json') } | ConvertTo-Json | Set-Content -LiteralPath $indexPath -Encoding UTF8
    $index | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $archive 'index.json') -Encoding UTF8
}
function Archive-Item([string]$relative, [string]$targetRelative) {
    $source = Assert-Source (Join-Path $workspace $relative)
    $destination = Assert-Destination (Join-Path $archive $targetRelative)
    if (-not (Test-Path -LiteralPath $source)) { return }
    if (Test-Path -LiteralPath $destination) {
        # Recover only a previously inventoried interrupted move. Never overwrite
        # a different archive or discard an unverified source file.
        $prior = @(Get-ChildItem -LiteralPath $archive -File -Filter 'inventory-*' | ForEach-Object {
            $record = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
            if ($record.original -eq $source -and $record.destination -eq $destination) { [pscustomobject]@{ file=$_.FullName; record=$record } }
        }) | Select-Object -Last 1
        if (-not $prior) { throw "Refusing to overwrite archive: $destination" }
        $before = @($prior.record.files)
        $inventoryPath = $prior.file
        foreach ($file in @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)) {
            $relativeFile = $file.FullName.Substring($source.Length + 1)
            $targetFile = Assert-Destination (Join-Path $destination $relativeFile)
            New-Item -ItemType Directory -Path (Split-Path $targetFile -Parent) -Force | Out-Null
            if (Test-Path -LiteralPath $targetFile) {
                if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $targetFile).Hash) { throw "Conflicting file during archive recovery: $relativeFile" }
                Remove-Item -LiteralPath $file.FullName -Force
            } else { Move-Item -LiteralPath $file.FullName -Destination $targetFile -Force }
        }
        foreach ($directory in @(Get-ChildItem -LiteralPath $source -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)) {
            [IO.File]::SetAttributes($directory.FullName, ($directory.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
            [IO.Directory]::Delete($directory.FullName, $false)
        }
        $sourceAttributes = (Get-Item -LiteralPath $source -Force).Attributes
        [IO.File]::SetAttributes($source, ($sourceAttributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
        [IO.Directory]::Delete($source, $false)
    } else {
        $before = @(Manifest $source)
        $inventoryPath = Join-Path $archive ('inventory-' + ([Guid]::NewGuid().ToString('N')) + '.json')
        [pscustomobject]@{ original=$source; destination=$destination; files=$before } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        if ((Get-Item -LiteralPath $source -Force).PSIsContainer) { [IO.Directory]::Move($source, $destination) }
        else { Move-Item -LiteralPath $source -Destination $destination -Force }
    }
    $after = @(Manifest $destination)
    if (($before | ConvertTo-Json -Depth 5 -Compress) -ne ($after | ConvertTo-Json -Depth 5 -Compress)) { throw "Archive validation failed: $destination; inventory: $inventoryPath" }
    $index.relocations = @($index.relocations) + [pscustomobject]@{ original=$source; destination=$destination; kind='move'; files=$before.Count; inventory=$inventoryPath }
    Write-Index
    Write-Host "Archived $relative ($($before.Count) files verified)"
}
function Remove-ExactDuplicate([string]$relative, [string]$canonical) {
    $source = Assert-Source (Join-Path $workspace $relative)
    $canonical = Assert-Destination $canonical
    if (-not (Test-Path -LiteralPath $source)) { return }
    if (-not (Test-Path -LiteralPath $canonical -PathType Leaf)) { throw "Canonical archive missing: $canonical" }
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if ($hash -ne (Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash) { throw "Files are not duplicates: $source" }
    $bytes = (Get-Item -LiteralPath $source).Length
    Remove-Item -LiteralPath $source
    $index.relocations = @($index.relocations) + [pscustomobject]@{ original=$source; destination=$canonical; kind='duplicate-alias'; sha256=$hash.ToLowerInvariant(); bytesRemoved=$bytes }
    Write-Index
    Write-Host "Removed verified duplicate $relative"
}

# Keep every running executable and the known working package in their locations.
$activePaths = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'diwan-offline.exe' -or $_.Name -eq 'diwan-relay-experiment.exe' } | ForEach-Object { $_.ExecutablePath })
$stableName = 'windows-x64-1793488092292'
$oldPackages = @(Get-ChildItem -LiteralPath (Join-Path $workspace 'diwan\offline-package') -Directory -Filter 'windows-x64-*' | Where-Object { $_.Name -ne $stableName })
foreach ($package in $oldPackages) {
    if (@($activePaths | Where-Object { $_ -and $_.StartsWith($package.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw "Package still running: $($package.FullName)" }
    [void](Assert-Source $package.FullName)
    [void](Assert-Destination (Join-Path $archive ('legacy-packages\' + $package.Name)))
}
foreach ($folder in @(Get-ChildItem -LiteralPath $workspace -Directory -Filter 'Diwan-source-backup-*') + @(Get-ChildItem -LiteralPath $workspace -Directory -Filter 'Diwan-working-checkpoint-*')) {
    Archive-Item $folder.Name ('snapshots\' + $folder.Name)
}
foreach ($package in $oldPackages) { Archive-Item ('diwan\offline-package\' + $package.Name) ('legacy-packages\' + $package.Name) }
Archive-Item 'Diwan-Windows-Bluetooth-Invitation-Fix.zip' 'releases\Diwan-Windows-Bluetooth-Invitation-Fix.zip'
Remove-ExactDuplicate 'Diwan-Offline-Windows-Development.zip' (Join-Path $archive 'releases\Diwan-Windows-Bluetooth-Invitation-Fix.zip')
Remove-ExactDuplicate 'Diwan-Windows-Bluetooth-Preview.zip' (Join-Path $archive 'releases\Diwan-Windows-Bluetooth-Invitation-Fix.zip')
Archive-Item 'Diwan-Windows-Host-Invitation-Fix.zip' 'releases\Diwan-Windows-Host-Invitation-Fix.zip'
$checkpointZip = Join-Path $archive 'snapshots\Diwan-working-checkpoint-2026-11-01-1793489479899\Diwan-Windows-Bluetooth-Update-Fix.zip'
Remove-ExactDuplicate 'Diwan-Windows-Bluetooth-Update-Fix.zip' $checkpointZip
foreach ($file in @('jdk.zip','gradle.zip','android-command-tools.zip')) { Archive-Item ('.tools\relay-android\' + $file) ('tool-downloads\' + $file) }
Archive-Item '.tools\relay-android\sdk-tools-staging' 'tool-downloads\sdk-tools-staging'
Archive-Item 'diwan\relay-experiment-package\windows-x64-1793491360357' 'experimental-packages\windows-x64-1793491360357'
Write-Index
Write-Host "Archive ready: $archive"
