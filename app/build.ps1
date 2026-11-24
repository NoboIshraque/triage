# Builds Triage on Windows. The steps live in build.mjs, shared with build.sh.
#   app\build.ps1            fetch, prepare, install, package
#   app\build.ps1 prepare    selected steps only (see build.mjs)
# Needs Node (the version in app\upstream\.nvmrc), Python and Visual Studio with
# the C++ workload, as VS Code's own build does.
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'build.mjs') @args
exit $LASTEXITCODE
