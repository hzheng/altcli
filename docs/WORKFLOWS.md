# Workspace and collaboration workflows

Status: target product design, not the current operating guide. For the existing console use [SETUP](SETUP.md). Decisions are owned by the [ADR index](../Architecture_Decision.md); implementation status is in [ROADMAP](../ROADMAP.md).

## Executive decision

CoderCrew's main entry point is **a workspace**, not a sequence of manually registered panes and named pairs. Discover eligible coding-agent panes on the configured tmux server, group them by canonical current working directory within a Git worktree, and let the user open or pin a workspace. The app validates the user's existing workspace and agent placement; it does not create worktrees or move sessions.

**Group replaces pair.** A fresh workspace with one eligible instance defaults to a solo group; exactly two defaults to both selected; three or more requires choosing two initially, with a deliberate solo option. No duplicate identity is used to represent self-pairing. The registry and planning state remain N-shaped so 3+ planning can be enabled later without another protocol. Group selection is fixed into a run membership snapshot, not continuously inferred from discovery.

**Two task phases remain:** optional **Plan**, then **Implementation**, or start directly in Implementation. Plan uses per-agent ignored drafts in the same clean existing workspace, followed by one shared plan. No planning worktrees, code branches, staging, force-add, or commits are introduced. Use captured versions and explicit results. One-member Plan reaches **Plan ready (solo)**; multi-agent agreement requires the complete current-version required endorsement set. Later N-agent planning preserves N initial drafts plus one unified plan and sequential shared-plan refinement.

**Implementation** uses one recorded branch and commit-based handoffs as the main direction. Each completed commit-mode turn publishes one direct handoff commit containing one appended entry in the tracked relay log and any permitted project changes. Two-member groups use **Peer relay** or **Worker + reviewer**; a one-member group does useful solo work without a fake peer review or implicit self-relay. The old index/worktree path remains deprecated under its frozen migration contract.

**Branch choice is explicit:** reuse the checked-out non-primary branch by default; on main/the configured primary branch offer a customizable new task branch or explicit continuation there; detached HEAD needs a named branch before commit implementation. The controller may create and check out a new branch only after scoped user consent, at a clean settled boundary, starting at the validated current commit. This is a narrow amendment to the previous read-only Git rule, not worktree management or permission to stage/commit/reset user files.

**Human control and automation stay separate:** automatic collaboration governs eligible successor turns; the optional Plan approval checkpoint governs plan-to-code authorization; branch consent separately governs the branch operation. A frozen final plan and authorization survive draft cleanup. One server owns groups, roles, artifact versions, lifecycle evidence, budgets, recovery, and uniquely consumed transitions. Viewing or discovery changes do not route work.

Start locally with all selected agents in the same canonical cwd/worktree/index. Keep unselected same-worktree agents visible as possible writers. Remote human access already fits the web-console model; future remote workers need explicit host/publication support. A shared Git remote exchanges commits; a PR is optional review/merge integration.

### End-to-end flow

