# ADR-0013: Confirmed branch and task-worktree setup

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

The workspace may be on a primary branch or detached HEAD. A small confirmed setup operation is useful without making CoderCrew a worktree or environment manager.

## Decision

### Branch behavior at workspace setup

Inspect the branch **currently checked out in this worktree**. Other local/remote branches existing in the repository do not determine the current task's branch.

| Checked-out state | UI and permitted action |
| --- | --- |
| Non-integration named branch | Display and reuse it by default; the user can explicitly request a new task branch. Do not auto-switch to another existing branch. |
| The default branch or a configured integration branch | Offer only a new task branch with an editable name, here or as a task worktree. There is no continue-on-this-branch option; the server refuses it as well. |
| Detached HEAD at a valid commit | Offer confirmed new named-branch creation at that commit, or ask the user to check out a branch and Recheck. Do not pretend it is main. |
| Unknown branch state, missing baseline, or failed Git inspection | Block commit implementation with an explanation; do not guess, initialize history, or repair automatically. |

Do not hard-code `main` as the only integration name. The integration set is the repository default branch as recorded locally in `origin/HEAD` plus the host's `CODERCREW_INTEGRATION_BRANCHES` list (default `main,master`); keep the actual checked-out name visible. If default-branch information is unavailable, the configured list still applies and the picker says no default is recorded, rather than classifying the checkout as a safe task branch by accident. Exact default-source and fallback detection remain implementation details, not an excuse for automatic network or configuration writes.

One implementation branch is recorded per run segment, and it is always a task branch: integration branches are starting points, never implementation branches, so intermediate work and review commits stay off them. Verified initial input, lineage, group ownership, ordinary permissions and final verification still apply. No PR is required and no automatic merge follows. The branch belongs to the workspace checkout, not to an individual agent or group object.

### Integration branches are starting points

The task flow is: select a project and a base branch or commit, usually the default branch; create a task branch and worktree (or a task branch at the same HEAD in the existing checkout); record that exact starting commit as the task's permanent baseline; run implementation and review rounds there; integrate the accepted result through a separate, explicit merge or pull request. Because an ordinary merge carries every review-round commit across, **squash integration is the recommended completion path** when a clean integration history is the goal. The app performs no integration step.

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

The create-and-checkout permission does **not** authorize existing-branch switching, unconfirmed worktree removal, stash, reset, clean, add/commit, merge, rebase, force-push, branch deletion, editing `.gitignore`, or changing global/local Git configuration. Agents or their authorized commit helper still publish implementation turns. Worktree creation requires its own consent below.

### Explicit task-worktree creation

The project view may offer **Create task worktree** before choosing agents or starting either phase. The user chooses an existing source checkout and a new task branch. A read-only preview returns the source worktree/index identity, source branch or detached state, full committed HEAD and destination. Default placement is `~/.codercrew/<repo-name>/<branch-name>`; separate same-named clones get distinct namespaces. Branch slashes create nested directories. Names and path components are checked, symlink indirection below the task root and checkout/metadata overlap are refused, and existing destinations are never adopted or overwritten.

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
integration branches and controller-data overlap. Never delete files directly or
use force, prune, reset or automatic cleanup. This remains cooperative same-user
control; external processes are not isolated by an OS filesystem lock.

Duplicate requests return the recorded result. Restart or an ambiguous Git result
retains ownership as uncertain and never retries. Read-only inspection can verify
absence of both checkout and Git worktree entry, or release a failed attempt when
the exact original clean state is still present; all other results stay uncertain.
Successful removal clears only that checkout's saved configuration, retaining its
branch, commits and workflow history. SQLite v8 prevents older servers from
ignoring a removal owner. Installed-host deletion acceptance remains separate.

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
