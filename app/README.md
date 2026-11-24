# app/: the VS Code fork

Triage's desktop app, built from VS Code's source (`microsoft/vscode`,
[ADR 0001](../docs/adr/0001-standalone-app-on-vscode-codebase.md)).

| Part | Where | Work package |
|---|---|---|
| Upstream VS Code at a pinned release tag, imported untouched | this folder | ROADMAP P0-2 |
| Build scripts (`build.sh` on Linux, `build.ps1` on Windows), Triage `product.json` | this folder | P0-2 |
| Triage's own workbench code (view container, Engineering layout, editors) | `src/vs/triage/` | P0-3 onwards |
| Small changes to upstream files, as numbered patches | `patches/` | P0-3 |

VS Code keeps its own npm build. It is not part of the pnpm workspace at the
repository root.
