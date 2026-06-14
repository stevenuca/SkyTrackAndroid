$ErrorActionPreference = "Stop"

$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

$gradle = Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists" -Recurse -Filter "gradle.bat" |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if (-not $gradle) {
    throw "Gradle was not found. Open this project in Android Studio and finish Gradle Sync first."
}

& $gradle.FullName assembleDebug
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
