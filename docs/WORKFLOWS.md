# Project, worktree and collaboration workflows

Status: target product design, not the current operating guide. For the existing console use [SETUP](SETUP.md). Decisions are owned by the [ADR index](../Architecture_Decision.md); implementation status is in [ROADMAP](../ROADMAP.md).

Local implementation update, September 19: the console now offers explicit Plan
and Implementation choices. Sequential one/two-planner drafting/refinement,
captured versions, independent approval/automation settings, overrides, and the
branch-gated transition are implemented in source. Start settings are frozen;
Request changes updates the shared brief only at a captured, settled boundary.
Live guidance queues, membership replacement, larger enabled planning groups,
parallel drafting and native CLI plan-mode permissions remain target behavior,
not installed-host acceptance claims. See [VALIDATION](../VALIDATION.md).

## Executive decision

CoderCrew's main entry point is **a project**, then a worktree and task/agent group. Projects are identified by canonical shared Git metadata, not origin URLs. tmux discovers projects and live agents; Git lists all linked worktrees, including empty checkouts. Explicitly used/created projects are remembered across restart. Agents group by canonical cwd beneath each worktree. The app validates placement and offers separately confirmed task-worktree creation; it never moves sessions or configures their environments.

**Group includes every cardinality.** Each workspace has one group, with all eligible agents included by default and a checkbox for every session. One selected instance is solo, two a pair, three or more a larger group. No Register/Create/Use group step is needed. The Name column supports inline display-name edits without changing instance IDs. Larger selections are saved, but execution currently requires one or two and displays that limit. Group selection is fixed into a run membership snapshot, not continuously inferred from discovery.

**Two task phases remain:** optional **Plan**, then **Implementation**, or start directly in Implementation. Plan runs in the same clean existing workspace and writes per-agent drafts, then one shared plan, to CoderCrew's data directory rather than the checkout. No planning worktrees, code branches, staging, force-add, or commits are introduced. Use captured versions and explicit results. One-member Plan reaches **Plan ready (solo)**; multi-agent agreement requires the complete current-version required endorsement set. Later N-agent planning preserves N initial drafts plus one unified plan and sequential shared-plan refinement.

**Implementation** uses one recorded branch and commit-based handoffs as the main direction. Each completed commit-mode turn publishes one structured result to CoderCrew's handoff journal and, when it changed project content, one direct handoff commit; a report-only turn publishes no commit. Mirroring the journal into a tracked relay log is an explicit project preference, not the default. Two-member groups use **Peer relay** or **Worker + reviewer**; a one-member group does useful solo work without a fake peer review or implicit self-relay. The old index/worktree path remains deprecated under its frozen migration contract.

**Branch choice is explicit:** reuse the checked-out task branch by default, confirming its recorded baseline when it cannot be inferred; on the default branch or a configured integration branch offer only a customizable new task branch, here or as a task worktree, never continuation there; detached HEAD needs a named branch before commit implementation. Creating a new branch in the existing checkout requires scoped consent at a settled boundary; initial work may preserve its captured uncommitted task changes at the same HEAD, while reviews and Plan require clean entry. Separately, **Create task worktree** creates a new branch and independent checkout at an exact committed baseline, without switching the source or copying dirty changes. Neither operation permits staging, committing or resetting user files.

**Human control and automation stay separate:** automatic collaboration governs eligible successor turns; the optional Plan approval checkpoint governs plan-to-code authorization; branch consent separately governs the branch operation. A frozen final plan and authorization survive draft cleanup. One server owns groups, roles, artifact versions, lifecycle evidence, budgets, recovery, and uniquely consumed transitions. Viewing or discovery changes do not route work.

Start locally with all selected agents in the same canonical cwd/worktree/index. Keep unselected same-worktree agents visible as possible writers. Remote human access already fits the web-console model; future remote workers need explicit host/publication support. A shared Git remote exchanges commits; a PR is optional review/merge integration.

### End-to-end flow

