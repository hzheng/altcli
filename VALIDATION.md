# Starter validation record

**Packaged:** September 14, 2026  
**Last local validation:** September 21, 2026
**Scope:** Source scaffold, not a completed release or security certification

## Review finding on intermediate widths, September 22, 2026

Peer review of `d30ddf8` found the one-line settings row overflowing between the
phone breakpoint and about 1100 px (Settings toggle at x=835 in an 800 px window
with 35 px of horizontal overflow) precisely when its warning badge asks the user
to open Settings. The row now wraps instead of overflowing: the summary text
shrinks first, down to a short minimum, so at desktop widths everything still sits
on one line, while at intermediate widths the Controller and Settings toggles move
to a second line inside the panel and the badge may shrink with an ellipsis. The
same investigation found the mock-mode top-bar note ("Simulated panes…")
overflowing between 761 and 785 px; it now shrinks with an ellipsis and is hidden
below 1000 px. A new browser case resizes a two-agent console on an integration
branch to 1100, 900, 800 and 761 px and checks no horizontal overflow, both toggles
fully inside the settings panel and the viewport, and that Settings opens; the
1440×900 Send-button assertion is unchanged.

What ran: `./scripts/check.sh` exited 0 (30 hook/setup, 42 smoke, 269 workflow, 61
unit, type checks, production build). `ALTCLI_E2E_PORT=9787 npx playwright test`
per project: desktop 88 passed and 1 skipped; iPhone 87 passed and 2 skipped (89
cases each; the new case runs on desktop only). Not run: installed-agent acceptance
and physical Safari.

## Review finding on the compact layout, September 22, 2026

Peer review of `58502ec` found that the two-agent console at 1440×900 clipped both
Send buttons (`layout.spec.ts` viewport case failing at 0.45 visible): the settings
row wrapped its Controller and Settings toggles onto a second line, and the visible
reason beside a blocked Reset status added a line above each fixed-height output.
Fixed by keeping the settings row on one line (the summary text truncates with its
full text on hover; the toggles stay together), by letting each output area give up
24 px, and by placing the reason inside the status row rather than below it. The
explanation and the viewport assertion are retained; the Send buttons end 54 px
above the bottom of a 900 px viewport in mock mode.

What ran: `./scripts/check.sh` exited 0 (30 hook/setup, 42 smoke, 269 workflow, 61
unit, type checks, production build). `ALTCLI_E2E_PORT=9787 npx playwright test`
per project on the committed tree: desktop 87 passed and 1 skipped; iPhone 87 passed
and 1 skipped (88 cases each). Not run: installed-agent acceptance and physical
Safari.

## Settings and About tabs, per-checkout history, September 21, 2026

Follow-up UI requests after the contextual pane actions:
- **Command history** lists only the selected checkout's commands (by the run's
  worktree root, or the agent's checkout for commands older than the run ledger);
  the group dropdown is gone. `HistoryCommand` gained `repository`.
- **How this works** moved from the Console into an **About** tab; the deprecated
  staging-fallback toggle moved from a Console "Advanced" disclosure into a
  **Settings** tab as a console preference.
- **Settings** shows the host's effective global configuration from a new read-only
  `GET /api/v1/config` (`HostConfig` in the contracts and `shared/openapi.yaml`):
  tmux binary and where PATH resolves it, tmux socket, data store, task worktree
  root, integration branches, adapter, input, staging relay, allowed origins, Claude
  config directory and Codex home, each with its environment variable and whether
  it was set. The token is never included. Values are read at start; the page says
  a change needs `web/.env.local` and a restart. Editing them from the UI was not
  built: the store, adapter and tmux runner are constructed from the configuration
  at process start, and an executable path set over HTTP would be a new decision.
- When an agent's unknown status cannot be reset (the controller still holds a
  paused command, an uncertain delivery, or an unverified CLI instance), the reason
  is shown beside the disabled Reset status button instead of only in a hover title.
- Each card has one instruction box and, with a relay follow-up, one **Relay note
  for [peer]** box; the separate Current changes disclosure, handoff note and second
  pair of buttons are gone. An empty instruction with a commit follow-up on a dirty
  checkout turns the primary button into **Commit current changes [agent]** or
  **… & relay [peer]** (the baseline picker appears only then). The note travels as a
  new optional `reviewNote` on the implementation start (validated like text;
  requires handoff; refused for `kind: review`) and reaches the peer's review
  assignment as `note`, never the author's turn; `skills/commit-handoff/SKILL.md`
  names the field, and `shared/openapi.yaml` documents it. A workflow test follows
  a relay note into the peer's assignment and checks the refusals.
- The controller's card sits behind a **Controller · driving / waiting for you /
  paused / idle** toggle in the settings row, next to **Settings**, above the
  Parallel/Focus row; it starts collapsed, the toggle always shows the state, and
  the open state is remembered per workspace. When idle, the panel holds the last
  command the controller drove.
- The card says who controls the agents instead of "Run": headings
  **Controller is driving the agents**, **Controller waiting for your Next turn** and
  **Controller paused · take over to drive the agents yourself** (region "Who
  controls the agents"), one line saying the controller is this server deciding what
  the agents are sent next, the owned command's target and text, and each
  participant's live status. Its single **Pause / take over** button became **Pause
  the controller** while running or waiting and **Take over from the controller…**
  once paused (confirmation: "I checked every participant; give me control"), since
  pausing a paused run did nothing. The finished-run section is **Last command the
  controller drove**, and agent status text says whether the controller is driving,
  paused but still holding, or not driving that agent's turns.
- **Stay unlocked on this device** (Settings › Console preferences, off by default)
  keeps the token in the browser's local storage so reopening the page skips the
  token form; Lock always forgets the token, and a token the host refuses is dropped.
  The server's bearer check is unchanged.
- Earlier in the same session: the After-send option reads "Commit & relay"; the
  finished run became a collapsed section below the panes (now **Last ownership**); the
  settings toggle is a fixed **Settings** button with the editor opening below;
  the Reset status confirmation appears inline beside its button.

What ran: `./scripts/check.sh` exited 0 (30 hook/setup, 42 smoke including the
configuration description, 268 workflow, 60 unit, type checks, production build).
`ALTCLI_E2E_PORT=9787 npx playwright test` per project: desktop 87 passed and 1
skipped; iPhone 87 passed and 1 skipped (88 cases each). New browser coverage: the
Settings rows and the About tab, no Advanced or How this works in the Console,
history limited to the checkout and following the selected checkout, Pause versus
Take over… with the owned command on the card, and the stay-unlocked preference
(reload skips the token, Lock forgets it, a refused token is dropped). Not run: installed-agent acceptance
and physical Safari.

## Review findings on the contextual pane actions, September 21, 2026

Peer review of `a1305ad` raised two findings, both reproduced and fixed:
- A refused derived review range ("no project proposal") kept Relay and Commit
  current changes & relay disabled even after a typed baseline previewed
  successfully, because the card's blocking hint still returned the stale error.
  Blocking now follows the selected range, and the derived-range alert is hidden
  once the typed preview succeeds.
- Lock cleared the page-memory map but not the values held by hooks that stay
  mounted above the unlock form, so unlocking in the same document restored the old
  branch, policy and log settings for the returning workspace. A remembered value
  now belongs to one memory instance, and Lock replaces the instance.

What ran: `./scripts/check.sh` exited 0 (30 hook/setup, 41 smoke, 268 workflow,
60 unit, type checks, production build). `ALTCLI_E2E_PORT=9787 npx playwright
test` per project: desktop 85 passed and 1 skipped; iPhone 85 passed and 1 skipped
(86 cases each, three of them new). The three new browser cases (a refused derived
range followed by a typed baseline, for a clean review and a dirty snapshot relay;
Lock and unlock in the same document with settings and drafts) were also run once
against the previous source and failed there, on desktop.

Observed but not changed: the hook regression "the real hooks preserve Claude
prompt pairing and Codex correlation through steering" in
`scripts/review-regressions.test.mjs` failed intermittently on this host (1 of 6
isolated runs, and the first `./scripts/check.sh` attempt) with `events.length`
1 instead of 2 after about 3.17 s, which matches the hook's 3 s POST timeout to
the test's local server. The hook and the test are untouched by this change; a
standalone probe of the same hook posted in 456, 120 and 120 ms.

## Contextual pane actions and a compact console on September 21, 2026

The console was one long column with a single composer below every panel. Each
agent pane now carries its own action group directly under its output. Every
control's first delivery goes to the agent above it:
- **Send**, with an **After send** choice of Nothing, Commit, or Commit & relay.
  The two new choices submit the existing `kind: work` implementation request with
  `handoff: false` or `true` and never a `reviewBase`.
- **Current changes**: snapshot Commit and Commit current changes & relay, with a
  separate handoff note.
- **Committed review**: existing-commit Relay, in the reviewing agent's own card.

Other layout changes:
- Settings for the next run sit in a one-line summary bar above the panes, with a
  collapsed editor and the Plan/Implementation switch.
- Blockers, the owned run and feedback sit above the panes.
- Agents, Command history (with Export history), the staging fallback and
  explanatory text are collapsed.

Console and Projects stay mounted, so switching tabs keeps their state. Drafts,
settings, disclosures and the chosen pane are kept per workspace and group in page
memory; Lock clears it. A working agent no longer takes a chosen pane away. That
also fixes the phone Focus case where no card was visible. Readiness is one slot
for the page, revoked by any view switch, change, stale reading, Recheck, start or
run change. No server, contract, OpenAPI or skill file changed.

What ran:
- `npm ci --prefix web`, with the user's approval (this worktree had no
  dependencies installed).
- Before the change, at `29a4874`: `./scripts/check.sh` exited 0 (30 hook/setup, 41
  smoke, 268 workflow, 56 unit, type checks, production build). The Playwright suite
  passed 148/148 with `ALTCLI_E2E_PORT=9787`, beside the live console on 8787.
- After the change:
  - `./scripts/check.sh` exited 0: 30 hook/setup, 41 smoke, 268 workflow, 60 unit
    (4 new request-mapping cases), type checks and production build.
  - `ALTCLI_E2E_PORT=9787 npx playwright test`, run once per project: desktop 83
    passed and 1 skipped; iPhone 83 passed and 1 skipped. Each project skips the
    other's viewport-specific test.
  - The existing browser specs were re-scoped to the agent cards and disclosures
    with their assertions kept.
  - A new `layout.spec.ts` covers:
    - the three After-send requests, and blocking on an integration branch until a
      task branch is set
    - the readiness slot and its revocations
    - drafts kept across tab, layout, phase, section and workspace switches with no
      mutation requests
    - Lock, the double-click guard and inline refusals
    - unique field IDs
    - both Send buttons fully in a 1440×900 viewport
    - a chosen pane never being taken away
    - no horizontal overflow at 390 and 320 px
