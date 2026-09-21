# ADR-0017: Phase-aware orchestration, evidence, and recovery

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: Extends ADR-0011 for new phase-aware workflows; retains its identity, ownership, and no-blind-replay guarantees.

## Local implementation update — September 19, 2026

Plan and Implementation now share the durable run owner, lifecycle correlation,
event deduplication and automatic-turn budget. Plan adds persisted ordered draft
assignments (concurrency one), epoch/brief/roster identities, captured versions,
endorsement history and a frozen authorization record. Result files are external
metadata, published before lifecycle completion; their existence alone never
advances the run. Missing or invalid results pause; late files are not retried.
Approval checks exact plan/hash/brief/policy and current-command identities, and
the first Implementation turn is created in the same transaction as the freeze.
Confirmed branch setup retains its separate once-only persisted claim. Restart
restores evidence and pauses without replay, including at a manual checkpoint.
This is local sequential source support, not native runtime/host acceptance or
the future concurrent/remote recovery machinery described below.

## Context

Workspace inventory, role assignment, artifact publication, and execution evidence have different meanings. One server must combine them durably without deriving authority from browser selection or uncorrelated output.

## Decision

### Server-owned orchestration and invariants

Scheduling remains in the Node controller and durable store, never React effects. Workspace discovery provides inventory; Start binds a group snapshot. The same engine supports a solo or multi-agent planning roster, one shared-plan writer, and an implementation group of one or two members under explicit phase policies. N-shaped planning is retained even while the selectable member count is capped at two.

```text
Host / tmux inventory
    └── Discovered workspace (canonical cwd + worktree/index identity)
         └── Task / project

Task / project
    ├── Bound workspace identity and group membership revisions
    ├── Branch choice, consent, and checked-out branch/baseline
    ├── Shared brief revision and planning/code baseline
    ├── Implementation task branch and publication destination
    ├── N drafts, one unified plan (data directory), captured versions
    ├── Frozen final plan and authorization
    └── Collaboration run
         ├── Task phase and planning step
         ├── Planning epoch, roster revision, ordered required members
         ├── Draft assignment map and bounded active-assignment set
         ├── Version-specific endorsements and unresolved findings
         ├── Explicit implementation group (solo or 2) and roles
         ├── Policy revision, continuation setting, and plan-exit gate
         ├── Workspace reservation and per-output write grants
         ├── Sequential current turn during refinement/implementation
         ├── Budget, pause state, and queued human guidance
         └── Published results, lifecycle evidence, and consumed transitions
```

#### Ownership and dispatch

Retain one task-level reservation for the shared local workspace. This excludes competing implementation/uncommitted runs while planning is active. Within that reservation, draft assignments receive disjoint file grants. They do not gain permission to write the shared plan, index, a tracked log, or project content.

Register N assignments from the start, even when `maxConcurrentDrafts=1`. When concurrency is enabled, the active set is bounded and identified; never overwrite one `currentCommandId` repeatedly and reinterpret other valid completions as late. During synthesis, refinement, and implementation, retain a single current editing turn.

Transport reservations and execution ownership are separate. Terminal text delivery may remain serialized while agent executions overlap; releasing a short delivery reservation must not release the workspace to another task. Each dispatch and result is tied to its own instance, assignment, and epoch. No two concurrent assignments target one live CLI session.

#### Invariants

1. **Ownership follows phase and artifact.** Up to the concurrency cap may write disjoint initial drafts; only one writer edits the unified plan or implementation workspace.
2. **A completed result is consumed at most once.** Duplicate events cannot satisfy another planner's slot or create multiple successors.
3. **The draft barrier is set-based.** Every required member needs a valid finalized result for the same current inputs; callbacks are not counted as anonymous votes.
4. **Agreement is version- and roster-specific.** Every required member endorses the same current revision by default. A changed plan invalidates stale endorsements.
5. **Routing is explicit.** The frozen phase group and its roles/order govern work, not current workspace inventory, group creation order, or viewing selection. One-member groups have no automatic peer successor.
6. **Edit permissions are phase- and role-specific.** Concurrent checks allow other authorized active drafts to change but do not claim snapshot-based attribution.
7. **Version identity is not approval.** A plan hash is not endorsement, a commit is not code acceptance, and group agreement does not bypass a human checkpoint.
8. **Active state is separate from history windows.** A long-running planner or worker cannot become idle by falling out of a recent-events list.
9. **Unknown state stays visible.** Unsupported adapter evidence, missing results, or interrupted work never means success.
10. **Transitions are durable and unique.** Synthesis and Plan-to-Implementation start once for a particular barrier/approval identity, including after restart or concurrent clicks.
11. **Budgets survive clients and phase changes.** Adding planners or re-enabling a preference is not an unlimited-run reset.
12. **A finished chain is not task acceptance.** Final requirements and cumulative project tests remain separate.