```text
App discovers projects from tmux and remembered local repository identities
    -> Git supplies each project's worktree inventory, including empty checkouts
    -> User chooses an existing worktree or explicitly creates a task worktree
    -> User prepares its environment and starts coding CLIs there
    -> User opens a task group directory and confirms its members
       all eligible preselected; checkboxes choose solo / pair / larger group
       current execution requires 1 or 2; larger selections remain visible
    -> Choose Plan or Implementation and branch intent

Plan (optional)
    -> Per-member drafts under enabled member/concurrency limits
    -> All required outputs finalized; one shared plan
    -> Sequential refinement and exact-version endorsements
       Solo: explicit recommendation, not independent consensus
    -> Human approval when required, otherwise preauthorized normal gate
    -> Freeze final text and authority

Implementation setup
    -> Confirm branch choice if required
    -> Recheck group cwd, worktree/index, baseline, cleanliness, and all affected activity
    -> Create/check out a new branch only when explicitly authorized and needed
    -> Bind branch and implementation group, then dispatch once

Implementation
    -> Solo work OR two-member Peer relay / Worker + reviewer
    -> Validated committed handoffs and applicable review/correction
    -> Final task-level verification
```

### What V4 preserves and changes

V4 retains the Plan/Implementation distinction, ignored planning documents, optional checkpoint, single tracked implementation log, exact revision/decision rules, provider-neutral adapters, N-party planning logic, safe output validation, deprecated-mode contract, and implementation-first rollout recommendation from V3. It revises the affected sections rather than appending a contradictory alternative.

The entry model is now project → worktree → task/group, with solo support and a two-member execution limit separate from larger selections. Environment preparation and agent placement remain user-owned. Explicit task-worktree creation supersedes the earlier no-creation boundary, not the prohibition on automatic provisioning. Detailed permission boundaries, migration consequences, and acceptance scenarios are integrated into the linked ADRs and guides.

## Separate workspaces, groups, phases, policies, and handoffs

### Working vocabulary

| Term | Meaning in this design |
| --- | --- |
| **Project** | A local repository identified by its canonical Git common directory on the host. Matching origins do not combine separate clones. |
| **Worktree** | An independent checkout/index within a project. Identity does not depend on branch; show its path and current branch or detached HEAD. Empty worktrees remain visible. |
| **Workspace / task group directory** | A canonical current-working-directory group beneath a worktree. Collaborators share this cwd; different directories within one checkout share its execution lock. Historical API `repository` fields still contain worktree roots, not project IDs. |
| **Available agents** | Eligible discovered instances in a workspace. This changing inventory is not a running group's membership. |
| **Group** | One or more distinct registered agent instances selected to collaborate in a workspace. Replaces the earlier product term pair. A run binds an exact group membership revision. A separate naming/setup wizard is not required. |
| **Planning group / roster** | The ordered required members assigned to Plan. N-shaped selections; current execution supports one or two, with 3+ including Gemini execution enabled later. |
| **Implementation group** | One eligible instance for solo work, or two distinct instances for Peer relay / Worker + reviewer. It may be a subset of a later larger planning group. |
| **Task** | The objective, requirements, scope, and acceptance target. It may begin with planning and records one implementation branch, always a task branch, plus the permanent task baseline commit. |
| **Run** | A bounded, server-managed execution for a task. It binds the workspace, group snapshots, policies, and selected phase. |
| **Task phase** | Plan or Implementation. Defines the artifact being produced and what edits are permitted, not how many agents are present. |
| **Planning step** | Independent draft(s), unified-plan preparation/refinement, and the implementation approval checkpoint. |
| **Policy revision** | The version of roles, selected groups, allowed actions, continuation policy, and checkpoint settings attached to assigned work. |
| **Turn / assignment** | One action bound to a distinct instance, phase, inputs, and permitted output. Initial draft executions may overlap only on disjoint files under the cap. |
| **Plan candidate** | A captured plan revision/hash associated with its brief, baseline, epoch, and required group revision. |
| **Implementation candidate** | Recorded project content awaiting the applicable review or human verification. A solo output is not independently accepted merely because it was committed. |
| **Handoff / publication** | A completed identified result at the phase's authoritative destination: a captured document plus controller record in Plan; a committed log entry and permitted changes on a local or remote branch in commit relay. |
| **Commit relay** | The preferred implementation handoff contract, including report-only reviews and one direct handoff commit per completed turn. Solo work uses its publication discipline without a fictitious peer. |
| **Uncommitted relay** | Deprecated index/worktree contract: stage accepted incoming work and leave reviewer improvements unstaged. Remains separately frozen. |
| **Lifecycle evidence** | Adapter-specific evidence of correlated execution completion and remaining activity. It is distinct from result publication. |
| **Result channel** | Captured plan result, published handoff result recorded in the journal, or legacy outcome line, according to phase and handoff contract. |
| **Handoff journal** | CoderCrew's durable record of completed implementation turns: identity, decision, findings, reported checks, the resulting commit and its archived patch. App data, exported for backup; never recovered by cloning the repository. |
| **Automatic collaboration** | Whether eligible successors proceed without a click under the server policy. A solo run has no implicit self-relay successor. |
| **Planning epoch** | One planning attempt with identified brief, baseline, and required membership revision; stale attempts cannot fill current slots. |
| **Agent instance / adapter / model** | Registered execution identity / runtime integration / actual configured or observed model. A model or display name never substitutes for an instance identity. |
| **Branch consent** | The user's explicit choice to create a named branch at the validated current commit or continue on the checked-out task branch with its confirmed baseline. Integration branches are excluded. Separate from plan approval. |

