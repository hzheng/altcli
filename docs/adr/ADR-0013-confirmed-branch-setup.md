# ADR-0013: Confirmed branch and task-worktree setup

> September 24 extension: ADR-0021 separately permits confirmed session launching in an existing or newly ready checkout. It does not combine branch/worktree consent, copy dirty source files or prepare environments.
>
> September 25 extension: [Confirmed closing of launched sessions](#confirmed-closing-of-launched-sessions) adds a fifth, narrow end-of-task exception: **Finish branch** closes only the tmux sessions AltCLI itself launched for a linked task worktree, then hands over to the existing removal or discard.
>
> September 27 extension: `main` is always an integration name, because it runs Stage relay ([ADR-0014](ADR-0014-commit-relay-and-deprecation.md#branch-scoped-stage-relay-september-27-2026)); this is implemented. [Reusable task worktrees](#reusable-task-worktrees-update-rename-and-move) accepts three more narrow exceptions. Update from main, including replay of unintegrated commits, and branch rename are implemented, and so are Rebase onto main and Reset to main (September 28); directory move is accepted design, **not implemented**.


Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Implementation update: local branch consent is now stored with the run's group,
canonical worktree/index, observed branch and full starting SHA, and optional new
name. Setup moves durably through pending/applying/ready or uncertain under the
same execution owner. Only the caller claiming pending setup may execute
`git switch -c`; hooks are disabled for this setup operation to avoid unrelated
hook side effects. There is no retry or rollback after an ambiguous result.
Known primary metadata comes from local `origin/HEAD`, without a fetch. Unknown
primary metadata requires an explicit choice. Every Start confirms the displayed
checkout and that selected/unselected writers are settled. This is cooperative
same-user control, not OS isolation. Installed-host acceptance remains pending.

Relationship: The read-only-controller setup restriction in ADR-0003 and ADR-0011, solely for the future operation defined here.

## Context

The workspace may be on a primary branch or detached HEAD. A small confirmed setup operation is useful without making AltCLI a worktree or environment manager.

## Decision

### Branch behavior at workspace setup

Inspect the branch **currently checked out in this worktree**. Other local/remote branches existing in the repository do not determine the current task's branch.

| Checked-out state | UI and permitted action |
| --- | --- |
| Non-integration named branch | Display and reuse it by default; the user can explicitly request a new task branch. Do not auto-switch to another existing branch. |
| The default branch or a configured integration branch | Offer only a new task branch with an editable name, here or as a task worktree. There is no continue-on-this-branch option; the server refuses it as well. |
| Detached HEAD at a valid commit | Offer confirmed new named-branch creation at that commit, or ask the user to check out a branch and Recheck. Do not pretend it is main. |
| Unknown branch state, missing baseline, or failed Git inspection | Block commit implementation with an explanation; do not guess, initialize history, or repair automatically. |

Do not hard-code `main` as the only integration name. The integration set is the repository default branch as recorded locally in `origin/HEAD`, literal `main` (since September 27, 2026, because `main` runs Stage relay even when the configured list omits it), and the host's `ALTCLI_INTEGRATION_BRANCHES` list (default `main,master`). Keep the actual checked-out name visible. If default-branch information is unavailable, the configured list still applies and the picker says no default is recorded, rather than classifying the checkout as a safe task branch by accident. Exact default-source and fallback detection remain implementation details, not an excuse for automatic network or configuration writes.

One implementation branch is recorded per run segment, and it is always a task branch: integration branches are starting points, never implementation branches, so intermediate work and review commits stay off them. Verified initial input, lineage, group ownership, ordinary permissions and final verification still apply. No PR is required and no automatic merge follows. The branch belongs to the workspace checkout, not to an individual agent or group object.

### Integration branches are starting points

The task flow is: select a project and a base branch or commit, usually the default branch; create a task branch and worktree (or a task branch at the same HEAD in the existing checkout); record that exact starting commit as the task's permanent baseline; run implementation and review rounds there; integrate the accepted result through a separate, explicit merge or pull request. Because an ordinary merge carries every review-round commit across, **squash integration is the recommended completion path** when a clean integration history is the goal. Since September 20, 2026 the app offers that one step as a separate confirmed operation ([Confirmed squash integration](#confirmed-squash-integration)); it never runs as a consequence of task completion.

The restriction applies to the repository's default branch and every configured integration branch, not just the literal name `main`, and is enforced on the server (`INTEGRATION_BRANCH`) as well as in the picker. An integration branch still appears in the project view for inspection and as a creation base; selecting it for implementation leads to the new-task-branch or task-worktree path. A new branch may not take an integration name either.

For an **existing task branch** the app records a confirmed baseline instead of guessing where the task began. Discovery reports `taskBase`: the head itself when no commit lies beyond an integration tip, the single nearest merge base with the local or origin integration tips when they agree, and null when they diverge. Start accepts `branch.taskBase`, requires it when nothing can be inferred (`BASELINE_REQUIRED`), and checks that it is the head or one of its ancestors (`INVALID_BASELINE`). A new branch begins at the confirmed head. The task baseline (`taskBaseSha`) and each round's review range (`acceptedSha` to `candidateSha`) are distinct and both are recorded; an explicit existing-candidate review must start at or after the task baseline.

### Narrow, explicitly confirmed create-and-checkout operation

**This is the existing-checkout Git-write authority.** After explicit user confirmation, create and check out a new named branch at the validated current commit. An ordinary create-and-switch operation such as `git switch -c <new-name> <validated-current-SHA>` is the intended shape; never use reset/force variants, and validate branch names and command arguments before execution. For the initial work turn, Commit may preserve captured unfinished changes at that same commit; other starts require a clean checkout. The separate task-worktree authority below never copies dirty source changes.

Record the user's chosen name, workspace/worktree/index identity, observed current branch/detached state, starting SHA, operation identity, and consent. The consent may be collected in the initial setup form, but it applies only to that checked state. If the baseline, checkout, or requested name changes before execution, stop for a fresh decision; do not silently rebase the approval onto a different branch.

Before mutation, establish that:

- The new workflow has exclusive setup control of the underlying worktree; no other run or active planner/implementer is using it.
- Every affected selected and relevant unselected agent has settled, or the user has explicitly reconciled uncertain external activity. Never switch underneath active planners merely because their drafts are ignored.
- The canonical paths/instance bindings and current commit still match the consent, and the index/nonignored worktree is clean or exactly matches the captured unfinished input of the first work turn (ADR-0014).
- The requested name is valid and does not collide with an existing branch. Existing branch/path conflicts are errors; do not reset or overwrite them.

Afterward verify the actual named branch, unchanged starting commit, and unchanged captured input (or clean state) before implementation dispatch. If the operation's result is uncertain, record the uncertainty and inspect/reconcile; do not blindly repeat it or issue a destructive rollback. Concurrent confirmations must produce one authorized setup transition. A fresh live state, not a reused stale UI card, is the basis for the check.

The create-and-checkout permission does **not** authorize existing-branch switching, unconfirmed worktree removal, stash, reset, clean, add/commit, merge, rebase, force-push, branch deletion, editing `.gitignore`, or changing global/local Git configuration. Agents or their authorized commit helper still publish implementation turns. Worktree creation, removal, squash integration and discard each require their own consent below.

### Explicit task-worktree creation

The project view may offer **Create task worktree** before choosing agents or starting either phase. The user chooses an existing source checkout and a new task branch. A read-only preview returns the source worktree/index identity, source branch or detached state, full committed HEAD and destination. Default placement is `~/.altcli/<repo-name>/<branch-name>`; separate same-named clones get distinct namespaces. Branch slashes create nested directories. Names and path components are checked, symlink indirection below the task root and checkout/metadata overlap are refused, and existing destinations are never adopted or overwritten.

Confirmation authorizes one non-force `git worktree add --no-track -b <new-branch> -- <destination> <exact-SHA>`, with hooks disabled and no submodule recursion. It does not switch the source checkout. A dirty or active source does not itself block creating an independent checkout from the confirmed immutable commit: staged, unstaged, untracked, ignored and environment files remain in the source. Source identity, branch and HEAD are rechecked immediately before creation; a changed observation requires fresh consent. Plan and existing-candidate review require clean entry in their selected worktree; initial work follows the captured-input contract in ADR-0014.

Persist the exact confirmation and request ID before invoking Git. A project-scoped setup owner serializes creation; task execution locks remain scoped to individual indexes and independent tasks are not globally locked. Identical requests return their existing result; an ID with different inputs conflicts. Verify the new worktree's common directory, branch, exact HEAD and clean state before recording success. Creation remembers the project so the new agentless worktree remains visible after restart.

An attempted Git operation or verification failure is **uncertain**, not automatically retried or rolled back. Restart converts applying setup to uncertain. While applying/uncertain, the destination refuses agent binding/configuration and new runs; this does not lock tasks on other indexes. Explicit **Inspect creation result** performs only read-only Git/filesystem checks: an exact clean result becomes ready; verified absence of the destination, Git worktree entry and branch becomes failed and releases setup; partial, changed or unreadable results retain ownership for human reconciliation. Never delete directories or branches to repair a failed creation. Pre-Git failures may leave newly created empty parent directories; these are not automatically removed.

This operation requires host input enabled and the normal bearer/origin gates. A new worktree has no agents: no tmux launch, relocation, environment installation, secret copying, ignore-rule editing, cleanup or run dispatch is implied. It is cooperative same-user control, not a filesystem sandbox or protection against malicious path races. Removal has the separate, confirmed authority below.

### Confirmed removal after integration

User requirement, September 20, 2026: Projects supports removing an unused linked
worktree after its task branch has reached local main (or the locally recorded
default when main is absent). This is a separate narrow Git-write exception.
It never runs as a consequence of discovery, task completion or a merge.

A read-only preview requires a named non-integration branch, an accessible linked
checkout, no hidden index flags, and no modified or nonignored untracked files.
Ignored files do not block removal. Confirmation warns that ignored local
environment files, dependencies and generated output will also be deleted.
No tmux pane (including shells and unselected agents), run owner, unresolved
delivery, or uncertain setup may use the checkout. Missing inspection evidence
blocks the operation. Users preserve local environment files and move panes
themselves; exclusion from a group is not proof a checkout is unused.

Integration evidence is either exact commit ancestry or an exact binary/full-index
diff match between the branch's combined changes from its single merge base and
one single-parent commit among the latest 500 first-parent main/default commits
since that base. This detects a multi-commit task squashed into one commit without
trusting commit messages or authors. Conflict-resolution edits, larger history,
or nonidentical patches can produce a conservative refusal. No fetch, merge or
branch deletion is implied, and the task branch and all historical runs are kept.

The confirmation pins project/worktree/index identity, branch, HEAD, target ref
and HEAD, integration evidence and request ID. Persist a project setup owner,
revalidate live occupancy and exact Git evidence, then execute only non-force
`git worktree remove -- <path>` with hooks disabled. Refuse the main checkout,
integration branches, controller-data overlap, and a checkout that the host's
installed AltCLI hook commands or skill links still point into (read from the
CLIs' user configuration, never edited: the installers own it and only install
from the main checkout). Never delete files directly or
use force, prune, reset or automatic cleanup. This remains cooperative same-user
control; external processes are not isolated by an OS filesystem lock.

Duplicate requests return the recorded result. Restart or an ambiguous Git result
retains ownership as uncertain and never retries. Read-only inspection can verify
absence of both checkout and Git worktree entry, or release a failed attempt when
the exact original clean state is still present; all other results stay uncertain.
Successful removal clears only that checkout's saved configuration, retaining its
branch, commits and workflow history. SQLite v8 prevents older servers from
ignoring a removal owner. Installed-host deletion acceptance remains separate.

### Confirmed squash integration

User requirement, September 20, 2026: each linked task worktree in Projects
offers **Squash into main**, so the recommended completion path can be taken from
the app instead of a hand-typed merge. This is a third narrow Git-write
exception, scoped to one commit on the integration branch. It never runs as a
consequence of discovery, task completion, review acceptance or removal.

A read-only preview requires a named non-integration task branch in an accessible
linked worktree; the integration branch (local `main`, else the recorded default)
checked out in a different accessible worktree that is clean, at the branch's
tip, with a Git committer identity; a single merge base; and a conflict-free
`git merge-tree --write-tree` result whose tree differs from the target tree. It
reports the merge base, the commits being squashed (newest first, at most 100
listed), the merged tree, a default commit message and the exact commands. Dirty
task-worktree changes are reported, not squashed. An already-integrated branch is
pointed at Check removal. Run or delivery ownership of either checkout refuses the
preview. Every agent pane in both checkouts, including subdirectories and unselected agents, must have a
verified current CLI, settled native turn evidence and a fresh process scan with no task processes.
Unknown evidence, active background work, unsupported processes and status acknowledgements alone
refuse squash. Codex's native Ready/Idle still needs the process scan; Claude also needs an explicit
clear background report. A shell pane is permitted only when its root shell is the observed foreground
process and no task processes remain under or attached to its terminal. Claude's exact bounded
`caffeinate -i -t 300` sleep-prevention helper is excluded using transient argument evidence; children
and other invocations remain work. Pane identity, occupancy and lifecycle changes during inspection refuse it.
AltCLI's own server pane is also permitted when fresh PID ancestry proves it contains the running backend,
with only shell/npm launch ancestors and a foreground process on that chain. A process named `node` alone
is insufficient. Every other descendant or terminal-attached process, including backend children, remains
work; only the exact completed `ps` inspection is omitted. When all remaining processes are direct children
of the verified backend, each guard scan waits up to 500 ms for a clear scan, rechecking every 25 ms. This
lets concurrent state/discovery inspection subprocesses exit; no process is exempted by its command name.
Persistent children, descendants beyond those direct children and other terminal-attached processes still
refuse squash. The host chain and writer scan are checked twice; unreadable evidence, a changed foreground
or a changed launch chain refuses squash even during the wait. This exception does not permit worktree removal while
the server or any other pane is inside it.
These checks repeat before staging and before committing. A failure after staging keeps the operation
uncertain. Exact parent/tree/cleanliness verification establishes completion; later activity cannot turn
that verified squash back into an uncertain operation. Read-only inspection checks settled writers before
inspecting Git; after finding the verified historical commit, it records completion without a later activity
gate. Releasing an attempt without that commit still requires a second writer check.
One lifecycle revision spans each request up to its final applicable writer check, so even a native turn
that starts and finishes between those checks invalidates it.
This is cooperative same-user inspection, not OS isolation from external writers.
September 29, at the owner's direction: when these activity checks are the only refusal, the human may
acknowledge that agents or processes in either checkout may still be working and preview and confirm the
squash anyway. The request carries `acknowledgeActivity: true`; the pinned preview records it, so its consent
digest covers it and a confirmation without it no longer matches. It skips only the settled-writer evidence
at preview, staging, commit and inspection; run and delivery ownership, cleanliness, conflicts, the pinned
tree and the manual-input hold still apply. The confirmation says that a concurrent edit in the integration
checkout can end up in the commit, stay uncommitted or make the squash fail.

User requirement, September 21, 2026: squash can run in multiple explicitly
confirmed batches. The user selects an inclusive **through commit** (a SHA on
the task branch, default HEAD) and edits the resulting commit message. The
preview pins the selected endpoint separately from the current task HEAD;
changing either endpoint or branch tip requires fresh consent. The first batch
starts at the unique common merge base. Later batches start after the source
endpoint of the latest recorded, verified squash, whose commit must still be
an ancestor of the integration tip, with its source endpoint still an ancestor
of the task HEAD. Inapplicable or unreadable checkpoints fall back to the unique
current merge base and a fresh full-range preview; removal can still use its
independent ancestry or exact-patch evidence. Each batch creates one
single-parent commit and leaves both later task commits and the source checkout
untouched. These boundaries survive restart in the existing integration records;
SQLite v11 prevents older servers from treating partial batches as full-branch
integration. Pre-batch records are interpreted as having integrated their HEAD.
Confirmed removal or discard (including successful inspection of an uncertain
result) atomically retires that worktree's checkpoints while retaining their
results for history and duplicate requests. A recreated worktree cannot inherit
those boundaries. SQLite v12 prevents older servers from reusing retired records.

[Git 2.40 or newer](https://git-scm.com/docs/git-merge-tree/2.40.0) computes
the three-way result using the explicit batch base (`git merge-tree --merge-base=<base>`). This preserves intervening main changes
without replaying previously integrated changes. Before inspecting checkout status or calculating that result,
squash preview reads effective Git configuration (including includes and worktree configuration). It refuses
configured external merge drivers, even unused definitions, and attributes selecting configured clean, smudge or
process filters. Git resolves attributes from the checkout, index and each merge input tree, including nested,
macro and host-local attributes. Unused filter definitions such as global Git LFS defaults remain allowed; a repository whose attributes select one,
such as a repository that stores files in Git LFS, is refused (an open choice in OPEN-DECISIONS).
Correction after the September 27 review: this refusal is scoped to squash. Ordinary discovery, clean-entry,
publication and worktree lifecycle checks use normal Git status semantics, including configured filters
and filesystem monitors. They do not refuse LFS repositories or scan all attributes before each status read.
The public squash endpoint's discovery refresh has those same semantics; it is not a command-free sandbox.
Squash's own status/merge reads preflight initialized submodules recursively and refuse external
filesystem-monitor hooks. Inventory reads do not invoke those monitors. Confirmation and uncertain-result
inspection repeat the scoped preflight; AltCLI does not disable drivers or filters or change Git configuration.
The preview can create unreachable Git objects, but changes no ref, index or checkout file.
The exact result is staged
through `git diff --binary` piped directly to `git apply --index --binary`, with
argument arrays and both processes awaited, then committed under normal hooks.
This also refuses ignored files that obstruct incoming paths instead of deleting
them. Final tree/parent/cleanliness verification and uncertain-owner handling
remain mandatory. Clean-worktree removal can use the verified batch history only
when its latest source endpoint equals the current task HEAD.

The UI shows a visible, accessible explanation whenever squash is blocked,
including host read-only mode, a pending request, discovery errors, detached
HEAD, run/delivery ownership, unresolved worktree operations, stale previews and
invalid messages. Removal and Discard explain hard blocks on click (read-only
host, a request in flight, unreadable discovery or worktree state, a pending
operation); a known occupant, run or delivery owner is shown as a hint beside
them and the click still runs the server preview, whose exact refusal (pane
inside the checkout, dirty files, no integration evidence) is then displayed
(September 21, 2026 update: previously any agent pane silently disabled them).
Git checks remain authoritative and their rejection messages appear beside the
preview controls. Selecting another SHA clears the old preview and message
consent; the browser never starts a batch automatically.

All eight Main/Branch entry buttons stay enabled: Squash, Update, Rebase, Reset,
Rename, Finish branch, Check removal and Discard. Clicking while blocked shows
the current reason, including the owning run's explanation and the Console →
Control access recovery path. A pending or unknown response is explained without
sending another request or replacing the saved request to inspect. Finish branch
stays visible while its operation is held. Preview and confirmation gates still apply.
When the explanation is already displayed, a blocked click focuses that notice
instead of adding a duplicate under the action. Repeated clicks across actions
reuse the same shared notice.

The preview carries a consent digest of every pinned field (project/worktree
identities, branch, HEAD, selected endpoint, previous squash, target ref and HEAD, batch base, commit list, merged
tree, commands). The confirmation is compact: request ID, that digest and the
final editable commit message. One sizing policy governs the message: at most
8 KiB once JSON-encoded (escapes count), which together with the bounded
identifiers keeps every accepted request inside the 16 KiB limit however many
commits the preview listed, and the generated default message is built to that
same budget (oldest listed subjects first, over-long subjects shortened, the
list cut with a count of omitted commits) so a long history confirms unedited.
The server re-derives the preview and refuses a changed digest before claiming
anything. The durable record is the
re-derived preview with the confirmed message. Persist a project setup owner,
revalidate the digest and ownership, stage the exact previewed tree with a streamed
binary diff from the pinned target HEAD and `git apply --index --binary`, followed by
`git commit -m <message>` in the integration checkout, under the repository's
normal hook policy: only handoff commits bypass hooks, final integration does
not. Success is exactly one new single-parent commit on the previous tip whose
tree equals the previewed merged tree, with the checkout clean. The task branch
and worktree are unchanged; Check removal then verifies the squash. Duplicate
requests return the recorded result; a different message under the same request
ID conflicts.

Restart or any failure after Git started retains an uncertain owner. A rejecting
hook is the typical case: the squash is staged but not committed, and inspection
keeps the operation uncertain while that checkout is dirty, until the human
commits or resets it. A clean integration checkout settles the operation on
inspection: the previewed commit (single parent at the pinned tip, the previewed
tree) anywhere on the branch's first-parent chain since that tip completes it,
even under later commits; an unchanged tip releases it as failed; and a tip that
moved on without that commit, because the human integrated, reset or rewrote by
hand, releases it as failed too, since nothing is left to retry and a later
removal check or squash preview judges the current history on its own evidence
(September 21, 2026 update: previously such a record stayed uncertain and held
every lifecycle action on the project with no recovery path). No reset, abort,
retry or history rewrite is performed by the app. Remote publication remains
outside the app.

### Confirmed discard

User requirement, September 20, 2026: each linked task worktree also offers
**Discard…** for abandoned work. This is the fourth exception and the only one
that uses force: it removes the worktree and deletes its branch without
integration evidence. A read-only preview requires a named non-integration
branch in an accessible linked worktree with no tmux pane, run owner, unresolved
delivery, uncertain setup or installed hook/skill reference, and reports the commits absent from the integration
branch and the modified or nonignored untracked files that would be lost; neither
refuses the operation. Confirmation requires the branch name to be typed exactly
and warns that ignored files are deleted too and that the app cannot undo it.

The preview pins a fingerprint of the exact nonignored content (HEAD, index
entries, unstaged content, untracked file contents), so editing an already dirty
file after the preview is a change even when the file count is not. Persist a
project setup owner and the exact consent, revalidate the preview and occupancy,
archive every unarchived handoff commit of that worktree in the journal, recheck
the fingerprint once more after that archive step, then execute
`git worktree remove --force -- <path>` followed by
`git branch -D -- <branch>`. Verified absence of the directory, the Git worktree
entry and the branch records success and clears that checkout's saved
configuration; run history and the journal are retained. Restart or an ambiguous
result retains ownership as uncertain; inspection recognises complete absence or
the unchanged original and never retries. Every other finding is written into the
record's message rather than returned silently (September 21, 2026 update:
previously a discard interrupted between the two Git commands stayed uncertain
with no visible result and no recovery path). When inspection verifies that the
directory and the Git worktree entry are gone while the branch still sits at the
confirmed head, the record is marked `branchRemains` and the card offers
**Delete branch … and finish discard**: a separate confirmed step under the same
request ID that re-verifies that exact evidence live, takes the applying owner,
runs only `git branch -D`, and settles on verified absence. A moved branch, a
stale worktree entry or a still-present directory refuses the finish without
touching Git and stays uncertain for human inspection. Every discard record
write is a compare-and-set on the snapshot it was computed from, so an
inspection that overlaps a finish (or a finish that overlaps a restart) returns
the record that moved on instead of overwriting it. SQLite v10 prevents older
servers from ignoring an uncertain integration or discard owner.

### Confirmed closing of launched sessions

User requirement, September 25, 2026: finishing a task branch must not require typing in a
terminal. Each linked task worktree offers **Finish branch…**, which closes the tmux sessions
AltCLI launched there (ADR-0021) and can then continue with the existing confirmed removal
(branch kept) or discard (branch deleted, exact branch name typed in the app). This is the fifth
exception. It never runs automatically, merges nothing, and never closes anything else.

**Scope.** A session is closable only when a durable launch record for this exact worktree
matches the live server (pid, start time and socket), session ID and full-UUID `@altcli_launch`
marker; every current window and pane is enumerated and inside the worktree; and no window is
linked into another session. The pane process may differ from launch time (a restarted CLI is
shown with its current process evidence). Additional splits or windows are included only when
previewed and wholly in scope. Names, prefixes, shortened labels and directories alone never
prove ownership; a reused name is never adopted. Everything else is listed with its reason and
stays the user's to close; non-launched panes still block removal and discard as before.

**Preview.** A read-only preview lists each launched session with every pane: agent label,
activity, the pane's own process and every descendant or terminal-attached process with its
start time (known CLI helpers labelled, not dropped); other panes in the worktree; and Git
facts: exact task and main/default refs and tips, ahead/behind counts, uncommitted changes,
and integration classified as *integrated* (ancestry, verified squash checkpoint or exact
single-commit patch match, the removal evidence), *not proven*, or *inspection unavailable*.
Different tips alone never mean unmerged work. The server keeps the preview and a digest of the
safety-relevant evidence (identities, session scope, activity class, task processes,
occupancy, run ownership); the browser confirms by request ID, digest and acknowledgements.

**Gates.** Refused while the worktree's run is running or waiting (pause first; pause never
interrupts workers), while a delivery is planned, dispatching or uncertain, while any keyboard
or manual-input barrier is pending, while a launch reservation or another setup/Finish
operation owns the project, and for the main checkout or integration branches. Working or
unknown activity, or task processes beyond the CLI, require an explicit *stop these sessions
anyway* acknowledgement; it is termination consent, not a claim that work completed. Removal
additionally needs proven integration and a clean worktree.

**Execution.** The operation and its owner are persisted before any tmux command, in the same
transaction that rechecks the gates (SQLite v15 prevents older servers from ignoring it). The
evidence is recomputed and must match the digest; before each kill the exact session is
re-verified with fresh activity and worktree/branch identity, and a change or unavailable
inspection stops further mutation. Task commits and dirty content do not change session-stop
consent. A live pane without complete process identity evidence is not closable; an already
exited pane requires acknowledgement and keeps background effects unknown after closing, until
a recorded human inspection decision. Native observer connections to those
panes are closed first. Each session is persisted as possibly executed, then closed with
`kill-session -t <session ID>` (argument array, never `kill-server` or a name), and its absence
is verified on the original server; an unreachable or restarted server is not proof unless the
original server process is gone. Processes retained before the kill are checked afterwards by
PID and start time; survivors or missing evidence keep the owner. The launch record is retired,
its history kept.

**Paused runs and the Git step.** A paused run keeps ownership; sessions may close, nothing is
accepted or replayed, and removal or discard wait until the user takes the run over after
checking its writers stopped. The operation keeps the worktree's owner through applying,
uncertain, attention (survivors), awaiting-Git and Git states, so Start, continuation, setup,
launch and other end-of-task operations are refused meanwhile; keyboard acquisition waits only
while a step may be acting. The Git step shows a fresh removal or discard preview and runs that
existing operation as the finish's only admitted child, bound by request ID; an uncertain child
keeps the parent owner and is inspected by its own ID, never reissued. A recorded child's identity
also survives a thrown response. A restart before any child was recorded can return to the Git
preview: children reserve durably before mutation. Inspection stays available at the project
level after the worktree card disappears. Compare-and-set revisions keep overlapping confirm,
continue and inspect calls from acting twice. Ownership is
released only by verified success, a verified no-effect failure, an explicit stop before the Git
step, or a recorded human inspection decision after the session step's effects are
reconciled. Restart turns in-flight steps uncertain; inspection is read-only and never repeats a
kill or Git command.

### Reusable task worktrees: update, rename and move

User requirement, September 27, 2026 (Plan run with human-approved frozen plan, items P-2 and P-6 to P-15):
reuse a prepared linked task worktree after integration instead of removing and recreating it. These are
three more narrow Git-write exceptions for linked task worktrees only; primary checkouts are excluded. None
runs automatically. **Update from main (with replay) and Rename branch are implemented (September 27,
2026), and Rebase onto main and Reset to main (September 28, 2026); Move directory is accepted design,
not implemented.** Where the implementation narrows this design, the operation's section says so.

**Shared contract.**
- **Preview.** Read-only. It pins these facts in a consent digest: project and worktree identity; branch,
  HEAD and cleanliness; target ref and SHA, or the new name or path; integration evidence; every pane in the
  worktree and its subdirectories; upstream facts; obstruction findings; the recovery ref; and the exact
  commands. As implemented, Update's digest covers identity, branch, HEAD, target, boundary, replay steps
  and trees, the resulting tree, fast-forward and commands; Rename's whole preview, including the content
  fingerprint, is its consent. Panes are not pinned: Update, Rebase, Reset and Rename rely on the human's
  acknowledgment of concurrent agent risks (see objection 1).
  Upstream and obstruction facts are re-derived at confirmation, and the
  recovery ref is named from the confirmed request ID.
- **Confirmation.** Re-derives the preview and refuses any change.
- **Agent activity (September 28, 2026 user revision).** Update, Rebase, Reset and Rename show their consequences
  and proceed after one explicit confirmation. Missing or active native turns, human readiness acknowledgments,
  background processes and unavailable process evidence do not block preview, confirmation or inspection.
  The app does not stop agents. Update and Rebase advise ensuring nobody is actively editing in the branch
  directory and explain that code conflicts need manual resolution; conflicts leave the branch unchanged.
  Reset explicitly warns that uncommitted tracked work is permanently discarded and branch contents are
  replaced by main; untracked and ignored files remain, and the old tip stays under the recovery ref.
  Rename advises avoiding concurrent Git commands and telling agents the new branch name; agents may still
  refer to the old name. Exact Git content/identity checks and controller ownership holds still apply.
- **Holds.** Holds are claimed in the same transaction that checks the index owner. Start, dispatch,
  setup, launch, the other lifecycle operations and keyboard acquisition all respect them. As implemented,
  keyboard acquisition is refused while an operation runs (the shared automation gate); as for the other
  setup operations, an uncertain record does not block keyboard input.
- **Refusals.** Each operation refuses:
  - run owners, including paused runs;
  - unresolved deliveries, launches or setup;
  - manual-input barriers;
  - in-progress merge, rebase, cherry-pick, revert, bisect or sequencer state;
  - hidden index flags or sparse checkout, and submodules;
  - installed hook or skill references inside the worktree;
  - the running AltCLI host's own checkout inside the worktree;
  - overlap with controller data.
- **Hooks.** Disabled (`-c core.hooksPath=/dev/null`), as for creation and removal. This is decided
  explicitly here: post-checkout hooks could otherwise bootstrap environments. Final squash integration
  keeps normal hooks.
- **Uncertainty.** Every step is persisted before it runs. An attempted mutation with an unknown result is
  uncertain, and restart turns applying into uncertain. Inspection is read-only. There is no retry, rollback
  or automatic repair, and a duplicate request returns its record.

**Update from main.**
- **Scope.** A clean linked task worktree. The boundary is the last task commit the target already
  contains. By ancestry it is HEAD, and the branch fast-forwards. With a verified squash checkpoint through
  HEAD or an exact patch match, it is also HEAD, and the branch moves to the target tip. Otherwise it is
  the last applicable squash checkpoint, or the single merge base when nothing is integrated; the commits
  after it are replayed. A target the branch already contains is refused as current.
- **Target.** The squash target (local `main`, else the recorded default) at a pinned SHA, with no fetch.
- **Steps.**
  1. Check for local obstructions in the preview: ignored files, files where directories go, case
     collisions, symlinked parents.
  2. Archive the journal.
  3. Write any replayed commits to the object database and record the expected new tip.
  4. Create the create-only recovery ref `refs/altcli/preserved/<requestId>` at the old tip.
  5. Run `git checkout --no-overwrite-ignore --no-recurse-submodules -B <branch> <SHA>`.
  6. Verify that HEAD is attached, that `<branch>@{1}` is the old tip, the checkout is clean at the
     recorded tip, the replayed chain has the previewed trees on the target, the recovery ref is in place
     and the identity is unchanged.
  7. Retire the worktree's squash checkpoints.
- **Never.** `git rebase`, `reset --hard` or `reset --keep` to move the branch. In scratch tests with
  Git 2.47, both `git rebase` and `git reset --keep` silently overwrote an ignored local file that
  `checkout --no-overwrite-ignore` refused. On September 28, `git reset --hard main` and
  `git checkout -f --no-overwrite-ignore` did the same, and `-f` also overwrote an untracked file in the
  way. Only the non-forced checkout refused both.
- **Remote copies.** A non-fast-forward update is refused when the branch has an upstream or a
  remote-tracking counterpart.
- **Intent.** Continue task or new task is recorded. Old runs never resume across rewritten history.
  As implemented, the intent is **not recorded**: the result asks the user to give agents fresh
  instructions. A run owner, including a paused run, refuses the update, so no run spans it.
- **Replay.** Replaying the commits after the boundary uses `git merge-tree` and
  `git commit-tree --no-gpg-sign` in the object database, keeping each commit's author, date and message.
  Before any ref or worktree change it refuses conflicts, merges, more than 100 commits, redundant commits,
  signed-commit configuration and non-default message encodings.
- **Also refused.** A worktree the host's installed CLI hooks or skill links point into, and the running
  host's own checkout, since both would change under the host.

**Rebase onto main and Reset to main.** User requirement, September 28, 2026: reset a task worktree to
main with a preview and warning, rebase it onto main with a preview and confirmation, and make Update's
case clear. The September 28 menu revision groups all three with **Squash into main** in the persistent
**Main** dropdown; **Branch** groups Rename, Finish branch, Check removal and Discard. Both support hover,
click and keyboard, with forms below the controls. Every preview
states which case applies, the equivalent Git command, and the exact commands that run instead. Rebase and
Reset share Update's contract above: holds, warned confirmation, recovery ref, disabled hooks, no fetch or push,
the published-copy refusal when history is rewritten, verification and uncertainty.
- **Rebase onto main.** Equivalent to `git rebase main`. It needs a clean checkout, like Update. It
  ignores squash evidence: it fast-forwards a contained branch, and otherwise replays every commit after
  the single merge base with the same object-database replay. Commits main already has, such as squashed
  ones, are refused as redundant, and the refusal points to Update from main, which skips them, or to
  Reset. It never runs `git rebase`.
- **Reset to main.** Equivalent to `git reset --hard main`.
  - **Preview.** Allowed in a dirty checkout. It lists the commits that leave the branch (they stay
    reachable under the recovery ref) and the uncommitted tracked changes, staged and unstaged, that are
    discarded for good. Untracked and ignored files stay. The content is pinned by fingerprint.
  - **Refused content.** Untracked or ignored content where a deleted tracked file would be restored, or
    where main adds a tracked file: the case plain `git reset --hard main` overwrites.
  - **Confirmation.** One **Confirm reset** button accepts the previewed loss; no typed branch is required.
    After the archive step, the fingerprint must still match.
  - **Steps.** After the recovery ref, `git reset --hard HEAD` discards the tracked changes in place.
    It can restore deleted or renamed paths, so their obstructions are checked again after archiving
    and the final fingerprint check; ignored files are outside that fingerprint. Controller ownership is
    rechecked after these content reads. The branch then moves with the same non-forced
    `checkout --no-overwrite-ignore -B`. Verification checks tracked files only, because untracked and
    ignored files stay.
  - **Inspection.** A reset whose changes were discarded but whose branch never moved is a definite
    outcome, so inspection releases it as failed. An unchanged checkout also releases as failed.
    Ancestry already present before a reset is never proof it ran: if the target was already in the old
    history and later commits obscure the exact result, inspection retains uncertainty and ownership.
    Nor is ancestry added afterwards: a reset that dropped commits leaves the old tip off the branch, so
    a branch that still contains it (main merged by hand) also retains uncertainty.
- **Update from main** keeps its own case: after a squash, it replays only the later commits. With no
  squash evidence, its preview says it is the same as Rebase onto main.

**Rename branch.**
- **Command.** `git branch -m` only, never `-M`, with a validated new name. The new name may not be an
  integration name, an existing branch, a case-only variant of one, or a path prefix of one.
- **Refused** when the branch has an upstream or remote-tracking counterpart.
- **Dirty content.** Allowed. The preview pins it by content fingerprint, and the confirmation re-derives
  the whole preview before and after the ownership check. Controller ownership is checked again after
  the final inspection, immediately before `git branch -m`. Native activity and process evidence do not
  block Rename; its explicit confirmation accepts the warning about concurrent Git work and the old name.
- **Narrowed refusals.** A rename changes no file, so sparse checkout, submodules, installed hook or skill
  links and the host's own checkout are not refused. Hidden index flags and stopped Git operations are.
- **Names that follow (September 28, 2026 user revision; widened September 30, 2026).** Open tmux sessions AltCLI
  launched in the worktree take the name it gives the new branch (profile and branch, with any uniqueness number)
  whatever branch their current name recalls, so a session left under an older name catches up; one already
  named for the new branch keeps its name. They are listed in the preview's commands as `tmux rename-session`
  and renamed after the verified Git rename, each only while it is still that launch's verified session under
  its recorded name; its launch record follows. A saved agent name equal to its session's old name follows it;
  a chosen name stays. A saved group named after the old branch's last segment takes the new one, and a linked
  worktree's default group name comes from its branch. Session renames are reported, never retried, and never
  make the Git rename uncertain.
- **Unchanged.** The directory, tmux sessions the user created, and launched sessions renamed by hand in tmux.
- **Squash batches.** Their boundaries follow verified rename records instead of the branch name alone.

**Move directory.**
- **Command.** `git worktree move` once, without force.
- **Destination.** Only under the task-worktree root, on the same filesystem, and never a case-only rename.
- **Occupancy.** No pane, process or service may be inside the worktree. Close app-launched sessions first
  with Finish branch "Close only".
- **Identity.** The worktree ID survives, because the Git directory and index path do not change.
- **Records.** The relocation is recorded without rewriting history, and requests carrying the old path are
  rejected.
- **Agents.** Relaunch is a separate launch preview. Resuming a conversation is not claimed.

**Objections and their resolution.** A peer raised these objections when the plan was approved by human
override. The September 28 user revision changes the writer-evidence policy for alignment and Rename;
the accepted Move design retains its occupancy checks.
1. Ready or Idle activity is not proof that writers have settled. Current process and background evidence
   is needed to prove it for every affected pane. *Revised:* Update, Rebase, Reset and Rename explain the
   risk and accept explicit human confirmation instead of requiring this proof. Missing, active or changed
   native evidence and background processes do not veto that consent. Controller ownership and exact Git
   inspection still apply.
2. `git merge-tree` honors configured merge drivers, which run commands. Check the effective configuration
   and attributes, and refuse external drivers before any replay preview. *Resolved:* the squash
   inspection preflight runs over the boundary, the target and every replayed commit before the first merge
   calculation. Combining the sides can make attributes effective that neither input selects alone, such
   as a macro defined on one side and used on the other. So every generated tree, including the one the
   checkout writes, is inspected before the preview is returned; confirmation re-derives the preview and
   repeats both checks. Without replay the preflight covers the target and HEAD trees the checkout writes.
3. A failed recovery-ref creation stays uncertain unless the ref's absence is proven. *Resolved:* creation
   is the first step after the attempt is recorded, so any failure is uncertain. Inspection releases the
   update as failed only for a clean checkout still at the old tip, after an ownership check. It reports and
   keeps a recovery ref that was created.
4. The dirty-state policy is set per operation. Update requires a clean checkout. Rename and move may carry
   dirty content only if the preview pins it and verification checks it. *Resolved:* Update requires a
   clean checkout; Rename pins the content fingerprint as described above.

### Branch consent and Plan approval are separate gates

Plan may run on a clean named branch or clean detached baseline because its turns make no Git changes. A new-branch choice can be collected beforehand and applied after the planning actions settle. If the user has already explicitly chosen to stay on main, no extra automatic branch operation is needed. The final transition verifies that this choice still matches the workspace.

```text
Plan result ready or direct Implementation requested
    -> satisfy applicable Plan approval/preauthorization
    -> satisfy explicit branch choice/consent
    -> revalidate group placement, all affected activity, clean or captured initial state, and baseline
    -> perform new-branch setup only when authorized and needed
    -> bind implementation branch and dispatch once
```

Disabling **Require my approval before implementation** is not authorization to create a branch. Missing branch consent leaves an explicit setup wait. The UI can collect both authorizations together clearly, but the server records them separately. Adding a branch at the same commit does not change the approved code baseline; any actual baseline/content change requires reconciliation.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
