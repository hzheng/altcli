# Starter validation record

**Packaged:** September 14, 2026  
**Last local validation:** September 15, 2026  
**Scope:** Source scaffold, not a completed release or security certification

## Executed locally on September 15, 2026

Host: macOS (Darwin 25.6.0), Node 26.0.0, npm 11.12.1, tmux 3.6a, Next.js 16.3.4.
The suggested runtime is still Node 24; Node 26 was what the host had.

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm ci` from the committed `web/package-lock.json` (isolated copy) | Passed, 133 packages | Lockfile and manifest are in sync |
| `node scripts/install-skills.mjs` then `--check` | Passed | `~/.claude/skills/review-handoff` and `~/.codex/skills/review-handoff` are symlinks into this repository; the check skips itself on a host without either CLI directory |
| `cd web && npm run test:smoke` | 34 tests passed | Validation, slug/label rules, registration and pair parsing, agent-type suggestion, denylist, identity checks, pane listing parsing, preview arguments, tmux error detail, hex transport, auth, config; fake runners only |
| `cd web && npm test` (Vitest) | 22 tests passed | SQLite store and controller: per-worktree reservation, duplicate suppression, uncertainty, recovery of several reservations, registration/replacement/removal, pairs and their refusals, turn-locked changes per worktree, preview, listing failure, reopen, version 1 to 2 migration |
| `cd web && npm run typecheck` | Passed | Full dependency-aware TypeScript check including Next route types |
| `cd web && npm run build` | Passed | Production build of all routes including `/api/v1/sessions`, `/api/v1/sessions/[id]`, `/api/v1/pairs`, `/api/v1/pairs/[id]`, and `/api/v1/panes/preview` |
| Playwright e2e (desktop Chromium and iPhone 13 viewport) | 10 tests passed | Mock relay and release, pane registration with preview and agent type, shell refusal, project tabs, removal, pair creation/filtering/refusal/removal, independent reservations across projects, wrong token; run against `next start` on an alternate port because a dev server occupied 8787 |
| Private tmux 3.6a server (`tmux -L`, throwaway, killed afterwards) | Passed | Real `display-message`/`list-panes` metadata parsing, `synchronize-panes` and copy-mode detection, literal delivery of `$(echo hi)`, backslash, `;`, CJK, accents and emoji through `send-keys -H`, Enter as a separate step, process gate failing closed against `cat` |
| Full round trip in tmux mode through the HTTP API against a `cat` pane on a private socket (`next start`, real input enabled, throwaway store) | Passed | Live listing showed the pane; preview returned its screen; registration recorded `expectedCommand: cat`, type `other`; an instruction with `$(echo …)` and CJK was `delivered` and appeared literally in the capture; the worktree reservation was held, then released; after the process exited the panel went `unavailable` with tmux's reason. This is [docs/TESTING.md](docs/TESTING.md) level 4. |

Process-name observation on this host, which motivated ADR-0004: the native Claude Code
install (`~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.272`) reports the
kernel short name `2.1.272`, so a hardcoded `claude` check never matches. The Codex cask
binary reports `codex`.

Earlier the same day, before the fixes now included: `npm run typecheck` and
`npm run build` failed with seven `NODE_ENV` type errors, and the original e2e
"unknown token" test failed on an ambiguous `role="alert"` locator. Both are fixed.

First real relay (Codex 0.154.0 and Claude Code 2.1.273 in tmux, repository
agentspec, September 15): registration, capture and delivery worked for both;
Claude Code submitted and ran the skill; Codex received `relay` but inserted the
Enter as a newline because its TUI treats a fast character burst as a paste for
120 ms. The adapter now waits 300 ms before Enter (smoke-tested); Codex
submission itself still needs a re-run on the host to confirm.

## Executed in the packaging environment (September 14, 2026)

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run test:smoke` | 25 tests passed | Dependency-free validation, policy, auth, configuration, bounded JSON, mock behavior, and tmux adapter argument/identity tests |
| `npm run skills:check` | Passed | Tool-specific copies match root canonical SKILL.md |
| TypeScript syntax transpilation | Passed for all 29 TS/TSX implementation/config/test files | Syntax/transpile diagnostics only; not full dependency-aware checking |
| Setup script | Passed in an isolated temporary directory | Random token generation, 0600 file mode, and no-overwrite behavior |
| Source/artifact structure | Passed | Supplied-source byte equality, JSON/YAML parsing, internal OpenAPI references, and current documentation links |
| Dependency-free TypeScript subset | Passed using local TypeScript 5.8.3 and Node types | Semantic checks for the smoke suite and its core/auth/config/tmux/mock/HTTP dependencies |

Smoke tests ran on Node **22.16.0** with `--experimental-strip-types`. The suggested
project runtime is Node 24, and package engines specify >=22.18.0. Running this
small suite on the packaging runtime is not a claim that the full application was
validated on that older runtime.

The tmux adapter tests use a fake argument runner, plus one harmless real Node
child-process invocation to test `execFile`. They do **not** run tmux, Codex, or
Claude Code. The tests prove local helper behavior, not terminal compatibility,
agent readiness, or the safety of unattended operation.

## Still not executed

- Real Codex or Claude Code sessions in tmux: registration of a live CLI pane,
  read-only capture of its screen, and a supervised `delivered` input. The tmux
  checks above used a private server running `cat`, not a coding CLI.
- The manual acceptance checklist in [docs/SETUP.md](docs/SETUP.md).
- Linux hosts, Safari on iPhone, Tailscale deployment, host restart acceptance,
  and a security audit.

No live-agent run is claimed. Package versions were taken from the inspected
TimedGoal manifest; the lockfile resolves them as installed locally.

## Local validation before real input

Follow [docs/TESTING.md](docs/TESTING.md) in order: install, automated checks, the
tmux dry run against a harmless `cat` pane, and only then real coding CLIs with
[docs/SETUP.md](docs/SETUP.md)'s manual acceptance checklist. Run read-only
(`CODERCREW_ENABLE_INPUT=false`) first if you want captures verified before any send.

Update this record with actual results and versions as you proceed. Do not check
off roadmap acceptance merely because a corresponding source file now exists.
