# Teardown: VS Code (Code-OSS)

**Target:** VSCodium 1.143.17232 for Linux x64 (`codium_1.143.17232_amd64.deb`), an
MIT build of **Code-OSS**, the same source Microsoft builds VS Code from. It is
the code Triage forks ([ADR 0001](../adr/0001-standalone-app-on-vscode-codebase.md)).

**Method:** REA static analysis. Round 1 used bounded defaults: 14 entry
bundles, and the 21 MB workbench bundle timed out at 900 s. Round 2 used
**unbounded mode** over the whole `out/` and `extensions/` trees (§5). Evidence IDs
are in [evidence-ledger.md](evidence-ledger.md).

Legend: **[O]** observed in the shipped files · **[I]** inferred · **[D]** documentation · **[?]** unknown.

## 1. Packaging

| Fact | Basis |
|---|---|
| 612 MB install; 2,998 files; Electron binary `codium` (224 MB ELF) | [O] |
| App code is an **unpacked** `resources/app/`: `out/` (**58.8 MB of JS in 30 bundles**) and 95 built-in `extensions/` (**77.7 MB of JS in 418 files**). Native modules are in `node_modules.asar` (54 MB) + `.unpacked` | [O] |
| Two giant bundles: `vs/workbench/workbench.desktop.main.js` **21.1 MB** (the IDE) and `vs/sessions/sessions.desktop.main.js` **22.3 MB** (the new agents window) | [O] |
| `package.json`: `"main": "./out/main.js"`, ESM (`"type": "module"`) | [O] |

**Electron fuses** [O]: RunAsNode **on**, NodeOptions on, NodeCliInspect on,
OnlyLoadAppFromAsar **off**, EmbeddedAsarIntegrityValidation off, CookieEncryption
off, GrantFileProtocolExtraPrivileges on, WasmTrapHandlers on. Electron's docs say
disabling RunAsNode breaks `child_process.fork` from the main process; utility
processes are the replacement [D].

## 2. Process model

| Process | Entry bundle | Role |
|---|---|---|
| Main | `out/main.js` → `out/mainImpl.js` (1.3 MB) | windows, lifecycle, IPC hub |
| Workbench renderer | `out/vs/code/electron-browser/workbench/workbench.js` + `workbench.desktop.main.js` | the whole IDE UI |
| Preload | `out/vs/base/parts/sandbox/electron-browser/preload.js` (2.3 KB) | exposes `window.vscode` |
| Shared process | `vs/code/electron-utility/sharedProcess/sharedProcessMain.js` | extension management, background services |
| Extension host | `vs/workbench/api/node/extensionHostProcess.js` (2.3 MB) | extensions, isolated from the UI |
| Pty host | `vs/platform/terminal/node/ptyHostMain.js` | terminals (`node-pty`) |
| File watcher | `vs/platform/files/node/watcher/watcherMain.js` | `@parcel/watcher` |
| **Agent host** | `vs/platform/agentHost/node/agentHostMain.js` (3 MB) | persistent agent sessions |
| Sessions window | `vs/sessions/sessions.desktop.main.js` | agents window UI |
| CLI | `out/cli.js`, `vs/code/node/cliProcessMain.js` | command line |
| Workers | editor, language detection, file search, profile analysis, output links, TextMate tokenization | off-thread work |

**Round-1 static graph** (13 JS entry bundles parsed; workbench semantics partial) [O]:
3 `BrowserWindow` sites, 1 `utilityProcess` site, 10 IPC operations (1 literal
channel, `vscode:fetchShellEnv`; 9 computed), 14 sender-validation checks.

**The renderer's privileged surface** is one `contextBridge` API, `window.vscode`,
with **26 members and 0 unknown** [O]:

```
context: configuration, resolveConfiguration
ipcMessagePort: acquire
ipcRenderer: invoke, on, once, removeListener, send
process: arch, cwd, env, execPath, getProcessMemoryInfo, on, platform, shellEnv, type, versions
webFrame: setZoomLevel
webUtils: getPathForFile
```

**`ipcMessagePort.acquire`** is how the sandboxed renderer gets a direct `MessagePort`
to a helper process without routing traffic through main [O + D]. Triage's engine
connections use exactly this.

**Round 2 (all 28 JS entry files, unbounded)** found the complete preload surface:
**4 bridge APIs with 34 members in 3 preload scripts** [O]:

