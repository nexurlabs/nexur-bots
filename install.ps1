# NexurBots, one command. Run this in PowerShell:
#
#   irm https://raw.githubusercontent.com/nexurlabs/nexur-bots/main/install.ps1 | iex
#
# Installs the latest NexurBots release, and Nous Research's Hermes first if it isn't on this PC yet.
# Switches, all optional, set as environment variables so they also work with `irm | iex` (they keep the
# names from before the app was renamed from Hermes Bots):
#   HERMES_BOTS_TARGET=pc|vps      skip the question: pc = this computer, vps = the app only
#   HERMES_BOTS_INSTALLER=<file>   install this installer file instead of the latest release (not checksummed)
#   HERMES_BOTS_DRY_RUN=1          print what would happen and change nothing

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 can default to older TLS; GitHub needs TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# The progress bar makes Invoke-WebRequest very slow on a download this size.
$ProgressPreference = 'SilentlyContinue'

$Repo = 'nexurlabs/nexur-bots'
$HermesInstallerUrl = 'https://hermes-agent.nousresearch.com/install.ps1'
# Releases up to 1.8.5 were named Hermes Bots; both names are accepted until every release is NexurBots.
$InstallerPattern = '^(NexurBots|Hermes-Bots)-Setup-.+\.exe$'
$AppNames = @('NexurBots', 'Hermes Bots')
# The same file the app starts Hermes from (electron/main.cjs, hermesCommand).
$HermesExe = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
$DryRun = $env:HERMES_BOTS_DRY_RUN -eq '1'

function Step($text) {
  Write-Host "==> $text"
}

function Get-PublishedHash($SumsText, $Name) {
  # SHA256SUMS.txt lines are "<hash>  <file>", or "<hash> *<file>" from sha256sum's binary mode.
  foreach ($line in ($SumsText -split "`r?`n")) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $Name) {
      return $parts[0].ToUpperInvariant()
    }
  }
  throw "SHA256SUMS.txt has no checksum for $Name, so it won't be installed."
}

function Test-Checksum($File, $Name, $SumsText) {
  # Refuses an installer whose SHA-256 doesn't match the one published with the release.
  $expected = Get-PublishedHash $SumsText $Name
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
  if ($actual -ne $expected) {
    throw "The download doesn't match its published checksum (expected $expected, got $actual). Nothing was installed."
  }
}

function Get-LatestInstaller {
  Step 'Looking up the latest NexurBots release'
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'nexur-bots-install' }
  $asset = $release.assets | Where-Object { $_.name -match $InstallerPattern } | Select-Object -First 1
  if (-not $asset) {
    throw "The latest release ($($release.tag_name)) has no Windows installer."
  }
  $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $sums) {
    throw "The latest release ($($release.tag_name)) has no SHA256SUMS.txt, so it won't be installed."
  }

  $file = Join-Path $env:TEMP $asset.name
  Step "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing
  # Saved to a file and read back as text: Windows PowerShell 5.1 hands a release asset (served as
  # application/octet-stream) to .Content as bytes, not text.
  $sumsFile = Join-Path $env:TEMP 'NexurBots-SHA256SUMS.txt'
  Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumsFile -UseBasicParsing
  Test-Checksum $file $asset.name (Get-Content -LiteralPath $sumsFile -Raw)
  return $file
}

function Find-AppExe {
  # A fresh install goes to Programs\NexurBots, but an upgrade over Hermes Bots (the old name) or a custom
  # folder lands elsewhere, so the uninstall entry is asked first. Its InstallLocation is often blank, while
  # UninstallString always names the uninstaller, which sits next to the app.
  $places = @()
  foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
    foreach ($key in (Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
      $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if (-not $entry -or "$($entry.DisplayName)" -notmatch '^(NexurBots|Hermes Bots)\b') { continue }
      if ($entry.InstallLocation) { $places += $entry.InstallLocation }
      if ("$($entry.UninstallString)" -match '^"?([^"]+\.exe)') { $places += (Split-Path -Parent $Matches[1]) }
    }
  }
  $places += (Join-Path $env:LOCALAPPDATA 'Programs\NexurBots'), (Join-Path $env:LOCALAPPDATA 'Programs\Hermes Bots')
  foreach ($dir in $places) {
    foreach ($name in $AppNames) {
      $file = Join-Path $dir "$name.exe"
      if (Test-Path -LiteralPath $file) { return $file }
    }
  }
  return $null
}

