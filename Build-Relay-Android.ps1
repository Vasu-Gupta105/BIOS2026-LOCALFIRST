$ErrorActionPreference = 'Stop'
$tools = Join-Path $PSScriptRoot '.tools\relay-android'
$jdk = Get-ChildItem -LiteralPath (Join-Path $tools 'java') -Directory -Filter 'jdk-*' | Select-Object -First 1
$gradle = Join-Path $tools 'gradle\gradle-8.13\bin\gradle.bat'
$sdk = Join-Path $tools 'sdk'
$project = Join-Path $PSScriptRoot 'diwan\experiments\android-relay'
if (-not $jdk -or -not (Test-Path -LiteralPath $gradle) -or -not (Test-Path -LiteralPath (Join-Path $sdk 'platforms\android-36\android.jar'))) { throw 'Prepare the workspace Android tools and SDK first.' }
$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = $sdk
$env:GRADLE_USER_HOME = Join-Path $tools 'gradle-user-home'
$env:ANDROID_USER_HOME = Join-Path $tools 'android-user-home'
$env:PATH = (Join-Path $jdk.FullName 'bin') + ';' + $env:PATH
$sdkProperty = $sdk.Replace('\', '/').Replace(':', '\:')
[IO.File]::WriteAllText((Join-Path $project 'local.properties'), "sdk.dir=$sdkProperty`n")
Push-Location -LiteralPath $project
try {
    & $gradle --no-daemon --console=plain assembleDebug lintDebug
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed.' }
    Write-Host "Experimental APK: $(Join-Path $project 'app\build\outputs\apk\debug\app-debug.apk')"
} finally { Pop-Location }
