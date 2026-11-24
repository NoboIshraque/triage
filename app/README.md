# app/: the VS Code fork

Triage's desktop app, built from VS Code's source (`microsoft/vscode`,
[ADR 0001](../docs/adr/0001-standalone-app-on-vscode-codebase.md)). Upstream is not
copied into this repository: [`upstream.json`](upstream.json) pins a release tag
and its commit, and the build checks out exactly that commit into `app/upstream/`
(ignored by git), then applies Triage's changes on top (GUIDELINES §6).

| Here | What | Work package |
|---|---|---|
| [`upstream.json`](upstream.json) | the pinned VS Code release (1.147.0) | P0-2 |
| [`product.json`](product.json) | Triage's keys merged over upstream's: name, data folders, Windows app IDs, **Open VSX** gallery | P0-2 |
| [`resources/`](resources/) | files that replace upstream's at the same path (placeholder icon from `scripts/branding/placeholder_icons.py`) | P0-2 |
| `src/vs/triage/` | Triage's workbench code, copied to the same path in upstream | P0-3 |
| `patches/` | numbered `*.patch` files, small changes to upstream files | P0-3 |
| [`build.mjs`](build.mjs), `build.sh`, `build.ps1` | the build (one Node implementation; Linux and Windows wrappers) | P0-2 |
| [`smoke/`](smoke/) | Playwright test: the packaged app opens a window | P0-2 |

## Build

Needs Node at the version in `app/upstream/.nvmrc` (24.22.1 for 1.147.0) with
corepack, Python 3, and a C++ toolchain: on Linux `pkg-config`, `libxkbfile-dev`,
`libkrb5-dev`; on Windows Visual Studio 2022 or 2026 with the C++ workload. VS
Code's install also needs network access for Electron and built-in extensions.

```sh
app/build.sh                 # Linux: fetch, prepare, install, package
app\build.ps1                # Windows: the same steps
node app/build.mjs prepare   # one step: fetch | prepare | install | package
```

The packaged app lands in `app/VSCode-<platform>-<arch>/` (`triage` on Linux,
`Triage.exe` on Windows). Then `pnpm app:smoke` opens it and checks the window.

**Don't edit `app/upstream/` by hand:** `prepare` resets it to the pinned commit
and refuses to discard changes it didn't make (unless `--force`). Put changes in
`app/` as overlay files or patches.

CI builds and smoke-tests the app on Windows and Linux when anything in `app/`
changes ([`.github/workflows/app.yml`](../.github/workflows/app.yml)), and uploads
the Windows build as an artifact for 3 days.
