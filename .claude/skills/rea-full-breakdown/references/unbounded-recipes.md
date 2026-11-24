# Unbounded recipes (verified on real targets, 2026-11-23)

`$REA` = `/abs/path/to/rea/scripts/rea-unbounded.sh`. Put each downloaded target in its
own directory, write evidence to a separate directory, and keep helper scripts outside
both.

## 1. Big Electron / JavaScript app (VS Code 1.143: ~140 MB of JS)

```bash
A=/targets/vscodium/x/usr/share/codium/resources/app
# split by subtree; each run analyzes every file under its root, sequentially
REA_PARENT_HEAP_MB=4096 $REA analyze-javascript-application $A/out \
  --detail summary --evidence_output ev/vscode-out.bundle.json --max-heap-mb 8192 --json \
  > ev/vscode-out.summary.json 2> ev/vscode-out.err &
REA_PARENT_HEAP_MB=2048 $REA analyze-javascript-application $A/extensions \
  --detail summary --evidence_output ev/vscode-ext.bundle.json --max-heap-mb 3072 --json \
  > ev/vscode-ext.summary.json 2> ev/vscode-ext.err &
tail -f ev/vscode-out.err      # {"rea_progress": ... "(25/39)"}
$REA inspect-electron-fuses $A/../../codium --json
```

- VS Code ships an **unpacked** `resources/app` (no `app.asar`), so the desktop
  inventory reports no Electron candidate. Analyze the directory directly.
- The two 21–22 MB renderer bundles dominate run time (well over 15 minutes each on 4
  cores). Bounded mode times them out at 300 s by default.
- Read results: extract the analysis record from the bundle, then query views:

```bash
python3 -c 'import json,sys; b=json.load(open(sys.argv[1])); r=[x for x in b["records"] if x["operation"]=="analyze_javascript_application"][0]; json.dump(r,open(sys.argv[2],"w"))' ev/vscode-out.bundle.json ev/vscode-out.record.json
cat > req.json <<EOF
{"source":{"kind":"evidence-file","path":"$PWD/ev/vscode-out.record.json"},
 "view":{"kind":"javascript-facts","where":{"paths":["vs/base/parts/sandbox/electron-browser/preload.js"]},
         "property_keys":["api_key","members","channel","channel_expression","operation","side"],"limit":500}}
EOF
$REA inspect-analysis-view req.json --json
```

Useful `javascript-facts` property keys: `api_key`, `members`, `world` (contextBridge),
`channel`, `channel_expression`, `operation`, `side` (IPC), `preload_path`,
`web_preferences`, `endpoint_kind`, `mechanism`, `specifier`.

## 2. Native app with debug symbols (KiCad 10.0.8 + `kicad-dbg`)

1. Download the `-dbg` / `-dbgsym` package for the **same build** (KiCad PPA:
   `kicad-dbg_<ver>_amd64.deb`, about 1 GB). Debug files live in
   `usr/lib/debug/.build-id/xx/yyyy.debug`.
2. Map binary to debug file by GNU build-id:
   `$REA inspect-elf-notes <binary> --json` and read `entries[].gnu.build_id_hex`.
3. Full symbol table (unbounded output; pcbnew is 25.7 MB, beyond the bounded 16 MiB):
   `$REA inspect-with-objdump <debug> symbols --json`. Function rows match
   `^([0-9a-f]{16}) .{6}F \.text\t([0-9a-f]{16}) (.*)$` (address, size, mangled name).
4. **LTO builds** name compile units `<artificial>`, so `.debug_aranges` can't map
   functions to source files. Use the line table instead:
   `addr2line -e <debug>` with every function address on stdin gives `path:line`.
5. Group paths by source directory (strip the build-root prefix, for example
   `kicad/`), sum function counts and sizes, and classify paths
   (dialogs/widgets/frames = UI, `tools/` = interaction, the rest = engine).
6. Demangle with `c++filt` to list class APIs, for example every `KIGFX::GAL`
   method (68), to size an interface you plan to reimplement.

## 3. Stripped native app (Blender 5.3)

- `$REA inspect-native-exports <binary>` shows that Blender exports the embedded
  CPython C API (1,686 symbols, 37 `PyInit_*` built-ins).
- `readelf -d` NEEDED and RUNPATH lists the bundled engines.
- **Embedded source paths** (`strings -n 6 <bin> | grep -oE "(source/blender|intern|extern)/…"`)
  give a module map from assert and log strings (970 files: partial but broad).
  Label it "observed strings, partial coverage".
- The shipped Python layer is readable source: count `class X(Panel|Menu|Operator)`.
- Runtime API dumps (`blender -b --python-expr …`) need permission to execute the
  downloaded binary. If the session policy blocks it, say so and ask the user. Don't
  route around it with process capture.

## 4. Modular native app exporting C++ (FreeCAD 1.1)

- Daily PPA `libfreecad-daily-python3-1.1_*.deb` holds the full library set.
- `$REA inspect-native-exports` on every `*.so` (4 in parallel), plus `.text` size
  from `readelf -SW`. Split by name: `*Gui.so` and `libFreeCADGui` are UI, the
  rest are engine. REA refuses symlink paths (analyze the real file) and static
  `.a` archives.

## 5. .NET (Renode 1.16.1)

```bash
$REA inspect-managed-artifact Infrastructure.dll --json            # table row counts
$REA inspect-managed-members Infrastructure.dll --detail summary \
  --evidence-bundle ev/renode-infra.bundle.json --json             # complete: 26 s, 270 MB bundle
```

Bounded mode refuses this assembly at the 64 MiB metadata budget, even with
`--type` selection.

## 6. Memory planning (4 cores, 15 GB host)

| Run | Worker heap | Parent heap | Observed peak |
|---|---|---|---|
| VS Code `out/` (two 21–22 MB bundles) | 8192 MiB | 4096 MiB | ~3–4 GB per process while parsing |
| VS Code `extensions/` (927 sources) | 3072 MiB | 2048 MiB | ~2–3 GB |
| Native exports / objdump symbols | – | default | under 1 GB |

Keep the sum of worker heaps under host RAM, and run small native jobs alongside.

## 7. Pitfalls seen

- `--evidence_output` writes a **bundle** (`records[]`). Views need the single record.
- `/usr/bin/time` may not exist. Use the shell's `time`.
- objdump symbol rows: the flag column is 7 characters including `F`.
- **Cloud sessions can restart and kill every process**, even ones started with
  `setsid nohup`. It happened twice when parallel REA runs reached about 10 GB of RAM
  together. Run one heavy JavaScript analysis at a time (about 2.5–4 GB for a
  21 MB bundle), write logs and bundles to disk, and commit and push reports
  between runs. A killed run leaves no Evidence (it is written at the end), so
  split long work into runs that finish within the restart window.
- Executing downloaded apps can be blocked by the session's safety policy.
  Static evidence first, then ask the user.
