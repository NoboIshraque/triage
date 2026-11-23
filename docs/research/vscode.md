# Teardown: VS Code (Code-OSS)

**Target:** VSCodium 1.143.17232 for Linux x64 (`codium_1.143.17232_amd64.deb`).
VSCodium is an MIT-licensed build of Code-OSS, the open-source core of VS Code.
We analyzed it instead of Microsoft's branded build because Microsoft's product
license restricts reverse engineering. The source code is identical apart from
branding and telemetry.

**Method:** REA 6.7.0 CLI, static only. Nothing was executed. Evidence IDs are listed in
[evidence-ledger.md](evidence-ledger.md).

Legend: **[O]** observed by REA in the shipped files · **[I]** inferred from
observations · **[D]** from official documentation · **[?]** unknown.

## 1. Packaging

| Fact | Basis |
|---|---|
| 612 MB install; 2,998 files. Electron binary `codium` (224 MB ELF) plus Chromium resources | [O] desktop inventory |
| App code is an **unpacked** `resources/app/` directory (`out/`, 95 built-in `extensions/`), not `app.asar`. Native modules live in `node_modules.asar` with an `.unpacked` sibling | [O] |
| REA's Electron detector keys on `app.asar`, so it reported no Electron candidate here. The only runtime candidate was .NET: 4 PowerShell PSReadLine DLLs used by terminal shell integration | [O] |
| `package.json` declares `"main": "./out/main.js"`, `"type": "module"`, license MIT | [O] |

### Electron fuses (compiled-in security switches)

| Fuse | State | Meaning for us |
|---|---|---|
| RunAsNode | **enabled** | The same binary can run as plain Node (`ELECTRON_RUN_AS_NODE`). Used by the CLI and helpers [I] |
| EnableNodeOptionsEnvironmentVariable | enabled | `NODE_OPTIONS` honored |
| EnableNodeCliInspectArguments | enabled | `--inspect` honored, so debuggable |
| OnlyLoadAppFromAsar | **disabled** | Consistent with the unpacked `resources/app` [O] |
| EnableEmbeddedAsarIntegrityValidation | disabled | (enforced only on macOS/Windows anyway) |
| EnableCookieEncryption | disabled | |
| GrantFileProtocolExtraPrivileges | enabled | |

**Why it matters to us:** Electron's docs say disabling RunAsNode breaks
`child_process.fork`, the call extensions use to start Node helper processes [D].
Because it is enabled, our extension can fork a Node helper for the JS MCU
emulators. Hardening these fuses is VS Code's job, since we don't ship Electron.

## 2. Process model

Process entry points found in `out/` [O]:

| Process | Entry bundle (size) | Role |
|---|---|---|
| Main (Electron browser process) | `out/main.js` (101 KB) → `out/mainImpl.js` (1.3 MB) | windows, lifecycle, menus, IPC hub |
| Renderer / workbench | `out/vs/code/electron-browser/workbench/workbench.js` + `out/vs/workbench/workbench.desktop.main.js` (**21 MB**) | the whole UI: Monaco, editors, panels |
| Preload (sandbox bridge) | `out/vs/base/parts/sandbox/electron-browser/preload.js` (2.3 KB) | exposes `window.vscode` |
| Shared process | `out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js` | extension management, background services [D] |
| Extension host (Node) | `out/vs/workbench/api/node/extensionHostProcess.js` (2.3 MB) | runs extensions isolated from the UI |
| Extension host (web worker) | `out/vs/workbench/api/worker/extensionHostWorkerMain.js` | browser-only extensions |
| Pty host | `out/vs/platform/terminal/node/ptyHostMain.js` | terminals via `node-pty` |
| File watcher | `out/vs/platform/files/node/watcher/watcherMain.js` | `@parcel/watcher` |
| **Agent host** (new) | `out/vs/platform/agentHost/node/agentHostMain.js` (3 MB) | persistent AI agent sessions [D: Aug 2026 VS Code blog] |
| CLI | `out/cli.js`, `out/vs/code/node/cliProcessMain.js` | `codium` command line |
| Workers | `editorWebWorkerMain`, `languageDetectionWebWorkerMain`, `localFileSearchMain`, `profileAnalysisWorkerMain`, `outputLinkComputerMain` | CPU work off the UI thread |