13. **Inventory is not authorization.** Auto-selection is a convenience before Start, never a live membership rule.
14. **Workspace grouping is not the lock boundary.** Cards for different subdirectories of the same checkout share its canonical worktree/index execution exclusion.
15. **The app does not manage environments.** The user prepares dependencies and agent cwd. Existing-worktree branch setup and new task-worktree creation are separate scoped confirmations under ADR-0013; neither relocates agents or bootstraps an environment.
16. **Branch writes need scoped consent.** Creation at a settled boundary requires the recorded workspace/current-commit consent and fresh checks; ambiguity is not an invitation to force or retry blindly.
17. **Solo is explicit.** One identity is stored once; self-review does not count as independent peer approval, and no virtual second vote or self-relay is created.
18. **Capability limits are server rules.** The registry may contain many agents while initial phase groups permit at most two. A larger payload cannot bypass the staged rollout.

Use transactional checks/unique keys for each consumed result and successor plan. A generated browser UUID alone is insufficient. Approval should compare the exact plan, brief, roster, and policy revisions viewed by the user before recording the transition.

#### Budget recommendation

Preserve bounded automation, but distinguish draft attempts from shared-plan refinement and implementation turns. A single old default of 20 should not silently make a large roster unable to finish its first review cycle. Show required participants, expected minimum review work, attempt limits, and remaining budget before dispatch. For N planners, a synthesized plan needs up to N-1 other endorsements even without revisions.

Use finite per-assignment attempts, a persistent refinement-turn limit, and an overall run limit as proposed implementation choices. Exhaustion pauses; it never removes a planner or manufactures agreement. `turnLimit` (default 20) and `automaticTurns` are the verified names at `46f228b`; the new per-phase limits are proposals.

### Publication, hooks, and completion evidence

#### Commit relay: the committed handoff is the record

```text
Agent produces its result.
    ↓
Helper validates the entry and permitted project diff.
    ↓
A completed handoff commit is published to the configured destination.
    ↓
Controller reads the entry from that exact revision.
    ↓
Controller validates and consumes it once.
    ↓
Policy selects the next action, waits for the user, or finishes.
```

The controller inspects the committed file, never a mutable local copy. A new commit is not sufficient by itself: the publication must match the expected run, turn, participant, policy revision, and predecessor, and a report-only acceptance terminates or waits according to policy rather than triggering a review because the branch advanced.

Hooks may wake the controller sooner, and polling the published branch can rediscover a handoff artifact after a missed notification, but it cannot manufacture correlated lifecycle completion or clear background-work evidence. The run retains ownership and schedules no successor until that evidence arrives or a human reconciles it. Correctness never depends on a terminal screen or a prose line from an unrelated turn. Existing correlation invariants remain, with provider-specific implementations: use native prompt/turn identity where supported, exact controller command association, instance/session binding, and explicit rejection of ambiguous input. An adapter must not invent a vendor-native ID or require another vendor's fields.

#### Publication is not proof that all writing stopped

A commit records a snapshot; it does not stop background tasks or prove readiness. The participant must finish the turn and cease edits before ownership transfers. The supplied record flags a conservative missing-evidence policy that may prevent a continuous mixed-agent loop, depending on installed adapter capabilities; commit relay reduces dependence on fragile outcome parsing, but **the acceptable evidence for safe ownership transfer remains a deliberate choice**, and absent background fields are never treated as empty lists.

