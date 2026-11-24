$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRawBase = 'https://raw.githubusercontent.com/zbero915/spicetify-sheetmusic/main'
$SpicetifyDir = Join-Path $env:LOCALAPPDATA 'spicetify'
$OldSpicetifyDir = Join-Path $HOME 'spicetify-cli'
$SpicetifyExe = Join-Path $SpicetifyDir 'spicetify.exe'
$ExtensionsDir = Join-Path $SpicetifyDir 'Extensions'
$ExtFile = Join-Path $ExtensionsDir 'sheetmusic.js'

function Write-Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

if ($PSVersionTable.PSVersion -lt [version]'5.1') {
  throw "PowerShell 5.1 or higher is required (current: $($PSVersionTable.PSVersion))."
}

# 1. Migrate legacy spicetify-cli folder if present
if ((Test-Path -LiteralPath $OldSpicetifyDir) -and -not (Test-Path -LiteralPath $SpicetifyExe)) {
  Write-Step 'Migrating legacy spicetify-cli folder...'
  New-Item -ItemType Directory -Force -Path $SpicetifyDir | Out-Null
  Copy-Item -Path "$OldSpicetifyDir\*" -Destination $SpicetifyDir -Recurse -Force
  Remove-Item -Path $OldSpicetifyDir -Recurse -Force
}

# 2. Download and install Spicetify if not already installed
if (-not (Test-Path -LiteralPath $SpicetifyExe -PathType Leaf)) {
  Write-Step 'Downloading latest Spicetify CLI...'
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { 'x32' }
  }
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/spicetify/cli/releases/latest'
  $version = $release.tag_name -replace '^v', ''
  $zipUrl = "https://github.com/spicetify/cli/releases/download/v$version/spicetify-$version-windows-$arch.zip"
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) "spicetify-$version.zip"

  Invoke-WebRequest -Uri $zipUrl -UseBasicParsing -OutFile $zipPath
  New-Item -ItemType Directory -Force -Path $SpicetifyDir | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $SpicetifyDir -Force
  Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
  Write-Ok "Installed Spicetify v$version to $SpicetifyDir"
} else {
  Write-Ok "Spicetify already installed at $SpicetifyExe"
}

# Ensure Spicetify is on User PATH and current session PATH
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$SpicetifyDir*") {
  $newUserPath = if ($userPath) { "$userPath;$SpicetifyDir" } else { $SpicetifyDir }
  [Environment]::SetEnvironmentVariable('PATH', $newUserPath, 'User')
}
if (($env:PATH -split ';') -notcontains $SpicetifyDir) {
  $env:PATH = "$env:PATH;$SpicetifyDir"
}

# 3. Download sheetmusic.js to Spicetify Extensions folder
Write-Step "Downloading sheetmusic.js to $ExtFile..."
New-Item -ItemType Directory -Force -Path $ExtensionsDir | Out-Null
Invoke-WebRequest -Uri "$RepoRawBase/sheetmusic.js" -UseBasicParsing -OutFile $ExtFile
Write-Ok 'Downloaded sheetmusic.js'

# 4. Create Desktop shortcut for "<LocalUser>\AppData\Local\spicetify\spicetify.exe auto"
Write-Step 'Creating Desktop shortcut for Spicetify Auto...'
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDir 'Spicetify Auto.lnk'
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $SpicetifyExe
$shortcut.Arguments = 'auto'
$shortcut.WorkingDirectory = $SpicetifyDir
$shortcut.Description = 'Run spicetify.exe auto (re-apply Spicetify & Sheet Music after Spotify updates)'
$spotifyExe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
if (Test-Path -LiteralPath $spotifyExe -PathType Leaf) {
  $shortcut.IconLocation = "$spotifyExe,0"
}
$shortcut.Save()
Write-Ok "Created shortcut: $shortcutPath -> `"$SpicetifyExe`" auto"

# 5. Enable extension and apply to Spotify
$spotifyPrefs = Join-Path $env:APPDATA 'Spotify\prefs'
if (-not (Test-Path -LiteralPath $spotifyExe -PathType Leaf)) {
  Write-Warn "Standard desktop Spotify was not found at $spotifyExe."
  Write-Warn 'If you use the Microsoft Store version, please install the regular Spotify desktop app from https://www.spotify.com/download, open it once, and double-click "Spicetify Auto" on your Desktop.'
  return
}
if (-not (Test-Path -LiteralPath $spotifyPrefs -PathType Leaf)) {
  Write-Warn "Spotify prefs file not found at $spotifyPrefs. Open Spotify once, log in, and then run `"$SpicetifyExe`" auto (or double-click `"Spicetify Auto`" on your Desktop)."
  return
}

Write-Step 'Configuring and applying Sheet Music extension...'
$existingExt = (& $SpicetifyExe config extensions 2>$null) -join '|'
$extList = $existingExt -split '[|\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($extList -notcontains 'sheetmusic.js') {
  & $SpicetifyExe config extensions sheetmusic.js
}

& $SpicetifyExe auto
& $SpicetifyExe apply
Write-Ok 'All done! Sheet Music is installed, applied, and ready in Spotify.'