One group is not necessarily two agents. It is also not every process found in a workspace. Selected members must be distinct actual executions; one-member groups store one identity once. All examples of three-or-more planners below describe the retained target capability, not the initial UI dispatch limit.

### Workspace, inventory, and bound group are separate

```text
Project -> Worktree -> Task group directory
    -> current available-agent inventory
    -> preselected or user-edited group
    -> Start confirms a frozen run membership snapshot
```

For a fresh task group directory, all eligible agents are included. Every session has a checkbox, so the user can select one, two or more members, or temporarily clear the selection. Unknown or unverified processes cannot be selected. A worktree with one agent directory opens Console directly; with multiple directories, choose the task group first. Empty worktrees show setup guidance. Border/background alone indicates selection. Opening never starts work or persists default grouping.

The current UI uses one workspace group for both phases; each checkbox change persists membership immediately. Inline Name edits save on Enter/blur and cancel on Escape. Discovery proposes exact instances without saving them; Start revalidates and binds them internally. A separate implementation subset belongs to later larger-roster planning, not a second current workspace group.

### Configuration dimensions

| Dimension | Choices | Meaning |
| --- | --- | --- |
| **Project / worktree / directory** | Local project, existing or explicitly created worktree, and group cwd | Navigation follows Git repository/worktree identities; task members still share the same directory. |
| **Selected group** | One or more distinct members; execution currently supports 1–2 | Which available eligible agents participate; not a live subscription to every discovered pane. |
| **Start phase** | Plan; Implementation | Develop a plan first or begin work directly. |
| **Planning procedure** | Per-member drafts, then sequential shared-plan refinement | Cooperative independent opening for 2+ members; solo produces/refines one recommendation without claiming peer agreement. |
| **Future planning membership** | 3+ eligible instances after capability enablement | Retained V3 direction, including Gemini; separate from the current two-member execution limit. |
| **Draft concurrency** | Bounded integer; rollout begins at 1 | Independent of member-count support and unrelated to implementation writer count. |
| **Implementation collaboration** | Solo when one member; Peer relay or Worker + reviewer when two | Solo is derived from group cardinality, not a self-pair or a third peer policy. |
| **Implementation handoff** | Commit relay; deprecated uncommitted relay where compatible | Planning uses neither index tricks nor commits. Do not add solo/N-agent features to the frozen legacy path. |
| **Implementation branch** | Current task branch; confirmed new branch. Never the default or a configured integration branch. | A workspace-level choice, not a property of a pair of terminals. |
| **Implementation publication** | Local only; later shared Git remote | Where a completed implementation handoff is available. |
| **PR integration** | None; optional create/link | Review-and-merge UI, never required for local or remote Git transport. |
| **Automatic collaboration** | Off; on within limits | Whether eligible subsequent assignments proceed automatically. |
| **Plan exit checkpoint** | Require my approval; preauthorized normal transition | Independent of automatic turn-taking and branch-change consent. |

