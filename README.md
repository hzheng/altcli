# CoderCrew

**A self-hosted control center for coding agents already running in tmux.**

Read multiple Codex and Claude Code sessions, select an explicit review pair, and
start a manual instruction or a bounded, server-owned relay. The same responsive
web console is intended for desktop and private iPhone access through Tailscale.
Native iOS and a third AI supervisor remain deferred.

## Status and boundaries

This is an experimental implementation, not a production release or a security
certification. See [VALIDATION.md](VALIDATION.md) for exactly what was exercised.
The server, not the browser, owns active runs. Closing or locking a page does
not stop a run. A backend restart pauses owned runs without replaying commands.

| Capability | Current behavior |
| --- | --- |
| Reading and registration | Discover panes, preview output, register explicit instances, group canonical Git worktrees |
| Command delivery | Bounded text (multi-line delivered as one bracketed paste), exact pane checks, durable delivery receipt and uncertainty |
| Relay pairing | An explicitly selected pair is frozen into each run |
| Automatic continuation | Server-only; exact correlated completion, clear background-work evidence, immutable participants, a per-run maximum of automatic turns (default 20) frozen at start; a Send & relay hands off only when the worktree digest changed during the turn |
| Unknown evidence | Pause and retain execution ownership; never guess from terminal text or recent history |
| Human control | Explicit readiness on start; pause does not interrupt; takeover requires inspection of all participants |
| Full terminal / native iOS / supervisor | Not implemented |

**Background-work evidence:** Claude uses `UserPromptSubmit` and the current
Stop payload, including background-task and cron information when available.
The Codex `notify` payload carries no such fields, so for a Codex participant the
server keeps its own evidence: it records the processes under or attached to the
pane just before delivery and, at completion, treats any process newly associated
with that pane that is still alive as active background work. Long-lived Codex
helpers that predate the turn are not counted. When neither source can answer (an older hook,
an unreadable process table, a pane whose identity changed), the completion stays
`unknown` and pauses the run. Use manual takeover after inspecting the workers.

## Start

Use Node 24 (`.nvmrc`). The application package is only under `web/`.

```bash
node scripts/setup.mjs
npm --prefix web ci
cd web && npm run dev
```

Open `http://127.0.0.1:8787` and enter the token from `web/.env.local`. The token
stays in page memory. For first use set `CODERCREW_ENABLE_INPUT=false`, restart the
backend, and verify captures before enabling input. `mock` is a test adapter;
`tmux` remains the normal product path.

Read [docs/SETUP.md](docs/SETUP.md) before issuing commands. Install the updated
hooks with `node scripts/install-hooks.mjs` and restart the CLIs. The installer
backs up changed files, preserves unrelated hook entries, and refuses unsupported
TOML instead of guessing. Review any refusal manually; it never needs your global
configuration uploaded anywhere.

## Using a run

Register the intended panes and create a named pair. A directory containing two
repositories is not one worktree; the backend discovers the actual root and index.
Select the pair, inspect every participant, then confirm readiness explicitly.

**Send** addresses one agent and never relays. **Send & relay** requests one review
when the instruction finishes, even with the continuation preference off, provided
the worker actually changed the worktree: the server takes a read-only Git digest
(HEAD, index, unstaged content, untracked files) just before delivery and again at
the correlated completion. An unchanged digest, for example when the worker asked
for more information or declined, ends the run without a review so you can answer
it with a plain Send; an unreadable digest pauses. Partial edits followed by a
question still relay, since the reviewer has something to look at. **Relay**
starts a review, with optional context. The preference only determines whether a
new explicitly started run continues after `accept_and_improve` and whether an
actionable `strong_objection` is sent back to the author as a correction instruction
before returning changed work to review; it is not an armed run by itself. An
objection without a reason or continuation permission, missing evidence, exhausted
budget, uncertain delivery, or changed instance pauses the run.

Commands carry a unique `[codercrew-command:<UUID>]` suffix. Hooks must echo the
exact prompt and bind its source turn/session; identical `relay` strings cannot
borrow each other's completion. Relay commands use the `relay:` prefix. The global
instruction rule must recognize that prefix as documented in [SKILLS](docs/SKILLS.md).
The marker is bookkeeping, not a new task. The skill's Git staging contract is
unchanged by this PR.

Use **Pause / take over** before desktop intervention. Pause keeps ownership and
does not send Ctrl-C or stop background jobs. After inspecting and stopping writers,
explicit takeover releases ownership without claiming success. No command is
silently retried. Final task-level tests and review remain your responsibility.

## Technology and layout

One host-resident Next.js App Router application: React, TypeScript frontend and
Node backend, Tailwind, SQLite through `better-sqlite3`, Vitest, and Playwright.
No ttyd, PTY emulator, message broker, separate worker service, or new npm workspace.

```text
web/src/components/       Browser views and explicit human actions
web/src/server/           ControlPlane, WorkflowStore, transport Controller, tmux adapter
web/src/contracts/        JSON-only API and workflow types
web/src/core/             Validation and policy
hooks/                   CLI lifecycle normalization and correlation
scripts/                 Repository checks and conservative local installers
shared/openapi.yaml      HTTP contract, including runs and lifecycle receipts
docs/adr/                Architectural decisions
ios/                     Reserved future host-API client
```

`WorkflowStore` owns execution independently of `Store`'s short-lived delivery
reservation. All active runs and commands remain visible even when the history
panel shows only the latest 30 deliveries. One backend process per database is
supported. Restart the development backend after server-code changes; hot reload
must not replace a live scheduler or close its database during delivery.

## Checks and documentation

```bash
./scripts/check.sh
./scripts/check.sh --e2e
node --test scripts/review-regressions.test.mjs
cd web && npm run test:workflow
```

See [ROADMAP.md](ROADMAP.md), [Architecture_Decision.md](Architecture_Decision.md),
[docs/SECURITY.md](docs/SECURITY.md), and [docs/TAILSCALE.md](docs/TAILSCALE.md).
The review-to-change map is in [docs/REVIEW-RESOLUTION.md](docs/REVIEW-RESOLUTION.md).
Historical documents under `docs/history/` are records, not current capability claims.

The source remains private-package/`UNLICENSED`; no public license is selected by
this change.