```text
User prepares workspace/worktree and starts coding CLIs there
    -> App discovers Git workspace cards and eligible panes
    -> User opens a workspace and confirms a group
       1 eligible: solo / 2: preselect both / 3+: choose 2 or solo initially
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

The new decisions simplify entry and responsibility: workspace-first selection, **groups**, solo support, an initial two-member selection cap with future N support intact, user-owned worktree/environment preparation, and a narrow branch-consent operation. The earlier suggestion of automatic implementation-worktree provisioning is explicitly superseded. Detailed permission boundaries, migration consequences, and acceptance scenarios are integrated into the linked ADRs and guides.

## Separate workspaces, groups, phases, policies, and handoffs

### Working vocabulary

| Term | Meaning in this design |
| --- | --- |
| **Project** | The repository context and shared task conventions. One project may have several user-created worktrees. |
| **Workspace** | A discoverable canonical current-working-directory group on a known host, associated with an actual Git worktree/root/index. The UI groups by directory; locking follows the underlying worktree/index. |
| **Available agents** | Eligible discovered instances in a workspace. This changing inventory is not a running group's membership. |
| **Group** | One or more distinct registered agent instances selected to collaborate in a workspace. Replaces the earlier product term pair. A run binds an exact group membership revision. A separate naming/setup wizard is not required. |
| **Planning group / roster** | The ordered required members assigned to Plan. N-shaped in the data model; one or two selected initially, with 3+ including Gemini enabled later. |
| **Implementation group** | One eligible instance for solo work, or two distinct instances for Peer relay / Worker + reviewer. It may be a subset of a later larger planning group. |
| **Task** | The objective, requirements, scope, and acceptance target. It may begin with planning and records one implementation branch, normally a task branch or the explicitly chosen current primary branch. |
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
| **Result channel** | Captured plan result, committed relay-log entry, or legacy outcome line, according to phase and handoff contract. |
| **Automatic collaboration** | Whether eligible successors proceed without a click under the server policy. A solo run has no implicit self-relay successor. |
| **Planning epoch** | One planning attempt with identified brief, baseline, and required membership revision; stale attempts cannot fill current slots. |
| **Agent instance / adapter / model** | Registered execution identity / runtime integration / actual configured or observed model. A model or display name never substitutes for an instance identity. |
| **Branch consent** | The user's explicit choice to create a named branch at the validated current commit or continue on the checked-out primary branch. Separate from plan approval. |

One group is not necessarily two agents. It is also not every process found in a workspace. Selected members must be distinct actual executions; one-member groups store one identity once. All examples of three-or-more planners below describe the retained target capability, not the initial UI dispatch limit.

### Workspace, inventory, and bound group are separate

```text
Workspace card
    -> current available-agent inventory
    -> preselected or user-edited group
    -> Start confirms a frozen run membership snapshot
```

For a fresh workspace selection, one eligible agent defaults to solo, exactly two default to a two-member group, and three or more require an explicit choice of two before larger groups are supported. The user may deliberately reduce a suggested group to solo. Unknown or unverified processes are not counted as ready coding agents. Selecting or pinning a workspace never starts work.

Groups can be created or remembered behind the Start action; users need not add panes and create a named group one at a time. Stable group/instance IDs remain internal. Separate `planningGroupId`/`implementationGroupId` or one group with phase-specific membership snapshots are both possible storage choices; the membership and generation actually used by each phase must be unambiguous.

### Configuration dimensions

| Dimension | Choices | Meaning |
| --- | --- | --- |
| **Workspace** | Discovered Git working-directory cards, optionally pinned | Where already-running agents operate; the user prepares it. |
| **Selected group** | Solo or 2 distinct members initially | Which available eligible agents participate; not a live subscription to every discovered pane. |
| **Start phase** | Plan; Implementation | Develop a plan first or begin work directly. |
| **Planning procedure** | Per-member drafts, then sequential shared-plan refinement | Cooperative independent opening for 2+ members; solo produces/refines one recommendation without claiming peer agreement. |
| **Future planning membership** | 3+ eligible instances after capability enablement | Retained V3 direction, including Gemini; not part of the initial two-member UI limit. |
| **Draft concurrency** | Bounded integer; rollout begins at 1 | Independent of member-count support and unrelated to implementation writer count. |
| **Implementation collaboration** | Solo when one member; Peer relay or Worker + reviewer when two | Solo is derived from group cardinality, not a self-pair or a third peer policy. |
| **Implementation handoff** | Commit relay; deprecated uncommitted relay where compatible | Planning uses neither index tricks nor commits. Do not add solo/N-agent features to the frozen legacy path. |
| **Implementation branch** | Current non-primary branch; confirmed new branch; explicitly retained primary branch | A workspace-level choice, not a property of a pair of terminals. |
| **Implementation publication** | Local only; later shared Git remote | Where a completed implementation handoff is available. |
| **PR integration** | None; optional create/link | Review-and-merge UI, never required for local or remote Git transport. |
| **Automatic collaboration** | Off; on within limits | Whether eligible subsequent assignments proceed automatically. |
| **Plan exit checkpoint** | Require my approval; preauthorized normal transition | Independent of automatic turn-taking and branch-change consent. |

Show the workspace, checked-out branch, group, phase, and actual next actor prominently. Roles and branch setup can be confirmed inline. Remote and PR settings remain secondary. Direct Implementation creates no placeholder drafts or fabricated plan approval.

Keep implementation handoff mode fixed for the execution segment. Plan-to-Implementation is an explicit phase boundary, not an implicit switch between staging and commit algorithms. Group edits and role changes take effect only at settled boundaries; refreshing discovery cannot perform them.

### Three handoff contracts at a glance

| | Plan documents | Commit relay | Uncommitted relay (deprecated) |
| --- | --- | --- | --- |
| Artifact | Ignored draft files and one unified plan | Handoff commits on one task branch | The shared index and worktree |
| Result channel | Structured planning result plus controller-captured revision | Appended entry in the tracked relay log | Final `RELAY-OUTCOME` line |
| "Did this turn change anything?" | Captured content hash of the assigned document | Handoff commit diff excluding the log path | Worktree digest before and after a Send & relay instruction; the outcome line otherwise |
| Git mutations by the agent | None | Stage and commit its own handoff | Stage accepted incoming work only |
| Git mutations by the controller during a turn | None | None; publication validation stays read-only | None |
| Concurrency | N disjoint assignments under enabled membership/concurrency limits; then one unified-plan writer | One writer/publisher per implementation branch, including solo | One writer per shared index |
| Travels between hosts | Only through explicit controller transfer | Push/fetch of the task branch | Never |
| Status | New, second in sequence | New, built first | Frozen; removal after commit relay is accepted |

The engine uses a common normalized lifecycle contract across the columns. Each CLI adapter obtains that evidence from its own supported mechanism. The artifact/result channel differs by phase, and the frozen legacy mode can retain its existing adapter implementation. Never require Gemini to invent Claude `prompt_id` or `background_tasks` fields merely to fit a shared interface.

The sole V4 exception to controller read-only Git inspection is **confirmed new-branch creation and checkout outside active turns**, as specified in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md). It applies to setup for the new workflow, not to a planning turn or the frozen legacy staging protocol. It does not permit worktree creation, file cleanup, staging, commits, existing-branch resets, or history rewrites.

## Workspace-first UI, groups, phases, and actions

### Replace pane-by-pane onboarding with workspace selection

The normal path becomes:

```text
Discover workspace cards
    -> Open or pin an existing workspace
    -> Confirm suggested group (or choose members when there are 3+)
    -> Choose phase, roles, and automation/checkpoint settings
    -> Resolve branch consent when necessary
    -> Start after fresh validation