Show the workspace, checked-out branch, group, phase, and actual next actor prominently. Roles and branch setup can be confirmed inline. Remote and PR settings remain secondary. Direct Implementation creates no placeholder drafts or fabricated plan approval.

Keep implementation handoff mode fixed for the execution segment. Plan-to-Implementation is an explicit phase boundary, not an implicit switch between staging and commit algorithms. Group edits and role changes take effect only at settled boundaries; refreshing discovery cannot perform them.

### Three handoff contracts at a glance

| | Plan documents | Commit relay | Uncommitted relay (deprecated) |
| --- | --- | --- | --- |
| Artifact | Draft files and one unified plan in CoderCrew's data directory | Handoff commits on one task branch, journal entries in CoderCrew | The shared index and worktree |
| Result channel | Structured planning result plus controller-captured revision | External result file recorded in the handoff journal (optionally mirrored into a tracked log) | Final `RELAY-OUTCOME` line |
| "Did this turn change anything?" | Captured content hash of the assigned document | Handoff commit diff, excluding the tracked log path when one is kept; no commit means no change | Worktree digest before and after a Send & relay instruction; the outcome line otherwise |
| Git mutations by the agent | None | Stage and commit its own handoff | Stage accepted incoming work only |
| Git mutations by the controller during a turn | None | None; publication validation stays read-only | None |
| Concurrency | N disjoint assignments under enabled membership/concurrency limits; then one unified-plan writer | One writer/publisher per implementation branch, including solo | One writer per shared index |
| Travels between hosts | Only through explicit controller transfer | Push/fetch of the task branch | Never |
| Status | New, second in sequence | New, built first | Frozen; removal after commit relay is accepted |

The engine uses a common normalized lifecycle contract across the columns. Each CLI adapter obtains that evidence from its own supported mechanism. The artifact/result channel differs by phase, and the frozen legacy mode can retain its existing adapter implementation. Never require Gemini to invent Claude `prompt_id` or `background_tasks` fields merely to fit a shared interface.

The setup exceptions to controller read-only Git inspection are **confirmed new-branch checkout** and separately **confirmed task-worktree creation**, as specified in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md). Neither is a planning turn or a change to the frozen staging protocol. Separately confirmed removal of a clean, unused, integrated task worktree, one confirmed squash commit into the integration branch's own clean checkout, and confirmed forced discard of a task worktree and branch are permitted under ADR-0013. No automatic removal, file cleanup, staging, handoff commits, existing-branch resets or history rewrites are permitted.

## Project-centered UI, groups, phases, and actions

### Choose the project and task worktree before the group

The normal path becomes:

```text
Discover local projects
    -> Choose an existing worktree or explicitly create one
    -> Open its task group directory
    -> Check/uncheck members and optionally edit inline names
    -> Choose phase, roles, and automation/checkpoint settings
    -> Resolve branch consent when necessary
    -> Start after fresh validation
```

Do not require "Add pane, add another pane, create a named pair" as the main path. **Group** is the current product term. Registration/identity still exists behind the interface, but validated discovery and the Start confirmation can establish it without a separate wizard for each pane. Show or edit stable labels where needed, especially for multiple instances of one runtime. No new task requires a group name just to begin.

Opening or pinning a card is read-only. It does not start a run, type into terminals, create a branch, or grant all visible agents participation. Several cards can be pinned to a dashboard. Starting tasks on cards sharing one underlying index is still serialized by the same execution lock.

Illustrative initial screen:

```text
PROJECT: CoderCrew
  Main checkout       main                    Claude
  Login fix           codercrew-fix-login      Codex + Claude
  Settings redesign   codercrew-feat-settings  No agents yet
  [Create task worktree]
```

Dirty or blocked workspaces remain visible and readable. Plan and existing-candidate review require clean entry; Commit snapshots current uncommitted work without completing pending requests. On a dirty checkout the author's card, with an empty instruction and the Commit & relay follow-up, offers Commit current changes & relay: snapshot first, then review only the validated new commit. Dirty input alone does not disable it or add a warning during Send. Readiness messages explain other start blockers; failures do not make the workspace disappear. Distinguish no tmux server, no Git workspace, unknown CLI, dirty files, directory mismatch, active/unknown writers, and detached HEAD. **Recheck** reruns discovery/validation; it does not repair the user's environment.