- One Projects assertion was flaky, failing 2 of 4 repeats: a page-wide status
  locator could match both the feedback and the operation's own busy line. Its
  status assertions now target the feedback text; the squash case then passed 6/6
  repeats.

Not run: installed-agent acceptance of the new work actions against real CLIs, and
physical Safari.

## Plan root links and in-checkout roots are refused on September 21, 2026

Review of the move found that `mkdir -p` accepted an existing `<data directory>/plans`
link and `realpath` then trusted its target, so a link to an ignored directory
inside the checkout let a draft land in the project while the clean-baseline check
still passed. Start now refuses a plans root that is a link or not a directory
before following it, and refuses a canonical root inside the bound worktree; every
validation repeats both checks, so a link swapped in after Start pauses capture.
A new workflow case reproduces the reported layout (refused, nothing delivered, no
run), a mid-run swap (paused, draft not finalized) and an ordinary in-checkout
directory; with the root check disabled it fails with "Missing expected
rejection". `./scripts/check.sh` exited 0: 30 hook/setup, 41 smoke, 268 workflow,
56 unit, type checks and production build. The UI is unchanged and the browser
suite was not rerun for this server-only fix.

## Plan documents move to the data directory on September 21, 2026

Start Plan was refused on every click in this repository: plans were written to
`<checkout>/.altcli/plans/`, the controller required that exact ignore rule,
and the checkout's `.gitignore` excluded all of `.altcli/`. The refusal reason
appeared only in the console message below the history, so nothing seemed to
happen. Plan documents are AltCLI working data, so each run now writes its
drafts and `plan.md` to `<data directory>/plans/<run-ID>/` beside the assignments,
with absolute canonical paths; the ignore-rule and tracked-file checks are gone
and the link, special-file, collision and protected-artifact checks remain. A run
stored with the old checkout-relative layout is refused, not resolved (the live
store had no planning runs). The `plan-handoff` skill grants the absolute output
path; ADR-0016, D18/D19 and the guides describe the new layout, and `.gitignore`
matches main again. A refused Start (Plan or Implementation) now shows its reason
as an alert beside the buttons, cleared by the next attempt or Recheck. The
planning fixture repository has no ignore rule; a rewritten workflow case checks
that plans land in the data directory, that nothing (not even an ignored file)
appears in the checkout, that a pre-existing document collides, and that the old
layout is refused. A new Playwright case covers the inline refusal.
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` exited 0 beside the live
console: 30 hook/setup, 41 smoke, 267 workflow, 56 unit, type checks, production
build, and 148 browser cases across both viewports. No real planner has run
against the new location yet.

## Start Plan explains why it is disabled on September 21, 2026

Clicking Start Plan after filling the brief did nothing: the Plan consent key
includes the brief text, so ticking "Ready for planning" and then typing unticked
the box silently, and the disabled button carried only a hover title without the
cause. No request reached the server (verified in the controller store). The
consent-revocation behaviour is kept; `Implementation.tsx` now derives one Plan
blocked reason (identity or run block, request or Recheck in flight, unreadable
Git state, dirty checkout, incomplete branch choice, missing baseline, turn limit
out of range, empty brief, or a confirmation to give again because the brief, a
setting or the checkout changed) and shows it as a status line under the buttons,
also linked to Start Plan by `aria-describedby` and prefixed to its title. A new
Playwright case reproduces the tick-then-type sequence and asserts the status
text, accessible description and title, the turn-limit reason, and one start once
Ready is confirmed again. `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e`
exited 0 beside the live console: 30 hook/setup, 41 smoke, 267 workflow, 56 unit,
type checks, production build, and 146 browser cases across both viewports.

## Installed hooks and skills follow the main checkout on September 21, 2026

Discarding the `feature/task-mgt` worktree left every CLI hook (`~/.claude/settings.json`
Stop/UserPromptSubmit/SessionStart, `~/.codex/config.toml` notify, `~/.codex/hooks.json`)
and all six skill links dangling: the installers had been run from that worktree,
because `scripts/check.sh` verifies the links against the running checkout and told
a session there to reinstall. Turn completion then went unobserved (`Stop hook error:
… No such file or directory`) and the run for the last standalone instruction on
`feature/ui` stayed `running`. Both installers now resolve the repository's main
worktree (`git worktree list`, falling back to a plain non-Git copy) and refuse to
install from a linked worktree, whose `--check` verifies the main installation
instead; the removal guard shared by Check removal and Discard refuses, before
mutation, a worktree that any installed hook command, Codex `notify` entry or skill
link still points into, and fails closed on unreadable CLI configuration. The server
reads that configuration only; it never edits it.

- `node --test scripts/review-regressions.test.mjs scripts/setup.test.mjs`: 30
  passed, including a new real-Git fixture where a linked worktree is refused and
  leaves the isolated home untouched, the main checkout installs, and the linked
  worktree's `--check` then passes; the installer regression now runs a plain copy.
  `scripts/setup.mjs` in a linked worktree installs that worktree's dependencies,
  verifies instead of reinstalling, and copies the main checkout's `web/.env.local`
  (the installed hook posts that token) instead of minting a new one; a second
  fixture covers the failing verification before main is set up, the copy, the
  unchanged host configuration and backups, and the no-overwrite rerun.
- `npm --prefix web run check`: 41 smoke, 267 workflow (the new control-plane case
  covers a Stop hook, a Codex `notify` entry and a skill link into the task
  worktree, a Codex trust entry and a real skill directory that do not block, a
  main-checkout installation that does not block, and malformed JSON failing
  closed; it failed with the guard removed), 56 unit tests, type checks and build.
- `./scripts/check.sh` exited 1 on this host at its first line: the live skill
  links still point at the deleted worktree, which is the condition being reported
  and must be fixed by reinstalling from the main checkout. Playwright was not run
  (no component changed). The live backend was not restarted while delivering.

Peer review of the handoff commit `98ac6f9` objected on two points, both
reproduced and fixed afterwards: the guard read only the first physical line of
Codex `notify`, so a valid multiline array (which the installer itself accepts)
evaded it; and a worktree `web/.env.local` left by an earlier setup with its own
minted token passed as complete although the installed hooks post the main
checkout's token. `notify` is now parsed as the installer parses it (root scope
only, strings across lines and comments, escapes) and any unsupported or
malformed value fails closed; `setup.mjs` compares the existing worktree token with
the main checkout's and stops with a reconciliation message on mismatch. The
`readdir` call was reshaped so the production build no longer traces the whole
project. After the fixes on this host (hooks and skills reinstalled from the main
checkout by the human): `./scripts/check.sh` exited 0 from this linked worktree —
30 hook/setup (mismatched-token case added), 41 smoke, 267 workflow (multiline,
table-local and four malformed `notify` cases added), 56 unit, type checks and a
warning-free production build.

## Stale squash checkpoint recovery on September 21, 2026

Checkpoints outside either current branch history, or with missing Git objects,
now fall back to a fresh full-range preview and independent removal evidence.
Successful removal/discard atomically retires checkpoints, including when an
uncertain result is resolved by inspection. Historical results and duplicate
request handling remain intact. SQLite v12 prevents downgrade to servers that
would reuse retired records.

- Seven focused scenarios failed against the prior implementation, then passed
  after the fix. A further regression covers a pruned historical squash object.
- `./scripts/check.sh` exited 0: 28 hook/setup, 41 smoke, 263 workflow (including
  52 real-Git/SQLite project cases), 56 unit tests, type checks and production build.
- Recovery coverage includes removal/discard followed by same-path recreation,
  uncertain-result inspection, persisted retirement, duplicate requests, and a
  main reset followed by either a confirmed or manual full squash and removal.
- OpenAPI parsed and all 335 internal references resolved.

Browser tests were not rerun for this server-only correction. All Git mutations
in these checks used disposable fixtures. No installed-agent acceptance or live
backend restart was performed; restart remains pending until delivery settles.

## Batch squash and disabled explanations on September 21, 2026

Squash now accepts an inclusive task-branch commit SHA (default HEAD), previews
that range and accepts an edited message for one integration commit per batch.
Later batches resume after the last verified source endpoint, retaining unrelated
main changes; rewritten histories are refused. Batch records survive restart,
SQLite v11 rejects older servers, and v10 full-branch records remain usable as
boundaries. Removal recognises verified batches through the current task HEAD.
The previewed merged-tree diff is streamed into `git apply --index --binary`
without a shell and committed under normal hooks, preserving ignored files that
obstruct incoming changes. Idle source panes no longer disable squash. Disabled
buttons show visible, accessible reasons; endpoint edits revoke preview consent.

Executed checks:

- `./scripts/check.sh` exited 0: 28 hook/setup tests, 41 smoke tests, 256 workflow
  tests, 56 unit tests, TypeScript checks and production build.
- All 45 real-Git/SQLite project tests passed in disposable repositories. New
  coverage exercises three batches with intervening main edits and binary data,
  restart, duplicate/conflicting requests, foreign/stale/rewritten endpoints,
  partial-hook failure and inspection, obstructing ignored files, removal only
  after the final batch, and upgrading old full-branch records.
- `env ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` exited 0, including
  repeated non-browser checks and all 140 Playwright cases (70 desktop, 70 iPhone;
  4.7 minutes).
- Six focused Playwright cases passed on desktop/iPhone: edited squash messages,
  idle source agents versus deletion, disabled explanations, and endpoint edits
  requiring a fresh preview. Desktop and iPhone batch screenshots were inspected.
- OpenAPI parsed with 335 internal references resolved. The diff passed whitespace
  checking and secret screening (none found).

No live worktree was integrated or deleted, and installed-agent acceptance was
not performed. The live backend was not restarted while delivering this task;
restart it after the turn settles before using the new server behavior.

## Deletion actions explain instead of silently disabling on September 21, 2026

Check removal and Discard were disabled whenever an agent pane sat in the
worktree, with no visible reason. They now disable only for hard blocks (read-only
host, a request in flight, unreadable discovery/worktree state, a pending
operation) and otherwise stay clickable: a status line beside them names a known
occupant, run or delivery owner, and clicking runs the server preview whose exact
refusal (pane inside the checkout, modified files, missing integration evidence)
appears as the alert. Squash keeps its disabled-with-reason behaviour. Browser
tests: a worktree occupied by the demo agents shows "Codex, Claude Code are still
in this worktree; the server refuses removal…", both deletion buttons are enabled,
and a routed WORKTREE_IN_USE refusal is displayed on click while the button stays
enabled; the batches test now asserts the hint, the read-only hard block and the
delivery-owner hint. `./scripts/check.sh` exited 0 and both Playwright projects
passed on the final source (counts in the entries below are superseded by this
run: 28 hook/setup, 41 smoke, 264 workflow, 56 unit tests; 71 + 71 browser cases).

## Uncertain squash release after inspection on September 21, 2026

A squash that went uncertain (the staged squash was never committed) and was
then resolved by hand — main reset and integrated as three separate commits —
stayed uncertain forever: inspection only recognised the exact expected commit
at HEAD or an unchanged tip, and the record held every lifecycle action on the
project. `reconcileIntegration` now keeps the hold only while the integration
checkout is dirty; once clean it completes the operation when the previewed
commit (pinned parent, previewed tree) is anywhere on the branch's first-parent
chain since the pinned tip, and otherwise releases it as failed, naming the tip
it moved to. A new real-Git test covers the buried commit under later main work,
the dirty checkout, the hand-resolved tip after restart, the released project
hold, and that a failed record is not a batch checkpoint while a verified one
still is. ADR-0013, TESTING and the OpenAPI reconcile description were updated.
`./scripts/check.sh` exited 0 (28 hook/setup, 41 smoke, 264 workflow and 56 unit
tests, typecheck, build); no component changed, so Playwright was not rerun. The
live uncertain record on this host is released by pressing **Inspect squash
result** after the backend is restarted with this code; it was not edited.

## Confirmed squash integration and discard on September 21, 2026

Projects now offers three confirmed end-of-task actions per linked task worktree,
top to bottom: **Squash into main**, **Check removal** (visible label shortened;
the accessible name still names the branch) and **Discard…**. Squash previews one
squash commit into local main/default computed with `git merge-tree` (merge base,
commits, conflict-free merged tree, exact commands, editable message) and, on
confirmation, runs `git merge --squash` plus `git commit` in the checkout that
has that branch checked out, under the repository's normal hook policy; the task
branch and worktree are untouched. Discard force-removes the worktree and deletes
the branch after the branch name is typed, reporting the unmerged commits and
uncommitted changes that will be lost and archiving the journal first. Both use
the removal pattern: durable operation records, project setup ownership,
uncertain results inspected read-only and never retried. ADR-0013, AGENTS.md,
README, SETUP, WORKFLOWS, TESTING, OPEN-DECISIONS, the decision ledger and the
OpenAPI contract describe the new authorities.

Review follow-up (September 21, 2026): discard consent now pins a fingerprint of
the exact nonignored content and rechecks it after the archive step, so an edited
dirty file with an unchanged file count refuses the old consent; the store
version is 10 so older servers refuse databases holding integration or discard
owners; and the squash confirmation is compact (consent digest plus a message of
at most 8 KiB) so a 100-commit preview confirms within the 16 KiB request limit.
Three regression tests cover these through real Git, a reopened store and the
HTTP body parser. Second follow-up: the message budget is now one policy shared
by the preview generator, validation and the browser (`core/squash-message.ts`:
at most 8 KiB once JSON-encoded, identifiers bounded to 200 characters), the
generated default is built within it (oldest listed subjects first, subjects
over 120 characters shortened, the list cut with a count of omitted commits),
and the browser shows the encoded size and disables confirmation instead of
failing later; a 101-commit preview confirms unedited and a worst-case message
of 4,095 double quotes round-trips through the body parser and commits, verified
by real-Git, unit and browser tests. `./scripts/check.sh` and both Playwright
projects were rerun (counts below are from that rerun).

Executed checks on this task's final source:

- `./scripts/check.sh` exited 0 on Node 26.0.0: installed skill links verified,
  28 hook/setup tests, 41 smoke tests, 251 workflow tests (real Git and SQLite in
  disposable repositories; ten new project tests cover the previewed merge
  result and default message, one verified squash commit with tree equality and
  the edited message, idempotent and conflicting repeats, refusal of conflicts,
  dirty or missing integration checkouts, the main worktree, stale consent, busy
  guards and read-only hosts, a rejecting `commit-msg` hook leaving a staged
  squash uncertain until the checkout is restored, restart and failed
  verification reconciled read-only, discard previews with typed-branch
  validation, guard-then-archive ordering, worktree and branch deletion, stale
  or busy discards, uncertain discards verified after restart, and the HTTP
  control-plane ownership/pane guards), type checking, 53 unit tests and the
  production build with the six new routes.
- `env ALTCLI_E2E_PORT=9787 npx playwright test --project=desktop` and
  `--project=iphone` (run separately beside the live console on 8787) each
  passed all 68 cases, 136 in total, including the new squash-preview and
  discard browser cases; both screenshots were inspected.
- `git diff --check` passed; the diff was screened for credentials (none).

Not executed: no real squash or discard was performed on a live repository, and
no installed-host deletion acceptance is claimed. The development backend was not
restarted during this turn; restart it before using the new Projects actions.

## Handoff journal as app data on September 20, 2026

The tracked `RELAY-LOG.jsonl` requirement is dropped. A completed commit-mode turn
now publishes one schema-1 result object to an external `resultPath` beside its
assignment (the Plan pattern); the controller validates it against the immutable
identity and Git, records it in the new `handoff_journal` table together with the
handoff commit's archived patch (the `git apply`-able patch with binary data when
it fits 1 MiB and is storable as UTF-8 text, else its diffstat marked incomplete;
the binary handling is a review follow-up covered by a fixture that applies the
archived patch in a separate clone), and derives
the Review-baseline default from that journal instead of Git log history.
Report-only turns publish no commit; empty commits, extra commits, missing,
malformed or mismatched results are refused without entering the journal.
Mirroring the journal into a tracked, nonignored file is an explicit opt-in
(**Also track the journal in the repository**, `logPath`), in which case every
turn commits and the mirrored line must equal the published result. `GET
/api/v1/history/export` and **Export history** in Status download runs, turns
and journal for one worktree or all; confirmed worktree removal archives any
unarchived handoff commit first and reports the count. Existing publications are
backfilled into the journal at startup; the database version is now 9. The
repository's own `RELAY-LOG.jsonl` is deleted from the worktree in this change;
the deletion is left uncommitted for the user to commit with the rest.

Executed checks on this task's final source:

- `./scripts/check.sh` exited 0 on the installed Node 26.0.0: installed skill
  links verified, 28 hook/setup tests, 41 smoke tests, 240 workflow tests (real Git
  and SQLite in disposable repositories; terminal delivery and lifecycle evidence
  simulated), type checking, 53 unit tests and the production build including the
  new `/api/v1/history/export` route. New coverage: report-only turns without a
  commit and their journal records with archived patches; the tracked-log
  preference; twelve invalid-publication faults (including empty commit, mirrored
  line mismatch, report-only turn without the required mirrored commit, and an
  invalid result) that pause with ownership and leave the journal untouched;
  journal-derived Review baselines with side-branch merges, hand-committed log
  lines and other agents' entries; history export scoping; startup backfill,
  pre-removal archiving that skips commits already gone, diffstat fallback for an
  oversized commit; and archive-before-`git worktree remove` ordering.
- `env ALTCLI_E2E_PORT=9787 npx playwright test --project=desktop` and
  `--project=iphone` (run separately beside the live console on 8787) each
  passed all 66 cases, 132 in total, including the new tracked-log opt-in and
  history-export download cases and the renamed reviewer tooltip.
- `git diff HEAD --check` passed. The diff was screened for credentials: only the
  pre-existing synthetic e2e token appears.

Not executed: no installed Codex or Claude agent performed a real handoff under
the revised `commit-handoff` skill, so installed-host acceptance of the
result-file publication remains pending. The development backend on 8787 was not
restarted, because this change was delivered as an active controller command;
restart it after this turn completes and before the next Implementation run, since
older server code cannot read runs without a tracked log. No live journal was
exported and no real worktree was removed during validation.

## Moved sessions and confirmed worktree removal on September 20, 2026

Follow-up: ignored files now permit removal, with an explicit warning before
confirmation. A real Git fixture verifies deletion of ignored environment files
and generated directories, while modified/nonignored untracked files still block
both preview and previously confirmed requests. `npm --prefix web run check`
passed (41 smoke, 230 workflow, 53 unit tests, type checking and build), as did
the 28 root hook/setup tests. The full
`env ALTCLI_E2E_PORT=9787 npm --prefix web run e2e` passed all 126 desktop/iPhone
viewport cases; both removal-warning screenshots were inspected. Both check
wrappers still stop at the existing global skill-link mismatch described below.
After verifying no active runs, executions or reservations, the backend was
restarted. The real `commit-relay` removal preview returned HTTP 200 with squash
integration verified despite its ignored files; no real worktree was deleted.
The follow-up diff was screened for credentials; none were found.

Live read-only inspection reproduced the report: two supported agents were in
`feature/task-mgt`, while their saved registrations and a paused run still belonged
to `feature/commit-relay`. Discovery now reports the exact old-owner blocker.
After explicit takeover, verified moved panes are proposed in their current
worktree without registration/reset; the next explicit edit or Start persists
that binding and updates old configuration without rewriting frozen history.

Projects now offers a removal preview and confirmation for a clean unused linked
task worktree. Verification accepts ancestry or an exact combined-patch match to
a single squash commit on local main/default. Modified/nonignored untracked
files, hidden index flags, panes and run/delivery ownership block removal. Ignored
files are allowed with a warning before confirmation that they will be deleted. The
non-force operation retains the branch and history; duplicate calls, stale consent,
restart and uncertain results have durable guards and read-only inspection.
A lost HTTP response offers inspection without repeating the removal.

Executed checks on this task's final relevant source:

- `npm --prefix web run test:workflow`: all 230 tests passed, including real Git
  and SQLite in disposable repositories for removal, integration, occupancy,
  hidden files, concurrent requests and recovery. CLI activity is simulated.
- `node --test scripts/review-regressions.test.mjs scripts/setup.test.mjs`:
  28 passed; `npm --prefix web run test:smoke`: 41 passed; `npm --prefix web test`:
  53 passed. Hook tests use temporary localhost servers and isolated homes.
- Type checking passed, and the final `npm --prefix web run build` passed,
  including all three removal routes.
- The full browser run passed 122 of 124 cases; two new cases had an ambiguous
  alert selector matching Next's route announcer. After correcting that selector
  and adding lost-response coverage, the final
  `env ALTCLI_E2E_PORT=9787 npm --prefix web run e2e -- e2e/projects.spec.ts`
  passed all 18 desktop/iPhone-viewport Projects cases. The other 108 browser
  cases passed in the earlier full run. Browser removal responses are fixtures;
  actual Git removal is exercised only by disposable server tests.
- Removal confirmation screenshots were inspected; `git diff HEAD --check`
  passed and the task diff was screened for credentials (synthetic test tokens only).

Both required wrappers, `./scripts/check.sh` and `./scripts/check.sh --e2e`,
were attempted and stopped at the installed-skill check: global skill links point
to the task worktree rather than this checkout. Global links were not changed;
the underlying checks above were run directly. Initial sandboxed hook/smoke calls
failed on localhost restrictions (including a Node assertion); the unrestricted
reruns passed. Checks ran on the installed Node 26.0.0, not the recommended Node 24.

The development backend was restarted after observing zero delivery reservations
and no dispatch in progress. Its authenticated inventory returned HTTP 200 and
preserved the old paused run, reporting both moved agents' ownership blocker.
No real worktree was deleted, no live run was taken over, and no CLI command was
sent as part of acceptance. The user must reconcile the old run before those
agents become eligible in their new worktree.

## Exact Codex interruption handling on September 20, 2026

Cancelling a native turn previously left only its start evidence: the installer
and event protocol omitted Codex's Interrupt hook. The installed hook now binds
the interrupted session, turn, pane, CLI PID and start time. It marks native
activity Interrupted, durably interrupts the matching execution and pauses its
run without accepting a publication or transferring ownership. Stale interruption,
duplicate start and late completion cannot resume the cancelled assignment or
replace a newer native turn. Buffered delivery and backend restart are covered.

The project check passed 28 hook/setup, 41 smoke, 216 workflow and 53 unit tests,
type-check and build. The browser fixture initially selected both the Codex row
and its peer's "Waiting for Codex" detail. After scoping it to the agent cell,
the console rerun passed all 52 desktop/iPhone-viewport cases; the other 68 browser
cases passed in the full run. Two focused hook tests also passed after tightening
missing-ID checks and verifying preservation of foreign Interrupt hooks.
Native payloads and tmux/process identity are simulated; hook subprocesses,
private binding files and HTTP delivery are real in the isolated hook fixture.

The project installer updated only the host's Codex hooks.json, with its private
backup, and its --check passed. The backend was restarted after verifying zero
delivery reservations and dispatching turns; HTTP health returned 200. Native
live cancellation still requires the user to load and trust the newly installed
Interrupt hook in Codex /hooks; no hook trust was bypassed or fabricated.

## Recovery for quiet Claude sessions on September 20, 2026

The installed Claude process still matched its registered foreground PID, and its
last completion hook had been posted before the development backend restarted.
Native activity observations live only in memory; a quiet CLI sends no new event
to replenish them. Workspace Reset clears registrations, not activity, so it was
not a recovery mechanism for this condition.

The console now offers a separate status reset for Unknown activity. Explicit
terminal inspection restores human-confirmed Ready for the exact current CLI,
without changing configuration, sending input or releasing execution ownership.
Changed registrations, native activity, owned runs and pending deliveries are
rejected. Old callbacks cannot undo the confirmation; new turns update normally.
This is manual recovery, not durable activity persistence or automatic replay.

The final project check passed 27 hook/setup, 41 smoke, 213 workflow and 51 unit tests,
type-check and production build. New server regressions use disposable Git and
SQLite with simulated CLI activity, including restart, replacement and a concurrent
native start. A final registration-race guard and its new regression passed all
four focused recovery tests. The browser fixture initially omitted its verified
instance state; after correcting the fixture and shortening the row button to
**Reset status**, all 118 desktop/iPhone-viewport tests passed. Checks used the
shared worktree, including pending relay changes; browser agents are simulated.
The development backend was reloaded
after confirming zero pending deliveries, and its HTTP health check returned 200.

## Finished Codex turns and persistent services on September 20, 2026

Retained completion evidence counted `npm run dev`, Next.js and process probes
as background work. The native activity tracker also used process liveness to
label a finished Codex response Working, then latched that finished observation.
A backend restart lost its pre-turn process baseline and made this especially
visible when the agent had started the development backend itself.

Codex activity now becomes Idle on an exact, settled native completion, including
a fresh completion matched against the current binding after backend restart.
Process checks remain in the controller's continuation gate; active or unknown
background work still retains ownership and blocks peer delivery. Claude's
source-specific Stop/background guards remain intact. No historical completion
was replayed and no live workflow ownership was released.

The final `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed 27 hook/setup,
41 smoke, 209 workflow and 49 unit tests, type-check, production build, and all
116 desktop/iPhone-viewport browser tests. New regressions cover persistent
services, restart binding, process-inspection failure, stale/duplicate events,
and native Idle alongside a controller background-work pause. Workflow fixtures
use real disposable Git and SQLite; native events, processes and browser agents
are simulated. Browser validation also exposed a fixture teardown race; the
reconciliation test now waits for its post-send refresh to finish before teardown.

