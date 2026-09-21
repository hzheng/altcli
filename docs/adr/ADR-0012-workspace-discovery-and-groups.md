# ADR-0012: Project-centered discovery, worktrees and explicit groups

Date: September 19, 2026

Status: Accepted design direction; local workspace grouping implemented, host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
See VALIDATION.md for executed checks; broader adapter capabilities remain future work.

Relationship: ADR-0004 and ADR-0005 for future onboarding and participant terminology; runtime pair compatibility remains until migration.

## Context

Users should choose a project and task worktree rather than register panes and construct a named pair one at a time. One repository can support independent tasks in separate linked worktrees. The user prepares environments and places agents; the app discovers and validates that arrangement and can explicitly create a task worktree.

## Decision

Navigation is **project → worktree → task/agent group**. A local project is keyed by its canonical shared Git metadata directory (`git rev-parse --git-common-dir`), within the configured host. Linked worktrees share that identity. Separate clones never merge merely because their origin URLs match; repositories without remotes work normally. Remotes are not needed for discovery and are not read or displayed by this increment.

Git's worktree inventory supplies main and linked checkouts, including those with no agents. Each worktree has a branch-independent identity derived from its canonical Git directory/index, with its directory, current branch or detached HEAD, and availability displayed separately. Missing/inaccessible worktrees remain diagnostic entries; bare Git directories are not runnable checkouts. tmux supplies the live agent inventory, not the whole project catalog.

Discovery caches observed project identities without writing configuration. Explicit name/membership edits, Start, and task-worktree creation remember the project in SQLite; these known projects survive restart with no panes. Existing stored session roots also seed discovery. Merely observed, unused projects remain known for the process lifetime but are not silently persisted by a GET. Opening projects/worktrees does not write Git or start a task.

Use **group** for distinct agent instances. A workspace has at most one current group, derived read-only from eligible live panes. All are selected initially, and every session has a checkbox; unsupported processes are disabled. One selected member is Solo, two a Pair, and three or more a larger Group. Checkbox edits persist immediately without Create/Use/Save group steps. Selection has no two-member cap; current Plan/Implementation execution still requires one or two and explicitly blocks larger groups. A group snapshot, not live discovery, controls an active run.

Registration is internal, not an onboarding action. Read-only discovery proposes stable instance identities and captures their output without writing configuration. Start revalidates the exact generation, process, cwd and worktree before binding it. Explicit name/membership edits may also persist a validated identity. The Name column defaults to the agent label and supports inline editing (Enter/blur saves, Escape cancels). Rename changes only the display label, with generation and previous-label checks; IDs, tmux identities and past snapshots stay unchanged. Name/membership edits require an unowned checkout; concurrent edits check current revisions and exact generations.

Project cards select the project view. Worktree cards are clickable and keyboard accessible: a single agent directory opens Console directly; multiple directories require choosing the task group directory first. An empty worktree opens setup guidance without Start. Border/background indicates selection; there is no Selected badge/button. No view action starts work or persists default membership.

The current UI shares this workspace group across Plan and Implementation; larger future planning rosters may need a separate implementation subset. Earlier overlapping stored associations and pair IDs are preserved for historical/frozen runs and staging compatibility, but only one current group is exposed per workspace. Discovery never rewrites those records. The [workflow guide](../WORKFLOWS.md) owns detailed vocabulary and phase controls.

### Responsibility boundary

**The user owns environments and agent placement; CoderCrew discovers projects, validates task boundaries and coordinates work.** Existing checkouts remain usable. An explicit **Create task worktree** action offers a clean linked checkout and new branch under `~/.codercrew/<repo-name>/<branch-name>`, with separate-clone name collisions disambiguated. Preview and confirmation bind the source identity, branch, full commit and destination; [ADR-0013](ADR-0013-confirmed-branch-setup.md) owns that setup authority.

The app does not remove worktrees, clone repositories, relocate or restart CLI sessions, install dependencies, copy environment secrets, allocate development databases, clean directories, or automatically manage retention. A new worktree initially has no agents; users start coding CLIs there and Recheck. Finishing a run does not delete a branch/worktree or merge it into main.

This supersedes the previous no-worktree-creation boundary, not the prohibition on automatic provisioning. Creation is a deliberate setup action separate from Start. The same chosen directory is used through Plan and Implementation; no planner-to-implementation migration is required.

### Discover panes and workspace candidates

On the configured host and tmux server socket, inspect all live panes, including panes in detached tmux sessions. A pane is the concrete input/output target; a tmux session/window can contain several. Do not limit discovery to attached terminal clients. The initial deployment can use one configured socket; additional sockets/hosts must be explicitly supported and identified, not silently swept from the filesystem.

A proposed read-only sequence is:

