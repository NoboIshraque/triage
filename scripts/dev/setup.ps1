<#
.SYNOPSIS
  Sets up a Windows machine to build Triage (ROADMAP P0-6). CI uses it too.

.DESCRIPTION
  scripts\dev\setup.ps1             install what is missing (winget, or Chocolatey if winget is absent)
  scripts\dev\setup.ps1 -App        also what the VS Code fork (app\) needs: Spectre-mitigated libraries
  scripts\dev\setup.ps1 -Eda        also what the KiCad fork (engines\eda\) needs: vcpkg (VCPKG_ROOT,
                                    cloned and bootstrapped if unset) and ccache 4 (ROADMAP P1-1)
  scripts\dev\setup.ps1 -Cad        also what the FreeCAD fork (engines\cad\) needs: FreeCAD's LibPack
                                    (FREECAD_LIBPACK_DIR, downloaded and SHA-256 checked if unset) and
                                    ccache 4 (ROADMAP P2-1)
  scripts\dev\setup.ps1 -DevShell   load the Visual Studio C++ environment into this shell
                                    (and, on GitHub Actions, into the later steps of the job)
  scripts\dev\setup.ps1 -Check      only report what is missing; exit 1 if anything is

  Installs: Git; Node at the exact version in .nvmrc (official zip, SHA-256 checked);
  pnpm through corepack; Python 3 (node-gyp); Visual Studio Build Tools with the C++
  workload; rustup and the toolchain pinned in rust-toolchain.toml (MSVC); CMake 3.25+
  and Ninja. Linux: scripts/dev/setup.sh.
#>
param([switch]$Check, [switch]$App, [switch]$Eda, [switch]$Cad, [switch]$DevShell)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$NodeVersion = (Get-Content (Join-Path $Root '.nvmrc') -Raw).Trim()
$CMakeMin = [version]'3.25'
$Tools = Join-Path $env:LOCALAPPDATA 'triage'
$VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$VcTools = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
$Spectre = 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
$Missing = New-Object System.Collections.Generic.List[string]

function Say([string]$Tool, [string]$Text) { Write-Host ('{0,-14} {1}' -f $Tool, $Text) }
function Have([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Add-ToPath([string]$Dir) {
  $env:Path = "$Dir;$env:Path"
  if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $Dir }
  else {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not ($user -split ';' -contains $Dir)) {
      [Environment]::SetEnvironmentVariable('Path', "$Dir;$user", 'User')
    }
  }
}

