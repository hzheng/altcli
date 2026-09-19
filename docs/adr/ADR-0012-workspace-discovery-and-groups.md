# ADR-0012: Workspace-first discovery and explicit groups

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: ADR-0004 and ADR-0005 for future onboarding and participant terminology; runtime pair compatibility remains until migration.

## Context

Users should open a workspace rather than register panes and construct a named pair one at a time. The user prepares the environment and places agents; the app discovers and validates that existing arrangement.

## Decision

Use **group** for one or more distinct registered instances. For a fresh workspace, select one eligible agent as Solo, preselect both when exactly two exist, and require choosing two or deliberate solo when three or more exist. Initial selected membership is capped at two; inventory and planning state remain N-shaped. A group snapshot, not live discovery, controls an active run.

Keep current and target behavior distinct: the current UI/API still uses pairs until a versioned implementation migration. The [workflow guide](../WORKFLOWS.md) owns detailed vocabulary, selection defaults, phase controls, and action labels.

### Responsibility boundary

**The user prepares the workspace; CoderCrew discovers, validates, and coordinates it.** The normal flow assumes an existing Git working tree, including a linked worktree when the user chooses one, and existing coding-agent sessions already placed there. A separate linked worktree is not mandatory when a normal checkout meets the same requirements.

The app does not create/remove worktrees, clone repositories, relocate or restart CLI sessions, install dependencies, copy environment secrets, allocate development databases, clean directories, or manage workspace retention in this version. A mismatch is explained with per-agent paths and a Recheck action. Finishing a run does not delete a branch/worktree or merge it into main.

This explicitly supersedes the earlier recommendation to auto-provision one implementation worktree per task. It does not undo the ability of the user to prepare separate worktrees for independent tasks. The same prepared directory is used through Plan and Implementation; no planner-to-implementation workspace migration is required.

### Discover panes and workspace candidates

On the configured host and tmux server socket, inspect all live panes, including panes in detached tmux sessions. A pane is the concrete input/output target; a tmux session/window can contain several. Do not limit discovery to attached terminal clients. The initial deployment can use one configured socket; additional sockets/hosts must be explicitly supported and identified, not silently swept from the filesystem.

A proposed read-only sequence is:

```text
List panes
    -> obtain exact tmux identity, observed command, and cwd
    -> canonicalize the cwd
    -> inspect actual Git worktree/root/gitdir/index and current branch
    -> classify eligible CLI instances and show unknowns separately
    -> group by canonical cwd within the host
    -> display workspace cards and candidate agents
```

Possible inspection primitives include `tmux list-panes -a -F ...`, `realpath`, and read-only Git worktree/status queries. Their parsing and installed-version behavior must be tested; this document does not provide a verified implementation. Use argument arrays and exact targets, not shell-concatenated prompts. Empty/inaccessible paths or failed Git checks are diagnostic states, not guessed repositories.

Count coding agents, not every pane in the directory. Shells, servers, pagers, and unidentified generic interpreters do not automatically become runnable group members. An unknown runtime can be identified through an explicit adapter/instance confirmation rather than silently weakening existing process checks. Discovery of a Gemini-looking process is not proof of verified planning/automation support. Stable controller instance labels/IDs can be generated or remembered during workspace selection and finalized at Start; no per-pane registration wizard is required for known eligible cases.

Inspect directories used by observed panes rather than recursively scanning the user's disk for repositories. A workspace is available because there is current tmux evidence for it. Pins may remain visibly unavailable after panes disappear; do not treat a stale card as a live session.

### Directory grouping versus Git execution identity

For the first local version, selected members must satisfy **both** rules:

1. The same canonical current working directory on the same host. Resolve equivalent path spellings; `/repo` and `/repo/web` are still distinct groups/cards, even when they belong to one checkout. The user aligns agents manually when necessary.
2. The same actual Git worktree and index. A similar repository name or common directory ancestor is not sufficient, and linked worktrees sharing a repository are not the same index.

The workspace card uses the canonical cwd as its grouping location, with worktree root and checked-out branch available as metadata. The execution lock uses the canonical worktree/index identity. Therefore `/repo` and `/repo/web` may appear separately but must be identified as sharing a checkout and may not start conflicting runs. Distinct user-created worktrees can host independent tasks, subject to the user's environment constraints.

The selected phase group, not every agent in the entire app, must satisfy the local placement contract. However, unselected panes sharing the underlying worktree are still potentially affected writers. Show them. Before Plan, implementation, or branch setup, verify no conflicting controller assignment exists and require explicit reconciliation of relevant active/unknown external work. Exclusion from scheduling is not isolation. tmux cwd/process snapshots cannot establish semantic readiness or prevent subsequent desktop writes; state these limits rather than claim a process sandbox.

Revalidate group identity, cwd, worktree/index, and branch at dispatch/handoff/phase boundaries. An unexpected move or restart marks the member unavailable or pauses the run; it does not silently rebind to a different pane or follow a new directory. Changes in discovery never mutate a bound group.

### Clean-entry contract

Workspace visibility and task readiness are different. Dirty workspaces remain visible and readable. New Plan and commit-relay execution require a clean project: no staged changes, unstaged tracked changes, or nonignored untracked files, with an explicit baseline and no conflicting writer. Verify planning outputs separately as narrowly ignored and untracked. Do not stash, reset, stage, commit, discard, or force-add work to satisfy the gate.

Direct-start implementation enforces the same rule. Users with intentional unfinished work either resolve it or use the deprecated mode only within its existing contract. The app does not move that work into a new worktree automatically. A valid initial commit/baseline is required by this first commit-relay design; an unborn/no-commit repository needs user preparation, not invented history.

Branch consent is specified separately in [ADR-0013](ADR-0013-confirmed-branch-setup.md). Future remote publication and host-aware placement are in [ADR-0018](ADR-0018-remote-publication-and-history.md); they are not implicit exceptions to this local contract.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