### Default group selection

| Eligible coding-agent instances in the card | Initial behavior |
| --- | --- |
| 0 | Read/diagnostic card may remain; no runnable group or Start. |
| 1 | Select it once as a solo group; checkbox can exclude it. |
| Exactly 2 | Select both as a two-member group automatically; user may explicitly choose solo instead. |
| 3 or more | Select all initially; users can exclude any via checkboxes. Save the complete selection, never truncate to two. Explain the current execution limit before Start. |

The current execution-size limit applies on the server and at Start, not to group selection. Later N-agent planning removes the planning execution cap only after acceptance. Selection and discovery can show all supported instances before every execution combination is enabled; unsupported runtimes remain ineligible.

Suggestions initialize a new selection. Once the user has edited it, polling must not overwrite their choices. Once a run starts, its frozen group determines routing until an explicit boundary-controlled change. Do not auto-add an arriving third agent, replace a missing member, or downgrade an active two-member group to solo.

### Branch selection is an inline workspace decision

Show the actual checked-out branch, not a guess based on what branches exist. On the default branch or a configured integration branch offer only a customizable new task branch (or the task-worktree path), and say why. On a task branch show and reuse it by default, with its inferred task baseline shown for confirmation or entered when the integration branches disagree; a new branch remains an explicit optional action. On detached HEAD require a named branch before commit-based implementation. Details and authority boundaries are in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md).

```text
Current branch: main (integration branch: starting point only)
(o) Create task branch: [crew/improve-planning]
    or create a task worktree in Projects
[Confirm branch choice]

Current branch: crew/improve-planning
(o) Continue on crew/improve-planning
    Task baseline commit: [3f9c…e2a1]  (inferred from main; confirm or correct)
( ) Create task branch: [                    ]
[Confirm branch choice]
```

A branch choice may be included in the clearly labeled Start confirmation rather than a separate dialog. It must still authorize that exact operation/current state, not rely on an invisible default. Collecting it during Plan setup does not switch branches while planners execute. Plan-checkpoint waiver is not branch consent.

### Phase and role setup after selecting the workspace

```text
Workspace:         CoderCrew /Users/hui/Dev/codercrew
Group:             Codex main, Claude architecture
Start phase:       [Plan]
Shared task:       [Describe the requested change...]

After planning:    [Worker + reviewer]
Worker:            Codex main
Reviewer:          Claude architecture

[x] Automatic collaboration
[x] Require my approval before implementation

[Start]
```

For a one-member group, show **Solo** and the selected agent instead of artificial worker/reviewer slots. For a two-member peer group, show both and the first implementer. Roles are not inferred permanently from provider names. The same person may read another panel without changing the actual action target.

The user may reuse an existing worktree or explicitly create one under `~/.codercrew/<repo-name>/<branch-name>`. Preview and confirmation show the exact source identity/commit, new branch and destination; existing paths/branches are not overwritten. A dirty source remains untouched, and its changes are not copied. Creation is separate from Start and does not bootstrap environments or move/start agents. An uncertain result retains setup ownership and requires read-only inspection, never automatic retry or cleanup. Missing agent/environment setup leads to diagnostics and Recheck.

### Later N-agent planning without new onboarding concepts

The group picker already accepts 3+ instances; executing their Plan remains a separate increment, with a separately confirmed one- or two-member implementation subset still to be enabled. Preserve V3's N+1 documents, full-roster draft barrier, same-version endorsement set, and capability checks. Example N=3 progress panels below describe that later execution capability.

The picker displays label, runtime/adapter, known model, and eligibility separately, not fixed vendor columns. Unknown runtimes require identification/verification; several genuine instances of one runtime are allowed. Draft concurrency remains secondary and independent of member-count support: initial dispatch can be sequential before bounded concurrent execution is enabled.

### Plan-phase UI

Use a scrollable participant list or compact cards showing assigned filename, draft state, source/model when known, blockers, and pending guidance. Desktop can show several consoles; mobile selects one without changing run routing. Do not require all N terminal panels to fit at once.

