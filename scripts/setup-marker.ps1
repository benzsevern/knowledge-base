param(
  [string]$Python = "python",
  [string]$VenvPath = ".venv-marker",
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$markerRoot = Join-Path $projectRoot "vendor\marker"
$resolvedVenvPath = Join-Path $projectRoot $VenvPath
$requirementsPath = Join-Path $projectRoot "requirements\marker-runtime.txt"
$uvExe = Get-Command uv -ErrorAction SilentlyContinue

if (-not (Test-Path $markerRoot)) {
  throw "vendor/marker was not found. Clone it first."
}

if (-not (Test-Path $requirementsPath)) {
  throw "requirements/marker-runtime.txt was not found."
}

$venvPython = Join-Path $resolvedVenvPath "Scripts\python.exe"
if ($Recreate -and (Test-Path $resolvedVenvPath)) {
  Remove-Item -LiteralPath $resolvedVenvPath -Recurse -Force
}

if (-not (Test-Path $venvPython)) {
  & $Python -m venv $resolvedVenvPath
  if (-not (Test-Path $venvPython)) {
    throw "Failed to create marker virtual environment at $resolvedVenvPath"
  }
}

& $venvPython -m pip install --upgrade pip setuptools wheel

if ($uvExe) {
  $env:UV_LINK_MODE = "copy"
  & $uvExe.Source pip install --python $venvPython -r $requirementsPath
} else {
  & $venvPython -m pip install -r $requirementsPath
}

Write-Host "Marker environment ready at $resolvedVenvPath"
Write-Host "Marker source will run from $markerRoot via PYTHONPATH."
Write-Host "Use KB_MARKER_PYTHON=$venvPython or let the CLI auto-discover it."
