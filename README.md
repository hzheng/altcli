# CoderCrew

**A self-hosted control center for coding agents already running in tmux.**

Read multiple Codex and Claude Code sessions, select a group,
and explicitly start in Plan or Implementation. Planning produces captured documents;
implementation uses committed handoffs. The same responsive
web console is intended for desktop and private iPhone access through Tailscale.
Native iOS and a third AI supervisor remain deferred.

## Accepted next direction

The local Implementation path supports groups, solo work, peer relay, fixed
worker/reviewer roles, committed handoffs, confirmed new-branch setup, and manual
Next turn. Plan now supports sequential independent drafts, shared-plan refinement,
exact-version endorsements, and a separate human approval checkpoint. The [ADR index](Architecture_Decision.md#accepted-collaboration-direction-not-yet-implemented)
and [workflow guide](docs/WORKFLOWS.md) describe the broader design; source support
does not imply installed-host acceptance.

The supervised staging fallback is off by default. Set
`CODERCREW_ENABLE_LEGACY_RELAY=true` and restart the backend to expose the supervised
fallback. Its staging contract remains unchanged.

Use [ROADMAP](ROADMAP.md#migration-and-implementation-sequence) for rollout, [OPEN-DECISIONS](docs/OPEN-DECISIONS.md) for unresolved choices, and [DESIGN-MIGRATION](docs/DESIGN-MIGRATION.md) to locate the content formerly held in the standalone collaboration draft. The draft is no longer a required document.

## Status and boundaries

This is an experimental implementation, not a production release or a security
certification. See [VALIDATION.md](VALIDATION.md) for exactly what was exercised.
The server, not the browser, owns active runs. Closing or locking a page does
not stop a run. A backend restart pauses owned runs without replaying commands.

| Capability | Current behavior |
| --- | --- |
| Reading and selection | Discover eligible agents without registration; checkboxes select members, inline names preserve identity; Start pins exact instances |
| Projects and worktrees | Local repositories grouped by shared Git metadata; linked and empty worktrees remain visible; explicit confirmed creation under `~/.codercrew/<repo-name>/<branch-name>` |
| Command delivery | Bounded text (multi-line delivered as one bracketed paste), exact pane checks, durable delivery receipt and uncertainty |
| Implementation groups | One or two exact registered instances, frozen into each run; solo, peers, or fixed worker/reviewer |
| Optional Plan | One or two required planners, concurrency one; ignored drafts, captured shared-plan versions, exact-version approval/override and retained final text |
| Committed handoffs | One published result per completed turn in CoderCrew's handoff journal, at most one direct commit (none for report-only turns), archived patches, exact review range and role checks, captured initial work, clean review entry and leftovers; a tracked log mirror is an explicit project preference |
| Automatic continuation | Server-only; correlated completion, clear background-work evidence, valid publication, frozen participants and bounded automatic turns (default 20); work hands off only when project content changed |
| Unknown evidence | Pause and retain execution ownership; never guess from terminal text or recent history |
| Human control | Explicit branch/readiness confirmation; normal Next turn at manual waits; pause does not interrupt; takeover requires inspection of all participants |
| Full terminal / native iOS / supervisor | Not implemented |

**Background-work evidence:** Claude uses `UserPromptSubmit` and the current
Stop payload, including background-task and cron information when available.
Both CLIs report native session startup as Ready before the first observed
prompt. Ready does not certify task completion or absence of background work.
Codex pairs native `UserPromptSubmit` with `notify` using the exact session and
turn IDs; install both hooks, restart Codex and trust the native hook through
`/hooks` after upgrading. Notification
prompt history is never used to infer the current command.
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
# For first-use capture checks, set CODERCREW_ENABLE_INPUT=false in web/.env.local.
cd web && npm run dev
```

Open `http://127.0.0.1:8787` and enter the token from `web/.env.local`. The token
stays in page memory. For first use set `CODERCREW_ENABLE_INPUT=false`, restart the
backend, and verify captures before enabling input. `mock` is a test adapter;
`tmux` remains the normal product path.

Setup installs dependencies, links skills, installs and verifies hooks, and creates
local configuration without overwriting it. Restart the coding CLIs to load their
hooks and skills. Read [docs/SETUP.md](docs/SETUP.md) before issuing commands.

## Choose a phase

The console makes **1 · Plan** and **2 · Implementation** explicit. You can skip
Plan and start coding directly; selecting a phase only configures a new run.
An active run always displays its server-owned phase separately.

### Plan first

Prepare a narrow `.codercrew/plans/` exclusion yourself, then start from a clean
checkout. The controller checks every assigned output is ignored and untracked;
it never changes ignore rules. A broad `.codercrew/` exclusion is refused. In
this repository that existing broad rule must be narrowed deliberately before
using Plan; this change does not expose or adopt any existing ignored files.

Each selected planner drafts independently, sequentially, without receiving peer
content. Once every required draft is finalized, one planner synthesizes a shared
plan and the others review its exact captured version. Any edit invalidates old
endorsements. Solo becomes **Plan ready (solo)** without claiming peer consensus.
Planning does not edit project code, stage, commit, or switch branches.

**Automatic collaboration** and **Require my approval before implementation**
are independent controls. With approval required (the default), agreement waits
for **Approve & implement**. With approval waived, automatic collaboration may
transition after agreement; with automation off it still waits for **Continue to
Implementation**. Missing branch consent always waits. The workspace group is shared
by both phases; implementation roles and branch choice are separate settings. Branch creation happens only
after planning settles.

At the checkpoint inspect captured drafts, the shared plan, endorsements and
objections. **Request changes** sends a new shared brief revision to the selected
planner at that settled boundary; stale approvals no longer apply. Proceeding
despite disagreement requires an explicit override reason. A frozen copy of the
final text and authorization is retained in SQLite and included in Implementation
assignments. The automatic-turn budget is shared across both phases, never reset
by approval. Stop/pause does not interrupt a worker.

The separate `plan-handoff` skill publishes a bounded structured result outside
the checkout before finishing. Only the exact correlated lifecycle completion,
clear activity evidence and validated document capture can advance the run.
Permissions and draft withholding are cooperative; no native CLI plan-mode
sandbox or real installed-agent acceptance is claimed. Larger rosters, concurrent
drafting, mid-turn guidance and automatic restart recovery remain deferred.

### Implementation

Choose a project and worktree in **Projects**, then open its task group in Console. It has one group per agent directory, with all
eligible agents included by default and a checkbox for each. One selected member
is solo, two a pair, and three or more a larger group. Names default to the tmux session name (for example, `codercrew-cc:1.1`
uses `codercrew-cc`); saved names remain explicit overrides. Inline Name fields replace
registration and rename buttons. Selection supports larger groups; execution
currently supports one or two and explicitly blocks larger runs.
Choose peer collaboration or fixed worker/reviewer roles for
two members. Solo work publishes a proposal without claiming independent review.
Direct Implementation creates no artificial planning record.

Commit snapshots all staged, unstaged and nonignored untracked changes
as they stand, including unfinished work, and stops without a relay.
It does not implement pending requests or claim the task is complete. Both Relay actions require
a clean index and nonignored worktree. Confirm the displayed branch and commit: continue on a task branch, confirming its recorded baseline when it
cannot be inferred, or explicitly create a new task branch there. The default
branch and configured integration branches (`CODERCREW_INTEGRATION_BRANCHES`,
default `main,master`) are starting points only: create a task branch or task
worktree from them; integrate accepted results with a separate squash merge or
pull request. Detached HEAD needs a new named branch. The controller never
switches to an existing branch, stashes, stages, commits, or discards changes.
Confirm that selected and unselected agents sharing the checkout are settled.
Use an existing worktree or **Create task worktree** in Projects. Preview and
confirm the source checkout, exact commit, new branch and destination; creation
does not switch any existing checkout. Dirty source changes remain untouched and
are not copied. Separate clones stay separate even with matching remotes; branch
names are not project or worktree identities. Git's worktree inventory includes
empty checkouts, and explicitly used/created projects are remembered after restart.
New worktrees have no agents: prepare dependencies/environment and launch coding
CLIs in the new directory yourself, then Recheck. No automatic cleanup or merge
follows completion; each linked task worktree instead offers three confirmed
end-of-task actions in Projects. Squash can run in successive batches: choose
**Squash through commit**, preview the range, edit its message, and confirm. Leave
the SHA empty for all remaining commits. Later batches resume after the last
recorded endpoint; idle agent panes are allowed, and disabled squash actions
explain their blocker. **Squash into main** previews one squash commit of the task
branch through a chosen SHA into local main/default (the exact staging and
`git commit` in the checkout that has that branch checked out, the commits
involved, a conflict-free merged tree and an editable message) and performs it
on confirmation; the target checkout must be clean and unowned, and the task
branch and worktree are left as they are. **Check removal** previews and confirms
non-force removal after ancestry, an exact squash patch, or verified batches
through the current task HEAD prove integration;
modified and nonignored untracked files, panes and unresolved runs block it,
ignored files are allowed with a warning, and the branch and history remain.
**Discard…** force-removes the worktree and deletes its branch without
integration evidence after you type the branch name; it reports the commits and
uncommitted changes that will be lost and archives the handoff journal first.
Uncertain results of any of them offer inspection, never automatic retry.

Each assigned agent reads the repository's separate `commit-handoff` skill and
an immutable assignment file outside the managed checkout. The agent publishes
one JSON result to the external result path named there and, when it changed
project content, exactly one direct commit with its permitted edits; a report-only
turn publishes no commit. The controller validates the result, exact parent/range,
clean leftovers, and correlated lifecycle evidence before recording the turn in
its handoff journal (with the commit's archived patch) and scheduling another
turn. Existing lifecycle hooks remain required. The journal is app data: **Export
history** in Status downloads a worktree's runs, turns and journal as JSON, since
cloning the repository cannot recover it, and worktree removal archives any
unarchived handoff commits first. Promote enduring knowledge (rationale, tests,
usage documentation, limitations) into the repository's documents when finishing
a task. Tracking the full journal in a nonignored file (default `RELAY-LOG.jsonl`)
remains an explicit opt-in under **Collaboration settings** for projects that
need that audit trail; every turn then commits the mirrored line.

Every action names its recipient. **Send [agent]** delivers one standalone
instruction without an automatic commit, branch change, or relay. **Commit
[agent]** publishes one snapshot and stops, including in solo mode. Optional text
is handoff context, not a new instruction. On a dirty checkout, the relay button
becomes **Commit current changes & relay [peer]**: the selected worker snapshots
the current changes, then the controller sends the selected baseline through the
new commit to the peer after validating publication and completion. The baseline
selector stays available; selecting current HEAD reviews only the current changes.
Readiness and active-run gates still apply. On a clean checkout, **Relay [peer]** reviews every commit
after the **Review baseline** chosen beside it. The selector lists each candidate
as a short SHA and subject: the earliest (default) is the newest commit on this
branch at which the journal records a completed turn of the recipient's, or the
task baseline when it records none; the latest is HEAD's parent (the last commit only); **Another commit…**
takes a typed SHA with a commit-list preview. The baseline is excluded and the
displayed HEAD is included; changing it needs fresh readiness. No range is guessed
from Git author or date. A range with no project content cannot be relayed as a proposal.
Send and Commit target the selected agent (or fixed worker); Relay targets the
other member (or fixed reviewer). Local handoff commits use a command-scoped hook
override; repository hook configuration is unchanged and required checks still run.
Automatic collaboration governs later turns. Otherwise use Next turn at the
normal waiting boundary without takeover. Roles and continuation policy can
change there without resetting the budget. Fixed reviewers publish no project changes.
The collapsible **Collaboration settings** panel holds the optional tracked relay log,
automatic collaboration, the turn budget and **Pause on a reviewer objection**; by default an objection goes
straight back to the author as the next automatic turn. A result marked `needsHuman`
pauses for scope or permission decisions. Restart and uncertain publication pause
without replay. A completed chain still needs final task-level verification.

## Using the staging fallback

Use a saved two-agent selection and inspect both participants before confirming
readiness. The deprecated transport retains its recorded instance bindings.
A directory containing two repositories is not one worktree; the backend checks
the actual root and index.

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
The marker is bookkeeping, not a new task. The skill defines its Git staging contract.

Use **Pause / take over** before desktop intervention. Pause keeps ownership and
does not send Ctrl-C or stop background jobs. After inspecting and stopping writers,
explicit takeover releases ownership without claiming success. No command is
silently retried. Final task-level tests and review remain your responsibility.

Once ownership is released, a restarted CLI in the same pane is
rediscovered automatically, including a verified move to another worktree. Names and group selections are preserved; your next
confirmed Send or phase start binds the new instance. A workspace reset is not
needed for an ordinary CLI restart. Unknown processes and changed pane identities
still require inspection, and no old command is replayed.

Agent activity is separate from run ownership. Native start/finish events identify
the exact CLI process, session and turn: Working can remain visible while the
controller is paused or after takeover, and Idle requires the matching settled
completion. Codex reports its completion after Stop hooks finish; long-lived
servers, watchers and other processes do not keep its finished turn Working.
Claude retains its Stop/background evidence guards because Stop hooks may continue
the agent. Controller safety checks still block relay continuation when background
work remains active or unknown. Idle describes the native
turn, not checkout readiness or permission to send. Missing turn evidence is Unknown.
An inactive peer displays Waiting while another participant has the current
relay turn. The current worker's native Idle is preserved even if the controller
has not accepted completion yet; Working evidence always stays visible.
Activity observations are live, not recovered from transcript history after a
backend restart; they never authorize relay continuation.
Codex's native Interrupt hook marks the matching turn **Interrupted** and pauses
its owned relay without accepting a handoff. Delayed events cannot interrupt a
newer native turn, and late completion cannot resume an interrupted assignment.
Pause in the web app remains a scheduling control; it does not send an interrupt
to the CLI. After upgrading hooks, review and trust Interrupt in Codex `/hooks`.
For a quiet CLI that remains Unknown, **Reset status** on its row in Status restores
Ready after you inspect its empty prompt and confirm no background writers.
It checks the exact current CLI and refuses owned runs, pending deliveries or
changed activity. It preserves workspace configuration and never certifies a
completed turn. This confirmation is in memory too; another backend restart
requires fresh native evidence or another explicit status reset.

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
