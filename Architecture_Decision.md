# CoderCrew architecture decisions

**Updated September 19, 2026.** The new local Implementation path implements the
commit contract of ADR-0014, solo/peer/fixed-role policies of ADR-0015, and the
confirmed new-branch exception of ADR-0013. The project-centered entry layer adds
Git common-directory identity, complete worktree inventory and explicit task-worktree
creation. SQLite v8 retains uncertain creation/removal operations while preserving the v5 mapping of
historical pairs into groups and guards against an implementation-only scheduler
opening phase-aware runs. ADR-0011 remains the lifecycle/ownership
boundary and the legacy staging contract. The local sequential Plan path now
implements captured plan documents, exact-version endorsements and the approval
gate of ADR-0016, using ADR-0017's ownership and transition invariants. Larger
rosters, native plan-mode integrations and remote paths remain future direction;
installed-host acceptance remains outstanding.

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

The submitted design is owned by the ADRs and guides below; there is no required
standalone collaboration draft. Their implementation updates identify local
Plan/Implementation support; remote publication and other unimplemented portions
remain design direction. Recommendations and open choices retain their labels.
The historical staging compatibility baseline remains `46f228b16658cd120515e717558d1def2e6e6a57`.

| Record | Decision owned here |
| --- | --- |
| [ADR-0012](docs/adr/ADR-0012-workspace-discovery-and-groups.md) | Project-centered discovery, worktrees and explicit groups |
| [ADR-0013](docs/adr/ADR-0013-confirmed-branch-setup.md) | Confirmed branch checkout and task-worktree creation |
| [ADR-0014](docs/adr/ADR-0014-commit-relay-and-deprecation.md) | Commit relay and staged deprecation of uncommitted relay |
| [ADR-0015](docs/adr/ADR-0015-collaboration-policies-and-solo.md) | Shared collaboration policies and solo execution |
| [ADR-0016](docs/adr/ADR-0016-plan-phase-and-approval.md) | Optional Plan phase and explicit implementation approval |
| [ADR-0017](docs/adr/ADR-0017-phase-orchestration-and-evidence.md) | Phase-aware orchestration, evidence, and recovery |
| [ADR-0018](docs/adr/ADR-0018-remote-publication-and-history.md) | Optional remote publication and deliberate history retention |
| [ADR-0019](docs/adr/ADR-0019-terminal-input-and-checkpoints.md) | Explicit terminal input, whole-run holds and evidence-bound checkpoint recovery |

