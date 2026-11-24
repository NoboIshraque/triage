# engines/hello/: hello engine

The smallest Triage engine process. It prints its version and exits, and its
unit test runs without a test framework. ROADMAP **P0-4** grows it into the
engine connection pattern: a utility-process broker, a MessagePort to the
renderer with transferable ArrayBuffers, crash and restart handling, and a
throughput benchmark.

```sh
cmake --workflow --preset dev
build/native/dev/engines/hello/triage-hello-engine --version
```
