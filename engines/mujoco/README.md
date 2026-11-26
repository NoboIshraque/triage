# engines/mujoco: MuJoCo for the mechanics unit

MuJoCo (`upstream.json`: 4.0.1) built from source, unpatched, for Triage's mechanics
unit (ROADMAP P3-4, `crates/triage-mujoco`). The library only: no samples, viewer or
tests.

```sh
node engines/mujoco/build.mjs        # fetch, configure, build, install into build/<os>/install/
```

On Windows run it in a Visual Studio developer shell (MSVC and Ninja). The sim addon
(`node crates/triage-sim-node/build.mjs --mujoco`) links to it and copies the library
beside itself; `node app/build.mjs engines` ships both in the app.
