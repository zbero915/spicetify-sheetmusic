$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SpicetifyDir = Join-Path $env:LOCALAPPDATA 'spicetify'
$SpicetifyAppData = Join-Path $env:APPDATA 'spicetify'
$OldSpicetifyDir = Join-Path $HOME 'spicetify-cli'
$SpicetifyExe = Join-Path $SpicetifyDir 'spicetify.exe'
$ExtFile = Join-Path $SpicetifyDir 'Extensions\sheetmusic.js'
$XpuiExtFile = Join-Path $env:APPDATA 'Spotify\Apps\xpui\extensions\sheetmusic.js'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Spicetify Auto.lnk'

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
  throw 'Please run this uninstaller from a normal (non-Administrator) PowerShell window.'
}

# Ask whether to remove Spicetify completely or keep Spicetify and remove only Sheet Music
$removeSpicetify = $null
while ($null -eq $removeSpicetify) {
  $answer = (Read-Host 'Also remove Spicetify completely? (Y = remove Spicetify + shortcut & restore Spotify, N = keep Spicetify, remove only Sheet Music) [Y/N]').Trim()
  if ($answer -match '^(y|yes)$') {
    $removeSpicetify = $true
  } elseif ($answer -match '^(n|no)$') {
    $removeSpicetify = $false
  } else {
    Write-Warn 'Please enter Y or N.'
  }
}

# Close Spotify if running so files are not locked during restore/apply
$spotifyProcs = Get-Process -Name 'Spotify' -ErrorAction SilentlyContinue
if ($spotifyProcs) {
  Write-Step 'Closing Spotify...'
  $spotifyProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

# 1. Remove Sheet Music from Spicetify config and delete extension files
if (Test-Path -LiteralPath $SpicetifyExe -PathType Leaf) {
  Write-Step 'Removing sheetmusic.js from Spicetify config...'
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $SpicetifyExe config extensions sheetmusic.js- 2>$null | Out-Null
  $ErrorActionPreference = $prevPref
}

if (Test-Path -LiteralPath $ExtFile) {
  Remove-Item -LiteralPath $ExtFile -Force -ErrorAction SilentlyContinue
  Write-Ok "Removed $ExtFile"
}
if (Test-Path -LiteralPath $XpuiExtFile) {
  Remove-Item -LiteralPath $XpuiExtFile -Force -ErrorAction SilentlyContinue
  Write-Ok "Removed $XpuiExtFile"
}

if (-not $removeSpicetify) {
  # Keep Spicetify, just re-apply without sheetmusic.js
  if (Test-Path -LiteralPath $SpicetifyExe -PathType Leaf) {
    $spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
    $spotifyPrefs = Join-Path $env:APPDATA 'Spotify\prefs'
    if ((Test-Path -LiteralPath $spotifyExe -PathType Leaf) -and (Test-Path -LiteralPath $spotifyPrefs -PathType Leaf)) {
      Write-Step 'Re-applying Spicetify without Sheet Music...'
      $prevPref = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & $SpicetifyExe apply
      $ErrorActionPreference = $prevPref
    }
  }
  Write-Ok 'Sheet Music extension removed. Spicetify and your Spotify login were kept.'
  return
}

# 2. Full Spicetify removal: restore original Spotify files (keeps Spotify & login intact)
if (Test-Path -LiteralPath $SpicetifyExe -PathType Leaf) {
  Write-Step 'Restoring original Spotify files (Spotify and your login are preserved)...'
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $SpicetifyExe restore 2>$null | Out-Null
  $ErrorActionPreference = $prevPref
}

# Clean up any leftover xpui extension file if restore did not run
if (Test-Path -LiteralPath $XpuiExtFile) {
  Remove-Item -LiteralPath $XpuiExtFile -Force -ErrorAction SilentlyContinue
}

# 3. Remove Desktop shortcut
if (Test-Path -LiteralPath $DesktopShortcut) {
  Remove-Item -LiteralPath $DesktopShortcut -Force -ErrorAction SilentlyContinue
  Write-Ok "Removed Desktop shortcut: $DesktopShortcut"
}

# 4. Remove Spicetify directories and temp installer archives
foreach ($dir in @($SpicetifyDir, $SpicetifyAppData, $OldSpicetifyDir)) {
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Removed $dir"
  }
}

Get-ChildItem -Path ([System.IO.Path]::GetTempPath()) -Filter 'spicetify-*.zip' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

# 5. Remove Spicetify from User PATH and current session PATH
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath) {
  $cleanedUser = ($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $SpicetifyDir.TrimEnd('\')) }) -join ';'
  if ($cleanedUser -ne $userPath) {
    [Environment]::SetEnvironmentVariable('PATH', $cleanedUser, 'User')
    Write-Ok 'Removed Spicetify from User PATH'
  }
}
if ($env:PATH) {
  $env:PATH = ($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $SpicetifyDir.TrimEnd('\')) }) -join ';'
}

Write-Ok 'Clean uninstall complete! Spotify and your login were not removed, and you can reinstall anytime.'
