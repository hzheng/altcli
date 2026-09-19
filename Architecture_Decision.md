# CoderCrew architecture decisions

**Documentation map updated September 19, 2026.** Current runtime behavior and accepted future direction are listed separately.

The current execution boundary is **[ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md)**.
Earlier records explain the design's evolution; their superseded statements are
not claims about the current implementation.

| Record | Current interpretation |
| --- | --- |
| [ADR-0001](docs/adr/ADR-0001-tmux-web-controller.md) | External tmux controller; human-first workflow, optional terminal extension and later supervisor |
| [ADR-0002](docs/adr/ADR-0002-typescript-web-stack.md) | TypeScript web stack, web workspace and SQLite; root wrapper later removed |
| [ADR-0003](docs/adr/ADR-0003-manual-dispatch-boundary.md) | Original manual ownership and uncertain-delivery contract; extended by later records |
| [ADR-0004](docs/adr/ADR-0004-observed-process-identity-and-console-registration.md) | Observed process checks and explicit pane registration; instance generations added by ADR-0011 |
| [ADR-0005](docs/adr/ADR-0005-projects-relay-pairs-and-per-worktree-turns.md) | Multiple sessions and named pairs; actual Git root/index identity now required by ADR-0011 |
| [ADR-0006](docs/adr/ADR-0006-no-root-manifest.md) | Only web/package.json; root scripts run repository operations |
| [ADR-0007](docs/adr/ADR-0007-tmux-by-default.md) | tmux product default; host read-only switch and separate mock testing |
| [ADR-0008](docs/adr/ADR-0008-deliveries-settle-themselves.md) | Delivery-only holds remain transport details; superseded as execution authority by ADR-0011 |
| [ADR-0009](docs/adr/ADR-0009-turn-complete-events-from-cli-hooks.md) | Original hook channel; informational-only and prompt-inference assumptions superseded |
| [ADR-0010](docs/adr/ADR-0010-outcome-line-and-auto-relay.md) | Defines the skill's final outcome line; browser scheduler and transcript fallback superseded |
| [ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md) | Server-owned runs, explicit immutable pairs, correlated events, persistent execution ownership and safe config installation |

See [ROADMAP.md](ROADMAP.md) for implementation versus remaining acceptance, and
[VALIDATION.md](VALIDATION.md) for executed checks. Original roadmap/ADR documents
remain under [docs/history/2026-09-13](docs/history/2026-09-13/), and pre-hardening
operating documents under [docs/history/2026-09-16-pre-hardening](docs/history/2026-09-16-pre-hardening/).

## Accepted collaboration direction (not yet implemented)

The submitted design is now owned by the ADRs and guides below; there is no required standalone collaboration draft. Accepted direction does not mean the UI, endpoints, skills, or permission changes already exist. Recommendations and open choices retain their labels. The current source baseline remains `46f228b16658cd120515e717558d1def2e6e6a57`.

| Record | Decision owned here |
| --- | --- |
| [ADR-0012](docs/adr/ADR-0012-workspace-discovery-and-groups.md) | Workspace-first discovery and explicit groups |
| [ADR-0013](docs/adr/ADR-0013-confirmed-branch-setup.md) | Confirmed branch creation at a settled boundary |
| [ADR-0014](docs/adr/ADR-0014-commit-relay-and-deprecation.md) | Commit relay and staged deprecation of uncommitted relay |
| [ADR-0015](docs/adr/ADR-0015-collaboration-policies-and-solo.md) | Shared collaboration policies and solo execution |
| [ADR-0016](docs/adr/ADR-0016-plan-phase-and-approval.md) | Optional Plan phase and explicit implementation approval |
| [ADR-0017](docs/adr/ADR-0017-phase-orchestration-and-evidence.md) | Phase-aware orchestration, evidence, and recovery |
| [ADR-0018](docs/adr/ADR-0018-remote-publication-and-history.md) | Optional remote publication and deliberate history retention |

