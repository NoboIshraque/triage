#!/usr/bin/env bash
# Sets up a Linux machine to build Triage (ROADMAP P0-6). CI uses it too.
#
#   scripts/dev/setup.sh           install what is missing (apt needs sudo or root)
#   scripts/dev/setup.sh --app     also the libraries the VS Code fork needs (app/)
#   scripts/dev/setup.sh --eda     also what the KiCad fork needs (engines/eda/, ROADMAP P1-1)
#   scripts/dev/setup.sh --cad     also what the FreeCAD fork needs (engines/cad/, ROADMAP P2-1)
#   scripts/dev/setup.sh --check   only report what is missing; exit 1 if anything is
#
# Installs: build tools (GCC, CMake >= 3.25, Ninja, pkg-config, Python 3,
# clang-format 18) from apt; Node at the exact version in .nvmrc (official
# tarball, SHA-256 checked); pnpm through corepack; rustup and the Rust toolchain
# pinned in rust-toolchain.toml. Windows: scripts/dev/setup.ps1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
CMAKE_MIN="3.25"

CHECK=0
APP=0
EDA=0
CAD=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --app) APP=1 ;;
    --eda) EDA=1 ;;
    --cad) CAD=1 ;;
    *) echo "usage: scripts/dev/setup.sh [--check] [--app] [--eda] [--cad]" >&2; exit 2 ;;
  esac
done

APT_PACKAGES=(ca-certificates curl git xz-utils build-essential python3 cmake ninja-build pkg-config clang-format-18)
# What VS Code's own Linux CI installs (app/upstream/.github/actions/install-linux-packages).
APP_PACKAGES=(libxkbfile-dev libkrb5-dev libgbm1 libgtk-3-0 xvfb)
# KiCad 10's build dependencies from Ubuntu 24.04's archive (engines/eda/upstream/CMakeLists.txt).
EDA_PACKAGES=(ccache gettext swig python3-dev libwxgtk3.2-dev libwxgtk-webview3.2-dev libgtk-3-dev
  libglm-dev zlib1g-dev libzstd-dev libcurl4-openssl-dev libspnav-dev libcairo2-dev libpixman-1-dev
  libgit2-dev libboost-dev libboost-locale-dev libboost-test-dev libboost-filesystem-dev
  libfreetype-dev libharfbuzz-dev libfontconfig-dev libngspice0-dev libocct-data-exchange-dev
  libocct-modeling-algorithms-dev libocct-modeling-data-dev libocct-foundation-dev
  libocct-visualization-dev libocct-ocaf-dev libprotobuf-dev protobuf-compiler libgl-dev
  libglu1-mesa-dev libnng-dev libsecret-1-dev libpoppler-glib-dev unixodbc-dev)
# FreeCAD 1.1's App layer (no GUI) from Ubuntu 24.04's archive: the libraries
# engines/cad/upstream/CMakeLists.txt asks for with BUILD_GUI off, the Qt tools its
# translations need (patch 0001), and TBB, fontconfig, GL and X11, which Ubuntu's
# OpenCASCADE links (its visualization toolkit).
CAD_PACKAGES=(ccache python3-dev libboost-dev libboost-program-options-dev libboost-regex-dev
  libboost-thread-dev libboost-date-time-dev libboost-filesystem-dev libboost-iostreams-dev
  libboost-graph-dev libboost-serialization-dev libeigen3-dev libxerces-c-dev libyaml-cpp-dev
  libfmt-dev libicu-dev zlib1g-dev libfreetype-dev libocct-foundation-dev
  libocct-modeling-data-dev libocct-modeling-algorithms-dev libocct-ocaf-dev
  libocct-data-exchange-dev libocct-visualization-dev libtbb-dev qt6-base-dev qt6-base-dev-tools
  qt6-tools-dev qt6-tools-dev-tools qt6-l10n-tools libkdtree++-dev pybind11-dev swig
  libfontconfig-dev libgl-dev libx11-dev)