## Preview cancellation lockup on September 20, 2026

Codex's review `d4e1b8a` objected to `e475f55..0d27986`: cancelling an automatic
preset preview by choosing **Another commit…** aborted the request but the
`finally` guard skipped clearing the loading flag, so **Preview commits** stayed
disabled as "Reading commits…". Loading is now owned by the newest preview
request: each request takes a sequence number, only that request may clear the
flag, and it does so whether it finishes or is cancelled, so an older request can
never clear a newer one's state.

The run reached this worker as an automatically routed objection (run
`3f6455c2`, turn 2) under the default agreement, and a mid-turn background-task
notification during the fix was absorbed as a continuation of the same command
without pausing the run — the first live observations of both #17 behaviors.

`./scripts/check.sh` passed 27 hook/setup, 41 smoke, 197 workflow and 44 Vitest
tests, typecheck and production build. `ALTCLI_E2E_PORT=9787 npm --prefix web
run e2e` passed all 106 desktop Chromium/iPhone-viewport cases, including the new
delayed-response regression that switches a preset preview to Another commit,
previews a typed SHA, and round-trips through the earliest preset; the same
regression fails against the previous `finally` guard. Terminal and lifecycle
evidence remain simulated in tests.

## Objection routing agreement and review findings on September 20, 2026

