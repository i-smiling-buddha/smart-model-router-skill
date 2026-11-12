<#
.SYNOPSIS
  Installs Smart Model Router (smr) on Windows.

.DESCRIPTION
  - Checks Node.js (>= 20; >= 22.5 recommended for the SQLite log).
  - Inside a clone of the repo: builds from source and installs the packed release.
  - Anywhere else: downloads the latest release package from GitHub and installs it.
  - Runs `smr doctor` at the end.

.EXAMPLE
  # from a clone of the repo
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1

.EXAMPLE
  # a specific release, without cloning
  powershell -ExecutionPolicy Bypass -File install.ps1 -Version v1.0.0-rc.1
#>
[CmdletBinding()]
param(
  [string]$Version = "latest",
  [switch]$FromSource
)

$ErrorActionPreference = "Stop"
$Repo = "i-smiling-buddha/smart-model-router-skill"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# 1. Node.js
Write-Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js not found. Install it first:  winget install OpenJS.NodeJS.LTS   (then open a NEW terminal and re-run this script)"
}
$nodeVersion = (& node -p "process.versions.node").Trim()
$parts = $nodeVersion.Split(".") | ForEach-Object { [int]$_ }
if ($parts[0] -lt 20) { Fail "Node.js $nodeVersion is too old. SMR needs Node 20+ (winget upgrade OpenJS.NodeJS.LTS)." }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 5)) {
  Write-Host "    Node $nodeVersion works; Node 22.5+ enables the faster SQLite log." -ForegroundColor Yellow
} else {
  Write-Host "    Node $nodeVersion OK"
}

# 2. Get the package
$repoRoot = Split-Path -Parent $PSScriptRoot
$inRepo = (Test-Path (Join-Path $repoRoot "scripts\build-release.mjs")) -and (Test-Path (Join-Path $repoRoot "packages\core"))
$tmp = Join-Path $env:TEMP "smr-install"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if ($inRepo -or $FromSource) {
  if (-not $inRepo) { Fail "-FromSource must be run from inside a clone of $Repo." }
  Write-Step "Building from source in $repoRoot"
  Push-Location $repoRoot
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }
    npm run release:pack
    if ($LASTEXITCODE -ne 0) { Fail "build failed" }
    $pkg = Join-Path $repoRoot "release\smart-model-router-skill.tgz"
  } finally { Pop-Location }
} else {
  $url = if ($Version -eq "latest") {
    "https://github.com/$Repo/releases/latest/download/smart-model-router-skill.tgz"
  } else {
    "https://github.com/$Repo/releases/download/$Version/smart-model-router-skill.tgz"
  }
  Write-Step "Downloading $url"
  $pkg = Join-Path $tmp "smart-model-router-skill.tgz"
  Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing
}

# 3. Install globally
Write-Step "Installing smr globally"
npm install -g "$pkg"
if ($LASTEXITCODE -ne 0) { Fail "npm install -g failed" }

# 4. Verify
$smr = Get-Command smr -ErrorAction SilentlyContinue
if (-not $smr) {
  $prefix = (& npm prefix -g).Trim()
  Write-Host "smr was installed to $prefix but that folder is not on your PATH." -ForegroundColor Yellow
  Write-Host "Add it in: Settings > System > About > Advanced system settings > Environment Variables > Path, then open a new terminal." -ForegroundColor Yellow
  exit 1
}
Write-Step "smr $(& smr --version) installed"
& smr doctor

Write-Host ""
Write-Host "Next, inside your project folder:" -ForegroundColor Green
Write-Host "  smr init claude-code    # or: smr init opencode / smr init codex"
Write-Host "  smr doctor"