Read [WORKFLOWS](docs/WORKFLOWS.md) for vocabulary and UI; [ROADMAP](ROADMAP.md#migration-and-implementation-sequence) for delivery order; [TESTING](docs/TESTING.md#acceptance-scenarios) for the complete acceptance catalog; [SECURITY](docs/SECURITY.md#validation-and-permissions) for validation boundaries; and [OPEN-DECISIONS](docs/OPEN-DECISIONS.md) for unresolved choices. [DESIGN-MIGRATION](docs/DESIGN-MIGRATION.md) maps the retired draft's sections and decision IDs to their maintained homes.

ADR-0001 through ADR-0011 remain historical/current-runtime records without being rewritten to pretend new features shipped. In particular, ADR-0013 records the target branch-setup exception; existing code and the legacy skill still perform no controller Git mutation. `pair` names in historical records or current API/code remain until the versioned group migration; vendor event pairing is a different concept.

## Scope and decision status

This registry preserves the submitted design's decision IDs and status distinctions after migration into maintained documents. Workspace-first groups, solo operation, optional Plan, committed Implementation, human checkpoints, and confirmed branch setup are the target direction. Quota policy and product-name selection remain out of scope; agent, adapter, and model identity remain relevant to attribution and capabilities. The source document and historical versions are provenance, not required reading dependencies. The migration includes targeted pinned-source verification only, not a full repository or installed-host audit or a replay of historical CI. No new runtime implementation or installed-host acceptance is claimed here.

Use these labels when implementing:

| Label | Meaning |
| --- | --- |
| **Agreed direction** | A product or architecture choice established in the discussion. |
| **Working specification** | A concrete way to express the direction, including example fields, labels, and state names. Final serialization and APIs are not yet fixed. |
| **Implementation consequence** | A change logically required by the agreed design, but not a claim that the code already makes it. |
| **Open choice** | A policy or detail that still needs a deliberate decision. Do not silently choose it while implementing an unrelated feature. |
| **Recommendation** | A proposed default or ordering judgment. It is not retroactively labeled a user decision or an observed implementation fact. |
| **Reference-baseline fact** | Behavior verified in source at pinned commit `46f228b`. This does not certify installed-host behavior, completed tests, or a later revision; re-pin before applying the claim to another baseline. |
| **New or reaffirmed user requirement** | Workspace-first discovery, groups, solo usage, user-prepared shared working directory, confirmed branch choice, and eventual 3+ planning including Gemini. The initial selectable group limit is one or two; that rollout limit does not shrink the N-capable model. |

### Decision ledger

| ID | Decision | Status |
| --- | --- | --- |
| D01 | Make commit-based relay the main long-term **implementation** handoff mechanism. | Agreed direction; scope clarified |
| D02 | Deprecate the existing index/worktree (uncommitted) relay: keep it available and unchanged as a local, supervised mode, add no new capabilities to it, and remove it only after commit relay passes host acceptance. | Agreed direction; deprecation contract in [Deprecate the uncommitted relay mode](docs/adr/ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode) |
| D03 | Use one recorded implementation branch and multiple completed-turn commits, not a PR per turn. A dedicated task branch is recommended; explicitly continuing on main/the primary branch is allowed. Planning does not require additional branches. | Retained direction with V4 branch-choice exception |
| D04 | Use one tracked append-only implementation relay log rather than one report file per turn. Plan drafts are separate, ignored working documents. | Agreed direction; scope clarified |
| D05 | In commit-based implementation, publish the new log entry and any permitted project changes in the same handoff commit. Planning turns do not commit. | Agreed direction; scope clarified |
| D06 | Record review judgment explicitly as `accept` or `object`; derive implementation changes from Git and plan changes from versioned document content. | Agreed direction; scope clarified |
| D07 | Distinguish work/proposal turns from reviews; a worker does not approve its own proposal. | Agreed direction |
| D08 | Use explicit revision identities and review ranges, not an unqualified instruction to review the latest commit. | Agreed direction |
| D09 | Support implementation peer relay and worker/reviewer cooperation through shared execution machinery and distinct policies. Shared-plan refinement uses peer relay initially. | Agreed direction; scope clarified |
| D10 | Keep roles and automatic-successor rules on the server for a run or phase. Buttons do not define lasting roles by themselves. | Agreed direction |
| D11 | Allow collaboration-policy or role changes only at an explicit turn boundary or after reconciliation. | Agreed direction |
| D12 | Separate local publication, remote synchronization, and optional PR integration. | Agreed direction |
| D13 | Committed implementation handoffs and versioned plan completions are phase-specific workflow records. Do not treat terminal activity, file existence, or uncorrelated hooks as authority. | Agreed direction; scope clarified |
| D14 | Preserve human control, bounded automation, duplicate suppression, uncertainty, and explicit recovery. | Agreed direction |
| D15 | Build incrementally, without introducing a third AI, native iOS app, or additional service as a prerequisite. | Agreed direction |
| D16 | Introduce optional **Plan** and **Implementation** phases, separate from collaboration policies. The UI may start in either phase. | Agreed direction |
| D17 | Support initial planning by an N-shaped group in one clean, user-prepared workspace, one assigned draft per participant, and a bounded concurrency cap. N may be 1; initial UI dispatch permits at most 2 members, with 3+ planning retained as a later enablement. | Retained N-capable direction plus latest rollout decision; see D28/D40 |
| D18 | Keep planning drafts under a narrowly ignored planning directory. Do not stage, force-add, commit, or create candidate branches during planning. | Agreed direction |
| D19 | Withhold peer draft contents until all required initial drafts are finalized; ignore rules are not read restrictions. | Existing direction generalized to N planners |
| D20 | Preserve N initial drafts and refine one unified plan sequentially: N+1 app-managed working plan documents per task, independent of the number of review turns. | Existing direction generalized to N planners |
| D21 | Require exact-version endorsements from every required planner before multi-agent agreement. No majority/timeout shortcut. N=1 produces a solo plan-ready result, not independent consensus; its approval checkpoint still applies. | Existing invariant extended to solo and later N-party planning |
| D22 | Separate automatic collaboration from **Require my approval before implementation**. The latter is a run-level checkpoint, not a third mode. | Agreed direction |
| D23 | With prior authorization and the checkpoint disabled, agreement may lead automatically into the configured implementation workflow. Unknown state and out-of-scope decisions still stop progression. | Agreed direction |
| D24 | Preserve a frozen final-plan snapshot and its authorization record when entering implementation, even if ignored draft files are later discarded. | Design refinement from the latest discussion |
| D25 | Share the controller, identity, versioning, budgets, and recovery machinery; use phase-specific permissions, result validation, and storage. | Agreed direction |
| D26 | Concurrent planning is a narrow disjoint-file exception, not permission for simultaneous edits to the unified plan, shared index, tracked log, or project content. | Implementation consequence |
| D27 | Build commit relay before Plan based on the comparison in [Product purpose, retained architecture, and comparison with the reference implementation](docs/SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation), whose shipped-code descriptions are verified at the pinned baseline `46f228b`. | Recommendation retained from the supplied revision; baseline pinned by review |
| D28 | Deliver N-capable planning with concurrency=1 first; add bounded parallel execution after assignment, validation, barrier, and recovery logic are ready. Concurrency changes more than dispatch. | Recommendation retained and made concurrency-correct |
| D29 | Planning membership is an explicit roster of registered instances, not two hard-coded CLI kinds. Gemini is a normal participant, not a supervisor. | New user requirement and implementation consequence |
| D30 | Separate the planning group from the implementation group. Implementation uses 1 member for solo work or 2 distinct members for peer/fixed-role collaboration; roles are explicit. Later N-agent planning does not imply N-agent code editing. | V4 scope refinement |
| D31 | Store phase, planning epoch, required roster revision, assignment identities, and version-specific endorsements durably. No silent member removal to obtain agreement. | Proposed working specification |
| D32 | Normalize lifecycle and result evidence through CLI-specific capability adapters. A common engine does not require identical vendor event fields. | Proposed compatibility refinement |
| D33 | Parallel validation permits other active assignments to change their own drafts, while protecting project content, finalized drafts, and unassigned files. Do not infer per-writer attribution from snapshots alone. | Correction to the supplied concurrent-write rule |
| D34 | Use collision-resistant controller-assigned draft paths and verify native plan output permissions without weakening project-write restrictions. | Proposed implementation consequence |
| D35 | Reference-baseline source assertions are pinned to `46f228b`; this design record does not certify installed-host behavior, completed tests, or later revisions. | Evidence qualification |
| D36 | Initial commit relay permits one direct, single-parent handoff commit per turn; multiple unpublished checkpoints on that branch require a future multi-commit protocol. | Correction to an inconsistent first-release lineage contract |
| D37 | Rename the product/API design concept pair to **group**. A group contains distinct registered instances; its identity and membership revision are separate from the selected workspace. | Latest explicit user decision |
| D38 | Discover available workspace cards from live tmux panes grouped by canonical current working directory, with Git worktree/index identity checked underneath. Select a workspace before participants. | Latest user decision and clarification |
| D39 | Count eligible coding-agent instances, not shells, servers, or unknown processes. Detached tmux sessions are discoverable; ambiguous processes need identification before selection. | Implementation consequence of workspace-first discovery |
| D40 | Default to solo for 1 eligible agent and select both for exactly 2. With 3+, require an explicit selection of 2 initially, or a deliberate solo choice. Model N members now; enable larger planning groups later. | Latest user decision with explicit rollout scope |
| D41 | A one-member group contains one instance once, never a self-duplicated pair. Solo work and optional self-review do not claim independent peer agreement or auto-loop into themselves. | Clarification retained from the discussion |
| D42 | The user creates/prepares the worktree and places agents there. CoderCrew does not create/remove worktrees, move/restart sessions, clone repos, or bootstrap environments in this scope. | Latest user decision superseding auto-provisioning |
| D43 | Enforce the same canonical current directory and the same local worktree/index for selected group members. Different subdirectories remain separate UI workspaces even when they share a worktree; their execution lock is shared. | Latest local operating contract |
| D44 | Discovery may refresh, but a running group is an explicit frozen membership snapshot. New/disappeared/moved panes do not silently change participants, roles, or successors. | Retained identity invariant applied to groups |
| D45 | Inspect the workspace's checked-out branch, not the existence of other branches. On main/the configured primary branch offer a new customizable task branch or explicit continuation there. Detached HEAD needs a named branch before commit implementation. | Latest branch-choice decision |
| D46 | Permit only a narrow confirmed controller operation: create and check out a new branch at the validated current commit, at a clean and settled setup boundary. This explicitly amends the prior absolute read-only Git rule. | Latest agreed authority change; ADR required before coding |
| D47 | Plan approval and branch consent are different authorizations. Waiving the Plan checkpoint does not authorize a branch change; branch choice can be collected up front and applied after planning settles. | Implementation consequence |
| D48 | Unselected agents on the same worktree remain potential writers. Surface them and reconcile their activity before branch changes or implementation; exclusion from a group is not filesystem isolation. | Implementation consequence |
| D49 | Opening/pinning a workspace and preselecting a group are read-only UI operations, not authorization to start work or change branches. The Start action confirms the selected group and settings. | UI clarification |
| D50 | Apply workspace-first onboarding and group terminology without altering the deprecated staging protocol; new solo/phase capabilities target the new paths only. | Compatibility consequence |