function Test-AppDataRedirected {
  # Claude Desktop runs its shell as an MSIX app, and MSIX redirects file writes under %LOCALAPPDATA% into the
  # app's package store. Hermes' Python step then fails with MissingPythonMinorVersionLinkTargetDirectory, so
  # this writes a probe file and checks whether it shows up in a package's LocalCache.
  $name = "nexurbots-probe-$([guid]::NewGuid().ToString('N')).tmp"
  $probe = Join-Path $env:LOCALAPPDATA $name
  Set-Content -LiteralPath $probe -Value 'probe'
  try {
    $copies = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Local\$name") }
    return [bool]$copies
  } finally {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  }
}

function Install-NexurBots {
  Write-Host 'NexurBots, one-command install'
  if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is for Windows.'
  }

  $target = $env:HERMES_BOTS_TARGET
  if (-not $target) {
    $target = 'pc'
    # A PowerShell started with -NonInteractive can't ask; it keeps the default, this PC.
    if ([Environment]::UserInteractive) {
      try {
        $answer = Read-Host 'Set up on this PC (1) or on a VPS (2)? [1]'
        if ($answer -eq '2') { $target = 'vps' }
      } catch {
        Step 'No way to ask here, so setting up on this PC'
      }
    }
  }
  if ($target -notin @('pc', 'vps')) {
    throw "HERMES_BOTS_TARGET must be pc or vps, not '$target'."
  }

  if (Get-Process -Name $AppNames -ErrorAction SilentlyContinue) {
    throw 'NexurBots is open. Close it first, then run this again.'
  }

  $installer = $env:HERMES_BOTS_INSTALLER

  if ($DryRun) {
    Step "Would install from $(if ($installer) { $installer } else { 'the latest GitHub release, after its checksum matches' })"
    if ($target -eq 'pc' -and -not (Test-Path -LiteralPath $HermesExe)) { Step "Would install Hermes from $HermesInstallerUrl" }
    Step "Would install NexurBots silently (into $(Join-Path $env:LOCALAPPDATA 'Programs\NexurBots'), or over an existing install)"
    Step 'Would open NexurBots'
    return
  }

  if ($installer) {
    if (-not (Test-Path -LiteralPath $installer)) { throw "No installer at $installer." }
    Step "Using $installer (its checksum isn't checked)"
  } else {
    $installer = Get-LatestInstaller
  }

  if ($target -eq 'pc') {
    if (Test-Path -LiteralPath $HermesExe) {
      Step 'Hermes is already installed'
    } else {
      if (Test-AppDataRedirected) {
        throw 'This PowerShell is running inside an app that redirects AppData writes (Claude Desktop does this), and the Hermes installer fails there. Open PowerShell from the Start menu, not from inside that app, then run this again.'
      }
      Step 'Installing Hermes (Nous Research installer)'
      Invoke-RestMethod -Uri $HermesInstallerUrl | Invoke-Expression
      if (-not (Test-Path -LiteralPath $HermesExe)) {
        throw 'Hermes did not install. Read the messages above, then run this again.'
      }
    }
  }

  Step 'Installing NexurBots'
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) {
    throw "The NexurBots installer failed (exit code $($setup.ExitCode))."
  }
  $appExe = Find-AppExe
  if (-not $appExe) {
    throw 'The installer finished, but the NexurBots app was not found.'
  }

  Step 'Opening NexurBots'
  Start-Process -FilePath $appExe
  if ($target -eq 'pc') {
    Write-Host 'Done. NexurBots is open. If it asks where Hermes runs, choose "This computer" and click Connect.'
  } else {
    Write-Host 'Done. Open Settings > Machines and add your VPS over SSH.'
  }
}

# HERMES_BOTS_NO_RUN lets a test load the functions above without running the install.
if (-not $env:HERMES_BOTS_NO_RUN) {
  Install-NexurBots
}
