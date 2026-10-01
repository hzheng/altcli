# Validation layers

**Scope:** the existing suite description below is retained. The [acceptance scenarios](#acceptance-scenarios) are requirements for future collaboration increments, not a claim that those tests exist or pass. Executed checks are recorded in commit messages.

Run the repository gate from the root; no root package.json is required.

```bash
npm --prefix web ci
./scripts/check.sh
./scripts/check.sh --e2e
```

The gate checks skill installation (read-only), dependency-free setup/hook/config
regressions, transport smoke tests, workflow tests against better-sqlite3, full
TypeScript, Vitest and production build. The e2e gate adds Playwright against mock
servers. Each viewport has a separate store. Mobile Chromium emulation is not
physical Safari/Tailscale validation.

## Focused checks

```bash
node --test scripts/review-regressions.test.mjs
node --test scripts/setup.test.mjs
cd web
npm run test:smoke
npm run test:workflow
npm test
npm run typecheck
npm run build
npm run e2e
```

Setup/hook/config tests use temporary homes only. Setup tests run the real hook
and skill installers in a copied fixture, but stub npm rather than install or
download dependencies. The HTTP hook smoke test invokes the
real hook with a fake tmux metadata executable and a loopback test server; it does
not launch a coding CLI. It proves current-message preference, start/stop binding,
overlapping-start refusal and no lagging-transcript reuse.

Workflow tests use simulated terminal transport and real SQLite. They cover exact
pair routing, duplicate and reordered lifecycle delivery, current-command binding,
source acknowledgment/session identity, unknown background state, delivery races,
long-running work beyond history limits, budget, restart and human takeover. Git
identity tests create disposable repositories, subdirectories and linked worktrees.

Image attachment tests use synthetic images and isolated data directories. `web/src/server/image-structure.test.ts`
covers the PNG/JPEG structural rules; `web/scripts/attachments.test.ts` covers authentication before
allocation, limits, time bounds, quotas under concurrency, symlink/hard-link/containment refusal,
idempotent retries, delete/pin races, draft expiry and restart recovery, and the broker's exact
bracketed reference, destination and CLI rechecks, receipts, revocation and uncertain writes;
implementation and planning tests cover the manifest prompt, pinned descriptors reaching workers,
reviewers, planners and the frozen plan, and a changed file pausing dispatch. `web/e2e/images.spec.ts`
exercises paste, picker, Display refusal, mixed clipboards, Insert, Remove, Send and a Plan brief with
browser-encoded images; synthetic clipboard events prove the handlers only.

Browser tests cover explicit readiness, registration, pair selection, server
progression with a locked page, multiple views, pause/takeover, uncertainty and
unauthorized reads. Assertions use explicit correlated hook fixtures; they do not
pretend those are actual installed Codex/Claude payloads.

## Host acceptance still required

### Interactive-terminal M0 probes

Use Node 24 from the repository root. The native suites require tmux and run only
private sockets with harmless fixture programs; they never use the user's sessions.

```bash
npm --prefix web run test:native
npm --prefix web run probe:terminal:ws
npm --prefix web run build
node web/scripts/terminal-websocket-probe.mjs --production
```

The native tests cover captured fallback for automatic sizing, manually sized
observer isolation, literal bytes, detach/lifetime, direct-argv launches, immediate
exit, old-server environment contamination and durable reservations. The real-host
WebSocket probe checks Next's shared broker, six live streams, typed errors,
first-frame ticket replay rejection and shutdown. It uses isolated stores.
`probe:terminal:http` retains the rejected six-HTTP-stream experiment for comparison.
Application checks include broker admission, restart, duplicate and checkpoint
fixtures; browser tests distinguish mock rendering from actual tmux behavior.
See [the protocol](TERMINAL-PROTOCOL.md).

### Direct-input and concurrent-writer probe

`npm --prefix web run probe:terminal:writers` uses a private tmux socket, two raw
byte-reader fixtures, the real ControlPlane/SQLite/broker/PTY path and Chromium
running the installed xterm. Only target lookup is injected because the readers
are not coding agents. Its socket bridge is in-process; receipt latency excludes
HTTP/WSS, Next, network delay and final display latency.

The probe compares 1, 2, 4 and 8 native observers with the same number of writers,
balanced across two sessions within the four-client session cap. It reports Node
and browser RSS/CPU, native process CPU, attachment counts/RSS, native inspection
counts, output volume, first-input time and keyboard/paste receipt p95. The Node
process also hosts the Playwright driver. CPU samples last 1.2 seconds and native
CPU uses process-time counters, so these are local regression measurements, not
deployment sizing. It separately exercises captured-only promotion, application
cursor/paste modes, concurrent input into the same pane, a slow/disconnected
consumer and 100 full open/promote/stop/close cycles. Descriptor counts, native
clients and browser terminals must return to their steady counts. Heap samples
use awaited major GC; allocator RSS alone is not a live-object leak diagnosis.

At equal native-client counts, compare incremental Node RSS with the larger of
16 MiB and 20% of observer RSS, idle host CPU with a five-percentage-point increase,
and input receipt p95 with a 20 ms increase over one writer at that client count.
The idle local first-input target is below one second. Record absolute browser
costs, sustained-output behavior and any failed gate as well as these deltas.

The pinned node-pty 1.1.0 remains the latest official stable release as checked on
2026-09-29. On macOS every spawn leaks three descriptors
([upstream report](https://github.com/microsoft/node-pty/issues/907)): a spare
`/dev/ptmx` master, the parent's copy of the slave and its exit thread's kqueue.
Full-cycle testing reproduced `posix_spawnp failed` before cycle 100; merely
checking that tmux clients exited did not detect that leak. Dependency upgrades are
restricted to official stable releases, so `web/src/server/tmux-attach.ts` closes
exactly those descriptors: pseudo-terminal masters new to that spawn other than
node-pty's own, the parent's descriptor for the spawned slave device and, after the
exit has been delivered, the one kqueue whose only event is that client's exit, as
`/usr/bin/lskq` reports while the client runs. It leaves an unidentified queue open.
`npm --prefix web run test:native` checks that closed and self-exiting attachments
return to the steady descriptor count; the churn probe then keeps its descriptors
flat through 100 cycles. The workaround runs only on macOS with exactly node-pty
1.1.0: a later release may close and reuse its own descriptors before the exit
callback. Each stable upgrade must pass both probes before resource acceptance;
do not extend the cleanup to a new version without auditing its ownership.
Raising host descriptor limits is not a substitute for that cleanup.

Use a disposable repository and private tmux socket first. Start with a harmless
read/echo process to check transport, then actual installed Codex and Claude Code.
Inspect process metadata, output and exact submitted prompt including command
marker. Confirm current hook fields and background-state evidence; missing fields
must pause rather than be faked for the test.

Exercise permission dialogs, queued/partial input, native CLI restarts, backend
restart, two clients, and physical iPhone disconnection. Record the exact commit,
CLI/tmux/Node versions, commands and observed outcomes. Final task-level tests and
Git delta review remain required after a relay chain ends.

### Terminal and launch release checklist

Image attachments (M4A/M4B) have their own rows below. For the remaining terminal/launch release, record each demonstration
against the source revision and installed Node/tmux/CLI/browser versions. Leave
an unexecuted row open; a mock result cannot fill an installed-host row.

| Demonstration | Required observations |
| --- | --- |
| Native idle/startup | In a disposable checkout/private tmux socket, launch the installed CLI, use its native model menu, answer a question, then establish fresh readiness. Record both supported providers separately. Do not automatically accept trust, login or permission prompts. |
| Active assignment | Answer a native prompt under a keyboard hold; validate the original correlated result, release/reconcile, and apply its saved checkpoint once. An unrelated new turn or interrupted task must require explicit recovery. |
| Project and batch launch | Add a repository with no tmux server, launch two profiles, handle startup and start a valid task. Launch three instances separately and verify the workflow execution cap remains one/two. Check uncertain worktree creation never launches into a guessed path. |
| Mobile and concurrent access | Use a physical iPhone Safari and a desktop together. Check English/Chinese IME, emoji, multiline paste, screen-reader mode, touch modifiers, expansion, rotation, keyboard visibility, two-client exclusion and focus routing. Chromium phone emulation is only layout/interaction evidence. |
| Remote path | On the intended private HTTPS/WSS origin, check upgrades, proxy buffering, output load, network switching and reconnect. Record input latency and verify no input replay or automatic workflow continuation. |
| Settled restart and rollback | With no active delivery, restart the backend and confirm original workers survive, old tickets fail and manual/launch uncertainty remains. Disable flags and verify captures and explicit reconciliation remain available; do not clear ownership rows. |
| Image insertion (per provider) | In a disposable checkout on a private socket, paste a real screenshot and choose Insert in each supported CLI. Record whether the reference becomes an image token, then submit manually and record image-specific output and any permission prompt. Repeat after the writer navigates away and back, after the CLI exits to a shell, and with text already typed; none may insert elsewhere or submit. A probe on September 29 covered the first part for Claude Code 2.1.285 and Codex 0.159.0; the rest is open. |
| Control images | Send, committed work with a peer review, and a one- and two-planner Plan with an image, using installed agents: each recipient reports image-specific content; hook prompt echoes match the manifest or skill prompts; a changed file pauses the next dispatch. |
| Mobile images | Physical iPhone Safari: photo-library picker (record the returned type), clipboard image paste where offered, a denied clipboard and an unsupported format. Desktop Safari and Chrome: screenshot paste and a mixed image-and-text copy. |
| Finish branch | In a disposable linked worktree on a private socket, launch two installed CLIs, split one session, and open a session of your own there. Finish branch must list both launched sessions with their processes, leave yours running, require the stop acknowledgement while one is working, close only the launched ones by ID, report a detached background process as a survivor, and hand over to removal or discard only after a fresh confirmation. Repeat with a paused run (takeover before the Git step) and with a backend restart mid-close (uncertain, inspection only). |

`web/e2e/native.spec.ts` exercises the real mock API and xterm renderer, including
late input responses after recovery, paste consent, separate control drafts,
expansion without lease changes, local keyboard claims and the server-wide ownership status (confirmation, transfer
between panes as one broker decision, cancel during a slow connect) and the keyboard
focus escape. `web/scripts/terminal-broker.test.ts` covers server resize admission,
generation checks and short launch-name allocation across worktrees.
`web/scripts/finish.test.ts` covers Finish branch against real Git with a fixture tmux
host (scope proof, digest and acknowledgement gates, survivors, paused runs, the admitted
child removal/discard, restart and inspection), and the private-tmux case in
`web/scripts/native-launch.test.ts` (`npm run test:native`) covers the real kill by
session ID, a split in scope, a linked window refused, a user session left alone and a
detached survivor. Run `./scripts/check.sh`, `./scripts/check.sh --e2e` and the native probes
above; inspect the produced screenshots. These local checks do not complete the
physical device, real-provider or deployed proxy rows.

A green CI checks the implementation and fixtures, not the host's process identity,
background-task observability or private-device security boundary.

---

## Acceptance scenarios

Use behavior-based tests and label capability stage. N=3/N>3 model tests preserve the target design, but do not mean the first UI release can dispatch more than two selected members. Workspace discovery can list any number in either stage.

### Workspace, group, and branch scenarios

| Scenario | Expected behavior |
| --- | --- |
| Multiple panes in attached or detached tmux sessions | Discovery inspects panes on the configured socket, not only visible terminal clients. |
| Same cwd contains Codex, Claude, a shell, and a dev server | Only the two eligible coding agents count toward the suggested group; others are visible diagnostics as appropriate. |
| Workspace contains 0, 1, exactly 2, or 3+ eligible instances | No runnable group; solo; both preselected; all selected respectively. Every session has a checkbox; larger selections persist without first-two truncation. |
| Discovery lists many agents before N-agent dispatch is enabled | Inventory/selection are complete within configured scope; Start enforces the execution cap. |
| Two registrations refer to one actual execution | Cannot form a two-member group or provide two planning endorsements. |
| User deliberately deselects one of two suggested agents | Solo is allowed on the new workflow; polling does not restore the second selection. |
| One-member implementation group | One worker identity, no automatic self-relay or fabricated peer approval. |
| User requests self-review | Labeled non-independent and bounded; no automatic endless correction cycle. |
| Start/phase selects a worker and reviewer with the same instance ID | Refused server-side, not converted into a virtual pair. |
| Equivalent path spellings resolve to one cwd | One workspace grouping; exact underlying worktree/index still checked. |
| `/repo` and `/repo/web` are task groups beneath one worktree | Selected local group cannot mix them under the same-directory rule; concurrent conflicting runs share a lock and are refused. |
| Same repository but distinct linked worktrees | One project with distinct worktree/index identities and independent task ownership; not combined into a local group. |
| Separate clones have the same origin, or no remote exists | Group by canonical common Git directory, not URL or display name; separate clones have disambiguated task-path namespaces. |
| Worktree switches branch or detaches HEAD | Identity remains branch-independent; current path and branch/detached state are displayed. |
| Worktree has no panes, or its directory becomes unavailable | Git inventory keeps it visible with setup guidance or a diagnostic; no agent readiness is invented. |
| Newly created/explicitly used project has no agents after restart | Remembered project identity and Git worktree inventory restore visibility without a disk scan. |
| Worktree creation is previewed or a project opened | No Git/configuration mutation, directory creation, dispatch or run change. |
| Confirmed new task-worktree creation from a dirty checkout | Create only at the confirmed commit; source branch, staged/unstaged/untracked files and index remain unchanged. |
| Creation has stale source identity, branch, commit, path, invalid name, symlink or existing destination | Refuse/reconfirm before Git; no overwrite or environment copying. |
| Duplicate/concurrent creation confirmations | One durable operation owns project setup; identical IDs return existing state, changed inputs conflict. |
| Creation fails after Git starts, or backend restarts while applying | Retain uncertain owner; no automatic retry, cleanup or rollback. |
| Human inspects uncertain creation | Read-only verification of exact clean success or complete absence; partial/changed/unreadable results remain owned. |
| Removal of a linked task worktree is previewed | Read-only: named non-integration branch, clean tracked/nonignored state, no hidden index flags, no pane in the directory, no run/delivery/setup owner, and exact ancestry or a single matching squash commit on local main/default; anything else is a precise refusal, including a pane in the checkout whose directory was deleted. A stale pane in a deleted directory elsewhere blocks nothing. |
| Confirmed removal | Persist the owner and exact consent, revalidate live occupancy and Git evidence, then run one non-force `git worktree remove`; the branch, commits and run history are kept and ignored files are deleted only after the warning. In the browser, Check removal and Discard stay clickable while agents occupy the worktree, name the occupant beside the button, and show the server's refusal on click; only read-only hosts, in-flight requests and unreadable state disable them. |
| Removal fails after Git starts, the backend restarts, or the response is lost | Retain the uncertain owner; inspection verifies complete absence or the unchanged original checkout and never retries or force-removes; the browser keeps its pending confirmation until a recorded result exists. |
| Squash integration is previewed | Read-only: named non-integration task branch, an unambiguous merge base, the integration branch checked out in a clean unowned checkout with a committer identity, a conflict-free `git merge-tree` whose tree differs from the target; conflicts name the files, an already-integrated branch points to Check removal, and dirty task-worktree changes are reported, not squashed. |
| Configured commands and filtered repositories | Ordinary discovery/status uses configured filters and monitors, including LFS-style selected filters; clean-entry checks, worktree creation and recovery of an earlier uncertain creation remain usable. Squash-specific reads refuse selected clean/process filters before running status or merge calculations. Cover submodules, monitors, includes/worktree config, every merge input and large inventories. A public squash request may execute filters in its ordinary discovery refresh; refusal still leaves refs and index unchanged. |
| Squash shares a checkout with native agents or background writers | Inspect both checkouts and every subdirectory/unselected pane. Working/unknown activity, display acknowledgements, active background evidence, surviving task processes, unavailable inventory/process evidence, replaced CLIs and restart refuse mutation. Shells require the root foreground PID and no task processes; generic interpreters remain unsupported. Exclude only the exact bounded caffeinate helper, keeping other arguments and children visible. Settled agents, idle shells and copy-mode panes can integrate. Repeat checks before staging and commit; failures after staging retain uncertainty. Activity after exact verification does not invalidate a completed squash or its read-only verification. Duplicate requests never repeat Git. |
| Confirmed squash | The compact confirmation (consent digest plus a message of at most 8 KiB once JSON-encoded) fits the request limit: a 101-commit preview confirms with its unedited generated default, and a worst-case message of double quotes at exactly the budget round-trips through the body parser and commits; one more escaped byte is refused by the same rule the browser displays. A changed digest is refused before any claim. Persist the owner and the re-derived consent (edited message included), revalidate Git and ownership, then stream the exact merged-tree diff into `git apply --index --binary` and run one `git commit` under the repository's normal hook policy; success is exactly one new single-parent commit with the previewed tree. A rejecting hook leaves a staged squash and an uncertain owner that inspection keeps while the checkout is dirty; once clean and with current settled writer evidence, inspection completes the operation when the previewed commit is anywhere on the branch since the pinned tip (later commits on top included) and otherwise releases it as failed, whether the tip is unchanged or moved on by hand, while missing or active writer evidence at inspection entry still retains ownership. Activity after verifying the historical commit does not undo that completed operation; release without a matching commit rechecks writer evidence. The task branch and worktree are unchanged and Check removal then verifies the squash. |
| Multiple squash batches | Confirm a chosen prefix, preserve intervening main edits in later batches, resume the recorded boundary after restart, reject foreign endpoints/stale consent, retain uncertain hook failures, preserve obstructing ignored files, and allow removal only once the verified endpoint reaches HEAD. Ignore checkpoints outside current history or whose objects were pruned; after a main reset, allow a fresh full squash and independent removal evidence. Retire checkpoints on removal/discard (including reconciliation) while retaining historical results and request deduplication; same-path recreation starts fresh. Browser tests show disabled reasons, permit idle source agents, and invalidate consent on endpoint edits. |
| Discard is previewed and confirmed | Read-only preview counts unmerged commits and uncommitted changes and fingerprints the exact nonignored content, so an edited dirty file with an unchanged file count refuses the old consent, including when it changes during the archive step; confirmation requires the typed branch name, no pane, run or delivery in the checkout, and archives the journal first; then `git worktree remove --force` and `git branch -D` run once, run history is retained, and uncertain results are inspected without retry. Inspection describes a changed worktree, a stale Git entry or a moved branch instead of returning silently; a discard interrupted between the two commands offers a confirmed finish that re-verifies the branch at the confirmed head, refuses a lost owner race, and deletes only the branch; an inspection overlapping the applying owner or a completed finish never overwrites that record. |
| Registered pane moves to another worktree while no run owns either checkout | Rediscovered under its saved name in the verified new placement; the next explicit edit or Start persists it and drops it from old groups. Missing process evidence, a changed pane identity, or ownership of either checkout is shown as the blocker instead of a rebind. |
| Dirty, unknown-runtime, or blocked workspace | Remains visible/readable; Start shows a precise precondition failure. Recheck performs no repair. |
| A new pane appears during a run | Available inventory changes; frozen group/roles/next actor do not. |
| Selected pane disappears, restarts, or changes cwd | Mark unavailable/pause; no automatic substitute, following, restart, or reduction to solo. |
| User opens/pins another workspace | Viewing changes only; no agent dispatch or branch mutation. |
| One of three same-worktree agents is not selected | It is unscheduled but visible as a potential writer; activity is reconciled before conflicting work or branch setup. |
| Current branch is main/configured primary | Explicit create-new or stay-current choice; staying says where commits land. |
| Current branch is feature/X while unrelated branches also exist | Actual checked-out branch is used; other branches do not trigger arbitrary selection. |
| Detached HEAD at a valid baseline | Plan may remain read-only; commit implementation waits for confirmed named-branch setup or user checkout. |
| No baseline commit exists | User preparation required; no automatic initial commit or fabricated history. |
| Plan approval is waived but branch consent is absent | Wait for branch choice; no mutation or code dispatch. |
| User confirms branch creation while planners are still executing | Record pending intent; do not switch underneath them. Revalidate at a settled boundary. |
| Branch name exists, is invalid, or baseline/workspace changed since consent | Reject/reconfirm; no force/reset or implicit adoption. |
| Two devices confirm branch setup, or restart occurs after an ambiguous operation | One scoped operation; inspect/reconcile actual state rather than blindly replaying. |
| Confirmed branch creation succeeds | Verify branch and unchanged baseline, bind group/branch, then dispatch once. |
| User tries committed work on main, the recorded default or another integration branch | Refused, even when `ALTCLI_INTEGRATION_BRANCHES` omits `main`; create a task branch or worktree, or use Stage relay for an uncommitted fix on main/default. |
| Task finishes | Do not auto-merge, delete branch/worktree, remove environment files, or provision another directory. |
| Older stored pair configuration is migrated | Membership/history stays intact under group terminology; vendor event pairing is not renamed semantically. |

### Stage relay and worktree-reuse scenarios

Stage relay rows are implemented locally; worktree-reuse rows describe accepted but unimplemented design (ADR-0013).

| Scenario | Expected behavior |
| --- | --- |
| Stage relay start on `main`, the recorded default, another integration branch, a task branch, detached or unborn HEAD | Only `main` and the recorded default start; the others are refused on the server with the reason; a linked checkout on `main` qualifies and a primary checkout on a task branch does not. |
| Stage relay start without the pair or without the displayed branch/commit, or with a stale one | Refused before any run or delivery. |
| Branch or HEAD changes before a delivery, or during a turn | The next delivery is rejected or the completion schedules nothing; the run pauses with ownership retained; nothing is sent. |
| Staging run recorded before branch binding | Its correlated completion is recorded; no successor; held for takeover. |
| Host sets `ALTCLI_ENABLE_LEGACY_RELAY=false` | New starts refused and the variable is named in the Console; an existing request ID returns its record. |
| Stage relay on a dirty main checkout | Staged and unstaged work is reviewed as the skill defines; nothing is committed automatically; squash into that owned checkout is refused. |
| Update from main: contained, fully squashed, partly squashed and unintegrated branches | Fast-forward, move to main, replay after the last batch, or replay after the merge base. Authors, dates and messages kept; old tip under `refs/altcli/preserved/<request>`; ignored files kept; repository hooks do not run; squash checkpoints retired. |
| Update refusals | Attributes that select a configured filter only in the combined replay tree (at preview and at confirmation), conflict, redundant or merge commits, more than 100 commits, dirty checkout, obstruction by an untracked or ignored file, upstream or remote copy (non-fast-forward), stopped Git operation, sparse checkout, submodules, hidden index flags, installed hook or skill links, the host's own checkout, run ownership: all refused with nothing changed. |
| Alignment agent evidence | Update, Rebase and Reset succeed with unknown, human-acknowledged, active, background or unavailable process evidence. A native turn starting during reset inspection does not veto consent; controller ownership and exact Git content checks still apply. |
| Update confirmation and uncertainty | Stale consent is refused; a duplicate request returns its record; a claim with a run owner is refused in one transaction; a run cannot start while an update is unresolved. An unverified result stays owned across restart; inspection verifies it, or releases a clean unchanged checkout as failed while keeping a created recovery ref. |
| Rebase onto main | Clean checkout required (dirty refused, pointing to Reset). Every commit since the merge base is replayed (`git rebase main`); a contained branch fast-forwards; after a squash batch, a commit main already has is refused, pointing to Update, which skips it. |
| Reset to main | Dirty checkout allowed. The preview lists dropped commits and discarded tracked changes. One explicit confirmation accepts the previewed loss; no typed branch is required. Afterwards the branch is at main, tracked files match, untracked and ignored files are kept, the old tip is under the recovery ref and repository hooks do not run. |
| Reset refusals and uncertainty | Refused, with nothing changed: an ignored file where main adds a tracked file (plain `git reset --hard main` overwrites it), untracked content where a deleted tracked file would be restored, and edits after the preview or during the archive step. An ignored file appearing just before the checkout leaves an uncertain result; inspection releases it as "changes discarded, branch not moved", keeping the recovery ref. |
| Reset review regressions | An ignored file appearing at a restored path during archiving refuses the reset before writes. A native turn starting before the final content reads does not veto the human's confirmation. After restart between the recovery ref and reset, a target already in the old history cannot prove success: unchanged content releases as failed, while later task commits retain uncertainty. Main merged by hand after an interrupted reset is not taken for the reset (the dropped old tip is still on the branch); a reset followed by more task work is still verified. |
| Worktree action menus (browser) | Main groups squash, update, rebase and reset; Branch groups rename, finish, removal check and discard. Hover/click/keyboard opening sends nothing, triggers persist above forms, and opening rename again preserves its draft. Each preview names its case, equivalent command and exact commands, and posts its mode; Update and Rebase warn about active editing and manual conflict resolution; Reset warns about lost work and needs one confirm button. Changing views revokes confirmation while keeping an unknown request inspectable, without resending. |
| Branch rename | The directory and uncommitted work are unchanged and squash batches continue under the new name. Same, integration, existing, case-variant or prefix names, published branches and content changed after preview are refused. Unknown or active native activity, background work and unavailable process evidence do not block a confirmed rename, including a native turn starting during the final inspection; run ownership still blocks it. The browser shows the concurrent-Git and old-name warning. An unverified rename stays owned until inspection and is never repeated; a lost response stays inspectable by its request ID after a view change revokes the preview. |
| Directory move (not implemented) | Preview/consent, transactional holds, no occupancy, uncertain-owner inspection, no retry or rollback; see ADR-0013. |

### Implementation scenarios

| Scenario | Expected behavior |
| --- | --- |
| Local proposal plus published result | Exactly one handoff commit, recorded in the journal with its archived patch; the next review names that candidate explicitly. |
| Accept with a result only | No commit unless the project keeps a tracked log; no artificial new proposal or metadata review loop. |
| Peer accepts and improves | Incoming candidate accepted; new edits still require peer review. |
| Objection with a result only | No commit; accepted baseline not advanced; reason available to the author. |
| Correction after objection | Review covers the revised proposal against the last accepted baseline, not only the repair commit. |
| Reviewer-only participant edits a test or config file | Role violation, even outside application source. |
| Optional advice on an accepted proposal | No forced revision loop. |
| Worker revises after actionable objection | Same roles; revised candidate returns to the reviewer. |
| Send with continuation preference on | No automatic successor. |
| Send & review with later continuation off | Initial review occurs; later cycles need a manual action. |
| Report-only `work` result after Send & review | No commit and no review scheduled; chain ends or waits; `acceptedSha` unchanged. |
| Empty Review/Relay context | Reviews the assigned incoming revision; nothing inferred from terminal state. |
| Two overlapping selected/saved groups in a workspace | The frozen phase group bound to the run controls routing; creation order and discovery order do not. |
| Two browsers see the same publication; browser switches project, locks, or disconnects | One successor; policy and consumption independent of the viewing selection. |
| Commit-relay manual handoff | Advances without a recovery takeover; the deprecated mode remains unchanged. |
| Role change during an active turn | New policy waits for a boundary; old permissions govern that turn. |
| More than 30 unrelated recent commands | Active execution still tracked. |
| Worker interrupted or publication incomplete | No fabricated entry; no replay. |
| Restart after publication but before observation | Published result recovered without double execution. |
| Missing, malformed or identity-mismatched result; empty commit; extra commit; tracked-log tampering, mirrored line differing from the result, or a report-only turn without the required mirrored commit | Refused or paused for reconciliation; nothing invalid enters the journal; no force-push or hidden rebase. |
| Entry `parent` differs from the commit's actual parent | Lineage mismatch; publication refused as competing. |
| Journal baseline for Relay | The newest first-parent commit at which the journal records the recipient's completed turn; merged side branches, hand-committed tracked-log lines and other agents' entries never advance it. |
| History export and pre-removal archive | Export returns every run, turn and journal record for a worktree or all; older publications are backfilled at startup; worktree removal archives unarchived handoff commits first and skips commits already gone. |
| Handoff commit published but staged, unstaged, or non-ignored untracked work remains | Leftover digest is nonempty; run pauses and names the paths. |
| Final `RELAY-OUTCOME` line contradicts the published result | Inconsistent turn; pause; the prose never wins. |
| Source hook notification lost | Artifact can be rediscovered; no ownership transfer until equivalent correlated lifecycle evidence or explicit human reconciliation is available. The required evidence is not tied to one vendor transport. |
| Commit exists but another writer is active | Snapshot existence is not safe ownership transfer. |
| Uncommitted (deprecated) run active on a worktree | A commit-relay run on the same index is refused until it is reconciled or taken over. |
| Task starts in commit relay with a dirty worktree | Refused with the paths shown; nothing staged, stashed, reset, committed, or discarded. |
| Remote worker receives the task | Fetches exact committed code (and the tracked log when the project keeps one) without shared paths or index; journal transfer remains future work. |
| No PR configured | Local and remote publication still operate. |

Planning and transition scenarios:

| Scenario | Expected behavior |
| --- | --- |
| User starts directly in Implementation | No forced planning step, placeholder drafts, or fabricated approval. |
| Dirty project at Plan entry | Paths explained; refused until resolved; no automatic stash/reset/commit. |
| A project writer is already active | None of the selected planning roster is launched into that owned workspace. |
| Draft path not ignored, or already tracked, at Plan entry | Refuse to dispatch and report the setup mismatch; the controller writes no ignore rule. |
| Draft path or an existing parent is a symlink, special file, or resolves outside the run's plan directory | Refuse before dispatch or capture; an assigned path is not authority to write through it. |
| The data directory's `plans` root is a link, or resolves inside the bound checkout (for example to an ignored directory) | Refuse at Start before any terminal delivery, and at capture if swapped in mid-run, keeping ownership. |
| Agent labels similar or containing path characters | Registry-derived safe IDs map to distinct controller-assigned files. |
| Draft file appears but no completed result exists | Incomplete; no premature cross-review. |
| Draft file exists but the turn ended without `PLAN-OUTCOME: complete` | Assignment incomplete; barrier closed. |
| First agent finishes earlier | Its new result remains withheld from all unfinished required planners until the complete-roster barrier opens. |
| One of N planners fails or is interrupted | Partial work preserved; its required slot remains incomplete; no automatic reduction to N-1. |
| Duplicate completion from one planner | Cannot fill another required slot, increase the completion cardinality, or create multiple synthesis actions. |
| Planning turn edits a project file, the index, or a tracked log | Project digest differs at completion; run pauses and names the paths. |
| Another active planner changes its own draft before A completes | Allowed under that assignment; does not create a false violation at A's completion. |
| A finalized or unassigned draft changes | Invalidate the affected result or pause; do not silently attribute the change to the completing agent. |
| A is observed writing B's draft through a mediated output path | Refuse the write or pause under the explicit path permission; snapshots alone do not prove attribution when B is also active. |
| Human types guidance directly into a planner's pane | Uncorrelated start pauses the run; guidance goes through the controller. |
| N draft assignments with a concurrency cap smaller than N | Exact per-assignment delivery; no more than the cap active, while the barrier still requires all N results. |
| All N required drafts finalize for current inputs | Originals frozen; exactly one synthesis; one unified-plan writer thereafter. |
| Plan unchanged with no explicit accept | Not agreement. |
| N=2: author recommends v3 and peer accepts v3 unchanged | Agreement on v3, subject to the checkpoint; task not complete. |
| N=3: A recommends v3 and B accepts, while C has not reviewed | Endorsements 2/3; no automatic agreement. |
| C changes v3 to v4 | Only C's explicit recommendation counts for v4; A and B must review v4. |
| Reviewer edits v3 to v4 | Previous endorsement does not apply to v4. |
| Plan objection with no edits | Reason and findings recorded; the unchanged file is not acceptance. |
| Refinement limit or oscillation | Pause/escalate; no forced agreement. |
| Human changes the shared brief | All required planners receive the revision at a boundary; stale drafts and endorsements do not satisfy current barriers. |
| Human submits agent-specific guidance while its planner is active | Guidance is visibly queued for the next boundary; no second prompt is injected into the active source turn. |
| Project baseline changes during planning | Reconcile before refinement or implementation. |
| Native CLI cannot write the assigned path, or offers to start implementation | Use supported capture or expose the limitation; the phase checkpoint cannot be bypassed. |
| Agreement with approval required | Wait; no code work. |
| Agreement, automatic collaboration on, approval off | Frozen authorized plan; implementation starts exactly once if all checks pass. |
| Approval off but automatic collaboration off | Await manual continuation. |
| Unresolved blocker with approval off | No automatic transition. |
| Human proceeds despite disagreement | Override and remaining objections recorded. |
| Plan changes after being displayed for approval | Stale approval rejected or new version reviewed. |
| Two devices approve or observe agreement together; browser closes while approval is required | One transition and one implementation start; checkpoint persists with no implicit consent. |
| Drafts cleaned up after transition | Frozen final text and authorization remain available. |
| Remote worker fetches implementation commits | Final-plan content supplied explicitly. |
| Return to planning from in-progress code | Writers settled and explicit reconciliation; no silent reset. |

Solo planning additionally tests one captured recommendation, optional promotion to the unified file, no unnecessary synthesis call, visible non-independent plan-ready status, both approval settings, no imaginary second completion, and no infinite self-review loop. Solo code output and optional self-review never count as independent acceptance merely because an event was recorded.

Additional multi-agent and adapter scenarios:

| Scenario | Expected behavior |
| --- | --- |
| Later 3+ planning capability enabled, including a Gemini-backed instance | N independent assignments and distinct outputs, one unified plan, no new workspace or supervisor; initial release otherwise requires selecting at most two. |
| Two registrations alias one live pane/session | Refused as distinct concurrent planners; aliases are not independent required results. |
| Agent label is `plan`, contains separators, or collides case-insensitively | Safe prefixed mapping has no collision with plan.md; unsafe or ambiguous paths are refused. |
| Same CLI/model used by multiple legitimate instances | Instances remain distinct; model metadata never serves as the assignment key. |
| Gemini event lacks Claude-only fields | Correct adapter applies its verified contract; fields are neither fabricated nor demanded from the wrong vendor. |
| Gemini completion cannot establish safe handoff evidence | Visible unsupported/unknown state; no automatic activity-clear claim. |
| Native planner can write only its own plans directory | Supported adapter capture or narrowly authorized output mapping; no broad project-write grant. |
| Native approval action would start coding early | Not approved before the app-level authorization gate. |
| One rejected or quota-limited planner is still required | Group waits or a human explicitly revises roster; no majority shortcut. |
| Human removes or replaces a planner | Settle its execution, record roster revision, invalidate stale transition/approval, preserve old evidence. |
| Old callback arrives after retry or registration replacement | Reject or retain as history; cannot satisfy the new assignment. |
| Plan returns to older text after further edits | Earlier-version/epoch approval is not resurrected merely by a matching hash. |
| Existing guidance is queued when all original drafts finish | Current required updates are resolved before synthesis; queue is not lost at the barrier. |
| Large roster exceeds configured planning budget | Warn/refuse or request deliberate budget change; no silently skipped reviewers. |
| Three planners converge, two chosen for Implementation | Only the implementation group receives code turns; all planning endorsements remain in history. |
| Auto-approved transition consumes a stale roster or brief | Refused; exact current versions are required. |
| Two tabs alter settings or approve simultaneously | One authoritative policy revision and transition; no double start. |
| Controller sees an extra unpublished commit during a first-release turn | Parent/single-commit contract violation; no hidden squash/reset. |

Automated fixtures, mock tmux tests, real tmux tests, installed-agent tests, and physical iPhone/Tailscale tests are reported separately; passing one category does not imply the others.

### Result-transport interpretation

Scenarios naming `PLAN-OUTCOME` assume the final-line transport. [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md#result-channel-and-stable-capture) also permits an equivalent correlated structured helper. Under that explicit adapter choice, test the same required identity, decision, findings, content, and lifecycle evidence rather than requiring both transports. A missing valid result is always incomplete.

## Fixture reliability follow-ups

Source inspection at `13283632c826e462768bfdbecc0cfbc1e265c4c5` supports two
focused investigations from the [next-step source](SOURCES.md#september-30-next-step-design-source).
These are not tests executed for the documentation integration or proof that all
historical failures share one cause.

- [projects.test.ts](../web/scripts/projects.test.ts) passes fixture identity as
  invocation-local `git -c` options, whereas [projects.ts](../web/src/server/projects.ts)
  independently checks `git var GIT_COMMITTER_IDENT`. Recommend local identity in
  each disposable repository that application Git touches, isolated from the real
  home/global configuration. Preserve the production identity check and test the
  actual application invocation, not only the fixture helper.
- [native-launch.test.ts](../web/scripts/native-launch.test.ts) starts two workers
  with one PID-file path, reads that file and checks descendant/survivor evidence
  for the first session. This supports a race hypothesis, not a reproduction here.
  Recommend per-instance PID evidence and repeated private-socket runs; keep the
  descendant assertion and inspect any remaining failures.

Historical CI/provider results retain their original provenance. Exact counts
are not copied here as current health. Future repairs must record the commands,
environment and actual outcomes, rather than weakening checks to obtain a pass.

## Proposed app-wide assistance and completion checks

**Planned requirements; no results are claimed by this catalog.** Only Global AI's
A1 read increment is implemented; its fixture checks and their limits are listed in
[GLOBAL-AI](GLOBAL-AI.md#storage-rollout-and-tests), and installed-provider acceptance
remains open. [ADR-0022](adr/ADR-0022-app-wide-ai-instances.md) and
[ADR-0023](adr/ADR-0023-app-tools-and-delegated-authority.md) own the proposed
design. Source scenario IDs below are provenance, not names of existing tests;
related rows are condensed without replacing current native/workflow coverage.

| Source scenarios | Trigger and expected behavior |
| --- | --- |
| NB01 | In an isolated home/repository, application Git calls obtain fixture identity without the owner's global config. |
| NB02 | Repeated two-worker launches retain PID/descendant evidence for the intended instance; neither overwrites the other's record. |
| NB03–NB06, NG05 | Multiple app writers, including the same pane, may coexist. Duplicate/conflicting sequences cannot duplicate bytes; losing one writer neither revokes another silently nor replays input. Manual input holds conflicting automated dispatch. Current Terminal/Display acquisition replaces old first-key/exclusive-writer expectations. |
| NB07 | Changing cards/views preserves target drafts and revokes stale readiness under the current linked selection model. No old confirmation sends to a new recipient; any redesigned selection policy needs separate expectations. |
| NB08, NG01, NG09 | A supported Global AI instance starts without a dummy project. Its exact startup launch can expose login/trust/model prompts through scoped browser access while retaining reservations and truthful needs-attention; no fake readiness or automatic permission bypass. |
| NB09 | Navigation into a session with incompatible lifetime settings, including destroy-unattached, has tested warning/refusal or documented native consequences; never promise survival without evidence. |
| NG02–NG04 | The same profile used for both roles creates distinct sessions/conversations. Background jobs never enter the user prompt; settings changed during a job do not rewrite attribution. |
| NG06–NG08 | Read-only inspection changes no job. Human manipulation invalidates/reconciles provenance. Host restart rebinds exact surviving instances, rejects old credentials/claims and avoids duplicate runners. |
| NG10 | Exact infrastructure identity excludes app agents from automatic group membership without hiding real project-writing effects or excluding all processes by name. |
| NM01–NM02, NM08 | Answers distinguish current capabilities/state from old ADRs; report uncertainty and detect changed tool/document versions rather than recommending unavailable features. |
| NM03–NM04 | Workspace changes do not retarget in-flight tools; out-of-scope project reads are refused or need an owner-authorized scope change. |
| NM05, NM07 | Instruction-like tool content and forged actor/policy/approval fields cannot alter authenticated principal or authority. |
| NM06, NM10 | Helpers reach one host-owned controller/database. A read-only tool scope gains no hidden shell or direct database-write route. |
| NM09, NA05 | Private preferences/images are shared only with the explicitly scoped conversation/job; neither another project nor the other app role receives them automatically. |
| ND01, ND11 | A valid standing delegation can resolve an eligible judgment without redundant per-action approval. Already-authorized deterministic progression needs no model gate. |
| ND02, ND08, ND12 | Human-only Plan approval remains human-only. Explicit delegated risk authority is recorded truthfully and never fabricates inspection/known idle; an assistant cannot broaden its own policy. |
| ND03–ND04 | Policy revocation or changed branch/plan/roster/action invalidates an assessment before effect admission. |
| ND05–ND06 | Identical retries inspect/return one operation; changed payloads conflict. A lost response after possible mutation remains uncertain and is not replayed. |
| ND07, ND09–ND10 | Insufficient completion evidence remains insufficient. Unsupported native permission prompts surface for human interaction; tool mutations cannot bypass manual/launch/workflow barriers. |
| NJ01–NJ03 | Unchanged polls create no repeated jobs, related events deduplicate/batch, and causation/depth/rate limits prevent self-triggering loops. |
| NJ04–NJ06 | Time/tool limits stop new admission while preserving possible effects. Quota/login failure is visible; unavailable allowance stays unknown, with no silent paid fallback. |
| NJ07–NJ09 | Important baseline notifications survive model failure. Delivery uses deduplication/receipts and truthful uncertainty; changed destinations cannot silently redirect old private content. |
| NB10, NJ10–NJ12 | Lock/phone suspension differs from pausing or stopping background work. Pause stops new jobs, not already admitted effects. Disabling AI preserves deterministic recovery; cooperative restrictions are never called a sandbox. |
| NA01, NA08 | Drop uses the existing bounded upload path and exact destination. Late upload/insert responses after context changes never write to another prompt; explicit fresh insertion is needed. |
| NA02 | Direct API bytes that pass structural checks but cannot decode produce behavior matching the explicitly adopted server-validation contract. |
| NA03–NA04, NA06 | Full storage explains retaining references and permits only eligible release; active/uncertain content is not evicted. Deletion cannot retract provider copies, and changed image bytes hold dispatch rather than substitute data. |
| NA07 | Physical iPhone Safari over private HTTPS/WSS exercises IME, viewport, picker/paste, suspension/reconnect and concurrent desktop input; viewport emulation is not this acceptance. |

Before effectful release, record exact commit, OS/Node/tmux/library versions,
CLI/model/auth and permission modes, commands and outcomes for scoped live help,
separate background work, delegated/stale decisions, startup recovery, quota
failure, concurrent input and physical-device operation. Fixtures, private tmux,
installed providers and physical devices are separate layers. See the
[roadmap gates](../ROADMAP.md#proposed-app-wide-assistance-and-completion-work);
document checks alone do not satisfy them.