Codex's review `e475f55` objected to `fff8352..0dcb671` with three findings; all
are addressed here, and peer objections now route automatically.

- **Hook (High):** a `<task-notification>` prompt is treated as a harness
  re-entry only while a turn is active in that session; with nothing active it is
  an ordinary prompt with normal lifecycle pairing. Claude Code queues a human
  prompt typed mid-turn until the Stop, so an active slot cannot have been typed
  into; the payload still carries no provenance, and that residual assumption is
  documented rather than hidden. Regressions cover the no-active-turn start and
  Stop, foreign Stop IDs, and the mid-turn continuation.
- **Provenance (Medium):** `lastPublishedBy` accepts only a real handoff commit —
  single parent, exactly one appended journal entry naming that parent and the
  recipient. Merged side-branch entries, imported or duplicated entries, rewritten
  journals and entries naming another parent no longer advance the baseline; the
  regression reproduces Codex's `unreviewed-main.txt` case.
- **Selector (Medium):** candidate baselines come from HEAD's first-parent chain
  (`candidates` in the preview), and any baseline other than the earliest is
  previewed as its own exact `base..HEAD` range on the server before it can be
  sent; the browser no longer estimates ranges from list positions.
- **Agreement:** `pauseOnObjection` (default false) is frozen with the run beside
  automatic collaboration and the turn budget, changeable at a settled boundary,
  and carried from Plan into Implementation. An actionable objection is dispatched
  to the author as the next automatic turn under both policies unless it is set;
  `needsHuman` still pauses. The console groups these in a collapsible
  **Collaboration settings** panel together with the tracked relay log, styled like
  Command history.

`./scripts/check.sh` passed 27 hook/setup, 41 smoke, 197 workflow and 44 Vitest
tests, typecheck and production build. `ALTCLI_E2E_PORT=9787 npm --prefix web
run e2e` passed all 104 desktop Chromium/iPhone-viewport cases; the selector and
agreement-panel screenshots were inspected. OpenAPI parsed with 285 internal
references resolved. Real Git fixtures cover automatic objection routing,
pausing by agreement, changing it at the boundary, and the provenance cases above.
Terminal and lifecycle evidence remain simulated; no live relay is claimed.

## Review baseline selector on September 20, 2026

The two Relay buttons became one **Relay [peer]** button beside a **Review
baseline** selector. Each candidate shows a six-character SHA and its subject:
the earliest (default) is the recipient's last handoff commit from the tracked
relay log, or the task baseline when they have none, marked "earliest: all since
…"; the latest is HEAD's parent, marked "latest: last commit only"; **Another
commit…** keeps the typed-SHA path with its read-only preview. The line under the
row restates the chosen range and marker. The preview endpoint now also returns
`baseSubject`. Changing the baseline resets readiness, and a delivered relay
returns the selector to the earliest candidate.

`./scripts/check.sh` passed 27 hook/setup, 41 smoke, 196 workflow and 44 Vitest
tests, typecheck and production build. `ALTCLI_E2E_PORT=9787 npm --prefix web
run e2e` passed all 104 desktop Chromium/iPhone-viewport cases; the
baseline-selector and typed-baseline screenshots were inspected. Browser fixtures
cover option labels and order, the earliest default, consent reset on a changed
baseline, the latest-only and middle choices, typed baselines with stale HEAD,
and a failed derived range falling back to the typed path with its reason shown.
Terminal and lifecycle evidence remain simulated; no live relay is claimed.

## Relay new commits on September 20, 2026