function Install-Tool([string]$Tool, [string]$WingetId, [string]$ChocoId, [string[]]$WingetArgs = @()) {
  Say $Tool "installing"
  if (Have 'winget') {
    winget install --id $WingetId --exact --silent --accept-package-agreements --accept-source-agreements @WingetArgs
  } elseif (Have 'choco') {
    choco install $ChocoId -y --no-progress
  } else {
    throw "Install $Tool by hand: neither winget nor Chocolatey is available"
  }
  # Pick up PATH changes made by the installer.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}

function Require([string]$Tool, [scriptblock]$Test, [scriptblock]$Install) {
  if (& $Test) { return $true }
  if ($Check) { Say $Tool 'missing'; $Missing.Add($Tool); return $false }
  # Package servers fail now and then (Chocolatey answered 504 on 2026-11-25), so
  # try three times. Installer output must not become this function's return value.
  foreach ($wait in 0, 20, 60) {
    if ($wait) { Say $Tool "retrying in $wait s"; Start-Sleep -Seconds $wait }
    & $Install | Out-Host
    if (& $Test) { return $true }
  }
  Say $Tool 'still missing after installing'
  $Missing.Add($Tool)
  return $false
}

function Get-VsPath([string[]]$Components) {
  if (-not (Test-Path $VsWhere)) { return $null }
  $path = & $VsWhere -latest -products * -requires $Components -property installationPath
  if ($path) { return ($path | Select-Object -First 1) }
  return $null
}

# --- Git ---------------------------------------------------------------------------
if (Require 'git' { Have 'git' } { Install-Tool 'git' 'Git.Git' 'git' }) { Say 'git' 'ok' }

# --- Node (exact version from .nvmrc) -------------------------------------------------
function Test-Node {
  if (-not (Have 'node')) { return $false }
  $found = [version]((node --version).TrimStart('v'))
  $needed = [version]$NodeVersion
  return ($found.Major -eq $needed.Major -and $found -ge $needed)
}
$nodeDir = Join-Path $Tools "node-v$NodeVersion-win-x64"
if (-not (Test-Node) -and (Test-Path (Join-Path $nodeDir 'node.exe'))) { Add-ToPath $nodeDir }
if (Require 'node' { Test-Node } {
    Say 'node' "installing $NodeVersion into $nodeDir"
    $name = "node-v$NodeVersion-win-x64"
    $base = "https://nodejs.org/dist/v$NodeVersion"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "triage-node-$PID"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile (Join-Path $tmp "$name.zip")
    Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile (Join-Path $tmp 'SHASUMS256.txt')
    $expected = (Select-String -Path (Join-Path $tmp 'SHASUMS256.txt') -Pattern " $name\.zip$").Line.Split(' ')[0]
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp "$name.zip")).Hash.ToLower()
    if ($expected -ne $actual) { throw "Node download checksum mismatch: $actual, expected $expected" }
    New-Item -ItemType Directory -Force -Path $Tools | Out-Null
    Expand-Archive -Path (Join-Path $tmp "$name.zip") -DestinationPath $Tools -Force
    Remove-Item -Recurse -Force $tmp
    Add-ToPath $nodeDir
  }) { Say 'node' "$(node --version) ok" }

# --- pnpm through corepack ---------------------------------------------------------
if (-not $Check -and (Have 'corepack')) {
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  $shims = Join-Path $Tools 'bin'
  New-Item -ItemType Directory -Force -Path $shims | Out-Null
  corepack enable --install-directory $shims
  if (-not ($env:Path -split ';' -contains $shims)) { Add-ToPath $shims }
}
if (Have 'pnpm') {
  Push-Location $Root
  try { Say 'pnpm' "$(pnpm --version) ok" } finally { Pop-Location }
} else { Say 'pnpm' 'missing (corepack enable)'; $Missing.Add('pnpm') }

# --- Python 3 (node-gyp) -------------------------------------------------------------
function Test-Python {
  if (-not (Have 'python')) { return $false }
  return ((python --version 2>&1) -match '^Python 3\.')
}
if (Require 'python' { Test-Python } { Install-Tool 'python' 'Python.Python.3.12' 'python312' }) {
  Say 'python' "$(python --version 2>&1) ok"
}

