param([Parameter(Mandatory=$true)][string]$SdkRoot, [Parameter(Mandatory=$true)][string]$JavaRoot)
$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = $JavaRoot
$env:PATH = (Join-Path $JavaRoot 'bin') + ';' + $env:PATH
$manager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\android.exe'
$log = Join-Path (Split-Path $SdkRoot -Parent) 'sdk-install.log'
# The user explicitly authorized SDK setup and accepting its license in chat.
$ErrorActionPreference = 'Continue'
& $manager --no-metrics "--sdk=$SdkRoot" sdk install 'platforms/android-36' *> $log
$sdkExit = $LASTEXITCODE
if ($sdkExit -eq 0) {
    & $manager --no-metrics "--sdk=$SdkRoot" sdk install 'build-tools/35.0.0' *>> $log
    $sdkExit = $LASTEXITCODE
}
if ($sdkExit -eq 0) {
    & $manager --no-metrics "--sdk=$SdkRoot" sdk install 'platform-tools' *>> $log
    $sdkExit = $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'
if ($sdkExit -ne 0) { Get-Content -LiteralPath $log -Tail 25; throw 'SDK manager failed.' }
Get-Content -LiteralPath $log -Tail 4