| Preload | World | API | Members |
|---|---|---|---|
| `vs/base/parts/sandbox/electron-browser/preload.js` | main | `vscode` | the 26 above |
| `vs/base/parts/sandbox/electron-browser/preload-aux.js` (auxiliary windows) | main | `vscode` | `ipcRenderer.invoke`, `ipcRenderer.send`, `webFrame.setZoomLevel` (5 with parents) |
| `vs/platform/browserView/electron-browser/preload-browserView.js` | isolated | `browserViewAPI` | `getSelectedText` |
| same | main | `__vscode_helpers` | `getElement`, `getFrameToken` |

IPC across those files [O]: 29 operations, **18 literal channels** (`vscode:fetchShellEnv`
plus 17 `vscode:browserView:*` channels: start/stop element and area pickers,
highlight and hide, element comments, theme, localized strings, keydown,
`preloadReady`), 11 dynamic-channel operations, 13 renderer sends, 13 renderer
listeners, 3 main handlers, 8 sender-validation observations, 3 `BrowserWindow`
sites and 1 `utilityProcess` site. The **browser view** is an embedded web page
with element picking, built for the agents features. [I] Triage can reuse it to show
datasheets and vendor pages inside the one window.

## 3. Native modules shipped

`node-pty`, `@parcel/watcher`, `@vscode/sqlite3`, `@vscode/spdlog`, `native-keymap`,
`native-watchdog`, `kerberos`, policy watcher, OS proxy resolver, `native-is-elevated`,
`windows-foreground-love`, `deviceid` [O].

## 4. Where Triage plugs into the fork

From the shipped layout above plus Code-OSS's source tree [I/D]. Verify each in
ROADMAP P0-2/P0-3.

| Need | Where in Code-OSS | Triage change |
|---|---|---|
| Name, icons, data folder, gallery | `product.json`, `resources/` | Triage branding; **Open VSX** gallery |
| Triage UI (editors, views, layout, walkthrough) | workbench contributions under `src/vs/workbench/contrib/` | a new `src/vs/workbench/contrib/triage/` (or `src/vs/triage/`) registered by one import line, as a patch |
| Native editors (schematic, board, 3D, sim) | `EditorPane` + editor input/serializer registrations | Triage editors with GPU canvases inside the renderer (no webviews) |
| Engine processes | the utility-process pattern used by the pty host and shared process (main spawns, hands the renderer a `MessagePort`) | `triageModel`, `triageEda`, `triageCad`, `triageSim`, `triageRender` entry points |
| Bundling new entry points | the build's entry-point list (where `ptyHostMain` and `watcherMain` are declared) | add Triage engine broker entry points |
| CLI | `cli.js` / `cliProcessMain` | `triage` subcommands, or a separate `cli/` package |

## 5. Round 2: unbounded analysis of the whole app

REA ran with no deadline and no fixed size caps, one heavy run at a time
(GUIDELINES §10): the two giant bundles each on their own, then the other 37 `out/`
files, then the built-in `extensions/` (927 sources). Evidence IDs are in
[evidence-ledger.md](evidence-ledger.md).

