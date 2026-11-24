#!/usr/bin/env bash
# Builds Triage on Linux. The steps live in build.mjs, shared with build.ps1.
#   app/build.sh            fetch, prepare, install, package
#   app/build.sh prepare    selected steps only (see build.mjs)
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/build.mjs" "$@"
