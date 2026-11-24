# crates/: Rust

Triage's Rust workspace (root `Cargo.toml`, toolchain pinned in `rust-toolchain.toml`).

| Crate | What | Work package |
|---|---|---|
| [`triage-model`](triage-model/) | Project model: `triage.toml`, link graph, codegen, napi binding | P0-5 (placeholder now) |
| `triage-sim-kernel` | Simulation kernel: clock, scheduler, signal bus, scopes, record/replay | P3-1 |
| `triage-mna` | MNA solver for small analog islands | P3-3 |
| `triage-mujoco` | MuJoCo binding for mechanics | P3-4 |
| `triage-ngspice` | ngspice binding | P7-1 |
| `triage-part-sdk` | WASM smart-part SDK | P7-3 |

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