```text
PLAN / Independent drafts       2 of 3 finalized
  Codex main                    Finalized
  Claude architecture           Finalized
  Gemini alternative            Running

PLAN / Shared-plan refinement   Claude reviewing plan v4
  Current v4 endorsements       1 of 3
  Codex main                    Endorsed v4
  Claude architecture           Reviewing v4
  Gemini alternative            Needs review of v4

PLAN / Awaiting approval        3 of 3 endorse plan v4
```

When a new revision is created, show older endorsements as historical/stale rather than erasing their existence or counting them toward the new version. Surface disagreement and blocked adapters as actionable states, not generic "busy" indicators.

Keep a shared task panel and per-agent guidance. Shared requirements update all selected planners at a safe boundary and may reopen stale drafts. Private guidance stays visibly queued until the target's next correlated assignment. Unexpected direct desktop input can require reconciliation; the UI must not pretend it dispatched or correlated that instruction.

The human may inspect initial drafts while the app withholds them from the other agents. Once any peer content was revealed, label further work accurately as informed refinement; an interface toggle cannot restore original independence.

At the checkpoint show the exact final revision/text, all required endorsements (or solo-ready status), objections, brief revision, implementation group, and checked-out/confirmed next branch:

```text
[Approve & implement]   [Request changes]   [Stop]
```

Approving despite objections requires an explicit override acknowledgment preserving the unresolved risks. Native CLI plan approval is not the app's phase gate. With gate off and automation authorized, display that the transition is preauthorized; do not imply that an extra human approval occurred.

### Group cardinality and policy first, implementation actions second

```text
PHASE: IMPLEMENTATION
Collaboration: Worker + reviewer
Worker:        Codex main
Reviewer:      Claude architecture
Other planners: Gemini alternative (not scheduled in this phase)
```

| User intention | Solo implementation | Peer implementation (2) | Worker + reviewer (2) |
| --- | --- | --- | --- |
| Standalone instruction, no automatic successor | Send [agent] | Send [agent] | Send [worker] |
| Instruction, then commit (After send: Commit) | Send & commit [agent] | Send & commit [agent] | Send & commit [worker] |
| Instruction, then commit and review (After send: Commit & relay) | Not offered | Send & commit [agent] → relay [peer] | Send & commit [worker] → relay [reviewer] |
| Snapshot current changes, then stop (empty instruction, After send: Commit) | Commit current changes [agent] | Commit current changes [agent] | Commit current changes [worker] |
| Snapshot current changes, then review (empty instruction, After send: Commit & relay; the relay note goes to the peer) | Not offered | Commit current changes & relay [peer] | Commit current changes & relay [reviewer] |
| Review every commit after a chosen baseline (default: the recipient's last handoff commit or the task baseline; latest: the last commit only; or a typed commit) | Not offered | Review baseline + Relay [peer] | Review baseline + Relay [reviewer] |

Every action names its actual recipients, and each control sits under the pane of the agent that receives its first delivery. Send and Commit start with the card's own agent (under Worker + reviewer, only the designated worker's card); Relay asks the card's own agent to review (the other member's commits, or under Worker + reviewer only in the designated reviewer's card). Plan-refinement controls operate on the assigned document revision and Plan permissions, never Git status. A generic Send cannot grant implementation writes to a planner or a reviewer-only participant.

### Distinct user intentions