```

Do not require "Add pane, add another pane, create a named pair" as the main path. **Group** is the current product term. Registration/identity still exists behind the interface, but validated discovery and the Start confirmation can establish it without a separate wizard for each pane. Show or edit stable labels where needed, especially for multiple instances of one runtime. No new task requires a group name just to begin.

Opening or pinning a card is read-only. It does not start a run, type into terminals, create a branch, or grant all visible agents participation. Several cards can be pinned to a dashboard. Starting tasks on cards sharing one underlying index is still serialized by the same execution lock.

Illustrative initial screen:

```text
AVAILABLE WORKSPACES

CoderCrew
/Users/hui/Dev/codercrew
Branch: feature/planning      Clean
Agents: Codex main, Claude architecture
[Open]

TimedGoal
/Users/hui/Dev/timedgoal
Branch: main                  Clean
Agent: Codex main              Solo suggested
[Open]

MindFlow
/Users/hui/Dev/mindflow
Branch: feature/capture       2 modified paths
Agents: Codex, Claude, Gemini
[Choose group]
```

Dirty or blocked workspaces remain visible and readable. Readiness messages explain why a new Plan/commit run cannot start; failures do not make the workspace disappear. Distinguish no tmux server, no Git workspace, unknown CLI, dirty files, missing planning ignore rule, directory mismatch, active/unknown writers, and detached HEAD. **Recheck** reruns discovery/validation; it does not repair the user's environment.

### Default group selection

| Eligible coding-agent instances in the card | Initial behavior |
| --- | --- |
| 0 | Read/diagnostic card may remain; no runnable group or Start. |
| 1 | Select it once as a solo group. |
| Exactly 2 | Select both as a two-member group automatically; user may explicitly choose solo instead. |
| 3 or more | Do not take the first two by incidental order. Ask the user to select two for the initial release, with a deliberate solo option. Show the remaining agents as unselected. |

The current group-size limit applies on the server as well as the picker. It is a release limit, not a list/registry capacity limit. Later N-agent planning removes the planning cap only after acceptance; the same picker can then select Codex + Claude + Gemini while keeping implementation membership at one or two. Discovery can show capabilities and all candidate instances before every combination is supported.

Suggestions initialize a new selection. Once the user has edited it, polling must not overwrite their choices. Once a run starts, its frozen group determines routing until an explicit boundary-controlled change. Do not auto-add an arriving third agent, replace a missing member, or downgrade an active two-member group to solo.

### Branch selection is an inline workspace decision

Show the actual checked-out branch, not a guess based on what branches exist. On main/the configured primary branch offer a customizable new task branch or explicit continuation on the current branch. On a non-primary branch show and reuse it by default; a new branch remains an explicit optional action. On detached HEAD require a named branch before commit-based implementation. Details and authority boundaries are in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md).

```text
Current branch: main
(o) Create task branch: [crew/improve-planning]
( ) Continue on main; this task's commits will land there
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

