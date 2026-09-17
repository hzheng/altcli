# Validation layers

Run the repository gate from the root; no root package.json is required.

```bash
npm --prefix web ci
./scripts/check.sh
./scripts/check.sh --e2e
```

The gate checks skill installation (read-only), dependency-free hook/config
regressions, transport smoke tests, workflow tests against better-sqlite3, full
TypeScript, Vitest and production build. The e2e gate adds Playwright against mock
servers. Each viewport has a separate store. Mobile Chromium emulation is not
physical Safari/Tailscale validation.

## Focused checks

```bash
node --test scripts/review-regressions.test.mjs
cd web
npm run test:smoke
npm run test:workflow
npm test
npm run typecheck
npm run build
npm run e2e
```

Hook/config tests use temporary homes only. The HTTP hook smoke test invokes the
real hook with a fake tmux metadata executable and a loopback test server; it does
not launch a coding CLI. It proves current-message preference, start/stop binding,
overlapping-start refusal and no lagging-transcript reuse.

Workflow tests use simulated terminal transport and real SQLite. They cover exact
pair routing, duplicate and reordered lifecycle delivery, current-command binding,
source acknowledgment/session identity, unknown background state, delivery races,
long-running work beyond history limits, budget, restart and human takeover. Git
identity tests create disposable repositories, subdirectories and linked worktrees.

Browser tests cover explicit readiness, registration, pair selection, server
progression with a locked page, multiple views, pause/takeover, uncertainty and
unauthorized reads. Assertions use explicit correlated hook fixtures; they do not
pretend those are actual installed Codex/Claude payloads.

## Host acceptance still required

Use a disposable repository and private tmux socket first. Start with a harmless
read/echo process to check transport, then actual installed Codex and Claude Code.
Inspect process metadata, output and exact submitted prompt including command
marker. Confirm current hook fields and background-state evidence; missing fields
must pause rather than be faked for the test.

Exercise permission dialogs, queued/partial input, native CLI restarts, backend
restart, two clients, and physical iPhone disconnection. Record the exact commit,
CLI/tmux/Node versions, commands and observed outcomes. Final task-level tests and
Git delta review remain required after a relay chain ends.

A green CI checks the implementation and fixtures, not the host's process identity,
background-task observability or private-device security boundary.