- **Start in Plan:** confirms the selected group and settings, then starts its N draft assignments under enabled membership/concurrency limits. It does not authorize source-code edits, branch changes, or selecting every discovered pane.
- **Send:** one standalone instruction with no automatic commit, branch setup, or relay. It uses the same exact-instance confirmation and execution ownership, but does not invoke the commit-handoff skill or require a clean checkout. An explicit user instruction is needed to authorize a commit. Branch and handoff settings apply only to committed relay actions. A saved continuation preference never silently arms a chain or creates a competing writer.
- **Send with After send:** with a relay follow-up, the **Relay note for [peer]** box is sent as `reviewNote` and reaches the peer's review assignment as `note`. *Commit* submits the existing `kind: work` contract with `handoff: false`: the agent implements the instruction and publishes one handoff commit (captured uncommitted input included), then stops. *Commit & relay* uses `handoff: true`: after validated publication with changed project content, the named peer reviews exactly that commit, from the pre-send HEAD, even when later automatic collaboration is off. No review baseline is sent with new work. A turn that changes nothing publishes a report (a journal-only commit when the tracked log is mirrored) and relays nothing. Branch, identity, readiness and ownership gates are those of Commit.
- **Relay:** evaluate the displayed committed range on a clean checkout. The Review baseline selector lists every candidate with a short SHA and subject; the earliest (default) is the newest first-parent commit at which the journal records a completed turn of the recipient's, or the task baseline when it records none on this chain, and the latest is HEAD's parent. A typed baseline requires a read-only commit-list preview before confirmation; the baseline is excluded. Changing or previewing a baseline sends nothing. A changed HEAD or range invalidates readiness. No author/date heuristic chooses commits, and log-only ranges are rejected.
- **Commit current changes & relay:** the dirty-checkout form of Relay snapshots all current project changes without implementing pending requests, then dispatches the named peer only after validated publication and settled completion. The baseline selector remains available: review spans the chosen baseline through the new snapshot. Selecting current HEAD reviews only the current changes; earlier baselines include the intervening committed work. The initial review remains authorized when later automatic collaboration is off. Readiness, branch, identity and ownership gates remain; clean/dirty changes revoke prior readiness.
- **Commit:** snapshot all staged, unstaged and nonignored untracked changes as they stand, publish one handoff commit, then stop without automatic relay in both solo and two-member groups. No new instruction is required; an empty instruction with the Commit follow-up is what selects it, so a typed instruction is never sent as snapshot context. The first assignment has `commitOnly: true`: it must not implement pending requests or edit project content. Unfinished work is described honestly in the published result, not represented as task completion. The controller captures and rechecks the initial worktree fingerprint at setup and delivery; the worker verifies it before publication. A changed input, modified existing log, unresolved conflicts or secrets can block publication without discarding work. A clean checkout has nothing to snapshot; use either explicit Relay action. Every later turn requires clean entry and follows the selected review policy.
- **Automatic collaboration:** enables subsequent eligible assignments within the persisted policy and budget. It does not bypass approval or convert a Send into a collaboration run. The Collaboration settings panel groups it with the optional tracked relay log, the turn budget, **Pause on a reviewer objection** (off by default: an objection is routed back to the author automatically) and, in Plan, the approval gate.
- **Require my approval before implementation:** independently controls the phase gate, with all four setting combinations defined in [Plan approval, phase transition, and final-plan retention](adr/ADR-0016-plan-phase-and-approval.md#plan-approval-phase-transition-and-final-plan-retention).
- **Next relay / Continue:** advances a normal manual waiting state without invoking recovery takeover.

Within one page, drafts, choices, open sections and scroll positions survive tab, view and workspace switches in page memory only (never browser storage; Lock clears them). Readiness and destructive confirmations do not survive a view switch. Browser preferences initialize choices only. Explicit roster, role, scope, gate, and budget changes are controller operations applied at safe boundaries. Tab switches, locks, reconnects, and extra devices do not change them.

## Final design principle

**Choose the project and worktree, confirm the group, and coordinate the work. Users own environments and agent placement; CoderCrew owns confirmed setup, explicit assignments, review, agreement, and progression.**

Phase determines the artifact and edit permission. Group membership determines the participating instances, not every discovered pane. A solo member works once without an invented peer; two members can cooperate as peers or worker/reviewer; later N-member planning requires complete current-version agreement. Workspace grouping follows canonical cwd, while local execution exclusion follows the underlying worktree/index.

Use data-directory documents and captured versions for Plan, the handoff journal and Git for Implementation, adapter-specific evidence for actual execution state, and separate human policies for Plan approval and setup consent. Publication validation remains read-only. Confirmed branch checkout and task-worktree creation are narrow setup exceptions, not automatic worktree lifecycle, environment bootstrap, session relocation or cleanup. Local reliability comes first; remote publication, optional PRs, and multi-host workers remain distinct extensions.