**Static graph (REA `analyze_javascript_application`, 15 selected sources:
13 JS bundles plus `package.json` and `product.json`):** all 13 JS files were
parsed (7.7 M AST nodes, 5,799 findings, 0 parse failures). Analysis of the 21 MB
workbench bundle **hit the 900 s per-file deadline**, so renderer-side facts are
partial [O, coverage = partial]. From the analyzed files:

- 3 `BrowserWindow` construction sites. Their `webPreferences` are built
  dynamically, so the values are unresolved statically [O].
- 1 `utilityProcess` launch site [O]. Docs say the extension host, pty host and
  shared process run as Electron utility processes [D].
- 10 IPC operations. Only **1 uses a literal channel, `vscode:fetchShellEnv`**
  (renderer `invoke`); 9 compute their channel names at runtime [O]. VS Code
  prefixes and validates channel names in the preload [I].
- 14 sender-validation checks in main-process handlers [O].

### The renderer's entire privileged surface

The preload exposes exactly **one** `contextBridge` API, `window.vscode`, in
the main world. It has **26 members and 0 unknown** [O]:

```
context: configuration, resolveConfiguration
ipcMessagePort: acquire
ipcRenderer: invoke, on, once, removeListener, send
process: arch, cwd, env, execPath, getProcessMemoryInfo, on, platform, shellEnv, type, versions
webFrame: setZoomLevel
webUtils: getPathForFile
```

**Key pattern: `ipcMessagePort.acquire`.** The sandboxed renderer asks main for a
`MessagePort` and then talks **directly** to a utility process, such as the
extension host or pty host, without routing traffic through main [O + D].
This is how VS Code keeps a sandboxed UI fast. Extensions can't use this
channel, so **our equivalent** for high-rate streams (simulation state,
waveforms, geometry) is a direct localhost WebSocket from our engine process to
our webview.

## 3. Native modules shipped

Found in `node_modules.asar.unpacked` [O]:

| Module | Purpose |
|---|---|
| `node-pty` (`pty.node`) | terminals |
| `@parcel/watcher` | file watching |
| `@vscode/sqlite3` | state storage |
| `@vscode/spdlog` | logging |
| `@vscodium/native-keymap` | keyboard layouts |
| `@vscode/native-watchdog` | hang detection |
| `kerberos` | proxy auth |
| `@vscodium/policy-watcher`, `@vscodium/os-proxy-resolver-linux-x64-gnu` | enterprise policy, proxies |
| `native-is-elevated`, `windows-foreground-love`, `@vscode/deviceid` | OS helpers |

## 4. What we take from VS Code

**Decision (2026-11-23): Triad runs inside the real VS Code as extensions**
([ADR 0001](../adr/0001-run-inside-vscode.md)). The teardown still shapes how we
build:

1. **We inherit the platform.** Monaco, LSP/DAP, terminal, git, tasks, Test
   Explorer, settings and the extension ecosystem come free, in the UI students
   already know. That includes Microsoft's own C/C++ and Python extensions, which
   are licensed only for Microsoft's VS Code.
2. **Copy the isolation pattern.** VS Code keeps the UI sandboxed and pushes heavy
   work into separate processes behind narrow message contracts. We do the same:
   our editors are sandboxed webviews, and our engines (model, geometry, sim) are
   separate processes launched by the extension.
3. **Fast data paths.** The renderer's MessagePorts aren't available to
   extensions. We use `postMessage` with transferred `ArrayBuffer`s (VS Code
   1.57+), plus a direct localhost WebSocket from the sim service to the webview
   for high-rate streams.
4. **RunAsNode matters to us** (see the fuses section): it lets our extension fork
   the Node helper for the JS emulators. We keep a fallback in case it changes.
5. **Security posture:** narrow, schema-validated messages (the spirit of the
   26-member preload), no Node in webviews, and Workspace Trust before building
   or running a cloned project.
6. **Reach:** publish to the VS Code Marketplace, and to Open VSX so VSCodium,
   Cursor and other forks can install it too.

## 5. Unknowns and limits

- [?] Renderer-side IPC and webview details inside the 21 MB bundle. Re-run with
  `--analysis-timeout-ms 3600000` (see `scripts/research/teardown.sh`).
- [?] Runtime behavior. Static analysis does not prove which code paths execute.
- Process roles for the shared process, pty host and agent host come from
  official docs, corroborated by entry-point names, not by runtime capture.