# --- Visual Studio C++ (MSVC) -------------------------------------------------------
$vsComponents = @($VcTools)
if ($App) { $vsComponents += $Spectre }
$vs = Get-VsPath $vsComponents
if (-not $vs -and -not $Check) {
  $existing = Get-VsPath @($VcTools)
  $installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
  if ($existing -and (Test-Path $installer)) {
    Say 'msvc' "adding $($vsComponents -join ', ') to $existing"
    $add = $vsComponents | ForEach-Object { '--add'; $_ }
    $process = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList (@('modify', '--installPath', "`"$existing`"") + $add + @('--quiet', '--norestart', '--nocache'))
    if ($process.ExitCode -notin 0, 3010) { throw "Visual Studio Installer exited with $($process.ExitCode)" }
  } else {
    $override = '--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended ' + (($vsComponents | ForEach-Object { "--add $_" }) -join ' ')
    Install-Tool 'msvc' 'Microsoft.VisualStudio.2022.BuildTools' 'visualstudio2022-workload-vctools' @('--override', $override)
  }
  $vs = Get-VsPath $vsComponents
}
if ($vs) { Say 'msvc' "$vs ok" } else { Say 'msvc' "missing: Visual Studio with $($vsComponents -join ', ')"; $Missing.Add('msvc') }

# --- Rust (rust-toolchain.toml, MSVC host) --------------------------------------------
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Have 'rustup') -and (Test-Path (Join-Path $cargoBin 'rustup.exe'))) { Add-ToPath $cargoBin }
if (Require 'rustup' { Have 'rustup' } {
    Say 'rustup' 'installing'
    $init = Join-Path ([IO.Path]::GetTempPath()) 'rustup-init.exe'
    Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $init
    & $init -y --profile minimal --default-toolchain none --default-host x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw "rustup-init exited with $LASTEXITCODE" }
    Add-ToPath $cargoBin
  }) {
  Push-Location $Root
  try {
    if (-not $Check) { rustup toolchain install; if ($LASTEXITCODE -ne 0) { throw 'rustup toolchain install failed' } }
    $rustc = rustc --version 2>$null
    if ($LASTEXITCODE -eq 0) { Say 'rust' "$rustc ok" } else { Say 'rust' 'toolchain from rust-toolchain.toml missing'; $Missing.Add('rust') }
  } finally { Pop-Location }
}

# --- CMake and Ninja -------------------------------------------------------------------
function Test-CMake {
  if (-not (Have 'cmake')) { return $false }
  $line = (cmake --version | Select-Object -First 1)
  return ([version](($line -split ' ')[2] -replace '-.*$', '') -ge $CMakeMin)
}
if (Require 'cmake' { Test-CMake } { Install-Tool 'cmake' 'Kitware.CMake' 'cmake' }) {
  Say 'cmake' "$((cmake --version | Select-Object -First 1)) ok"
}
if (Require 'ninja' { Have 'ninja' } { Install-Tool 'ninja' 'Ninja-build.Ninja' 'ninja' }) { Say 'ninja' 'ok' }

# --- KiCad fork: vcpkg and ccache ------------------------------------------------------
if ($Eda) {
  # KiCad builds its dependencies from its vcpkg.json; GitHub's runners carry a vcpkg.
  if (-not $env:VCPKG_ROOT -and $env:VCPKG_INSTALLATION_ROOT) { $env:VCPKG_ROOT = $env:VCPKG_INSTALLATION_ROOT }
  if (-not $env:VCPKG_ROOT) { $env:VCPKG_ROOT = Join-Path $Tools 'vcpkg' }
  if (Require 'vcpkg' { Test-Path (Join-Path $env:VCPKG_ROOT 'vcpkg.exe') } {
      if (-not (Test-Path (Join-Path $env:VCPKG_ROOT '.git'))) {
        git clone --quiet https://github.com/microsoft/vcpkg.git $env:VCPKG_ROOT
      }
      & (Join-Path $env:VCPKG_ROOT 'bootstrap-vcpkg.bat') -disableMetrics
    }) {
    Say 'vcpkg' "$env:VCPKG_ROOT ok"
    if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "VCPKG_ROOT=$env:VCPKG_ROOT" }
    else { [Environment]::SetEnvironmentVariable('VCPKG_ROOT', $env:VCPKG_ROOT, 'User') }
  }
}

# --- Compiler cache for the engine forks ------------------------------------------------
if ($Eda -or $Cad) {
  # Strawberry Perl's old ccache on the runners can't cache MSVC; ccache 4 can.
  function Test-Ccache {
    $exe = Get-Command ccache -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'Strawberry' } | Select-Object -First 1
    if (-not $exe) { return $false }
    $env:CCACHE_EXE = $exe.Source
    return ((& $exe.Source --version | Select-Object -First 1) -match 'version 4\.')
  }
  if (Require 'ccache' { Test-Ccache } { Install-Tool 'ccache' 'Ccache.Ccache' 'ccache' }) {
    [void](Test-Ccache)
    Say 'ccache' "$env:CCACHE_EXE ok"
    if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "CCACHE_EXE=$env:CCACHE_EXE" }
  }
}

# --- FreeCAD fork: LibPack ---------------------------------------------------------------
if ($Cad) {
  # FreeCAD's own bundle of its Windows dependencies (Python 3.12, Qt 6, OpenCASCADE,
  # Boost, Xerces …): the one FreeCAD 1.1.4's own CI builds with
  # (engines/cad/upstream/.github/workflows/actions/windows/getLibpack).
  $LibPackName = 'LibPack-1.1.0-v3.1.1.3-Release'
  $LibPackUrl = "https://github.com/FreeCAD/FreeCAD-LibPack/releases/download/3.1.1.3/$LibPackName.7z"
  $LibPackSha256 = '3565842b2f2c464d891d37f1ce8467f2cd0b3dd758a6dfacc7acfeff290b67d4'
  if (-not $env:FREECAD_LIBPACK_DIR) { $env:FREECAD_LIBPACK_DIR = Join-Path $Tools $LibPackName }
  function Test-LibPack { Test-Path (Join-Path $env:FREECAD_LIBPACK_DIR 'bin\Qt6Core.dll') }
  if (-not (Test-LibPack) -and -not $Check) {
    [void](Require '7-zip' { (Have '7z') -or (Test-Path "$env:ProgramFiles\7-Zip\7z.exe") } { Install-Tool '7-zip' '7zip.7zip' '7zip' })
  }
  if (Require 'libpack' { Test-LibPack } {
      $sevenZip = if (Have '7z') { (Get-Command 7z).Source } else { "$env:ProgramFiles\7-Zip\7z.exe" }
      $archive = Join-Path ([IO.Path]::GetTempPath()) "$LibPackName.7z"
      Invoke-WebRequest -Uri $LibPackUrl -OutFile $archive
      $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
      if ($actual -ne $LibPackSha256) { throw "LibPack checksum mismatch: $actual" }
      $parent = Split-Path $env:FREECAD_LIBPACK_DIR -Parent
      New-Item -ItemType Directory -Force $parent | Out-Null
      & $sevenZip x $archive "-o$parent" -y -bso0 -bsp0
      if ($LASTEXITCODE -ne 0) { throw "7-Zip failed to unpack $archive" }
      $unpacked = Join-Path $parent $LibPackName
      if ($unpacked -ne $env:FREECAD_LIBPACK_DIR) { Move-Item $unpacked $env:FREECAD_LIBPACK_DIR }
      Remove-Item $archive
    }) {
    Say 'libpack' "$env:FREECAD_LIBPACK_DIR ok"
    if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "FREECAD_LIBPACK_DIR=$env:FREECAD_LIBPACK_DIR" }
    else { [Environment]::SetEnvironmentVariable('FREECAD_LIBPACK_DIR', $env:FREECAD_LIBPACK_DIR, 'User') }
  }
}

# --- Visual Studio developer environment ----------------------------------------------
if ($DevShell -and $vs) {
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  $before = @{}
  Get-ChildItem env: | ForEach-Object { $before[$_.Name.ToUpperInvariant()] = $_.Value }
  $oldPath = $env:Path -split ';'
  $lines = cmd /c "`"$vcvars`" >nul && set"
  if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed" }
  $newPathEntries = @()
  foreach ($line in $lines) {
    if ($line -notmatch '^([^=]+)=(.*)$') { continue }
    $name = $Matches[1]; $value = $Matches[2]
    if ($name -ieq 'Path') {
      $newPathEntries = @($value -split ';' | Where-Object { $_ -and ($oldPath -notcontains $_) })
      $env:Path = $value
    } elseif ($before[$name.ToUpperInvariant()] -ne $value) {
      Set-Item -Path "env:$name" -Value $value
      if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "$name=$value" }
    }
  }
  if ($env:GITHUB_PATH) {
    # Each GITHUB_PATH line is prepended, so write the entries last-first.
    [array]::Reverse($newPathEntries)
    foreach ($dir in $newPathEntries) { Add-Content -Path $env:GITHUB_PATH -Value $dir }
  }
  Say 'devshell' "Visual Studio C++ environment loaded (cl, link, Windows SDK)"
}

if ($Missing.Count -gt 0) {
  Write-Host "Missing: $($Missing -join ', ')"
  exit 1
}
Write-Host 'Ready to build Triage. Next: pnpm install; pnpm check; cargo test --workspace; cmake --workflow --preset dev (from a developer shell: -DevShell)'
