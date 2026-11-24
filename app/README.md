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
| [`src/vs/triage/`](src/vs/triage/) | Triage's workbench code (VS Code's style: tabs, its APIs), copied to the same path in upstream: Triage sidebar, Engineering layout, walkthrough | P0-3 |
| [`src/tsconfig.triage.json`](src/tsconfig.triage.json) | type-checks `vs/triage` and what it imports (576 files) | P0-3 |
| [`patches/`](patches/) | numbered `*.patch` files, small changes to upstream files. `0001` loads `vs/triage` in the workbench and ships its walkthrough pages | P0-3 |
| [`build.mjs`](build.mjs), `build.sh`, `build.ps1` | the build (one Node implementation; Linux and Windows wrappers) | P0-2 |
| [`smoke/`](smoke/) | Playwright test: the packaged app opens a window | P0-2 |

## Build

Needs Node at the version in `app/upstream/.nvmrc` (24.22.1 for 1.147.0) with
corepack, Python 3, and a C++ toolchain: on Linux `pkg-config`, `libxkbfile-dev`,
`libkrb5-dev`; on Windows Visual Studio 2022 or 2026 with the C++ workload. VS
Code's install also needs network access for Electron and built-in extensions.

```sh
app/build.sh                 # Linux: fetch, prepare, install, typecheck, package
app\build.ps1                # Windows: the same steps
node app/build.mjs prepare   # one step: fetch | prepare | install | typecheck | package
```

The packaged app lands in `app/VSCode-<platform>-<arch>/` (`triage` on Linux,
`Triage.exe` on Windows). Then `pnpm app:smoke` opens it and checks the window.

## Changing upstream files (the patch queue)

Prefer new files in `app/src/` (overlay). When an upstream file must change:

1. Edit it in `app/upstream/`.
2. `node app/build.mjs refresh-patches --new 0002-short-description` writes the
   edit into `app/patches/`. Later edits to a file that a patch already owns go
   back into that patch with plain `refresh-patches`. Each upstream file belongs
   to one patch; a patch whose edits were all undone is deleted.
3. `node app/build.mjs check-patches` applies every patch onto a fresh checkout
   of the pinned commit (CI runs it too).

`prepare` resets `app/upstream/` to the pinned commit, then applies product.json,
overlays and patches. It refuses to discard edits made since the last prepare
(unless `--force`), so run `refresh-patches` first.

CI builds and smoke-tests the app on Windows and Linux when anything in `app/`
changes ([`.github/workflows/app.yml`](../.github/workflows/app.yml)), and uploads
the Windows build as an artifact for 3 days.
