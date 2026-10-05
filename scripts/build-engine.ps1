[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildRoot = Join-Path $root ".build\engine"
$venv = Join-Path $buildRoot "venv"
$venvPython = Join-Path $venv "Scripts\python.exe"
$spec = Join-Path $root "packaging\datarefine-engine.spec"
$requirements = Join-Path $root "requirements.txt"
$target = Join-Path $root "src-tauri\resources\datarefine-engine.exe"

function Invoke-Checked([string]$File, [string[]]$CommandArgs) {
    Write-Host "[DataRefine] $File $($CommandArgs -join ' ')" -ForegroundColor DarkCyan
    & $File @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $File"
    }
}

function Find-Python {
    # Probe with -c, then return the resolved python.exe path. Returning the
    # launcher plus its version flag is fragile in PowerShell because nested
    # arrays can be flattened and cause the launcher to open an interactive
    # prompt during the subsequent `-m venv` call.
    $probeCode = "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}')"
    $candidates = @(
        @{ Command = "py"; Version = "-3.12" },
        @{ Command = "py"; Version = "-3.11" },
        @{ Command = "py"; Version = "-3.13" },
        @{ Command = "py"; Version = "-3.14" },
        @{ Command = "python"; Version = "" }
    )
    foreach ($candidate in $candidates) {
        $cmd = [string]$candidate.Command
        $probeArgs = @()
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate.Version)) {
            $probeArgs += [string]$candidate.Version
        }
        $probeArgs += "-c"
        $probeArgs += $probeCode
        try {
            $output = (& $cmd @probeArgs 2>$null | Out-String).Trim()
            $line = ($output -split '\r?\n' | Where-Object { $_ -match "\|" } | Select-Object -Last 1).Trim()
            $parts = $line -split "\|", 2
            $version = [string]$parts[0]
            $exe = if ($parts.Count -gt 1) { [string]$parts[1].Trim() } else { "" }
            if ($version -match '^3\.(11|12|13|14)$' -and $exe -and (Test-Path $exe)) {
                return @{ Command = $exe; Args = @() }
            }
        } catch {
            # Try the next supported interpreter.
        }
    }
    throw "A Python 3.11, 3.12, 3.13, or 3.14 interpreter is required on the build machine to package the standalone engine."
}

$python = Find-Python
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null

if (-not (Test-Path $venvPython)) {
    Invoke-Checked $python.Command ($python.Args + @("-m", "venv", $venv))
}

Invoke-Checked $venvPython @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel")
Invoke-Checked $venvPython @("-m", "pip", "install", "-r", $requirements)
Invoke-Checked $venvPython @("-m", "pip", "install", "pyinstaller>=6.10,<7")

$dist = Join-Path $buildRoot "dist"
$work = Join-Path $buildRoot "work"
if ($Force -or -not (Test-Path $target)) {
    Remove-Item -Force -ErrorAction SilentlyContinue $target
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dist, $work
    Invoke-Checked $venvPython @(
        "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--distpath", $dist,
        "--workpath", $work,
        $spec
    )
    $built = Join-Path $dist "datarefine-engine.exe"
    if (-not (Test-Path $built)) {
        throw "PyInstaller completed without producing $built"
    }
    Copy-Item -Force $built $target
} else {
    Write-Host "[DataRefine] Reusing existing standalone engine: $target" -ForegroundColor DarkGreen
}

Write-Host "[DataRefine] Standalone engine ready: $target" -ForegroundColor Green
