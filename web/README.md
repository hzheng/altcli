# CoderCrew web workspace

Next.js App Router, React, TypeScript, Tailwind, SQLite/better-sqlite3, Vitest, and
Playwright. Node 24 is suggested.

Repository operations run from the root with plain `node`; every npm task runs here:

```bash
node scripts/setup.mjs        # from the repository root; dependencies, hooks, skills and local config
cd web
npm run dev                   # npm run (no task) lists dev, build, start, typecheck, test:smoke, test, e2e, check
```

The backend listens on `127.0.0.1:8787`. `src/app/api/v1/` contains thin Node route
handlers; `src/server/` owns privileged operations. `src/core/` contains deterministic
validation/policy and `src/contracts/` contains portable API types. The initial
transport is polling, not WebSocket/SSE, and captures are not a transcript.

See the root [README](../README.md), [validation record](../VALIDATION.md), and
[host setup guide](../docs/SETUP.md). tmux is the default adapter; `mock` exists
for the automated tests. Panes are registered from the console, not from a script.
`CODERCREW_ENABLE_INPUT=false` makes the console read-only.