The manual one-click Relay no longer reviews only HEAD against its first parent.
The live review 6c85dd8d covered `d56b9b2..fff8352` while the recipient had never
published on the branch, so four unreviewed Codex handoffs (#8–#11) were skipped.
**Relay [peer] · new commits** now derives its baseline from the tracked relay log
as committed: the newest first-parent commit after the task baseline that appended
an entry published by the recipient, or the task baseline itself when there is
none. Provenance is compared against each commit's first parent; a rewritten
journal never counts, and Git author/date are never consulted. The preview
endpoint takes `recipient` + `taskBase` (or an explicit `base`) and reports
`since: explicit | recipient | task`; the console shows the count and origin
before Ready is confirmed. Recent commits keeps its explicit baseline dialog.
Automatic chains still review from the accepted commit as before.

`./scripts/check.sh` passed 27 hook/setup, 41 smoke, 196 workflow and 44 Vitest
tests, typecheck and production build. `ALTCLI_E2E_PORT=9787 npm --prefix web
run e2e` passed all 102 desktop Chromium/iPhone-viewport cases; the explicit-range
screenshot was inspected. Real disposable Git fixtures cover task-baseline
fallback, recipient handoffs including log-only reviews, HEAD published by the
recipient, merged side-branch handoffs, rewritten journals, foreign recipients,
non-ancestor task baselines and the 100-commit cap. Terminal and lifecycle
evidence remain simulated; no live relay through the derived range is claimed.

## Task notifications are not prompts on September 20, 2026

Live relay run 6c85dd8d paused at 14:00:35Z with "Another prompt started on this
checkout outside its current assignment" while the reviewer was still working.
Claude Code fires `UserPromptSubmit` for the synthetic `<task-notification>` turn
that follows a background task, so the hook posted an uncorrelated `turn_started`,
and the slot overwrite left the later `Stop` without a command ID; the published
review commit was never validated. Reproduced on the host with a trivial
background command (hook slot saved `prompt: "<task-notification>…"`, no command).

The Claude hook now treats a `UserPromptSubmit` whose prompt begins with
`<task-notification>` as a re-entry of the active turn: nothing is posted, the
saved command, prompt and source turn are kept, and the notification's
`prompt_id` is remembered so the `Stop` closing it still completes the command
under the original source turn. Without an active slot the notification is
ignored. `node --test scripts/review-regressions.test.mjs` passed 22 tests,
including the real-hook flow (fake tmux/ps, real subprocess, files and HTTP) and
protocol pairing for notification, original and foreign Stop IDs. Full
`./scripts/check.sh` passed 27 hook/setup, 41 smoke, 196 workflow and 44 Vitest
tests, typecheck and production build. Live relay continuation after this fix is
not yet observed; the paused run still needs human takeover.

## Separate named actions on September 20, 2026

Implementation now offers Send [agent], Commit [agent], Relay [peer] · last
commit, and Relay [peer] · recent commits. Commit snapshots current changes and
ends without automatic relay, including solo mode. Last commit compares HEAD
with its first parent; recent commits requires an explicit baseline, read-only
commit-list preview and final confirmation. Send and Commit target the selected
agent or fixed worker; Relay targets the other member or designated reviewer.
Changed HEAD, range, recipient or readiness invalidates confirmation. Deprecated
staging controls also name their recipients while retaining their contracts.

Final `./scripts/check.sh` passed 26 hook/setup, 41 smoke, 196 workflow and 44
Vitest tests, typecheck and production build. `ALTCLI_E2E_PORT=9787
./scripts/check.sh --e2e` initially passed 84 browser cases; two legacy console
cases retained the wrong recipient selector and caused 16 serial cases to skip.
After correcting the Claude selector, the complete console spec passed all 44
desktop/mobile cases. Combined with the 58 non-console cases from the full run,
all 102 browser cases passed. Desktop and iPhone-viewport screenshots were
inspected. Skill frontmatter validation, OpenAPI YAML/internal references and
`git diff --check` passed. These are Chromium viewport checks, not real Safari.

Real disposable Git/SQLite fixtures cover standalone snapshot completion, solo
commit, subsequent explicit review, immutable range previews, stale HEAD,
log-only rejection, merge first-parent semantics and the 100-commit preview cap.
Browser fixtures cover recipient changes, preview/cancel without delivery,
range/HEAD changes revoking consent, and dirty checkout action gates. Terminal
and lifecycle evidence is simulated; no live agent commit or relay is claimed.

The live backend still owns the Send implementing this change. A bounded reload
watcher waits for this exact command to complete and refuses reload while another
delivery or setup owns the checkout. Reload and new-endpoint verification are
queued after completion, not claimed as already observed. No staging or commit
was performed in the managed checkout.

## Publication observation fix on September 20, 2026

The live snapshot commit d56b9b2 completed, and its correlated lifecycle event
arrived, but publication validation rejected a temporarily ineligible terminal
with a generic message. The historical input-mode flags were not retained, so
the exact transient condition is not proven. Both CLI instances were valid on
inspection. Five new regressions reproduced loss of publication/plan capture in
copy mode or synchronized-input mode before the fix and passed afterward.

Completion now validates identity, CLI pid, cwd and artifacts independently of
input modes. Peer delivery still validates the destination's complete input gates;
a blocked destination retains the already validated publication. Error messages
now identify the affected participant and concrete classification reason.

`./scripts/check.sh` passed 26 hook/setup, 41 smoke, 192 workflow and 44 Vitest
tests, typecheck and production build. The initial full run caught regression-mock
parameter types; they were corrected and the full check rerun successfully.
No UI was changed and browser tests were not rerun for this fix. These regressions
use real disposable Git/SQLite and simulated terminal/lifecycle evidence.

After checking there was no delivery or setup in flight, the development backend
was reloaded. The failed run remains paused with the same command and finished
execution; no completion replay, ownership release or peer prompt was sent.
The source fix remains uncommitted. Live end-to-end continuation after the fix
is still unverified.

## Commit snapshot action validation on September 20, 2026

Committed Implementation now uses **Commit & relay / Commit & review**. Its
`kind: commit` request accepts optional handoff context and produces a first
`work` assignment with `commitOnly: true`. The skill snapshots all current staged,
unstaged and nonignored untracked project changes without implementing pending
requests; it records incomplete work without claiming task acceptance. A clean
checkout directs the user to existing-candidate review. Ordinary API `work`, Plan
implementation and the deprecated staging fallback retain their existing behavior.

`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed: 26 hook/setup tests,
41 smoke tests, 187 workflow tests, 44 Vitest tests, typecheck, production build,
and all 98 desktop Chromium/iPhone viewport browser tests. The first sandboxed
attempt could not bind a localhost hook fixture (`EPERM`); the authorized rerun
completed successfully. `git diff --check` also passed.

Real Git/SQLite fixtures verify staged-plus-unstaged content and untracked files
are included without finishing them, exactly one publication hands off the
expected range, context is separate from the snapshot instruction, and the
fixed worker hands off to its reviewer. Browser fixtures verify empty-context
submission, dirty/clean gates, branch consent, and unchanged standalone Send.
Agent behavior is specified by the skill, not a native editing sandbox; no live
agent snapshot/commit is claimed. No Git write was made in the managed checkout.
The live backend still owns the Send requesting this change, so its required
reload is deferred until that command completes; it was not restarted mid-run.

## Restart recovery and independent activity validation on September 20, 2026

Follow-up status validation found that a fresh Claude session had no prompt hook
yet, so it could not report its initial state. SessionStart now reports Ready
for startup/resume; compaction is excluded and startup never certifies a task.
Activity reception no longer depends on browser discovery or input-mode gates.
A fresh completion after backend reload must match the native binding's exact
session, turn, pane, CLI pid and start time before recovering display activity.
Without its original process baseline, remaining non-helper processes still
count as work. This does not recover or advance controller ownership.

Live process inspection also identified persistent browser-tool kernels and their
sandbox/app-server wrappers being counted as task work. Classification now checks
their installed executable, specific arguments and node_repl ancestry; regressions
retain arbitrary workers and other Codex turns. Arguments are not persisted or
returned in API records. Bounded hook diagnostics record delivery metadata only.

The real installed Codex 0.155.1 executable was exercised in isolated temporary
homes against a fixed local Responses fixture (no external model request or live
agent prompt). Actual native start/notify events traversed the project hook,
parser and activity tracker, producing Working then Idle both normally and after
discarding tracker memory between events. Terminal/process identity was simulated
in those tests; this is not acceptance of this interactive pane's final callback.
The original missing callback cannot be conclusively reconstructed from retained
logs. No historical response was replayed as completion.

The installed hook settings were updated with private backups. After verifying
no owned run or delivery, the backend was reloaded and the empty Claude session
restarted with its original arguments; the live API and Chrome console both
reported altcli-cc as Ready from its real startup event. Codex SessionStart
still needs native hook trust through `/hooks`; existing prompt-hook trust was
preserved. No live task prompt, synthetic completion, Git write or ownership
reconciliation was issued for these checks.

An initial mobile browser failure coincided with this investigation touching the
shared Next config to reload the live backend while the isolated test servers
were still running. The six affected viewport cases passed when rerun separately.
A later sandboxed Turbopack failure remained cached; the build cache was moved
to a temporary backup and validation repeated. A new startup fixture initially
failed because its existing group/pair prevented session deletion; the fixture
now removes its group first without weakening the product guard.

The final `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed 26 hook/setup,
41 smoke, 185 workflow and 44 Vitest tests, type-check, production build and all
98 desktop/iPhone-viewport browser cases. The additional cross-session completion
guard passed the nine focused activity tests. OpenAPI parsed with all 273 local
references resolved; whitespace and added-line credential checks passed. The
final backend reload was separated from the browser suite. Changes remain
uncommitted and the index and relay log remain untouched.

Idle, same-pane CLI restarts now produce read-only identity proposals after run
ownership is released. A fresh explicit Send/phase start binds the displayed
generation, preserving names, group selection and historical participants. Real
Git/SQLite regressions cover frozen identities while owned, reconciliation,
stable read-only discovery, rejected stale consent, a second restart, unknown or
moved peers, and successful new committed work without resetting configuration.
Terminal processes and delivery in these tests are simulated.

Native hooks now retain the CLI pid and start timestamp through the exact native
session/turn completion, including manual prompts without command markers. A
separate live activity tracker reports Working/Idle/Unknown independently of run
ownership. Six unit tests cover matched completion, duplicates, older events,
CLI/pane/backend replacement, missing evidence and vendor-specific background
evidence. An API-level workflow regression verifies that Working survives pause
and takeover, then a matching finish updates activity while the run stays stopped;
manual later work and old completions cannot revive it. Hook subprocess/HTTP
tests exercise the added metadata with simulated tmux and foreground discovery.

`./scripts/check.sh` passed for the recovery change. The final
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed 26 hook/setup tests,
40 smoke tests, 184 workflow tests, 41 Vitest tests, type-check, production build,
and all 98 desktop Chromium/iPhone-viewport browser cases. Eight focused recovery
browser cases also passed earlier. Browser activity/discovery observations are
mocked; pause/takeover use the test API/store. Desktop/mobile recovery screenshots
were inspected. OpenAPI parsed with all 273 references resolved; whitespace and
added-line credential screening passed. Source changes remain uncommitted, and
the index and relay log are unchanged.

The live API reports the updated activity field and current CLI identity after
the backend restarted externally. No runtime database edits, configuration reset,
synthetic completion or live command delivery were performed. The current manual
turn began before activity pid/timestamp capture was added, so it has no eligible
start observation and remains Unknown until a new native start is observed. This
is not installed-agent start/finish acceptance or physical iPhone acceptance.

## Native Codex turn binding validation on September 20, 2026

Read-only inspection found no correlated lifecycle event for the last committed
work command; its execution was still `delivered`, with no validated publication
or scheduled review. Human takeover had already replaced its original run reason.
The raw notify payload was not retained, so that particular payload and the exact
original pause reason cannot be reconstructed. Codex 0.155.1 source inspection
established that notify input messages come from sampling history. A fixture with
two historical command markers reproduced the previous hook's lost correlation.
This supersedes the turn-input-only assumption in the earlier steering entry.

Native UserPromptSubmit now captures the exact prompt, session and turn IDs;
notify completion must match that binding and does not inspect input messages.
Tests reject absent bindings, changed sessions/turns/panes, conflicting commands,
and later unmarked turns. The real hook subprocess/loopback HTTP test exercises
start, steering and completion with simulated vendor events and tmux identity.
Real Git/SQLite tests verify one peer review after publication and duplicate
suppression. Installer tests use isolated homes, preserve foreign hooks and verify
both default and custom Codex configuration directories.

`./scripts/check.sh` passed 26 hook/setup tests, 40 smoke tests, 181 workflow tests,
35 Vitest tests, type-check and production build. The first run exposed a new
review test fixture that created only a log commit; adding its intended project
change verified the existing content-change gate without relaxing it. The hook
HTTP test initially needed an unsandboxed localhost listener; its rerun passed.
The live installer check initially reported only the missing Codex `hooks.json`
entry. With explicit filesystem approval, the tested native hook configuration
was created there without overwriting any file; the final installer check passed.
Codex restart and human trust through `/hooks` remain required. No installed-agent
handoff with the new binding is claimed.
No stopped run was replayed or inferred complete from terminal output.

`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` repeated the non-browser checks
successfully and passed 90 browser cases; two existing tooltip assertions failed
because the new disabled explanation replaced the commit explanation. The final
tooltip preserves both. A focused desktop/iPhone rerun passed all six affected
cases, including both existing-candidate policies. The final installer-message
change also passed all five isolated setup tests. Whitespace and secret screening
passed. Source changes remain uncommitted, with the index and relay log untouched.

While this investigation was still running, the live Console reported another
pause. Its retained reason was `Backend restarted`; the main `npm run dev` process
had been relaunched from its existing terminal, separately from the isolated
browser-test servers. The worker continued running, as required by pause semantics.
No controller restart or takeover was issued by this investigation.

## Tmux default names and live dirty-entry validation on September 20, 2026

`./scripts/check.sh` and `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e`
passed: 26 setup/hook tests, 40 smoke tests, 180 workflow tests, 35 Vitest tests,
type-check, production build, and all 88 desktop Chromium/iPhone-viewport browser
tests. Two focused discovery regressions also passed after the final adjustment
that preserves diagnostic names for shells. Tests cover tmux session name defaults,
duplicate display names with distinct pane identities, preserved saved labels,
and an unsaved agent following a tmux rename without registration changes or
configuration writes. Desktop/mobile naming screenshots were inspected.

The live backend was still serving the earlier clean-entry implementation. It
restarted externally during inspection; the fresh process exposed tmux defaults
for unsaved agents while keeping this workspace's saved names. A live dirty-work
request deliberately selected an already-existing new branch name: validation
passed the dirty-entry gate and rejected the branch collision before setup,
creating no run or command and delivering nothing. This verifies the live gate,
not an installed-agent committed handoff. The restart paused the current Console
run and retained its ownership for deliberate takeover after the worker finishes.
No completion was synthesized and no runtime database was edited. Changes remain
uncommitted; the index and committed relay log are unchanged.

## Codex steering completion validation on September 20, 2026

The live standalone command remained delivered/running after its Codex turn
recorded completion. Its notification was not retained, so the exact original
payload could not be replayed. The same turn contained an unmarked clarification;
two new regressions reproduced lost correlation and ambiguous-marker acceptance
before the hook fix, then passed afterward.

The hook now takes exactly one marked message from the current notification's
turn inputs, preserving its original echo through unmarked steering. It does not
search chat history or save a previous event's command ID. Multiple marked inputs,
malformed arrays, and unmarked later turns remain uncorrelated. The actual hook
subprocess and loopback HTTP test covers Codex steering alongside the existing
Claude pairing cases; tmux identity and vendor payloads are simulated. A real
Git/SQLite workflow test verifies standalone completion, duplicate suppression,
older-event isolation and wrong-prompt rejection.

`./scripts/check.sh` passed: 26 setup/hook tests, 40 smoke tests, 179 workflow
tests, 34 Vitest tests, type-check and production build. No UI code changed in
this fix; the prior 88-browser-test result remains the last browser validation.
The configured notifier points at this repository's hook, so its next invocation
loads the fix without a CLI or backend restart. No global configuration changed.
The specific stranded live run was paused through the existing API and its paused
state was verified. It retains ownership until deliberate takeover; no synthetic
completion, transcript-based replay, direct database edit or forced release was
performed. Changes remain uncommitted, preserving all earlier work.

## Finish-and-relay validation on September 20, 2026

`./scripts/check.sh` passed. The final
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed 24 setup/hook tests,
40 smoke tests, 178 workflow tests, 34 Vitest tests, type-check, production build,
and all 88 desktop Chromium/iPhone-viewport browser tests. The first full browser
pipeline stopped on a new test whose simulated external writer ran during setup
rather than after it; correcting that fixture's timing verified the intended
pre-dispatch rejection. No production guard was relaxed to make the test pass.

Disposable real Git/SQLite tests cover captured staged/unstaged/untracked input,
preserving it through confirmed new-branch setup, one direct handoff commit even
when the final instruction adds no project edits, and the resulting review range.
They execute the skill's read-only input verifier, reject changed content at setup
and delivery, preserve captured input/ownership across restart without replay,
reject modified journal input, and retain clean-entry rules for existing-candidate
reviews and later turns. Terminal delivery and lifecycle events remain simulated.
Browser tests verify dirty Send & relay/Send & review requests for both policies,
existing-candidate disabled tooltip text, and no dirty-checkout warning during an
active plain Send. Git discovery and committed start requests are mocked; active
plain Send exercises the mock-backend instruction API. Desktop/mobile screenshots
were inspected. No installed-agent or physical Safari acceptance is claimed.

OpenAPI parsed with all 271 references resolved; whitespace and changed-content
secret screening passed. The skill-creator Python validator could not run because
PyYAML is unavailable; no dependency was installed. Repository skill-link checks
and the executable input-verifier regressions passed. These changes are uncommitted;
the prior reset changes are preserved and the committed relay log is untouched.
The live backend was not restarted during this controller-delivered work; restart
after the current run settles is needed to load the server contract change.

## Inline workspace reset validation on September 20, 2026

`./scripts/check.sh` and `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e`
passed: 24 setup/hook tests, 40 smoke tests, 171 workflow tests, 34 Vitest tests,
type-check, production build, and all 82 desktop Chromium/iPhone-viewport browser
tests. New browser cases simulate changed process identities while exercising
the real mock-backend reset API. They verify confirmation/cancellation, revoked
confirmation after changing the selected agent, retained history and unrelated
workspace configuration, and reset blocked during execution ownership. The
takeover control is present for an owned run and absent after it completes.
Desktop/mobile confirmation screenshots were inspected. No live CLI or workspace
was reset; no backend code changed or process was restarted. Changes remain
uncommitted, and the committed handoff log is untouched.

## Send and relay button validation on September 19, 2026

`./scripts/check.sh` passed: 24 setup/hook tests, 40 smoke tests, 171 workflow
tests, 34 Vitest tests, type-check and production build. The full
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` pipeline repeated those checks;
its browser runs exposed a legacy test-helper discovery race and then an
incorrect fallback expectation in the registration-free read-only scenario.
The helper now waits explicitly and that read-only scenario skips fallback
setup. After those test-only fixes, the final
`ALTCLI_E2E_PORT=9787 npm --prefix web run e2e` passed all 78 tests across
desktop Chromium and the iPhone viewport, with no skipped tests. An initial
sandboxed check could not bind localhost; the checks above ran with that
permission. OpenAPI parsed with all 271 internal references resolved.

New disposable-Git/SQLite tests verify standalone Send leaves dirty files,
branch and HEAD unchanged, completes without a handoff commit or successor,
rejects stale instances and wrong roles, deduplicates requests, and retains
ownership across active background work and restart. A rejecting commit-msg
hook blocks a normal fixture commit but permits the documented command-scoped
handoff override without changing hook files or persistent configuration.
Browser checks verify native tooltip text for both collaboration policies and
Send's request omitting branch/commit/automation settings. Terminal transport
and lifecycle events remain simulated; button requests are mocked. Desktop and
mobile screenshots were inspected. No installed-agent or physical Safari
acceptance is claimed.

The live backend was not restarted during this active controller assignment;
restart after the relay settles is still required to load the server changes.
Isolated Playwright servers exited with the suite. No global CLI configuration,
installed skill, or legacy staging-skill changes were made.

## Integration-policy relay review on September 19, 2026

Reviewed the incoming unstaged change against the index and staged its 30 paths
before adding outgoing improvements. The new criss-cross-history regression
failed against the incoming inference, then passed after inspecting every merge
base rather than letting Git choose one. Ambiguous history now requires an
explicit baseline before dispatch. The OpenAPI workspace Git schema no longer
extends a closed object through `allOf`; sample task, integration and detached
responses validate, while missing, invalid and unknown fields are refused.
The decision ledger and baseline descriptions now match the integration policy.

`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` passed on the incoming runtime,
including all 76 desktop/mobile browser tests. After the server/schema fixes,
`./scripts/check.sh` passed: 24 setup/hook, 40 smoke, 167 workflow and 34 Vitest
tests, type-check and production build. OpenAPI parsed with 72 schemas and 264
resolved internal references. No outgoing UI behavior was changed.

The backend was restarted only after verifying no owned runs, deliveries or
setup operations; authenticated post-restart discovery and health checks passed.
No live-agent commands were sent. The fixes, regression and documentation remain
unstaged for the next reviewer. Secret screening found only an intentional token
placeholder in `.env.example`, not a credential. Installed-agent acceptance is
not claimed.

## Integration-branch policy validation on September 19, 2026

`./scripts/check.sh` passed, followed by `ALTCLI_E2E_PORT=9787 npm run e2e` in
`web/`: 24 setup/hook tests, 40 smoke tests, 166 workflow tests (55 staging/
workspace, 48 Implementation, 49 Plan, 14 project/worktree), 34 Vitest tests,
type-check, production build, and all 76 browser tests on desktop Chromium and
the iPhone viewport. OpenAPI YAML parsed with 72 schemas and all 263 internal
references resolved.

New disposable-Git tests cover: the default branch and configured integration
branches refused as the implementation branch and as a new branch name, on the
server for Implementation start, existing-candidate review, up-front Plan consent
and the Plan checkpoint; a detected `origin/HEAD` default counted without a
fetch; `ALTCLI_INTEGRATION_BRANCHES` parsing; a new task branch created from
the default branch recording its baseline; an existing task branch's baseline
inferred from the nearest integration tip, rejected outside the branch, required
when diverged integration tips give no single base, and a review range that
precedes it refused; task-worktree names that are integration names refused.
Workflow fixtures now start on a task branch created from `main`, as the policy
requires. Browser tests cover the picker offering no continue option on an
integration branch with the task-branch/squash guidance, a prefilled and an
absent task baseline field, and deferred checkpoint consent offering only a new
task branch. Earlier readiness tests moved to the new-branch path; assertions
were retained.

Also in this pass: the assume-unchanged/skip-worktree scan streams `git ls-files`
so repositories above the former 4 MiB listing bound read as clean (a 75k-file
probe and a 6,500-long-path test), worktree-creation failures before Git record
their specific reason, a finished run of forgotten agents leaves the Status
headline while staying in history, the unused RegisterPane component was
removed, and the Git 2.36 prerequisite is documented.

The development backend was restarted after a fresh state check found no owned
runs, reservations or executions; its Config predates `integrationBranches`, so a
restart was required. Post-restart discovery on the host reported the real
`main` checkouts as integration branches (one via the configured list, one via
its detected default). No live agent commands were sent, no user checkout was
branched, staged or committed, and no global CLI configuration changed. No
in-app integration or protected-branch discovery from a forge is claimed.

## Project and task-worktree validation on September 19, 2026

`./scripts/check.sh` passed, followed by the final stable-source
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` pipeline: 24 setup/hook
tests, 40 smoke tests, 160 workflow tests (54 staging/workspace, 44 Implementation,
48 Plan and 14 project/worktree), 34 Vitest tests, type-check, production build,
and all 68 browser tests on desktop Chromium and the iPhone viewport. OpenAPI
YAML parsed and all 260 internal references resolved. The final build completed
without the intermediate dynamic-path tracing warning after removing unnecessary
relative-path resolution from the host-only task root.

The new real-Git/SQLite tests use disposable repositories and an isolated task
root, never the user's home or project checkout. They cover shared-common-directory
grouping, separate same-origin clones, branch-independent worktree identity,
detached/missing/empty worktrees, remembered projects across restart, independent
index ownership, dirty-source preservation, confirmed creation, stale consent,
branch/path/symlink refusal, concurrent/duplicate requests, uncertain restart and
explicit reconciliation. A real failing checkout filter exercises partial Git
creation without retry or cleanup. An Implementation regression refuses dispatch
and agent edits into an uncertain creation destination. Agent transports and
lifecycle events remain simulated.

Six new browser scenarios run on both viewport projects: project/worktree
navigation, empty/detached checkouts, exact preview/confirmation, stale consent,
uncertain-result inspection, same-checkout directory groups and read-only-host
behavior. Project creation responses/inventories are mocked in browser tests;
real creation is exercised by the isolated Git tests. Project and creation-form
screenshots were inspected on desktop and mobile. Older solo browser helpers were
updated to select the project before its worktree; assertions were retained.

The development backend was restarted only after a fresh check found no owned
runs, reservations, executions or worktree setup operations. Post-restart checks
confirmed the real tmux project's inventory and a read-only creation preview under
the default task root; its destination was not created. No live agent commands
were sent, no actual user worktree/branch was created, and no project Git writes
or global CLI changes were performed by this work. Credentials and live terminal
contents were withheld from diagnostic output. The original staging skill and
hook protocol remain unchanged. This is not installed-agent handoff, physical
iPhone/Safari, automatic cleanup, or environment-bootstrap acceptance.

## Registration-free workspace selection validation on September 19, 2026

`./scripts/check.sh` passed, followed by the final stable-source
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` pipeline: 24 setup/hook
tests, 40 smoke tests, 145 workflow tests (54 staging/workspace, 43 Implementation,
48 Plan), 34 Vitest tests, type-check, production build, and all 56 browser tests
on desktop Chromium and the iPhone viewport. The final Playwright run status is
passed with no failed tests. OpenAPI YAML and all 245 internal references passed
inspection.

Five new workflow tests cover inline naming without prior registration, stale
discovered identities, direct unregistered solo Implementation and Plan starts,
the approved Plan transition, and refusal to execute unsupported larger groups.
Existing workspace tests cover read-only discovery, exact-generation binding at
explicit actions, retained solo/empty membership, and no hidden legacy-pair
fallback. Git and SQLite fixtures are real; terminal transport/events are
simulated. Three-or-more-member selection is supported, but execution remains
explicitly limited to one or two members.

Browser checks cover checkbox selection on every agent, saved solo/pair/larger
and empty groups, immediate read-only use without registration, inline name
Enter/blur/Escape behavior, and whole-card navigation to Console without a
Selected button. Membership and rename checks include real mock-backend API
requests; larger inventories and phase requests use route mocks. Desktop/mobile
workspace screenshots were inspected. Intermediate runs exposed a fixture ID
mismatch and delayed checkbox feedback; both were corrected. The narrow-screen
output test now selects each agent before checking its active pane, preserving
the existing mobile layout and assertions.

The development backend was restarted after verifying no owned runs,
reservations or executions; its authenticated health check remained idle.
No commands were sent to live agents. Credentials and live terminal contents
were withheld from validation output. No project Git writes, global CLI changes,
or original staging-skill/hook changes were made. This is not real-agent handoff,
larger-group execution, or physical iPhone/Safari acceptance.

## Automatic workspace-group validation on September 19, 2026

`./scripts/check.sh` passed, followed by the final stable-source
`ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e` pipeline: 24 setup/hook
tests, 40 smoke tests, 140 workflow tests (53 staging/workspace, 41 Implementation,
46 Plan), 34 Vitest tests, type-check, production build, and all 54 browser
tests on desktop Chromium and the iPhone viewport. OpenAPI YAML and all 244
internal references passed inspection.

Seven new workflow tests cover read-only automatic groups, identity-preserving
rename and stale/owned-operation refusals, explicit selection for larger
inventories, concurrent saves, duplicate-group refusal, automatic inclusion of
one/two agents, idle removal without losing history, retained historical
associations, and staging fallback binding the displayed roster. Plan and
Implementation use the same workspace group; active run snapshots remain frozen.
Browser tests cover Register/Rename, automatic groups, exclusion checkboxes only
above two eligible agents, and invalidated readiness after a registration change.
Workflow transport/events are simulated; browser phase requests and larger-agent
inventories use mocks. Git-writing tests use disposable repositories.

Desktop/mobile workspace screenshots were inspected. An intermediate mobile run
was interrupted by a source-triggered page reload; the final unchanged-source
run passed without weakening assertions. The development backend was restarted
after confirming no owned runs, reservations or executions, and its authenticated
post-restart health check remained idle. No commands were sent to live agents.

Existing staged work was preserved; this work did not stage, commit or branch
the project checkout. Rename changes only the display label, not tmux sessions.
The original staging skill and hook protocol remain unchanged. This is not
real Codex/Claude handoff or physical iPhone/Safari acceptance.

## Dirty-worktree entry validation on September 19, 2026

`./scripts/check.sh` and `ALTCLI_E2E_PORT=9787 ./scripts/check.sh --e2e`
passed: 24 setup/hook tests, 40 smoke tests, 133 workflow tests (46 staging,
41 Implementation, 46 Plan), 34 Vitest tests, type-check and production build.
The final browser run passed all 52 tests on desktop Chromium and the iPhone
viewport. OpenAPI YAML and all 235 schema references also passed inspection.

Nine new disposable-Git tests cover staged, unstaged, mixed and untracked entry
refusals before branch creation or dispatch; read-only status reporting;
rename/Unicode/newline paths; ignored files; and the bounded changed-file list.
Six new browser cases cover both phases, file labels and literal text rendering,
retained phase selection and staging fallback, Recheck, failed discovery, and
fresh consent after returning to the same clean branch/HEAD. Browser responses
are mocked; terminal lifecycle events in workflow tests remain simulated.

Desktop/mobile dirty-worktree screenshots were inspected. Intermediate browser
failures exposed an ambiguous alert locator, stale generated test CSS, and a
mock polling request still running during teardown. The locator was scoped,
stopped test build artifacts were moved aside and regenerated, and phase tests
now await in-flight route handlers before teardown. Assertions were not weakened.

The host development backend was restarted only after confirming no owned runs,
reservations or executions. Post-restart checks verified discovery, changed-file
metadata and current UI styles without dispatching agent work. No existing
managed checkout was staged, committed or branched by this validation; Git writes
were confined to disposable test repositories. The original staging skill and
hook protocol remain unchanged. No real Codex/Claude handoff or physical
iPhone/Safari acceptance is claimed.

## Unified setup validation on September 19, 2026

`./scripts/check.sh` passed: 24 setup/hook tests, 40 smoke tests, 124 workflow
tests, 34 Vitest tests, type-check and production build. The five new setup tests
run the real installers in copied fixtures with temporary CLI homes; npm is
stubbed, so no dependency download or actual user configuration change is claimed.
They cover default/custom CLI paths, repeat runs, preserved settings and backups,
private token storage without log output, and dependency/configuration/skill
conflicts. Browser tests were not rerun for this script/documentation-only change.

## Plan and Implementation validation on September 19, 2026

The sequential one/two-member Plan phase and its Implementation transition were
checked with `./scripts/check.sh` and `./scripts/check.sh --e2e` on Node 26.0.0
and npm 11.12.1. The final full pipeline completed successfully:

| Check | Result | What it establishes |
| --- | --- | --- |
| Installed-skill check and hook regressions | Passed; 19 tests | Legacy skill links and hook behavior remain unchanged; new phase skills use explicit repository paths, without global installation changes. |
| Smoke suite | 40 tests passed | Parsing, auth, transport and configuration helpers |
| Workflow suite | 124 tests passed | 46 legacy, 36 Implementation and 42 Plan tests, using disposable real Git repositories and SQLite. Plan coverage includes independent drafts, complete-roster barriers, exact-version endorsements, objections, changes, all automation/approval combinations, separate implementation membership, deferred branch consent, frozen authorization, shared budgets, duplicate/early events, artifact faults, unknown activity, restart and v5 migration. Terminal delivery and lifecycle events are simulated. |
| Type-check, Vitest and production build | Passed; 34 Vitest tests | Full TypeScript and route build plus store, controller and workspace regressions |
| Playwright, desktop Chromium and iPhone viewport | 46 tests passed | Explicit phase selection, independent approval/automation and branch controls, captured checkpoints, stale confirmation, changes and override controls, plus existing console/Implementation/fallback behavior. Planning Start/decision responses and checkpoint state are mocked; these are not real coding-agent handoffs. |
| OpenAPI and skill metadata | Passed | YAML parsing, internal schema references, frozen-plan required fields and planning-skill frontmatter checked without installing dependencies |

Desktop/mobile planning setup and checkpoint screenshots were inspected. An
intermediate browser run exposed a legacy-test initialization race: it checked
for fallback before the initial view was selected. The helper now waits for that
view without weakening assertions. Earlier mobile Lock-click timeouts did not
recur in the final stable-source run; physical iPhone/Safari acceptance remains
unverified.

No existing managed worktree was branched, staged or committed by this work;
Git writes in validation were confined to disposable repositories. No persistent
AltCLI development backend was found to restart; isolated test servers were
started and stopped by Playwright. No global CLI configuration or installed
skills were changed. The original staging skill and hook protocol are unchanged.

This validates the local sequential increment, not native CLI plan-mode isolation,
real installed-agent execution, enabled 3+ member planning, concurrent drafts,
in-flight guidance queues, automatic restart recovery, or deployment acceptance.
N=3/N=5 tests exercise only the N-shaped state model. Plan requires a clean checkout
and a user-prepared narrow `.altcli/plans/` exclusion; no ignore rules were
silently changed. Live-agent acceptance remains a separate supervised check.

## Implementation-phase validation on September 19, 2026

The branch/commit Implementation phase was checked with `./scripts/check.sh` and
`./scripts/check.sh --e2e` on Node 26.0.0 and npm 11.12.1. The latter runs the full
`check` pipeline before browser tests. All of the following completed successfully:

| Check | Result | What it establishes |
| --- | --- | --- |
| Installed-skill check and hook regression suite | Passed; 19 tests | Existing legacy skill links remain valid; hook correlation behavior is preserved. The new commit-handoff skill is read from this repository, without changing global skill installations. |
| Smoke suite | 40 tests passed | Input parsing, auth, transport and configuration helper behavior |
| Workflow suite | 82 tests passed | 46 existing workflow tests plus 36 implementation tests: real disposable Git repositories and SQLite stores exercise branch consent, commit/range/log validation, policies, migration, ownership, duplicates, restart, readiness generations and retained staging fallback. Terminal transport and lifecycle events are simulated. |
| Type-check and production build | Passed | Full TypeScript check and Next.js production route build |
| Vitest | 34 tests passed | Store, controller and workspace grouping regressions |
| Playwright, desktop Chromium and iPhone viewport | 38 tests passed | Existing console/fallback flows plus commit-mode defaults, solo controls, fixed-role/branch consent requests and stale branch confirmation. New Start requests use mocked responses; these are not real coding-agent handoffs. |
| OpenAPI and skill metadata | Passed | Ruby YAML parsing and internal OpenAPI reference resolution; commit-handoff frontmatter checked without installing dependencies |

Desktop and mobile implementation-form screenshots were inspected. No live
AltCLI development backend was running, so none was restarted. No existing
managed worktree was branched, staged or committed by this validation; Git writes
in tests were confined to disposable repositories. The user's pre-existing staged
change was preserved.

This does **not** establish real Codex/Claude commit-skill execution, unattended
relay acceptance, physical iPhone/Safari compatibility, or deployed-host restart
behavior. Plan was deferred at that earlier checkpoint. Those checks still require supervised host
acceptance; the older observations below are historical, not new-phase acceptance.

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
| Playwright e2e (desktop Chromium and iPhone 13 viewport) | 16 tests passed | Mock relay and release, pane registration with preview and agent type, shell refusal, pair tabs labeled with their project, removal, pair creation/filtering/refusal/removal, independent reservations across projects, wrong token; run against `next start` on an alternate port because a dev server occupied 8787 |
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

No live-agent run is claimed. The lockfile resolves package versions as installed
locally.

## Local validation before real input

Follow [docs/TESTING.md](docs/TESTING.md) in order: install, automated checks, the
tmux dry run against a harmless `cat` pane, and only then real coding CLIs with
[docs/SETUP.md](docs/SETUP.md)'s manual acceptance checklist. Run read-only
(`ALTCLI_ENABLE_INPUT=false`) first if you want captures verified before any send.

Update this record with actual results and versions as you proceed. Do not check
off roadmap acceptance merely because a corresponding source file now exists.

## Terminal input and checkpoint proposal — 2026-09-22

Scope: [ADR-0019](docs/adr/ADR-0019-terminal-input-and-checkpoints.md), based on `ec7fc49`. Validation used macOS 26.6.2, Node 26.0.0, tmux 3.6a and the locked Next.js 16.3.4 toolchain. This linked checkout had no dependencies installed. Checks ran on a disposable copy of the source with the existing main checkout's dependency tree, whose lockfile matched exactly. No dependency install or global CLI configuration change was made. Installer checks used isolated Claude/Codex configuration directories. Browser servers used ports 9787/9788 and disposable SQLite stores.

The first check exposed a mistaken solo-Plan test fixture; correcting it verified that a final Plan input hold also gates preauthorized Implementation. Browser regression testing exposed the hidden disabled legacy composer; its behavior was restored. The advice test's picker selector was corrected to use its accessible combobox role. These failures were not counted as passes.

`node --experimental-strip-types --test web/scripts/terminal-input.test.ts` passed against a private tmux socket and a harmless `cat` byte reader. It verified exact UTF-8/numeric text, bracketed multiline paste, key-only Enter and Escape (no extra Enter after Escape), and copy-mode refusal. It did not launch a coding agent. Fake-runner smoke cases also cover the closed key enum, preflight and partial-send uncertainty. Git/SQLite fixtures cover current-holder/revision checks, two-client reservations, duplicates, completion/input races, final ownership release, invalid/changed publication, restart, Plan approval, exact external settlement, stale events and restoration without dispatch. These simulated lifecycle events do not certify an installed CLI.

| Installed provider / layer | Detail during work and queued prompts | Numeric answers, Enter and Escape | Same-turn completion and recovery |
| --- | --- | --- | --- |
| Codex CLI 0.155.1 (`codex --version`) | Live behavior unverified; manual inspection required | Live dialog semantics unverified | Existing exact-binding/steering hook fixtures pass; no new live CLI acceptance claim |
| Claude Code 2.1.278 (`claude --version`) | Live behavior unverified; new native turns fail closed | Live dialog semantics unverified; no generic permission-answer interpretation | Prompt pairing/background fixtures pass; no new live CLI acceptance claim |
| Private tmux + harmless byte reader | Literal bytes and multiline transport observed | Exact bytes observed, no semantic interpretation | No agent lifecycle involved |
| Mock browser and disposable controller fixtures | Explicit actions, immutable follow-up and whole-run holds exercised | Literal input and separate Escape confirmation exercised | Validated input/restore checkpoints and failure cases exercised |

Real-provider tests of detail while working, queued next prompts, permission dialogs and interrupted work remain a release acceptance step in supervised isolated sessions. The controls therefore expose manual input and fail-closed reconciliation; they do not advertise verified provider semantics. Physical iPhone/Safari and multi-host acceptance remain untested. The active development backend was not restarted: the controller-issued assignment still owns work during this handoff. Restart only at a verified settled boundary, then perform installed-host acceptance; browser test servers were separately started and stopped.

Final automated results for this proposal:

- `./scripts/check.sh`: passed on the final source, including 30 hook/setup regressions, 43 smoke tests, 287 workflow/implementation/planning/project tests, 66 unit tests, type generation/type checking and production build.
- `./scripts/check.sh --e2e`: passed, including the backend/build checks and 179 Chromium browser cases across desktop and iPhone emulation; three desktop-only layout cases were intentionally skipped on the phone project. The final additional copied-command-marker guard was then covered by the full backend/build check above. UI source did not change after this browser pass.
- The private-tmux byte test passed separately (one case). New input-checkpoint screenshots were inspected at desktop and iPhone dimensions; existing intermediate-width layout coverage also passed.
- New inline OpenAPI JSON schemas parsed and all schema references resolved. `git diff --check` passed. Task files and the handoff report were screened for credentials; only dummy test fixtures were retained.

No live-provider or physical-mobile acceptance is inferred from these results.
