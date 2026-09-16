#!/usr/bin/env bash
# Repository-wide gate: the skill links are a root concern, everything else belongs to the web application.
# Usage: ./scripts/check.sh [--e2e]
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/install-skills.mjs --check
npm --prefix web run "$([ "${1:-}" = "--e2e" ] && echo check:e2e || echo check)"