```text
List panes
    -> obtain exact tmux identity, observed command, and cwd
    -> canonicalize the cwd
    -> inspect actual Git worktree/root/gitdir/index and current branch
    -> classify eligible CLI instances and show unknowns separately
    -> group repositories by canonical shared Git metadata directory
    -> enumerate every project's Git worktrees, even without panes
    -> group agents by canonical cwd beneath each worktree
    -> display projects, worktrees, and task groups
```

Possible inspection primitives include `tmux list-panes -a -F ...`, `realpath`, and read-only Git worktree/status queries. Their parsing and installed-version behavior must be tested; this document does not provide a verified implementation. Use argument arrays and exact targets, not shell-concatenated prompts. Empty/inaccessible paths or failed Git checks are diagnostic states, not guessed repositories.

Count coding agents, not every pane in the directory. Shells, servers, pagers, and unidentified generic interpreters do not automatically become runnable group members. An unknown runtime can be identified through an explicit adapter/instance confirmation rather than silently weakening existing process checks. Discovery of a Gemini-looking process is not proof of verified planning/automation support. Stable controller instance labels/IDs can be generated or remembered during workspace selection and finalized at Start; no per-pane registration wizard is required for known eligible cases.

Inspect observed pane directories, stored session roots and remembered projects rather than recursively scanning the disk. Enumerate worktrees through Git. An available worktree is not proof of a live agent or task readiness; empty and unavailable entries remain visible without inventing sessions.

### Directory grouping versus Git execution identity

For the first local version, selected members must satisfy **both** rules:

1. The same canonical current working directory on the same host. Resolve equivalent path spellings; `/repo` and `/repo/web` are distinct task groups under one worktree. The user aligns collaborating agents manually when necessary.
2. The same actual Git worktree and index. A similar repository name or common directory ancestor is not sufficient, and linked worktrees sharing a repository are not the same index.

Project identity is not an execution lock. The canonical cwd groups agents; the canonical worktree/index excludes competing runs. Therefore `/repo` and `/repo/web` share one checkout card and execution boundary even with different task groups. Separate linked worktrees can host independent tasks, subject to shared environment resources and the user's setup constraints. Do not rename historical `repository` fields (which hold worktree roots) into project identities or invalidate active run snapshots.

The selected phase group, not every agent in the entire app, must satisfy the local placement contract. However, unselected panes sharing the underlying worktree are still potentially affected writers. Show them. Before Plan, implementation, or branch setup, verify no conflicting controller assignment exists and require explicit reconciliation of relevant active/unknown external work. Exclusion from scheduling is not isolation. tmux cwd/process snapshots cannot establish semantic readiness or prevent subsequent desktop writes; state these limits rather than claim a process sandbox.

Revalidate group identity, cwd, worktree/index, and branch at dispatch/handoff/phase boundaries. An unexpected move or restart marks the member unavailable or pauses the run; it does not silently rebind to a different pane or follow a new directory. Changes in discovery never mutate a bound group.

### Clean-entry contract

Workspace visibility and task readiness are different. Dirty workspaces remain visible and readable. New Plan, existing-candidate review and later commit-relay turns require a clean project: no staged changes, unstaged tracked changes, or nonignored untracked files. Commit may snapshot captured uncommitted work on its first work turn, as defined in ADR-0014. Every start binds an explicit baseline and requires no conflicting writer. Planning outputs live in CoderCrew's data directory and are verified there. Do not stash, reset, stage, commit, discard, or force-add work to satisfy the gate.

Direct-start implementation enforces the same rule. Users with intentional unfinished work either resolve it or use the deprecated mode only within its existing contract. The app does not move that work into a new worktree automatically. A valid initial commit/baseline is required by this first commit-relay design; an unborn/no-commit repository needs user preparation, not invented history.

Branch consent is specified separately in [ADR-0013](ADR-0013-confirmed-branch-setup.md). Future remote publication and host-aware placement are in [ADR-0018](ADR-0018-remote-publication-and-history.md); they are not implicit exceptions to this local contract.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).

### Moved panes at an unowned boundary

Discovery may automatically propose the same named agent in its newly verified
canonical cwd/worktree when the tmux identity and supported CLI type match and
the foreground CLI can be identified. Both the old and new checkout must be free
of execution/delivery ownership. Old paused or uncertain runs retain their exact
participants and require explicit takeover; a moved pane displays that blocker
instead of generic instructions to start another CLI. Missing process evidence
or changed pane identity is never an automatic rebind.

The live view follows the verified placement without a registration/reset step.
Discovery stays read-only. The next explicit name/membership edit or Start pins
the fresh registration, removes the moved member from old saved group/pair
configuration, and preserves remaining members and all frozen run history.
