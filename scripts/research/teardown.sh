#!/usr/bin/env bash
# Reproduce the REA breakdowns behind docs/research/ (round 2: unbounded mode).
#
# Downloads the shipped Linux builds analyzed on 2026-11-23/24, extracts each into
# its own directory, and runs REA statically (nothing downloaded is executed).
#
# Usage:
#   REA=/abs/path/to/rea/scripts/rea-unbounded.sh scripts/research/teardown.sh /abs/workdir
# REA must be the unbounded build from NoboIshraque/rea (branch
# claude/unified-engineering-platform-jn5rmk); the npm package stops at bounded defaults.
#
# Needs: curl, dpkg-deb, tar, xz, python3 (+venv for pyelftools-free addr2line path),
# pip, npm, readelf, addr2line, c++filt, strings. Disk ~8 GB.
# Memory: runs heavy jobs one at a time. Cloud sessions restarted when background
# jobs used ~10 GB together, so keep the total under ~6-8 GB.
set -uo pipefail

WORK="${1:?usage: teardown.sh /absolute/workdir}"
REA="${REA:?set REA to the unbounded launcher, e.g. ../rea/scripts/rea-unbounded.sh}"
T="$WORK/targets"; E="$WORK/evidence"
mkdir -p "$T"/{vscodium,blender,kicad,kicad-dbg,freecad,renode,mujoco,npm,ngspice,wokwi} "$E"/{kicad,freecad}

log() { printf '\n== %s\n' "$*"; }
dl() { for i in 1 2 3 4 5 6; do curl -sSfL --max-time 1800 -o "$2" "$1" && return 0; sleep $((i * 3)); done
       echo "download failed: $1" >&2; return 1; }
run() { local name="$1"; shift; "$REA" "$@" --json > "$E/$name.json" 2> "$E/$name.err" || echo "  (non-zero exit: $E/$name.err)"; }

log "Download (versions pinned to the analysis)"
KP=https://ppa.launchpadcontent.net/kicad/kicad-10.0-releases/ubuntu/pool/main/k/kicad
FP=https://ppa.launchpadcontent.net/freecad-maintainers/freecad-daily/ubuntu/pool/main/f/freecad-daily
dl https://download.vscodium.com/debs/pool/main/c/codium/codium_1.143.17232_amd64.deb "$T/vscodium/codium.deb"
dl https://download.blender.org/release/Blender5.3/blender-5.3.0-linux-x64.tar.xz "$T/blender/blender.tar.xz"
dl "$KP/kicad_10.0.8~ubuntu24.04.1_amd64.deb" "$T/kicad/kicad.deb"
dl "$KP/kicad-demos_10.0.8~ubuntu24.04.1_all.deb" "$T/kicad/kicad-demos.deb"
dl "$KP/kicad-dbg_10.0.8~ubuntu24.04.1_amd64.deb" "$T/kicad-dbg/kicad-dbg.deb"
dl "$FP/libfreecad-daily-python3-1.1_1.1~pre1~202508270404~ubuntu24.04.1_amd64.deb" "$T/freecad/libfreecad.deb"
dl https://builds.renode.io/renode-latest.linux-portable-dotnet.tar.gz "$T/renode/renode.tar.gz"
dl https://open-vsx.org/api/Wokwi/wokwi-vscode/4.1.0/file/Wokwi.wokwi-vscode-4.1.0.vsix "$T/wokwi/wokwi.vsix"
(cd "$T/mujoco" && pip3 download --no-deps --only-binary=:all: --platform manylinux_2_28_x86_64 \
   --python-version 3.13 mujoco-core==4.0.1 -q -d .)
(cd "$T/npm" && npm pack avr8js@0.21.1 rp2040js@1.4.2 eecircuit-engine@1.9.0 --silent)
(cd "$T/ngspice" && apt-get download libngspice0 simavr libsimavr2)

