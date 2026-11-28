# crates/: Rust

Triage's Rust workspace (root `Cargo.toml`, toolchain pinned in `rust-toolchain.toml`).

| Crate | What | Work package |
|---|---|---|
| [`triage-model`](triage-model/) | Project model: `triage.toml`, link graph, codegen, napi binding | P0-5 (placeholder now) |
| [`triage-sim-kernel`](triage-sim-kernel/) | Simulation kernel: picosecond clock, units, quantum scheduler (grant/sync/unblock), signal bus, record/replay, scopes and stubs | P3-1 |
| [`triage-mna`](triage-mna/) | MNA solver for small analog islands (Newton–Raphson, backward Euler) | P3-3 |
| [`triage-sim`](triage-sim/) | The simulated device: circuit islands, parts, environment, mechanics, scopes' default stubs | P3-3 … P3-5 |
| [`triage-mujoco`](triage-mujoco/) | MuJoCo for mechanics: rotors built with `mjs_*`, torques in `mjcb_control` (needs `node engines/mujoco/build.mjs`) | P3-4 |
| [`triage-sim-node`](triage-sim-node/) | The kernel and device as a Node addon, `triage_sim.node` (`node crates/triage-sim-node/build.mjs --mujoco`) | P3-2 … P3-6 |
| [`triage-companion`](triage-companion/) | The phone companion's laptop side: QR payloads, wire frames, Noise sessions, certificates, pairing, the WebTransport server and the relay client | PC-2, PC-7 |
| [`triage-companion-node`](triage-companion-node/) | The companion as a Node addon, `triage_companion.node`, for the companion broker (`node crates/triage-companion-node/build.mjs`) | PC-2 |
| `triage-ngspice` | ngspice binding | P7-1 |
| `triage-part-sdk` | WASM smart-part SDK | P7-3 |

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
# with MuJoCo (after node engines/mujoco/build.mjs):
TRIAGE_REQUIRE_MUJOCO=1 cargo test -p triage-mujoco -p triage-sim --features triage-sim/mujoco
```
