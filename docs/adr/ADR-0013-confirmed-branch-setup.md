# ADR-0013: Confirmed branch creation at a settled boundary

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: The read-only-controller setup restriction in ADR-0003 and ADR-0011, solely for the future operation defined here.

## Context

The workspace may be on a primary branch or detached HEAD. A small confirmed setup operation is useful without making CoderCrew a worktree or environment manager.

## Decision

### Branch behavior at workspace setup

Inspect the branch **currently checked out in this worktree**. Other local/remote branches existing in the repository do not determine the current task's branch.

| Checked-out state | UI and permitted action |
| --- | --- |
| Non-primary named branch | Display and reuse it by default; the user can explicitly request a new task branch. Do not auto-switch to another existing branch. |
| `main` or the configured primary branch | Ask whether to create a new task branch with an editable name, or explicitly continue on the current branch. Show that implementation commits will land there. |
| Detached HEAD at a valid commit | Offer confirmed new named-branch creation at that commit, or ask the user to check out a branch and Recheck. Do not pretend it is main. |
| Unknown branch state, missing baseline, or failed Git inspection | Block commit implementation with an explanation; do not guess, initialize history, or repair automatically. |

Do not hard-code `main` as the only primary name. Use the configured/known repository default and keep the actual checked-out name visible. If default-branch information is unavailable or ambiguous, expose that fact and require a clear branch decision rather than classifying the checkout as a safe task branch by accident. Exact default-source and fallback detection remain implementation details, not an excuse for automatic network or configuration writes.

One implementation branch is recorded per run segment. A dedicated task branch is recommended, but the user may choose main/the primary branch. That opt-in does not disable clean entry, lineage, group ownership, ordinary permissions, or final verification. No PR is required and no automatic merge follows. The branch belongs to the workspace checkout, not to an individual agent or group object.

### Narrow, explicitly confirmed create-and-checkout operation

**This is the only new controller Git-write authority in V4.** After explicit user confirmation, create and check out a new named branch at the validated current commit. An ordinary create-and-switch operation such as `git switch -c <new-name> <validated-current-SHA>` is the intended shape; never use reset/force variants, and validate branch names and command arguments before execution. This is a working operation contract, not an executed command in this document.

Record the user's chosen name, workspace/worktree/index identity, observed current branch/detached state, starting SHA, operation identity, and consent. The consent may be collected in the initial setup form, but it applies only to that checked state. If the baseline, checkout, or requested name changes before execution, stop for a fresh decision; do not silently rebase the approval onto a different branch.

Before mutation, establish that:

- The new workflow has exclusive setup control of the underlying worktree; no other run or active planner/implementer is using it.
- Every affected selected and relevant unselected agent has settled, or the user has explicitly reconciled uncertain external activity. Never switch underneath active planners merely because their drafts are ignored.
- The canonical paths/instance bindings and current commit still match the consent, and the index/nonignored worktree is clean.
- The requested name is valid and does not collide with an existing branch. Existing branch/path conflicts are errors; do not reset or overwrite them.

Afterward verify the actual named branch, unchanged starting commit, and clean state before implementation dispatch. If the operation's result is uncertain, record the uncertainty and inspect/reconcile; do not blindly repeat it or issue a destructive rollback. Concurrent confirmations must produce one authorized setup transition. A fresh live state, not a reused stale UI card, is the basis for the check.

The create-and-checkout permission does **not** authorize existing-branch switching, worktree add/remove, stash, reset, clean, add/commit, merge, rebase, force-push, branch deletion, editing `.gitignore`, or changing global/local Git configuration. Agents or their authorized commit helper still publish implementation turns. This ADR records the narrow exception; runtime support and its acceptance tests must be implemented before the operation is exposed.

### Branch consent and Plan approval are separate gates

Plan may run on a clean named branch or clean detached baseline because its turns make no Git changes. A new-branch choice can be collected beforehand and applied after the planning actions settle. If the user has already explicitly chosen to stay on main, no extra automatic branch operation is needed. The final transition verifies that this choice still matches the workspace.

```text
Plan result ready or direct Implementation requested
    -> satisfy applicable Plan approval/preauthorization
    -> satisfy explicit branch choice/consent
    -> revalidate group placement, all affected activity, clean state, and baseline
    -> perform new-branch setup only when authorized and needed
    -> bind implementation branch and dispatch once
```

Disabling **Require my approval before implementation** is not authorization to create a branch. Missing branch consent leaves an explicit setup wait. The UI can collect both authorizations together clearly, but the server records them separately. Adding a branch at the same commit does not change the approved code baseline; any actual baseline/content change requires reconciliation.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
