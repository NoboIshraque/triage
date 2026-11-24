# How we build Triad (the owner + Claude)

Triad is built by two: **the owner** and **Claude**, working in Claude Code
sessions. These guidelines make every session productive on its own and keep the
project coherent across many sessions.

## 1. Roles

| The owner | Claude |
|---|---|
| Product direction and priorities | Implementation, tests, documentation |
| Decisions (confirms ADRs, answers open questions) | Proposes options with a recommendation; writes ADRs |
| Tries builds on their own laptop and reports what felt wrong | Keeps builds green and `STATUS.md` current |
| Engineering-student perspective: what courses and boards need | Research with REA when integrating engines |
| Merges pull requests | Opens pull requests when a work package is done (only when asked) |

## 2. Session routine

**Start (first minutes)**
1. Read `CLAUDE.md`, then `docs/STATUS.md`: the current work package (WP), blockers and open questions.
2. Read that WP in `docs/ROADMAP.md`, plus the PLAN sections and ADRs it touches.
3. State the goal and "done when" in two or three lines. If a decision the WP
   depends on is open, ask before building.

**During**
- Work on the session's assigned branch. Use small Conventional Commits
  (`feat(sim): …`, `fix(eda): …`).
- Keep `main`-quality: the build stays green and tests pass at every push.
- **Commit and push at each meaningful step.** Cloud sessions can restart (see §10),
  and anything not pushed can be lost.

**End**
1. Update `docs/STATUS.md`: WP status, what's done, what's next, known issues.
2. Push.
3. Tell the owner what now works, how to try it, what's next, and any questions.

## 3. Work package template

```markdown
### <ID> <title>
Goal: one sentence.
Deliverable: what exists afterwards (code, UI, docs).
Done when: observable checks (tests, demo steps).
Depends on: WPs, decisions.
Notes: risks, references (PLAN §, ADR, research doc).
```

A WP is **1–3 sessions**. If one grows beyond that, split it in `ROADMAP.md`
before continuing.

## 4. Definition of done (every WP)

- The "done when" checks pass and are automated where possible.
- New code has tests. Engine integrations have golden files.
- CI is green on Linux (Windows and macOS once P0-6 lands).
- No performance budget from PLAN §4.14 regresses (benchmarks for touched areas).
- Docs updated: user-facing notes, `STATUS.md`, and an ADR if a decision was made or changed.

## 5. Branches and pull requests

- One assigned branch per session. Never push to `main` directly.
- When a WP (or a few related ones) is done and CI is green, open a PR to `main`
  if the owner asked for PRs. The owner reviews and merges.
- Parallel sessions on **independent** WPs are fine, with separate branches and
  no shared files beyond `STATUS.md` (merge that by hand).

## 6. Forks: VS Code, KiCad, FreeCAD

All three follow the same rules:
- `upstream/`: a pinned upstream release, imported untouched.
- `patches/`: numbered `*.patch` files with **small** changes to upstream
  files, such as registration hooks or new backends. Apply and refresh them with
  `scripts/forks/apply.sh` and `scripts/forks/refresh.sh` (created in P0-3).
- **Triad-only code lives in its own folders** (`app/src/vs/triad/`,
  `engines/eda/triad/`, `engines/cad/triad/`), so upstream merges stay mechanical.
- **Update cadence:** VS Code every 2–3 months; KiCad and FreeCAD on stable
  releases. An update is its own WP. Re-run the REA breakdown (§9) first to
  see what changed (new protos, GAL methods, process entry points, exports).

## 7. Testing strategy

| Layer | How |
|---|---|
| Rust and TypeScript units | `cargo test`, Vitest |
| KiCad engine | round-trip and render goldens on the `kicad-demos` corpus (36 projects); Stream GAL display-list goldens; ERC/DRC parity with `kicad-cli` |
| CAD engine | recompute goldens for FreeCAD test documents; tessellation checksums |
| App | Playwright on the Electron app: open project, edit, run sim |
| Simulation | deterministic scenario replays; per-part scenarios; scheduler property tests |
| Performance | benchmarks for PLAN §4.14, tracked in CI |

## 8. Build and CI

- Toolchains: Node (VS Code's pinned version), pnpm, Rust stable, CMake + Ninja,
  and the C/C++ compilers per OS. Dependencies install via `scripts/dev/setup.sh`.
- CI: GitHub Actions matrix (Linux first, then Windows and macOS), with **ccache**,
  cargo and pnpm caches. Native engine builds are cached by upstream version and
  patch hash.
- Nightly builds are uploaded as artifacts, so the owner can try them.

## 9. Using REA (reverse engineering)

Use the **`rea-full-breakdown`** skill (`.claude/skills/`). It runs REA in
**unbounded mode** from the owner's fork (`NoboIshraque/rea`, branch
`claude/unified-engineering-platform-jn5rmk`). Use it when:
- **Updating a fork:** compare the new shipped build with the old one. For VS Code
  bundles, `compare-application-versions`. For KiCad, symbol diffs via the `-dbg`
  package. For FreeCAD, export diffs.
- **Integrating behavior that isn't documented**, from a shipped binary.
- **Learning from other tools** (simulators, EDA, CAD).

For source trees we have (the forks), read the source. REA is for shipped artifacts.

## 10. Lessons from the planning sessions

- **Cloud sessions can restart** and kill running processes. Two restarts
  happened while analysis jobs together used about 10 GB of RAM. So keep
  combined memory of background jobs under about 6–8 GB, launch long jobs
  detached (`setsid nohup … &`) with logs on disk, and **commit and push often**.
- **Running downloaded third-party binaries can be blocked** by the session's
  safety policy (a headless Blender run was refused). Build engines from source
  inside sessions, and ask the owner before any workaround. Never bypass a refusal.
- Large native builds (KiCad, FreeCAD, VS Code) take long. Use ccache, build only
  needed targets, and prefer CI for full builds.

## 11. When Claude stops and asks

- A decision changes product scope, user-visible behavior or architecture (ADR level).
- Anything outward-facing: publishing a release, creating repositories, posting
  anywhere.
- Two consecutive sessions fail to reach a WP's "done when". Re-plan with the owner.