log "Extract (each target in its own directory)"
for d in vscodium kicad kicad-dbg freecad; do mkdir -p "$T/$d/x"; done
dpkg-deb -x "$T/vscodium/codium.deb" "$T/vscodium/x"
dpkg-deb -x "$T/kicad/kicad.deb" "$T/kicad/x"; mkdir -p "$T/kicad/demos"; dpkg-deb -x "$T/kicad/kicad-demos.deb" "$T/kicad/demos"
dpkg-deb -x "$T/kicad-dbg/kicad-dbg.deb" "$T/kicad-dbg/x"
dpkg-deb -x "$T/freecad/libfreecad.deb" "$T/freecad/x"
mkdir -p "$T/blender/x" "$T/renode/x" "$T/wokwi/x" "$T/mujoco/core"
tar -xJf "$T/blender/blender.tar.xz" -C "$T/blender/x"
tar -xzf "$T/renode/renode.tar.gz" -C "$T/renode/x"
(cd "$T/wokwi/x" && python3 -I -m zipfile -e ../wokwi.vsix .)
(cd "$T/mujoco/core" && python3 -I -m zipfile -e ../mujoco_core-*.whl .)
(cd "$T/npm" && for f in *.tgz; do d="${f%.tgz}"; mkdir -p "$d" && tar -xzf "$f" -C "$d"; done)
(cd "$T/ngspice" && for f in *.deb; do d="x-${f%%_*}"; mkdir -p "$d" && dpkg-deb -x "$f" "$d"; done)

A="$T/vscodium/x/usr/share/codium/resources/app"; B="$(ls -d "$T"/blender/x/blender-*)"
K="$T/kicad/x/usr"; DBG="$T/kicad-dbg/x/usr/lib/debug/.build-id"; R="$(ls -d "$T"/renode/x/*)"
FC="$T/freecad/x/usr/lib/freecad-daily-python3/lib"

log "VS Code (one heavy run at a time; the two 21-22 MB bundles dominate)"
run vscode-fuses inspect-electron-fuses "$A/../../codium"
for part in out extensions; do
  REA_PARENT_HEAP_MB=1536 run "vscode-$part" analyze-javascript-application "$A/$part" \
    --detail summary --evidence_output "$E/vscode-$part.bundle.json" --max-heap-mb 6144
done

log "KiCad 10.0.8 with debug symbols"
for f in $(find "$K/bin" "$K/lib" -type f \( -name '*.kiface' -o -name '*.so*' -o -perm -u+x \)); do
  file -b "$f" | grep -q ELF || continue
  n="$(basename "$f")"; run "kicad/notes-$n" inspect-elf-notes "$f"
  run "kicad/exports-$n" inspect-native-exports "$f"
  bid="$(python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1])); print(next((e["gnu"]["build_id_hex"] for e in s["normalized_result"]["entries"] if (e.get("gnu") or {}).get("build_id_hex")), ""))' "$E/kicad/notes-$n.json" 2>/dev/null)"
  dbg="$DBG/${bid:0:2}/${bid:2}.debug"
  [ -n "$bid" ] && [ -f "$dbg" ] && run "kicad/syms-$n" inspect-with-objdump "$dbg" symbols
done
echo "  size map: map each function address with 'addr2line -e <debug>' (LTO build); see docs/research/kicad.md"

log "FreeCAD 1.1 (every library; symlinks and .a archives are skipped by REA)"
for f in "$FC"/*.so*; do [ -L "$f" ] || run "freecad/$(basename "$f")" inspect-native-exports "$f"; done

log "Blender 5.3 (static; a runtime API dump needs permission to execute the binary)"
run blender-exports inspect-native-exports "$B/blender"
run blender-elfnotes inspect-elf-notes "$B/blender"
strings -n 6 "$B/blender" | grep -oE "(source/blender|intern|extern)/[A-Za-z0-9_./+-]+\.(cc|c|cpp|hh|h)" | sort -u > "$E/blender-srcpaths.txt"

log "Simulators"
run ngspice-exports inspect-native-exports "$T/ngspice/x-libngspice0/usr/lib/x86_64-linux-gnu/libngspice.so.0.0.9"
run simavr-exports inspect-native-exports "$T/ngspice/x-libsimavr2/usr/lib/x86_64-linux-gnu/libsimavr.so.2"
run mujoco-exports inspect-native-exports "$T/mujoco/core/mujoco/libmujoco.so.4.0.1"
run renode-infra-members inspect-managed-members "$R/Infrastructure.dll" --detail summary --evidence-bundle "$E/renode-infra.bundle.json"
run renode-cosim-members inspect-managed-members "$R/CoSimulationPlugin.dll"
for p in avr8js-0.21.1 rp2040js-1.4.2; do
  run "$p" analyze-javascript-application "$T/npm/$p/package" --detail summary --evidence_output "$E/$p.bundle.json"
done
run wokwi-ext analyze-javascript-application "$T/wokwi/x/extension" --detail summary --evidence_output "$E/wokwi-ext.bundle.json"

log "Done. Compare Evidence IDs and SHA-256s with docs/research/evidence-ledger.md."