Read [WORKFLOWS](docs/WORKFLOWS.md) for vocabulary and UI; [ROADMAP](ROADMAP.md#migration-and-implementation-sequence) for delivery order; [TESTING](docs/TESTING.md#acceptance-scenarios) for the complete acceptance catalog; [SECURITY](docs/SECURITY.md#validation-and-permissions) for validation boundaries; and [OPEN-DECISIONS](docs/OPEN-DECISIONS.md) for unresolved choices. [DESIGN-MIGRATION](docs/DESIGN-MIGRATION.md) maps the retired draft's sections and decision IDs to their maintained homes.

ADR-0001 through ADR-0011 remain historical/current-runtime records without being rewritten to pretend new features shipped. ADR-0013 owns the confirmed branch/worktree setup exceptions; the legacy staging path still performs no controller Git mutation. Historical `repository` fields and pair IDs retain their worktree-scoped meaning; project navigation does not rewrite frozen runs or vendor event pairing.

## Scope and decision status

This registry preserves the submitted design's decision IDs and status distinctions after migration into maintained documents. Project-centered task groups, solo operation, optional Plan, committed Implementation, human checkpoints, and confirmed branch/worktree setup are the direction. Quota policy and product-name selection remain out of scope; agent, adapter, and model identity remain relevant to attribution and capabilities. Source and historical versions are provenance, not required reading dependencies. Local implementation and executed checks are recorded separately in VALIDATION; this registry does not claim installed-host acceptance.

Use these labels when implementing:

| Label | Meaning |
| --- | --- |
| **Agreed direction** | A product or architecture choice established in the discussion. |
| **Working specification** | A concrete way to express the direction, including example fields, labels, and state names. Final serialization and APIs are not yet fixed. |
| **Implementation consequence** | A change logically required by the agreed design, but not a claim that the code already makes it. |
| **Open choice** | A policy or detail that still needs a deliberate decision. Do not silently choose it while implementing an unrelated feature. |
| **Recommendation** | A proposed default or ordering judgment. It is not retroactively labeled a user decision or an observed implementation fact. |
| **Reference-baseline fact** | Behavior verified in source at pinned commit `46f228b`. This does not certify installed-host behavior, completed tests, or a later revision; re-pin before applying the claim to another baseline. |
| **New or reaffirmed user requirement** | Project → worktree → task/group navigation, common-Git-directory identity, visible empty worktrees, explicit task-worktree creation under ~/.codercrew, no registration UI, checkbox membership, inline names and user-prepared shared agent cwd. Selection is not capped at two; current execution remains one/two-member. |

### Decision ledger

| ID | Decision | Status |
| --- | --- | --- |
| D01 | Make commit-based relay the main long-term **implementation** handoff mechanism. | Agreed direction; scope clarified |
| D02 | Deprecate the existing index/worktree (uncommitted) relay: keep it available and unchanged as a local, supervised mode, add no new capabilities to it, and remove it only after commit relay passes host acceptance. | Agreed direction; deprecation contract in [Deprecate the uncommitted relay mode](docs/adr/ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode) |
| D03 | Use one recorded task branch and multiple completed-turn commits, not a PR per turn. Default/configured integration branches are creation bases only; integrate accepted results separately, preferably by squash. Planning does not require additional branches. | Integration-branch policy supersedes the earlier primary-branch opt-in; ADR-0013 |
| D04 | Record each implementation turn in CoderCrew's append-only handoff journal (app data with export and pre-cleanup archiving); a tracked relay log is an explicit project preference, not the default (ADR-0014, September 20, 2026). Plan drafts are separate, ignored working documents. | Agreed direction; revised |
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
| D18 | Keep planning drafts in CoderCrew's data directory, outside the checkout, so no project ignore rule is needed. Do not stage, force-add, commit, or create candidate branches during planning. | Agreed direction; revised September 21, 2026 from a narrowly ignored in-checkout directory ([ADR-0016](docs/adr/ADR-0016-plan-phase-and-approval.md)) |
| D19 | Withhold peer draft contents until all required initial drafts are finalized; document placement is not a read restriction. | Existing direction generalized to N planners |
| D20 | Preserve N initial drafts and refine one unified plan sequentially: N+1 app-managed working plan documents per task, independent of the number of review turns. | Existing direction generalized to N planners |
| D21 | Require exact-version endorsements from every required planner before multi-agent agreement. No majority/timeout shortcut. N=1 produces a solo plan-ready result, not independent consensus; its approval checkpoint still applies. | Existing invariant extended to solo and later N-party planning |
| D22 | Separate automatic collaboration from **Require my approval before implementation**. The latter is a run-level checkpoint, not a third mode. | Agreed direction |
| D23 | With prior authorization and the checkpoint disabled, agreement may lead automatically into the configured implementation workflow. Unknown state and out-of-scope decisions still stop progression. | Agreed direction |
| D24 | Preserve a frozen final-plan snapshot and its authorization record when entering implementation, even if working draft files are later discarded. | Design refinement from the latest discussion |
| D25 | Share the controller, identity, versioning, budgets, and recovery machinery; use phase-specific permissions, result validation, and storage. | Agreed direction |
| D26 | Concurrent planning is a narrow disjoint-file exception, not permission for simultaneous edits to the unified plan, shared index, a tracked log, or project content. | Implementation consequence |
| D27 | Build commit relay before Plan based on the comparison in [Product purpose, retained architecture, and comparison with the reference implementation](docs/SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation), whose shipped-code descriptions are verified at the pinned baseline `46f228b`. | Recommendation retained from the supplied revision; baseline pinned by review |
| D28 | Deliver N-capable planning with concurrency=1 first; add bounded parallel execution after assignment, validation, barrier, and recovery logic are ready. Concurrency changes more than dispatch. | Recommendation retained and made concurrency-correct |
| D29 | Planning membership is an explicit roster of registered instances, not two hard-coded CLI kinds. Gemini is a normal participant, not a supervisor. | New user requirement and implementation consequence |
| D30 | Freeze phase membership separately, while the current UI uses the same sole workspace group for both phases. A separate implementation subset is retained for later larger planning rosters; N-agent planning does not imply N-agent code editing. | Refined by the one-group workspace decision |
| D31 | Store phase, planning epoch, required roster revision, assignment identities, and version-specific endorsements durably. No silent member removal to obtain agreement. | Proposed working specification |
| D32 | Normalize lifecycle and result evidence through CLI-specific capability adapters. A common engine does not require identical vendor event fields. | Proposed compatibility refinement |
| D33 | Parallel validation permits other active assignments to change their own drafts, while protecting project content, finalized drafts, and unassigned files. Do not infer per-writer attribution from snapshots alone. | Correction to the supplied concurrent-write rule |
| D34 | Use collision-resistant controller-assigned draft paths and verify native plan output permissions without weakening project-write restrictions. | Proposed implementation consequence |
| D35 | Reference-baseline source assertions are pinned to `46f228b`; this design record does not certify installed-host behavior, completed tests, or later revisions. | Evidence qualification |
| D36 | Initial commit relay permits one direct, single-parent handoff commit per turn; multiple unpublished checkpoints on that branch require a future multi-commit protocol. | Correction to an inconsistent first-release lineage contract |
| D37 | Use **group** for all cardinalities: one member is solo, two a pair, three or more a larger group. Exact instance binding remains internal; no per-agent registration step is required. | Latest explicit user decision |
| D38 | Discover projects through canonical shared Git metadata, then enumerate their worktrees through Git and groups through tmux cwd. Origins are not identities; empty worktrees remain visible. | Latest project-centered user decision |
| D39 | Count eligible coding-agent instances, not shells, servers, or unknown processes. Detached tmux sessions are discoverable; ambiguous processes need identification before selection. | Implementation consequence of workspace-first discovery |
| D40 | One group per workspace, all eligible agents included by default. Every session has a membership checkbox; saved selections may contain 3+ agents. Add an inline Name column instead of Register/Rename buttons. Click anywhere on a card to select it and open Console; border/background alone marks selection. Current execution limits remain explicit, separate from selection. | Latest user UI clarification; larger execution remains a separate increment |
| D41 | A one-member group contains one instance once, never a self-duplicated pair. Solo work and optional self-review do not claim independent peer agreement or auto-loop into themselves. | Clarification retained from the discussion |
| D42 | Users prepare environments and agent placement. CoderCrew may explicitly create a confirmed new task branch/worktree, defaulting under ~/.codercrew/<repo-name>/<branch-name>; no automatic provisioning, removal, session relocation, cloning or environment bootstrap. Confirmed integrated-worktree removal, confirmed squash integration into the integration branch's own checkout, confirmed forced discard, and unowned moved-pane discovery are separate accepted exceptions. | Latest user decision superseding the no-creation boundary |
| D43 | Enforce the same canonical cwd and local worktree/index for collaborators. Different subdirectories are task groups beneath one worktree and share its lock; linked worktrees have independent locks. Branch names do not define identity. | Project navigation with the retained local execution contract |
| D44 | Discovery may refresh, but a running group is an explicit frozen membership snapshot. New/disappeared/moved panes do not silently change participants, roles, or successors. | Retained identity invariant applied to groups |
| D45 | Inspect the workspace's checked-out branch, not the existence of other branches. On the default or a configured integration branch offer only a new task branch or task worktree. Existing task branches retain a confirmed or unambiguously inferred baseline; detached HEAD needs a named branch before commit implementation. | Integration-branch policy; ADR-0013 |
| D46 | Permit scoped confirmed new-branch checkout at a settled boundary, preserving captured unfinished input for initial work or requiring clean entry otherwise, and separately new task-branch/worktree creation at an exact committed baseline without touching dirty source files. Durable setup ownership, no overwrite, retry, rollback or cleanup. | Authority defined in ADR-0013 |
| D47 | Plan approval and branch consent are different authorizations. Waiving the Plan checkpoint does not authorize a branch change; branch choice can be collected up front and applied after planning settles. | Implementation consequence |
| D48 | Unselected agents on the same worktree remain potential writers. Surface them and reconcile their activity before branch changes or implementation; exclusion from a group is not filesystem isolation. | Implementation consequence |
| D49 | Opening/pinning a workspace and preselecting a group are read-only UI operations, not authorization to start work or change branches. The Start action confirms the selected group and settings. | UI clarification |
| D50 | Apply project/worktree navigation and group terminology without altering the deprecated staging protocol; new solo/phase capabilities target the new paths only. | Compatibility consequence |