The user's original workspace/worktree and CLI placement are prerequisites. The UI neither advertises automatic environment bootstrap nor creates/moves worktrees or agent sessions. Missing setup leads to actionable diagnostics and Recheck.

### Later N-agent planning without new onboarding concepts

Once enabled, the planning group picker can contain 3+ instances; the implementation group remains a separately confirmed one- or two-member selection. Preserve V3's N+1 documents, full-roster draft barrier, same-version endorsement set, and capability checks. Example N=3 progress panels below describe that later capability. The initial release uses the same component at N=1 or N=2.

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
| Standalone instruction, no automatic successor | Send | Send | Send |
| Evaluate the assigned incoming candidate | Optional explicit Self-review, labeled non-independent | Relay | Review |
| Implement, then request a peer's initial review | Not applicable; do not create a self-relay | Send & relay | Send & review |

Review targets the designated reviewer; Send & review starts with the designated worker. Plan-refinement controls operate on the assigned document revision and Plan permissions, never Git status. A generic Send cannot grant implementation writes to a planner or a reviewer-only participant.

### Distinct user intentions

- **Start in Plan:** confirms the selected group and settings, then starts its N draft assignments under enabled membership/concurrency limits. It does not authorize source-code edits, branch changes, or selecting every discovered pane.
- **Send:** one standalone instruction. A saved continuation preference never silently arms a chain or creates a competing writer.
- **Relay / Review:** evaluate the explicit incoming artifact; an empty composer supplies no extra context, not an absent target.
- **Send & relay / Send & review:** request initial work and its successor when there is a new project proposal. The proposed log-only work behavior of [Review decisions and derived change status](adr/ADR-0014-commit-relay-and-deprecation.md#review-decisions-and-derived-change-status) avoids pointless review loops; an independent request to review an existing candidate remains possible.
- **Automatic collaboration:** enables subsequent eligible assignments within the persisted policy and budget. It does not bypass approval or convert a Send into a collaboration run.
- **Require my approval before implementation:** independently controls the phase gate, with all four setting combinations defined in [Plan approval, phase transition, and final-plan retention](adr/ADR-0016-plan-phase-and-approval.md#plan-approval-phase-transition-and-final-plan-retention).
- **Next relay / Continue:** advances a normal manual waiting state without invoking recovery takeover.

Browser preferences initialize choices only. Explicit roster, role, scope, gate, and budget changes are controller operations applied at safe boundaries. Tab switches, locks, reconnects, and extra devices do not change them.

## Final design principle

**Discover the workspace, confirm the group, and coordinate the work. Users own environments and agent placement; CoderCrew owns explicit assignments, review, agreement, and progression.**

Phase determines the artifact and edit permission. Group membership determines the participating instances, not every discovered pane. A solo member works once without an invented peer; two members can cooperate as peers or worker/reviewer; later N-member planning requires complete current-version agreement. Workspace grouping follows canonical cwd, while local execution exclusion follows the underlying worktree/index.

Use ignored documents and captured versions for Plan, the tracked log and Git for Implementation, adapter-specific evidence for actual execution state, and separate human policies for Plan approval and branch consent. Read-only publication validation remains the rule; creating/checking out a new branch at a validated settled boundary is the sole confirmed setup exception. No automatic worktree lifecycle, environment bootstrap, session relocation, or cleanup is required. Local reliability comes first; remote publication, optional PRs, and multi-host workers remain distinct extensions.
