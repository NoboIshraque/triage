# Teardown: VS Code (Code-OSS)

**Target:** VSCodium 1.143.17232 for Linux x64 (`codium_1.143.17232_amd64.deb`), an
MIT build of **Code-OSS**, the same source Microsoft builds VS Code from. It is
the code Triad forks ([ADR 0001](../adr/0001-standalone-app-on-vscode-codebase.md)).

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
to a helper process without routing traffic through main [O + D]. Triad's engine
connections use exactly this.

## 3. Native modules shipped

`node-pty`, `@parcel/watcher`, `@vscode/sqlite3`, `@vscode/spdlog`, `native-keymap`,
`native-watchdog`, `kerberos`, policy watcher, OS proxy resolver, `native-is-elevated`,
`windows-foreground-love`, `deviceid` [O].

## 4. Where Triad plugs into the fork

From the shipped layout above plus Code-OSS's source tree [I/D]. Verify each in
ROADMAP P0-2/P0-3.

| Need | Where in Code-OSS | Triad change |
|---|---|---|
| Name, icons, data folder, gallery | `product.json`, `resources/` | Triad branding; **Open VSX** gallery |
| Triad UI (editors, views, layout, walkthrough) | workbench contributions under `src/vs/workbench/contrib/` | a new `src/vs/workbench/contrib/triad/` (or `src/vs/triad/`) registered by one import line, as a patch |
| Native editors (schematic, board, 3D, sim) | `EditorPane` + editor input/serializer registrations | Triad editors with GPU canvases inside the renderer (no webviews) |
| Engine processes | the utility-process pattern used by the pty host and shared process (main spawns, hands the renderer a `MessagePort`) | `triadModel`, `triadEda`, `triadCad`, `triadSim`, `triadRender` entry points |
| Bundling new entry points | the build's entry-point list (where `ptyHostMain` and `watcherMain` are declared) | add Triad engine broker entry points |
| CLI | `cli.js` / `cliProcessMain` | `triad` subcommands, or a separate `cli/` package |

## 5. Round 2: unbounded analysis of the whole app

Runs: `out/` (all 39 sources) and `extensions/` (927 sources), with no deadline and no
size caps. Results are recorded below when the runs complete.

- Status (2026-11-24): earlier attempts were stopped by session restarts (heavy
  parallel runs reached ~10 GB of RAM). The workbench bundle is being re-run alone.
  Notes follow below.

## 6. Unknowns and limits

- [?] Runtime behavior. Static analysis does not prove which code paths execute.
- Process roles for shared, pty and agent hosts come from official docs plus entry-point names.
- §4 maps the shipped layout onto the source tree by name. Confirm against the
  source in P0-2.
