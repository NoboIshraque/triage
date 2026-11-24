# cli/: the `triage` command line

Headless commands for CI and scripting (PLAN §4.10): `build`, `sim run [--scope …]`,
`test`, `erc`, `drc` and `export release`. For now it only has `help` and `version`.
The other commands arrive with their work packages (scenario tests in P3-6).

```sh
pnpm --filter @triage/cli build
node cli/dist/bin.js --version
```
