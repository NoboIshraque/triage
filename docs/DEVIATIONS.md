# Deviations from the plan

> Every place where what was **built** differs from what [PLAN.md](PLAN.md),
> [ROADMAP.md](ROADMAP.md), [GUIDELINES.md](GUIDELINES.md) or an
> [ADR](adr/) said. The owner uses this list to compare the final build with
> the plan. Add an entry **in the same commit** as the change (GUIDELINES §4).
>
> **Docs updated?** "yes" means the plan documents were changed to match, and
> the entry keeps the original wording here. "no" means the plan still says the
> original, and this entry is the only record.

| # | Date · WP | The plan said | What was built | Why | Docs updated? | Revisit |
|---|---|---|---|---|---|---|
| DV-01 | 2026-11-24 · P0-2 | Forks keep "`upstream/`: a pinned upstream release, imported untouched" (GUIDELINES §6) and an "upstream snapshot" in `app/` (PLAN §4.12) | Upstream is **not committed**. `app/upstream.json` pins tag + commit; `scripts/forks/fetch.mjs` checks out exactly that commit into `app/upstream/` (git-ignored) and refuses a moved tag. The build applies `product.json`, overlay folders and patches on top | VS Code 1.147.0 is 411 MB / 21,462 files, and KiCad and FreeCAD are larger. Keeping only the pin and Triage's changes is VSCodium's model and makes P0-3's "re-applies onto a fresh upstream checkout" the normal path | yes (GUIDELINES §6, PLAN §4.12) | no |
| DV-02 | 2026-11-24 · P0-2 | Patch scripts `scripts/forks/apply.sh` and `refresh.sh` (GUIDELINES §6) | Node scripts (`scripts/forks/*.mjs`, `app/build.mjs`). `app/build.sh` and `app/build.ps1` (ROADMAP P0-2) only start `build.mjs` | `.sh` files don't run on Windows, and GUIDELINES §8 bans Linux-only scripts; one implementation serves both | yes (GUIDELINES §6) | no |
| DV-03 | 2026-11-24 · P0-2 | The research and its fork insertion points describe VS Code **1.143** (VSCodium 1.143.17232, [vscode.md](research/vscode.md)) | The fork pins **VS Code 1.147.0** (tagged 2026-11-17), the latest release when P0-2 started | build on a current release; four minor versions apart | no (research stays as observed) | P0-3: re-check the insertion points it uses |
| DV-04 | 2026-11-24 · P0-2 | VS Code's build was assumed to use npm (PLAN §4.11: "pnpm + Turborepo (TS)" for Triage only; GUIDELINES §8: "Node (VS Code's pinned version)") | Upstream VS Code moved to **pnpm 12.16.0** and **Node 24.22.1** since planning. Triage's own workspace stays on pnpm 10.28.0; corepack runs the pnpm each `package.json` pins | an upstream change, not a choice | no | P0-6 (setup scripts install both) |
| DV-05 | 2026-11-24 · P0-1 | Node = "VS Code's pinned version" (GUIDELINES §8) | CI and the App build use **Node 24.22.1** (root `.nvmrc` and `app/upstream/.nvmrc`). Claude's cloud sessions run the root tooling on their preinstalled **Node 22.23.5** | installing another Node in a session means running a downloaded binary (CLAUDE.md) | no | P0-6 |
| DV-06 | 2026-11-24 · P0-1 | Repository layout of PLAN §4.12 | **Added:** `engines/hello/` (seed of P0-4's hello engine), root `CMakeLists.txt` + `CMakePresets.json` (Triage's own C++; the forked engines keep their own builds), `app/product.json`, `app/resources/`, `app/smoke/` (smoke test package), `scripts/forks/`, `scripts/format/`, `scripts/branding/` | each is needed by a P0 deliverable | no | no |
| DV-07 | 2026-11-24 · P0-2 | "Running builds on Linux and Windows; a Playwright smoke test opens a window on both" (ROADMAP P0-2), with Claude developing on Linux (GUIDELINES §10) | The app is built and smoke-tested **only in CI** (GitHub's runners). Claude's sessions don't run Electron | building VS Code downloads Electron and other prebuilt binaries, and CLAUDE.md forbids running them in a session without the owner's OK | no | when the owner answers the STATUS open question |
| DV-08 | 2026-11-24 · P0-2 | "Keep `main`-quality: the build stays green and tests pass at every push" (GUIDELINES §2); CI on Windows and Linux on every push (GUIDELINES §8) | The fast CI (format, TypeScript, Rust, C++) runs on every push. The **App** workflow (VS Code build + smoke test, about an hour of Windows time) runs only when `app/`, `scripts/forks/` or its workflow change, or by hand | the repository is private: 2-core runners, and Windows minutes count double | no | P0-7 adds a nightly run |
| DV-09 | 2026-11-24 · P0-1 | CI matrix on Windows and Linux for every check (ROADMAP P0-1) | Formatting checks (Prettier, clang-format 18, rustfmt) run on **Linux only**; build, lint, typecheck and tests run on both | formatting doesn't depend on the OS, and `.gitattributes` forces LF line endings on Windows checkouts | no | no |
| DV-10 | 2026-11-24 · P0-1 | CI uses ccache (GUIDELINES §8) | The `ci` CMake preset turns ccache **off** | the Windows runners carry an unrelated `ccache.exe` (Strawberry Perl) that CMake picked up | no | P0-6 adds a cached ccache |

## Choices the plan left open

Not deviations. Recorded so the final build can be traced back to them.

| Date · WP | Choice | Why |
|---|---|---|
| 2026-11-24 · P0-1 | TypeScript **6.0** for Triage's packages (TypeScript 7, the native port, is the latest) | typescript-eslint supports TypeScript < 6.1. VS Code itself pins `@typescript/typescript6` |
| 2026-11-24 · P0-1 | pnpm installs only releases at least **7 days old** (`minimumReleaseAge`) | supply-chain guard against freshly published malicious releases |
| 2026-11-24 · P0-1 | clang-format **18** from Ubuntu's packages, checked by a Node script | a downloaded PyPI wheel would be a third-party binary; the version is pinned because formatting differs between majors |
| 2026-11-24 · P0-1 | Rust **1.97.0** pinned (`rust-toolchain.toml`), clippy pedantic, `unsafe_code` denied by default | same compiler and lints locally and on both CI systems |
| 2026-11-24 · P0-2 | Open VSX gallery keys as VSCodium uses them; Triage's own Windows app IDs and data folders (`.triage`) | Triage installs beside VS Code without clashing |
| 2026-11-24 · P0-2 | Placeholder icon (teal square, white "T", amber dot) drawn by `scripts/branding/placeholder_icons.py` | ROADMAP P0-2 asks for placeholder branding; the real icon comes before v1.0 |
| 2026-11-24 · P0-2 | GitHub Actions pinned by commit SHA, at the versions upstream VS Code's own workflows use | supply-chain hygiene; versions observed in `app/upstream/.github/` |
