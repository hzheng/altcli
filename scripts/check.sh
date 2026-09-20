#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/install-skills.mjs --check
node --test scripts/review-regressions.test.mjs scripts/setup.test.mjs
npm --prefix web run "$([ "${1:-}" = "--e2e" ] && echo check:e2e || echo check)"
