#!/usr/bin/env bash
# Reproduce the REA teardown that informed docs/PLAN.md.
#
# Downloads the shipped Linux builds that were analyzed on 2026-11-23, extracts
# them into separate directories, and runs the same REA CLI commands. Nothing
# downloaded here is executed; REA reads the files statically.
#
# Usage:
#   REA="node /path/to/rea/scripts/rea.mjs" scripts/research/teardown.sh /abs/workdir
#   (REA defaults to `npx -y rea-agents@6.7.0`.)
#
# Requirements: curl, dpkg-deb, tar, xz, python3, pip, npm, readelf, Node 22.19+.
# Disk: ~4 GB. The VS Code renderer bundle needs ~4 GB RAM and >15 min to analyze.
set -uo pipefail

WORK="${1:?usage: teardown.sh /absolute/workdir}"
REA="${REA:-npx -y rea-agents@6.7.0}"
T="$WORK/targets"; E="$WORK/evidence"
mkdir -p "$T"/{vscodium,blender,kicad,renode,mujoco,npm,ngspice} "$E"

log() { printf '\n== %s\n' "$*"; }
dl() { # url dest — retry with backoff
  for i in 1 2 3 4 5; do curl -sSfL --max-time 900 -o "$2" "$1" && return 0; sleep $((i * 3)); done
  echo "download failed: $1" >&2; return 1
}
run() { # name -- rea args...   (keeps going on failure; output saved as evidence)
  local name="$1"; shift; shift
  $REA "$@" --json > "$E/$name.json" 2> "$E/$name.err" || echo "  (non-zero exit; see $E/$name.err)"
}

log "Download shipped builds (versions pinned to the 2026-11-23 analysis)"
KICAD_POOL=https://ppa.launchpadcontent.net/kicad/kicad-10.0-releases/ubuntu/pool/main/k/kicad
dl https://download.vscodium.com/debs/pool/main/c/codium/codium_1.143.17232_amd64.deb "$T/vscodium/codium.deb"
dl https://download.blender.org/release/Blender5.3/blender-5.3.0-linux-x64.tar.xz "$T/blender/blender.tar.xz"
dl "$KICAD_POOL/kicad_10.0.8~ubuntu24.04.1_amd64.deb" "$T/kicad/kicad.deb"
dl "$KICAD_POOL/kicad-demos_10.0.8~ubuntu24.04.1_all.deb" "$T/kicad/kicad-demos.deb"
dl https://builds.renode.io/renode-latest.linux-portable-dotnet.tar.gz "$T/renode/renode.tar.gz"
(cd "$T/mujoco" && pip3 download --no-deps --only-binary=:all: --platform manylinux_2_28_x86_64 \
   --python-version 3.13 mujoco-core==4.0.1 -q -d .)
(cd "$T/npm" && npm pack avr8js@0.21.1 rp2040js@1.4.2 @wokwi/elements@1.9.2 eecircuit-engine@1.9.0 --silent)
(cd "$T/ngspice" && apt-get download libngspice0 ngspice simavr libsimavr2)

log "Extract (each target in its own directory)"
mkdir -p "$T/vscodium/x" "$T/blender/x" "$T/kicad/x" "$T/kicad/demos" "$T/renode/x" "$T/mujoco/core"
dpkg-deb -x "$T/vscodium/codium.deb" "$T/vscodium/x"
tar -xJf "$T/blender/blender.tar.xz" -C "$T/blender/x"
dpkg-deb -x "$T/kicad/kicad.deb" "$T/kicad/x"; dpkg-deb -x "$T/kicad/kicad-demos.deb" "$T/kicad/demos"
tar -xzf "$T/renode/renode.tar.gz" -C "$T/renode/x"
(cd "$T/mujoco/core" && python3 -I -m zipfile -e ../mujoco_core-*.whl .)
(cd "$T/npm" && for f in *.tgz; do d="${f%.tgz}"; mkdir -p "$d" && tar -xzf "$f" -C "$d"; done)
(cd "$T/ngspice" && for f in *.deb; do d="x-${f%%_*}"; mkdir -p "$d" && dpkg-deb -x "$f" "$d"; done)