| Run | Result | Basis |
|---|---|---|
| `vs/workbench/workbench.desktop.main.js` (21.1 MB, the IDE) | **Parsed completely:** 21,103,304 bytes, 5,318,098 syntax-tree nodes, 3,017 findings, 0 parse failures, in 29 min 54 s on one core. The bundle itself has **no `BrowserWindow`, IPC or utility-process sites**: the renderer reaches the main process only through the `window.vscode` preload globals (§2). Also: 6 sender-validation observations, `localStorage` get/set/remove, one module `Worker`, 255 literal asset and route strings, none with an http(s) host. **The semantic relationship graph was not retained:** its projection exhausted the 6 GiB worker heap, chosen to stay under this host's restart threshold | [O] `ev_9b375b8e…` (view `ev_20728c1c…`) |
| `vs/sessions/sessions.desktop.main.js` (22.3 MB, the agents window) | **Parsed completely:** 22,304,735 bytes, 5,631,871 syntax-tree nodes, 3,001 findings, 0 parse failures, in 32 min 10 s. Like the workbench: no Electron sites in the bundle, 6 sender-validation observations, and **no semantic graph** (the projection exhausted the 6 GiB worker heap) | [O] `ev_aa88f498…` (view `ev_4fcc4006…`) |
| The other 37 `out/` files (28 JS entry points, plus JSON and HTML) | **All 28 JS files parsed:** 20,696,344 bytes, 3,414,945 nodes, 3,193 findings, 0 parse failures, in 8 min 12 s. Electron surface in §2. **Static facts retained for 26 of the 28.** For `agentHostMain.js` (3.0 MB) and `extensionHostProcess.js` (2.3 MB) the complete facts exceed REA's per-file transfer ceiling (512 MiB at the 8 GiB parent heap, 2 GiB maximum), so REA marks their static analysis unavailable. **Semantic graphs retained for 13 of the 28:** the 3 preloads, `main.js`, `cli.js`, `bootstrap-fork.js`, `workbench.js`, `sessions.js`, `editorWebWorkerMain.js`, `textMateTokenizationWorker.workerMain.js`, `diffWorkerMain.js`, `service-worker.js` and `nls.messages.js` (strings only, 3 nodes). Together: 134,416 data-flow, 17,504 call-flow, 16,899 object-flow, 10,851 closure, 417 promise, 90 boundary, 83 timer, 71 event, 19 child-process, 5 configuration and 4 request relations. For 12 more files the graph exceeded the parent's remaining result budget, and their static and module facts were kept: `mainImpl.js`, `sharedProcessMain.js`, `cliProcessMain.js`, `watcherMain.js`, `ptyHostMain.js`, `localTranscriptionMain.js`, `profileAnalysisWorkerMain.js`, `telemetryApp.js`, `notebookWebWorkerMain.js`, `outputLinkComputerMain.js`, `languageDetectionWebWorkerMain.js`, `localFileSearchMain.js`. For `extensionHostWorkerMain.js`, semantic analysis never started: the parent kept its remaining capacity for static facts. *Corrected 2026-11-24: an earlier version said 22 of 28, counted from the summary view's first 30 unknowns. The counts above come from the parent bundle (semantic nodes per module path)* | [O] `ev_d5f6028b…` (view `ev_9d60ac01…`) |
| Built-in `extensions/` (418 JS files, 77.7 MB) | **Six batches, 21 min in total** (2026-11-24). `mermaid-markdown-features/notebook-out/` repeats `markdown-preview-out/` byte for byte except `index.js` (115 of 116 files), so 115 copies were not re-run. **300 unique files selected, 299 parsed** (47,634,722 bytes read, 6,953,896 nodes, 10,978 findings, 0 parse failures). **No `BrowserWindow`, preload, context-bridge, IPC, utility-process or native-addon sites in any of them:** built-in extensions reach the app only through the extension host API. **Static facts kept for 298:** `node_modules/typescript/lib/typescript.js` (9.1 MB) exceeds the per-file transfer ceiling, and `zenuml-definition-*.js` (1.7 MB) exhausted the 4 GiB worker heap. **Semantic graphs for 45.** Files in one run share the parent's result budget, and REA reserves it for static facts first. So semantic analysis never started for 233 files, the graph exceeded what was left for 19, and 1 lost its module facts. **3 files not completed:** the ELK graph-layout library (elkjs, compiled from Java by GWT) inside the Mermaid extension: `markdown-preview-out/render-TAZW7USW-*.js` (1.5 MB) and the two 5 MB `chat-webview-out/index*.js` bundles that inline it. On the first one, REA's alias fixpoint for writes through shared prototype aliases (`indexJavaScriptAmbientWritesSteps`) ran for 1 h 55 min. CPU profile and inspector samples showed about one item every 10 s, with 5,551 of 12,098 still queued and the queue not shrinking, so the run was stopped and the batch re-run without the file. Those three files remain unknown. | [O] ledger rows "VSCodium `extensions/`" |
| Single-file pass (round 3) | **running.** One REA run per file, so each gets the whole parent result budget: the zenuml file with a 6 GiB worker; the 13 `out/` entry files without semantic graphs (worker 3 GiB); then the 253 extension files without one. Results are added here when it ends | – |

**Parent heap.** All the runs above used an **8 GiB parent heap limit**, whatever the plans said. This cloud environment sets `NODE_OPTIONS=--max-old-space-size=8192`, and REA's unbounded launcher put its own flag before that one, so the inherited value won (fixed in `NoboIshraque/rea@84e2b99`). Worker heaps were as stated [O].

**What this means.** REA's fixed time and size caps no longer stop a run; physical
memory does, through the worker heap and the parent's result budget. A full semantic graph of a 21 MB minified bundle needs more than 6 GiB
of V8 heap (how much more is unknown), and a bigger worker risks this host's
restart threshold. The 2,208 "module" nodes REA reports for this bundle are
unresolved references to minified `require` names, not module paths: REA found no
bundler module table (`modules: 0`) [O]. For the workbench's internals, the Code-OSS source
tree imported in P0-2 is the better instrument. REA's lasting value for VS Code is
the shipped process and IPC surface (§1–§3) and version diffs when the fork is
updated (GUIDELINES §9).

## 6. Unknowns and limits

- [?] Runtime behavior. Static analysis does not prove which code paths execute.
- Process roles for shared, pty and agent hosts come from official docs plus entry-point names.
- §4 maps the shipped layout onto the source tree by name. Confirm against the
  source in P0-2.