**Working specification.** Ownership transfers only when three things agree for the same turn: correlated lifecycle completion and adequate activity evidence under the verified adapter policy, a validated handoff commit at the publication destination ([Validation and permissions](../SECURITY.md#validation-and-permissions)), and a post-publication leftover check. For the last, take a read-only *leftover digest* right after the commit is observed: staged changes relative to HEAD, unstaged changes, and the contents of untracked non-ignored files. This is a proposed HEAD-relative inspection derived from the digest described by the source: compare index to current HEAD, worktree to index, and nonignored untracked content. The **change set must be empty**; a hash of an empty set is still a hash, not an empty string. A legitimate new commit must not count as a leftover merely because HEAD advanced. Unexpected changes pause and report paths from the same inspection. Plan documents live outside the checkout, so they never count as code leftovers; changes to protected frozen planning artifacts are checked separately. These checks cannot prove a same-user process will not write after the inspection.

#### Planning: explicit completion plus captured document version

Planning has no committed handoff to poll. The writer finishes its assigned document and reports the structured result of [Optional Plan phase in one shared workspace](ADR-0016-plan-phase-and-approval.md#optional-plan-phase-in-one-shared-workspace); the controller captures and validates the content before advancing. CLI-specific hooks or an equivalent explicit helper assist when identity and lifecycle semantics are adequate, but "file exists", "mtime stopped changing", or a screen phrase is never the signal, and polling ignored files cannot distinguish an objection from an acceptance or a half-written draft from a finished one. Review and approve a stable captured version, never a file another turn is editing. Before granting implementation permission, settle all planning activity and recheck the code baseline.

#### Provider-neutral lifecycle transport, not missing-evidence defaults

The required **evidence contract** is shared, but the concrete hook event names and fields need not be. Claude/Codex-specific legacy handlers can remain frozen on the deprecated path; new planning adapters normalize only what their runtime actually establishes. Gemini's result channel must not be rejected solely for not carrying a Claude field, nor accepted by filling missing activity data with empty arrays. [S4](../SOURCES.md#source-4)

A planning helper reporting a file hash supplies result evidence, not automatically proof of process quiescence. Lifecycle failure, unknown background state, and ambiguous output remain distinct and visible. A human can reconcile an unsupported case explicitly; an adapter-specific automatic policy needs a defined threat model and host acceptance, not just a changed boolean.

Event ingestion should record and acknowledge evidence promptly. Do not create a cycle in which a synchronous vendor hook waits for the HTTP handler while that handler waits for the same hook to finish. Later scheduling belongs to the server's validated transition processing, with no unconditional next-turn launch from a callback.

### Manual handoffs, pauses, and recovery

#### Routine manual progression is not takeover

At `46f228b` the shipped uncommitted mode leaves a clear `accept_and_improve` result in `paused` when automatic continuation is off, with the worktree still owned, so another relay first requires takeover. [Deprecate the uncommitted relay mode](ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode) freezes that behavior rather than adding a new affordance to the deprecated path. Commit relay and Plan should not inherit the friction: they use a normal waiting state and a **Next relay** (or phase-equivalent) action that validates the successor and readiness while preserving task, findings, roles, and history. `awaiting_manual_handoff` is a working name for those new paths. Their takeover action remains reserved for recovery, abandonment, or changing control ownership.

Working semantic states, whose storage is open and which must not collapse into "busy" and "idle":

```text
Workspace discovered / read-only view / group selection required
Workspace setup blocked: dirty, mismatched, unavailable, or conflicting activity
Branch choice or confirmed branch setup pending
Plan: draft assignments queued/running / waiting for all required planners
Plan: unified-plan refinement / current-revision endorsement set incomplete
Plan: agreed and awaiting human approval or manual continuation
Transition: final plan captured and implementation start pending
Implementation: executing a solo or group turn
Awaiting a completed publication
Awaiting manual handoff
Paused for objection or human decision
Delivery/publication uncertain
Participant unavailable or changed
Stopped through takeover
Review chain completed
```

#### Pause, restart, and plan recovery

Pause prevents future automatic scheduling; it does not kill a running process, and an immediate interruption leaves partial work that needs reconciliation before another agent receives write ownership. Closing or locking a browser is not a pause control.

Durable commits and log entries let the controller rediscover published results after a restart; they do not make redispatching an ambiguous instruction safe. Recover known state, mark ambiguity visibly, and never replay uncertain commands or resume an owned run without the chosen recovery policy. Reconciling local commit success, remote push uncertainty, and unconsumed handoffs needs specification and tests. Distinguishing a known pre-send failure from a possibly delivered command through explicit transport stages remains separate follow-up work; the broad `deliver()` catch can overclassify pre-send failures as uncertain, and exception text is not the fix.

An interrupted planner may leave a partial draft: preserve it, never count it as complete, and do not release the workspace while any planner remains active. Stopping future scheduling is distinct from canceling and settling N already-running assignments. On restart, restore recorded completions, captured revisions, endorsements, and checkpoint policy, compare them with the files and code baseline, and pause on ambiguity. A reconnect must not recreate the N assignments, open the draft barrier with stale callbacks, or approve twice. Request changes and task updates reopen the appropriate step and invalidate stale agreement. Cleanup never deletes a draft in use or the only copy of the final plan.

Restarts recover the required roster and every assignment state, not just the most recent command. A previously finalized draft remains evidence for its original inputs; an ambiguous active assignment is not automatically rerun over it. Retried work uses a fresh attempt identity. Preserve queued guidance and apply it only to its intended current assignment/brief. A file reappearing at the same path is not proof that a previous attempt completed.

An explicit member removal or human override can resolve missing planning input, but cannot release grants while the removed planner may still be writing. Record scope changes and preserve original contributions. Resume or reopening semantics need dedicated tests; no timeout or provider error is an implicit authorization to continue with fewer members.

#### Discovery refresh and branch-setup recovery

Restore a running group's exact membership rather than rebuilding it from whatever panes are currently visible. A disappeared member remains unavailable; no replacement, reduction to solo, or regrouping by a new cwd happens automatically. Pins and discovery cards may refresh without altering execution. Recheck can confirm restored placement, but changed source-session/instance identity still requires explicit reconciliation.

A branch setup operation is recorded independently from implementation publication. After a restart or unclear operation result, inspect the actual worktree branch/HEAD and compare with the scoped consent. A matching-looking branch name alone does not authorize replay or reuse. No automatic force-reset, rollback, new worktree, or code dispatch occurs when setup state is ambiguous. Exact durable operation states remain to implement and test.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
