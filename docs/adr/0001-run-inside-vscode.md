# ADR 0001: Run inside the real VS Code, as extensions

- **Status:** Accepted, 2026-11-23 (project owner: "Use VS Code, it's the most used one")
- **Supersedes:** PLAN v0.1 bet #1 (a lightly patched Code-OSS distribution)

## Context

Triad needs a code editor with C/C++ language support, debugging, a terminal,
git and an extension ecosystem, plus room for our own schematic, PCB, 3D and
simulation views. The options:

| Option | Summary |
|---|---|
| A. Branded Code-OSS build | Patch VS Code's open-source core into our own app, as Positron and Cursor do. Full UI control, but a fork to maintain every month, a new app for students to install, and no access to Microsoft's Marketplace or Microsoft-only extensions |
| **B. Extensions for the real VS Code** | Ship Triad as extensions that install into the VS Code students already use |
| C. Eclipse Theia | An IDE framework (Arduino IDE 2 uses it). Smaller ecosystem, and a different UI from what students know |

The teardown (`docs/research/vscode.md`) analyzed VSCodium, the MIT build of the
same source, only because Microsoft's build license forbids reverse
engineering. Every finding applies to VS Code itself.

## Decision

**Option B.** Triad is a set of VS Code extensions published on the **VS Code
Marketplace**, and on **Open VSX** for VSCodium, Cursor and other forks. There
is no fork and no separate app.

How the pieces map onto VS Code:
- **Editors** (schematic, PCB, 3D/CAD, scenarios) are **custom editors**
  rendered in sandboxed webviews with WebGL2/WebGPU canvases.
- The **Run & Test views** are webview panels. Tests use the **Testing API**,
  debugging uses a **debug adapter** (DAP → GDB → emulator stubs), and builds
  use **tasks**.
- The **project explorer** is a view container with tree views. Onboarding
  uses **walkthroughs**.
- **Engines** (model, geometry and sim services) are separate processes
  launched and supervised by the extension. Native binaries ship in
  **platform-specific VSIX** packages. The JS MCU emulators run in a forked
  Node helper, which relies on the RunAsNode fuse we observed enabled.
- **Data paths:** `postMessage` (with transferred ArrayBuffers) between webviews
  and the extension, JSON-RPC between the extension and the engines, and a
  direct localhost WebSocket from the sim service to webviews for live streams.

## Consequences

Good:
- **Reach:** one-click install into the most widely used editor, keeping
  students' settings, themes and extensions, including Microsoft's C/C++ and
  Python extensions.
- **No fork maintenance:** VS Code updates itself, and we test against stable and Insiders.
- **Remote and cloud work for free:** Remote-SSH, WSL and Codespaces (handy for lab machines).
- A path to the **web** through web extensions on vscode.dev.

Costs and limits:
- **Only the public extension API.** We can't rearrange the workbench into
  custom "perspectives" or draw outside webviews. The plan doesn't need either.
- **Webview overhead:** each heavy view is an iframe, and messages are
  serialized. Mitigated with GPU canvases, workers, transferred buffers and
  direct WebSocket streams. The §4.14 budgets are checked from Phase 1.
- **Platform-specific packages** must be built for every OS and architecture in CI.

## Revisit when

A must-have experience proves impossible with stable extension APIs. Then
consider a branded Code-OSS build (Positron's route). Our extensions would run
in it unchanged, so this decision doesn't close that door.
