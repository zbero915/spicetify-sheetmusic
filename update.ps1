$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRawBase = 'https://raw.githubusercontent.com/zbero915/spicetify-sheetmusic/main'
$SpicetifyDir = Join-Path $env:LOCALAPPDATA 'spicetify'
$SpicetifyExe = Join-Path $SpicetifyDir 'spicetify.exe'
$ExtensionsDir = Join-Path $SpicetifyDir 'Extensions'
$ExtFile = Join-Path $ExtensionsDir 'sheetmusic.js'

function Write-Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

if ($PSVersionTable.PSVersion -lt [version]'5.1') {
  throw "PowerShell 5.1 or higher is required (current: $($PSVersionTable.PSVersion))."
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if ($isAdmin) {
  throw 'Please run this updater from a normal (non-Administrator) PowerShell window.'
}

if (-not (Test-Path -LiteralPath $SpicetifyExe -PathType Leaf)) {
  throw "Spicetify is not installed at $SpicetifyExe. Run the installer first: irm $RepoRawBase/install.ps1 | iex"
}

# Close Spotify if running so files are not locked during update/apply
$spotifyProcs = Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue
if ($spotifyProcs) {
  Write-Step 'Closing Spotify...'
  $spotifyProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

# 1. Check for Spicetify CLI updates
Write-Step 'Checking for Spicetify CLI updates...'
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $SpicetifyExe update
$ErrorActionPreference = $prevPref

# 2. Download latest sheetmusic.js
Write-Step "Downloading latest sheetmusic.js to $ExtFile..."
New-Item -ItemType Directory -Force -Path $ExtensionsDir | Out-Null
Invoke-WebRequest -Uri "$RepoRawBase/sheetmusic.js" -UseBasicParsing -OutFile $ExtFile
Write-Ok 'Downloaded latest sheetmusic.js'

# 3. Ensure extension is enabled and re-apply to Spotify
$spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
$spotifyPrefs = Join-Path $env:APPDATA 'Spotify\prefs'
if (-not (Test-Path -LiteralPath $spotifyExe -PathType Leaf) -or -not (Test-Path -LiteralPath $spotifyPrefs -PathType Leaf)) {
  Write-Warn 'Spotify desktop app or prefs not found. Updated sheetmusic.js; open Spotify once and run "Spicetify Auto" on your Desktop.'
  return
}

$existingExt = (& $SpicetifyExe config extensions 2>$null) -join '|'
$extList = $existingExt -split '[|\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($extList -notcontains 'sheetmusic.js') {
  & $SpicetifyExe config extensions sheetmusic.js
}

Write-Step 'Applying updated Sheet Music extension...'
& $SpicetifyExe auto
& $SpicetifyExe apply
Write-Ok 'Update complete! Sheet Music is up to date.'