V="$T/vscodium/x/usr/share/codium"; A="$V/resources/app"
B="$(ls -d "$T"/blender/x/blender-*)"; K="$T/kicad/x/usr"; R="$(ls -d "$T"/renode/x/*)"

log "VS Code (VSCodium build of Code-OSS, MIT)"
run vscodium-desktop -- inspect-desktop-application "$V" --detail summary --evidence_output "$E/vscodium-desktop.bundle.json"
run vscodium-fuses -- inspect-electron-fuses "$V/codium"
SRC=(package.json product.json out/main.js out/mainImpl.js out/cli.js out/bootstrap-fork.js
  out/vs/base/parts/sandbox/electron-browser/preload.js out/vs/code/electron-browser/workbench/workbench.js
  out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js out/vs/workbench/api/node/extensionHostProcess.js
  out/vs/platform/terminal/node/ptyHostMain.js out/vs/platform/files/node/watcher/watcherMain.js
  out/vs/platform/agentHost/node/agentHostMain.js out/vs/code/node/cliProcessMain.js
  out/vs/workbench/workbench.desktop.main.js)
ARGS=(); for s in "${SRC[@]}"; do ARGS+=(--source-path "$s"); done
# The 21 MB renderer bundle exceeded 900 s on 4 cores; raise the deadline for complete coverage.
run vscodium-app -- analyze-javascript-application "$A" --detail summary \
  --evidence_output "$E/vscodium-app.bundle.json" --max-heap-mb 6144 --analysis-timeout-ms 3600000 "${ARGS[@]}"

log "Blender 5.3 (GPL)"
run blender-desktop -- inspect-desktop-application "$B" --detail summary --evidence_output "$E/blender-desktop.bundle.json"
run blender-exports -- inspect-native-exports "$B/blender"
run blender-elfnotes -- inspect-elf-notes "$B/blender" --max-file-bytes 300000000 --max-entries 256
readelf -d "$B/blender" > "$E/blender-dynamic.txt"

log "KiCad 10.0.8 (GPL)"
run kicad-desktop -- inspect-desktop-application "$K" --detail summary --evidence_output "$E/kicad-desktop.bundle.json"
for f in bin/_pcbnew.kiface bin/_eeschema.kiface bin/_kipython.kiface bin/kicad-cli bin/kicad \
         lib/x86_64-linux-gnu/libkiapi.so.10.0.8 lib/x86_64-linux-gnu/libkicommon.so.10.0.8 \
         lib/x86_64-linux-gnu/libkigal.so.10.0.8; do
  n="$(basename "$f")"; run "kicad-exports-$n" -- inspect-native-exports "$K/$f"
  readelf -d "$K/$f" > "$E/kicad-dynamic-$n.txt"
done

log "Simulators"
run ngspice-exports -- inspect-native-exports "$T/ngspice/x-libngspice0/usr/lib/x86_64-linux-gnu/libngspice.so.0.0.9"
run simavr-exports -- inspect-native-exports "$T/ngspice/x-libsimavr2/usr/lib/x86_64-linux-gnu/libsimavr.so.2"
run mujoco-exports -- inspect-native-exports "$T/mujoco/core/mujoco/libmujoco.so.4.0.1"
run renode-desktop -- inspect-desktop-application "$R" --detail summary --evidence_output "$E/renode-desktop.bundle.json"
run renode-infra-artifact -- inspect-managed-artifact "$R/Infrastructure.dll"
run renode-cosim-members -- inspect-managed-members "$R/CoSimulationPlugin.dll"
for p in avr8js-0.21.1 rp2040js-1.4.2; do
  run "$p" -- analyze-javascript-application "$T/npm/$p/package" --detail summary --evidence_output "$E/$p.bundle.json"
done

log "Done. Evidence in $E. Compare Evidence IDs with docs/research/evidence-ledger.md."
