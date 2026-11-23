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

**Lesson:** our distribution should **turn RunAsNode and Inspect off** and turn
asar integrity on for release builds. It needs a different way to launch helper
Node processes, which Electron's `utilityProcess` already provides.

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
This is how VS Code keeps a sandboxed UI fast. **We copy it** for our high-rate
streams (simulation state, waveforms, geometry).

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

1. **Use Code-OSS as the shell.** We get Monaco, LSP/DAP, terminal, git, tasks,
   settings, keybindings, the extension host and the Open VSX ecosystem for free.
   Students already know the UI.
2. **Extension-first.** Build every feature as a (built-in) extension. Patch
   the workbench only for what the extension API cannot do: custom layout and
   perspectives, the unified project explorer, startup flow and branding.
   Positron forked for the same reason; VSCodium and GitLab show how to keep
   the patch set small [D].
3. **New services become utility processes** (sim kernel, geometry, model) wired
   to the renderer with `MessagePort`, exactly like the pty host.
4. **Security posture:** keep the 26-member style of a narrow preload. Never give
   webviews or the renderer Node access. Respect Workspace Trust before building
   or running untrusted firmware.
5. **Marketplace:** a Code-OSS distribution must use **Open VSX**, not
   Microsoft's Marketplace (Marketplace terms limit it to Microsoft products) [D].

## 5. Unknowns and limits

- [?] Renderer-side IPC and webview details inside the 21 MB bundle. Re-run with
  `--analysis-timeout-ms 3600000` (see `scripts/research/teardown.sh`).
- [?] Runtime behavior. Static analysis does not prove which code paths execute.
- Process roles for the shared process, pty host and agent host come from
  official docs, corroborated by entry-point names, not by runtime capture.
