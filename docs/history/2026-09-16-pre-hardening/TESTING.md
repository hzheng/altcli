# Setup and end-to-end testing

One ordered path from a fresh clone to a real relay. Each level proves more than
the one before it; do not skip to a later level to "save time". Everything below
was run on macOS with Node 26, tmux 3.6a, and Next.js 16; Node 24 is the suggested
runtime.

## 0. Prerequisites

- macOS or Linux, one Unix user for everything (CoderCrew, tmux, the coding CLIs).
- Node >= 22.18 (`.nvmrc` says 24), npm, git, tmux 3.x.
- For level 4 only: Codex and/or Claude Code installed as native binaries and
  already logged in. An npm-installed CLI reports `node` as its process name and is
  refused on purpose.

## 1. Install

```bash
git clone <this repo> codercrew && cd codercrew
node scripts/setup.mjs            # writes web/.env.local with a random token; never overwrites
npm --prefix web ci               # exact versions from the committed lockfile
node scripts/install-skills.mjs   # symlink skills/review-handoff into ~/.claude/skills and ~/.codex/skills
```

Then add the one-line `relay` rule from [SKILLS.md](SKILLS.md) to your global
instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) so the console's
default prompt reaches the skill in every repository. Restart any open CLI.

## 2. Automated checks

```bash
./scripts/check.sh                                   # everything that needs no browser
cd web && npx playwright install chromium && cd ..   # once per machine
./scripts/check.sh --e2e                             # the same, plus the browser tests
```

`check.sh` runs, in order and stopping at the first failure: the skill-link check
(installed links point at this clone), then `web/`'s `check`: `test:smoke` (34
dependency-free tests: validation, denylist, identity, hex input, auth, config),
`typecheck`, `test` (22 Vitest tests: SQLite store, reservations, pairs, migration,
controller), and `build`. `--e2e` adds the 10 Playwright tests, desktop and iPhone
viewport, against the mock adapter (see the appendix). Each web step is also available on its own from `web/`
(`cd web && npm run test:smoke`, and so on; `npm run` alone lists them).

What they prove and what they don't: the smoke and Vitest suites use fake tmux
runners and the mock adapter; they never touch tmux, a repository, or a CLI. The
e2e suite drives the real console against a mock backend with its own temporary
store. It starts its own dev servers on ports 8787 and 8788 (one per viewport), so
either stop the dev server first or move the suite: `CODERCREW_E2E_PORT=9787
./scripts/check.sh --e2e` uses 9787 and 9788. CI runs exactly `./scripts/check.sh` and the e2e step.

## 3. First run: a harmless pane on a private tmux server

This is the product flow, end to end, against a pane that only runs `cat`, on a
**private tmux server** that cannot reach your real sessions. It proves listing,
preview, identity, hex input, Enter, capture, the reservation, and fail-closed
without involving a coding CLI.

```bash
mkdir -p /tmp/codercrew-dryrun/repo
tmux -L codercrew-dryrun new-session -d -s echo -c /tmp/codercrew-dryrun/repo 'exec cat'
SOCK=$(tmux -L codercrew-dryrun display-message -p '#{socket_path}')
STORE=$(mktemp -d /tmp/codercrew-store.XXXX)
cd web && CODERCREW_TMUX_SOCKET=$SOCK CODERCREW_DATA_DIR=$STORE npm run dev
```

Command-line variables override `web/.env.local` (keep `CODERCREW_TOKEN` in the
file); the throwaway store keeps your real registrations untouched. Open
`http://127.0.0.1:8787` and paste the token. Expected:

1. **LOCAL HOST** badge and, because nothing is registered yet, the add-pane
   panel is the page. Its list has one row, `echo:1.1 · %0 · cat ·
   /tmp/codercrew-dryrun/repo` (macOS shows the resolved `/private/tmp/…` path;
   window and pane indexes follow your tmux `base-index`) with a **Select** button.
   Try it first with the private server stopped (`tmux -L codercrew-dryrun
   kill-server`) to see the *No tmux server is running* message, then start it again.
2. **Select** it: a **Project** line appears with the pane's directory (the first
   pane fixes the project), the preview is an empty screen, and the type suggests
   *Other CLI*. Label it `Echo`, **Register pane**. The panel stays open, saying
   `1 of 2 panes`, now locked to that project; press **Cancel** to go to the console
   with one panel whose header reads `%0 · echo:1.1 · cat` and whose capture is empty.
3. Tick readiness and send `hello from CoderCrew; $(echo x) 中文`. Status:
   `DELIVERED`. The panel shows the line **twice**, once echoed by the terminal and
   once by `cat`, with `$(echo x)` and the CJK text literal. The composer is back
   to **MANUAL** at once; nothing to release. Tick readiness again to send more.
4. Fail closed: `tmux -L codercrew-dryrun send-keys -t %0 C-d` ends `cat`. Within
   one poll the panel turns **UNAVAILABLE** with tmux's own reason, and the
   composer is blocked.

Clean up:

```bash
tmux -L codercrew-dryrun kill-server 2>/dev/null; rm -rf /tmp/codercrew-dryrun "$STORE"
```

The same sequence through the HTTP API (curl with `Authorization: Bearer <token>`
against `/api/v1/state`, `/api/v1/panes/preview?paneId=%250`, `/api/v1/sessions`,
`/api/v1/commands`, `/api/v1/control/release`) produced exactly these results on
September 15, 2026; see [VALIDATION.md](../VALIDATION.md).

## 4. Real coding CLIs

Only after level 3. Follow [SETUP.md](SETUP.md) sections 2 to 5: start each CLI
in tmux on your default socket with `exec`, run `cd web && npm run dev` with no
overrides, and the first screen lists their panes. Select the first CLI's pane —
that fixes the project — then the second, which must be in the same repository (a
pane elsewhere is greyed as *outside …*); the panel stays open until both are in.
Verify each capture against the desktop terminal, then send one innocuous instruction such as `Reply only READY
without using tools or changing files.` before the first `relay`.

What to expect in the list: the Codex cask binary reports `codex`; a native Claude
Code install reports its version, for example `2.1.272`, and the agent type
suggests Claude Code. A pane that reports `zsh` or `node` says *shell or
interpreter* and cannot be selected.

Then `node scripts/install-hooks.mjs`, restart both CLIs and re-register their
panes: from now on each panel shows IDLE/WORKING from the CLI's own hook, a
finished relay hands the target to the pair partner, and readiness is pre-ticked
when the target is known idle (SETUP.md section 6).

Work through the manual acceptance checklist at the end of SETUP.md and record
the results in [VALIDATION.md](../VALIDATION.md). Only then consider
[private phone access](TAILSCALE.md).

## What is still not covered by any check

Real Codex/Claude Code sessions (level 4 is manual), Linux hosts, Safari on an
iPhone, Tailscale, host restarts, and a security audit. `VALIDATION.md` records
which of these have been done on which host.

## Appendix: the mock adapter (developers only)

`CODERCREW_ADAPTER=mock` replaces tmux with four simulated panes (`%0` codex and
`%1` claude registered in `/demo/project`, `%2` a shell, `%3` a spare codex in
`/demo/other`). The Playwright suite runs against it, and it is handy for UI work
on a machine without tmux: `cd web && CODERCREW_ADAPTER=mock npm run dev`. It never
touches a terminal or repository and has its own store under
`~/.local/share/codercrew/mock/`. It is not part of the product flow.
