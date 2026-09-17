# CoderCrew

**A self-hosted control center for AI coding agents.**

Read Codex, Claude Code, or any other coding CLI running in tmux in one browser
interface, issue a single-line instruction or `relay`, and keep their existing tmux
sessions alive independently of the browser.
Start with human-operated control. Add deterministic relay automation, then an
optional AI supervisor. A native iOS client is reserved for a future phase.

> **Starter status:** source scaffold with a mock console and a guarded tmux adapter.
> This is not a production release or an autonomous orchestrator. The build, unit,
> browser, and private-tmux checks have passed locally; real coding-CLI sessions and
> the phone path have not. See [VALIDATION.md](VALIDATION.md) before enabling real input.

## Start

Use Node 24 (`.nvmrc`), or another compatible Node version >=22.18.0.

```bash
cd codercrew
nvm use                         # Optional when the right Node version is already active
node scripts/setup.mjs          # Creates web/.env.local with a random local token
npm --prefix web ci
cd web && npm run dev
```

Open `http://127.0.0.1:8787` and paste the token printed by setup. It is also stored
in `web/.env.local`. Do not share it. Setup never overwrites an existing file. The
token stays in browser memory, not local storage.

The first screen lists the panes of your tmux server. If no server is running it
says so and shows the one command to start a CLI in tmux. Select the pane running
your first coding CLI: that fixes the **project** (its repository), and from then
on only panes inside that worktree can be added, because a review relay between
two repositories makes no sense. Name it, **Register pane**; the panel stays open
until the second agent is in. Then pick a target, confirm it is at an empty prompt,
and press **Relay** (optionally with context typed in the box, sent as `relay: …`)
or **Send** a one-line instruction. Delivery and completion are
intentionally different concepts: read the pane to see what the agent did; the
readiness box you tick before the next send is your confirmation that it finished.
Only a delivery the transport could not confirm asks you to check the terminal.

`node scripts/install-hooks.mjs` registers one small script as Claude Code's `Stop`
hook and Codex's `notify` command, so each panel shows when its agent's turn ended
(from the CLI itself, never from screen text), including the reviewer's final
`RELAY-OUTCOME:` line. A finished relay hands the target to the other agent with the
box pre-ticked; an objection comes back with its reason and a prefilled instruction to
the author. **Auto-relay** (on by default) keeps a chain going on `accept_and_improve`
only; on anything else it waits for you and says why.

`CODERCREW_ENABLE_INPUT=false` in `web/.env.local` turns the console read-only. The
`mock` adapter (`CODERCREW_ADAPTER=mock`) drives the automated tests with simulated
panes; it is not part of the product flow.

## Technology and layout

The `web/` workspace uses **Next.js App Router, React,
TypeScript on both client and Node backend, Tailwind CSS, SQLite with
better-sqlite3/raw SQL, Vitest, and Playwright**. This is one host-resident Next.js
application, not a Vite frontend plus a separate Express server.

```text
codercrew/
  README.md                     Start here
  ROADMAP.md                    Current phases and completion criteria
  Architecture_Decision.md      ADR index
  skills/review-handoff/        The relay skill; installed by symlink into both CLIs
  AGENTS.md / CLAUDE.md          Coding-agent project guidance
  docs/
    adr/                        Architecture records: stack, identity, projects and pairs
    history/                    Original roadmap and ADR, preserved unchanged
    TESTING.md                  Ordered setup and end-to-end test path, clone to relay
    SETUP.md                    Real tmux registration and manual verification
    SECURITY.md                 Threat boundary and current limitations
    TAILSCALE.md                Private phone access, after local validation
    SKILLS.md                   Skill ownership and use in other repositories
    SOURCES.md                  Reference sources and official documentation
  web/
    src/app/                    React pages and Node API route handlers
    src/components/             Responsive console, pane registration, relay pairs
    src/client/                 Browser API client
    src/contracts/              JSON-only TypeScript API types
    src/core/                   Framework-independent validation and policy
    src/server/                 Controller, auth, SQLite, and terminal adapters
    scripts/                    Offline smoke tests
    e2e/                        Desktop and mobile-viewport browser tests
  shared/openapi.yaml           HTTP contract for web and future native clients
  ios/README.md                 Reserved native-client boundary; no Xcode app yet
  scripts/                      Setup, skill installation, hook installation
  hooks/                        Turn-complete hook for Claude Code (Stop) and Codex (notify)
```

