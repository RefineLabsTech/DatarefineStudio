[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resourceRoot = Join-Path $root "src-tauri\resources\datarefine"
$engine = Join-Path $root "src-tauri\resources\datarefine-engine.exe"

# A production bundle must never accidentally reuse an engine built from an
# older checkout. Rebuild it for every release package.
& (Join-Path $PSScriptRoot "build-engine.ps1") -Force
if ($LASTEXITCODE -ne 0) {
    throw "Standalone engine build failed."
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $resourceRoot
New-Item -ItemType Directory -Force -Path (Join-Path $resourceRoot "libraries") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resourceRoot "plugins\catalog") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resourceRoot "auth") | Out-Null

$builtinRules = Join-Path $root "libraries\builtin-rules.json"
if (-not (Test-Path $builtinRules)) {
    throw "Required built-in rule catalogue is missing: $builtinRules"
}
Copy-Item -Force $builtinRules (Join-Path $resourceRoot "libraries\builtin-rules.json")

$catalog = Join-Path $root "plugins\catalog"
if (Test-Path $catalog) {
    Copy-Item -Force (Join-Path $catalog "*") (Join-Path $resourceRoot "plugins\catalog") -ErrorAction SilentlyContinue
}

$askPass = Join-Path $root "sidecar\auth"
if (Test-Path $askPass) {
    Copy-Item -Recurse -Force (Join-Path $askPass "*") (Join-Path $resourceRoot "auth")
}

# This marker makes the read-only resource/data split visible in an installed
# bundle and is not used as application state.
@'
DataRefine Studio bundled resources.
Mutable files belong under DATAREFINE_DATA, not beside the installed EXE.
'@ | Set-Content -Encoding UTF8 (Join-Path $resourceRoot "README.txt")

if (-not (Test-Path $engine)) {
    throw "The bundled engine is missing: $engine"
}

Write-Host "[DataRefine] Windows bundle resources prepared." -ForegroundColor Green
Write-Host "[DataRefine] Engine: $engine" -ForegroundColor Green
Write-Host "[DataRefine] Resources: $resourceRoot" -ForegroundColor Green
