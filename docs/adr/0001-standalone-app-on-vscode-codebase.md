# ADR 0001: A standalone app built on VS Code's codebase

- **Status:** Accepted, 2026-11-23 (project owner: "use VS Code … I want a full and
  complete new app")
- **Replaces:** the extension-only plan, which now lives in `NoboIshraque/triad-extension`

## Context

The owner wants one complete application that unifies coding, electronics, 3D design
and simulation, built on VS Code because it is the most widely used code editor.
VS Code's application code is open source as **Code-OSS** (`microsoft/vscode`, MIT).
Every VS Code-based product (VSCodium, Cursor, Windsurf, Positron) is built from that
repository. Microsoft's own download is a build of the same code with branding,
telemetry and Marketplace configuration added.

## Decision

**Triage is a standalone desktop app built from VS Code's source (a fork of
`microsoft/vscode`).** It has its own name, icon, installer and update channel, and
its new parts are compiled into the workbench rather than shipped as add-ons:

- **Native editors** inside the workbench (not webviews): schematic, PCB,
  3D/CAD and simulation, as `EditorPane`s with GPU canvases.
- **New engine processes** launched like VS Code's own helpers (`utilityProcess`
  plus `MessagePort`, the `ipcMessagePort.acquire` pattern found in the teardown):
  model, EDA, CAD, sim and render engines.
- **A Triage workbench layout** ("Engineering" layout with Code, Circuit, Board,
  3D and Sim side by side), a unified project explorer, Triage onboarding and branding.
- **Extensions keep working.** Use **Open VSX** as the gallery (Microsoft's
  Marketplace is for Microsoft's products). Students keep their themes, keymaps and
  language extensions.

## Consequences

Good:
- Full control of layout, editors, processes and performance. No webview overhead
  for the heavy views.
- Students get the VS Code they already know, with Triage built in.

Costs:
- **Fork maintenance:** keep Triage's changes isolated (new folders plus a small
  patch set on upstream files) and merge upstream releases on a schedule
  (GUIDELINES §6). REA's `compare-application-versions` helps check what changed.
- **Build infrastructure:** VS Code builds need Node, Python and native toolchains
  per OS. CI produces Windows, macOS and Linux installers, Windows first
  ([ADR 0003](0003-boards-and-windows.md)).
- Microsoft-only extensions (for example the C/C++ and Pylance extensions) are not
  available. Use open equivalents (clangd, basedpyright).