The Node runtime owns tmux access. The browser cannot select arbitrary binaries,
issue tmux subcommands, or send arbitrary shell commands through an execution API.
No ttyd, xterm.js, node-pty, agent SDK, or third model is required in this scaffold.
The architecture and source-reference scope are recorded in
[ADR-0002](docs/adr/ADR-0002-typescript-web-stack.md).

## What is included

The source implements a desktop multi-pane and mobile selected-pane reading view
for any number of registered panes, grouped into projects by worktree root; a
registration form fed by the live tmux pane list with a read-only preview of the
chosen pane and a confirmed agent type; named relay pairs validated to share one
worktree; bounded snapshot polling; a central composer with explicit target
selection; manual relay delivery; per-request UUIDs; SQLite command history; a
per-worktree hold while a command is in flight or its delivery is uncertain; and
explicit human acknowledgement of uncertain deliveries.
Snapshots replace one another; they are not accumulated as a transcript. Pairs group
and validate; they do not automate turns.

The tmux adapter checks registered pane/server identity, the process name observed
at registration, repository location, copy mode, and synchronized input before
every capture and send. Shells and generic interpreters can never be registered.
It never creates or kills an agent. These checks do **not** establish semantic
readiness or eliminate the race between inspecting a terminal and typing into it.
A read-only switch (`CODERCREW_ENABLE_INPUT=false`) disables Send and Relay.

Automatic turn-taking, permission-dialog handling, full terminal emulation,
notifications, third-agent supervision, and native iOS implementation are **not
implemented**. Turn-complete events from the CLIs' hooks are ingested and shown;
they suggest the next target and pre-tick readiness but never send anything.

## Connect existing sessions

Follow [docs/SETUP.md](docs/SETUP.md). In outline:

1. Run the coding CLIs in tmux on the same host as CoderCrew.
2. Set `CODERCREW_ADAPTER=tmux`, leaving input disabled initially.
3. In the console, pick each CLI's pane from the live list, check its preview, and register it with a label and type.
   Sessions on the same repository form a project; name the two that alternate as a relay pair.
4. Verify read-only captures, target checks, and the local manual acceptance list.
5. Explicitly enable real input only after that verification.

The relay skill reaches the agents through `node scripts/install-skills.mjs`, which links
`skills/review-handoff` into `~/.claude/skills` and `~/.codex/skills` for every
repository; it needs nothing outside this clone. Mapping the bare word `relay` to
the skill is a one-line rule in your global instruction files. See
[docs/SKILLS.md](docs/SKILLS.md).

## Development commands

```bash
./scripts/check.sh              # Skill links + web gate (test:smoke, typecheck, test, build); what CI runs
./scripts/check.sh --e2e        # The same plus the browser tests (once: cd web && npx playwright install chromium)
node scripts/install-skills.mjs # Link skills/ into ~/.claude/skills and ~/.codex/skills
cd web && npm run               # Lists every web task: dev, build, start, typecheck, test:smoke, test, e2e, check
```

There is no root `package.json`: `web/package.json` owns every npm task, and root
`scripts/` holds repository operations run with plain `node` (ADR-0006).

[docs/TESTING.md](docs/TESTING.md) walks through what each check proves, the mock
console, a safe tmux dry run against a `cat` pane, and the first real relay.

`web/package-lock.json` is committed from a local install and CI uses `npm ci`.

## Phone access and native iOS

The first iPhone experience is this responsive web interface over private Tailscale
Serve, not a native app. Use a production build, HTTPS, an exact origin allowlist,
and tailnet access restrictions. Do not expose the controller publicly. See
[docs/TAILSCALE.md](docs/TAILSCALE.md).

`ios/` reserves a future client of the host API. It does not promise Swift code
sharing, local coding-agent execution on iOS, or a standalone data model.

## Documentation and license

The original `ROADMAP.md` and ADR are archived under `docs/history/2026-09-13/`.
The active roadmap reflects CoderCrew's name and the newly confirmed TypeScript
backend. The uploaded handoff skill is preserved byte-for-byte at
`skills/review-handoff/SKILL.md`.

This starter is marked private/`UNLICENSED`; no public
license or trademark clearance is implied. Choose a license before publishing.
