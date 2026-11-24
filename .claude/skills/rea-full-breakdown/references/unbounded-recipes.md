# Unbounded recipes (verified on real targets, 2026-11-23/24)

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
- The two 21–22 MB renderer bundles dominate run time. Bounded mode times them out at
  300 s by default. Measured (2026-11-24): `workbench.desktop.main.js` alone, selected
  with `--source-path`, parsed completely in 29 min 54 s on one core (5.3M AST nodes),
  but its **semantic projection exhausted a 6144 MiB worker heap**, so relations were
  not retained. Give the semantic graph more heap on a bigger host, or accept
  parse-level facts and read the open source instead.
- In a flat minified ESM bundle, REA's `javascript-module` nodes are unresolved
  `require` references (`modules: 0`), not module paths.
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

### Batches, budgets and counting (measured on VS Code, 2026-11-24)

- **Files in one run share the parent's result budget, and REA reserves it for
  static facts first.** Semantic graphs then exist only for the first few files:
  13 of VS Code's 28 `out/` entry files, and 45 of 300 extension files across six
  batches. For a semantic graph of every file, run **one file per invocation**
  (a single `--source-path`), sequentially, and delete each bundle after
  extracting what you need (each bundle repeats the whole inventory, 30–300 MB).
- **Don't count from the summary view.** It lists only the first 30 unknowns
  ("N additional unknowns omitted"). Count from the parent bundle, by file:
  `Semantic graph for X exceeds` (graph over budget), `semantic analysis of X was
  not started`, `Completed module facts for X exceed`, `Complete JavaScript file
  facts exceed the effective transfer` (static facts unavailable) and `Owned
  JavaScript worker exhausted` (worker heap). Semantic nodes per file: count
  `"module_path"` values between `"nodes":[` and `"relations":[` inside the
  bundle's `"semantic_graph":{"application_graph_id"` object (1 node = placeholder only).
- **Per-file transfer ceiling** = min(2 GiB, max(512 MiB, offered budget / 8)).
  The offered budget is about (parent V8 heap limit − heap in use − 192 MiB) / 2
  (`JavaScriptAnalysisWorker.ts`). So the ceiling passes 512 MiB only with a parent
  heap limit above about 8.2 GiB plus what is in use, and reaches 1 GiB at about
  16.4 GiB. At an 8 GiB parent it stayed 512 MiB [O]. Over it: `agentHostMain.js`
  (3.0 MB), `extensionHostProcess.js` (2.3 MB), `extensionHostWorkerMain.js` (2.0 MB,
  when run alone), `typescript.js` (9.1 MB). How far over is unknown.
- **Pathological code shapes.** GWT-compiled JavaScript (elkjs, inlined by
  Mermaid) stalls the alias fixpoint in `indexJavaScriptAmbientWritesSteps`.
  After 1 h 55 min, 5,551 of 12,098 items were still queued, the queue did not
  shrink over 7 min of sampling, and each item took about 10 s, so at least
  15 h remained (inferred).
  An ANTLR-style generated parser (`zenuml-definition-*.js`, 1.7 MB) exhausted a
  6 GiB worker heap during static analysis. Isolate such files, record them as
  unknown with the measurements, and re-run the rest.
- **Is a long run stuck or slow?** `kill -USR1 <worker pid>` opens Node's
  inspector on 127.0.0.1:9229 without stopping the run. Over CDP, take a 15 s
  `Profiler.start`/`Profiler.stop` profile for the hot function. Then
  `Debugger.pause`, read loop sizes with `Debugger.evaluateOnCallFrame`
  (`throwOnSideEffect: true`), and `Debugger.resume`. Sample twice, a minute
  apart, to get a rate.

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

| Run | Worker heap | Parent heap limit¹ | Observed peak |
|---|---|---|---|
| VS Code workbench bundle alone (21 MB) | 6144 MiB | 8 GiB | ~4 GB while parsing; projection needed > 6 GiB |
| VS Code `extensions/` (927 sources) | 3072 MiB | 8 GiB | ~2–3 GB |
| VS Code `extensions/` batches (2–115 selected files) | 4096–6144 MiB | 8 GiB | 3–4.5 GB; semantic graphs only for the first files of each batch |
| One 1.7 MB generated parser (`zenuml-definition-*.js`) | 6144 MiB | 8 GiB | ~7.4 GB host use; worker heap exhausted after 2 min |
| Native exports / objdump symbols | – | default | under 1 GB |

¹ Effective limits. These runs asked for 2–5 GiB through `REA_PARENT_HEAP_MB`, but the
host's `NODE_OPTIONS` already held `--max-old-space-size=8192` and overrode it (see §7).

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
- **Check `NODE_OPTIONS` before sizing the parent.** V8 uses the last
  `--max-old-space-size` it sees. Claude's cloud sessions set
  `NODE_OPTIONS=--use-openssl-ca --max-old-space-size=8192`, and the launcher used
  to put `REA_PARENT_HEAP_MB` first, so every parent ran at 8 GiB whatever was
  asked. `NoboIshraque/rea@84e2b99` appends the flag so it wins. Confirm with
  `tr '\0' '\n' < /proc/<pid>/environ | grep NODE_OPTIONS`.
- Stopping a run: the parent can outlive its killed worker. Stop both
  (`pkill -f javascriptAnalysisWorkerProcess; pkill -f analyze-javascript-application`),
  and don't delete a summary file while its run still writes to it.
- A memory guard helps on shared hosts: poll the summed RSS of the REA processes
  and stop the current run above a limit (9 GiB here), so one file can't take the
  host down.