missing=()
say() { printf '%-14s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
add_path() {
  export PATH="$1:$PATH"
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$1" >> "$GITHUB_PATH"; fi
}
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# --- System packages -----------------------------------------------------------
packages=("${APT_PACKAGES[@]}")
if [ "$APP" = 1 ]; then packages+=("${APP_PACKAGES[@]}"); fi
if [ "$EDA" = 1 ]; then packages+=("${EDA_PACKAGES[@]}"); fi
if [ "$CAD" = 1 ]; then packages+=("${CAD_PACKAGES[@]}"); fi
if have dpkg-query; then
  absent=()
  for package in "${packages[@]}"; do
    # libgtk-3-0 is provided by libgtk-3-0t64 on Ubuntu 24.04.
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "ok installed" &&
      ! dpkg-query -W -f='${Status}' "${package}t64" 2>/dev/null | grep -q "ok installed"; then
      absent+=("$package")
    fi
  done
  if [ "${#absent[@]}" -gt 0 ]; then
    if [ "$CHECK" = 1 ]; then
      say "apt" "missing: ${absent[*]}"
      missing+=(apt)
    else
      say "apt" "installing: ${absent[*]}"
      $SUDO apt-get update -q
      DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -q --no-install-recommends "${absent[@]}"
    fi
  else
    say "apt" "ok"
  fi
else
  say "packages" "not a Debian/Ubuntu system: install ${packages[*]} with your package manager"
fi

# --- CMake ---------------------------------------------------------------------
if have cmake; then
  cmake_version="$(cmake --version | head -1 | awk '{print $3}')"
  if version_ge "$cmake_version" "$CMAKE_MIN"; then
    say "cmake" "$cmake_version ok"
  else
    say "cmake" "$cmake_version is older than $CMAKE_MIN (CMake presets need it): install a newer CMake"
    missing+=(cmake)
  fi
else
  say "cmake" "missing"
  missing+=(cmake)
fi

# --- Node (exact version from .nvmrc) ------------------------------------------
node_ok() {
  have node || return 1
  local found major_found major_needed
  found="$(node --version | sed 's/^v//')"
  major_found="${found%%.*}"
  major_needed="${NODE_VERSION%%.*}"
  [ "$major_found" = "$major_needed" ] && version_ge "$found" "$NODE_VERSION"
}
if node_ok; then
  say "node" "$(node --version) ok"
elif [ "$CHECK" = 1 ]; then
  say "node" "need $NODE_VERSION, found $(node --version 2>/dev/null || echo none)"
  missing+=(node)
else
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;;
  esac
  name="node-v$NODE_VERSION-linux-$arch"
  dest="${TRIAGE_TOOLS:-$HOME/.local/share/triage}/$name"
  if [ ! -x "$dest/bin/node" ]; then
    say "node" "installing $NODE_VERSION into $dest"
    tmp="$(mktemp -d)"
    base="https://nodejs.org/dist/v$NODE_VERSION"
    curl -fsSL --retry 4 -o "$tmp/$name.tar.xz" "$base/$name.tar.xz"
    curl -fsSL --retry 4 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
    (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
    mkdir -p "$dest"
    tar -xJf "$tmp/$name.tar.xz" -C "$dest" --strip-components=1
    rm -rf "$tmp"
  fi
  add_path "$dest/bin"
  say "node" "$(node --version) (add $dest/bin to your PATH)"
fi

# --- pnpm through corepack -----------------------------------------------------
if [ "$CHECK" = 0 ] && have corepack; then
  shim_dir="$HOME/.local/bin"
  mkdir -p "$shim_dir"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable --install-directory "$shim_dir"
  case ":$PATH:" in *":$shim_dir:"*) ;; *) add_path "$shim_dir" ;; esac
fi
if have pnpm; then
  say "pnpm" "$(cd "$ROOT" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version) ok"
else
  say "pnpm" "missing (corepack enable)"
  missing+=(pnpm)
fi

# --- Rust (rust-toolchain.toml) --------------------------------------------------
if ! have rustup && [ -x "$HOME/.cargo/bin/rustup" ]; then add_path "$HOME/.cargo/bin"; fi
if ! have rustup; then
  if [ "$CHECK" = 1 ]; then
    say "rustup" "missing"
    missing+=(rustup)
  else
    say "rustup" "installing"
    curl --proto '=https' --tlsv1.2 -sSf --retry 4 https://sh.rustup.rs |
      sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
    add_path "$HOME/.cargo/bin"
  fi
fi
if have rustup; then
  if [ "$CHECK" = 0 ]; then (cd "$ROOT" && rustup toolchain install); fi
  if (cd "$ROOT" && rustc --version >/dev/null 2>&1); then
    say "rust" "$(cd "$ROOT" && rustc --version) ok"
  else
    say "rust" "the toolchain in rust-toolchain.toml is not installed (rustup toolchain install)"
    missing+=(rust)
  fi
fi

# --- Summary -------------------------------------------------------------------
for tool in git ninja python3 clang-format-18; do
  if have "$tool"; then say "$tool" "ok"; else say "$tool" "missing"; missing+=("$tool"); fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing: ${missing[*]}" >&2
  exit 1
fi
echo "Ready to build Triage. Next: pnpm install && pnpm check; cargo test --workspace; cmake --workflow --preset dev"
