# Spicetify Sheet Music

A single-file Spicetify extension that adds a **Sheet music** button to Spotify's player bar, fetches matching public-domain scores from Wikimedia Commons, detects staves and bars, and highlights the current bar during playback.

> **Coverage note:** Scores are sourced from Wikimedia Commons, so classical and public-domain pieces are usually found, while copyrighted modern pop/rock tracks will show `"No sheet music found for this track."`.

## One-Line Install (Windows PowerShell)

Run this command in **PowerShell** (not as Administrator):

```powershell
irm https://raw.githubusercontent.com/zbero915/spicetify-sheetmusic/main/install.ps1 | iex
```

What this does automatically:
1. Installs **Spicetify** to `%LOCALAPPDATA%\spicetify` (if not already installed) and adds it to your user `PATH`.
2. Downloads `sheetmusic.js` into `%LOCALAPPDATA%\spicetify\Extensions\sheetmusic.js`.
3. Enables `sheetmusic.js` and applies Spicetify to Spotify.
4. Creates a **Spicetify Auto** shortcut on your Desktop running `"<YourUser>\AppData\Local\spicetify\spicetify.exe" auto` so you can re-apply easily whenever Spotify updates.

## Controls

- **Player-bar music note button**: Open / close Sheet Music (pressing any other menu like Home, Search, Library, Queue, or Lyrics switches away automatically).
- **Click any bar**: Jump Spotify playback to that bar.
- **Clock button (or `Shift+click` a bar)**: Choose the bar playing right now to fix drift.
- **`Alt+click` a bar**: Reset manual sync adjustments for the current track.
- **Top-right icons**: Sync bar, Try another score, Night mode, Download PDF, Close.

## Update (Windows PowerShell)

Run this command in **PowerShell** (not as Administrator):

```powershell
irm https://raw.githubusercontent.com/zbero915/spicetify-sheetmusic/main/update.ps1 | iex
```

Updates Spicetify CLI, downloads the latest `sheetmusic.js`, and re-applies it to Spotify.

## Uninstall (Windows PowerShell)

Run this command in **PowerShell** (not as Administrator):

```powershell
irm https://raw.githubusercontent.com/zbero915/spicetify-sheetmusic/main/uninstall.ps1 | iex
```

It asks whether to remove **Spicetify** completely (`Y` restores Spotify without touching your app or login, removes the Desktop shortcut, deletes Spicetify folders, and cleans `PATH`) or keep Spicetify and remove only the **Sheet Music** extension (`N`).
