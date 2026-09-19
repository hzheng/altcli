# ADR-0016: Optional Plan phase and explicit implementation approval

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: The implementation-only task model; this is additive and does not rewrite the legacy skill.

## Context

The user may ask agents to develop independent plans before coding. Keep drafting lightweight in one clean workspace, preserve initial independence cooperatively, and make the plan-to-code gate explicit.

## Decision

### Optional Plan phase in one shared workspace

#### Purpose, membership, and scope

The Plan phase develops the approach before implementation in the selected user-prepared workspace. Its data model selects **N distinct registered instances, N >= 1**, under the currently enabled group-size limit. Initial UI groups have one or two members. Later N-agent planning can include `codex-main`, `claude-main`, and `gemini-main`; model variety is not mandatory or proof of independent reasoning. Give every selected planner the same brief revision and code baseline, capture its assigned draft, and refine one unified plan. Multi-agent rules in this section apply when N >= 2; the solo specialization is explicit below.

The task can skip Plan when its approach is settled. This is not parallel implementation: no candidate code branches, app-created worktrees, clones, or convergence merge. Selected members must have the same canonical current directory and worktree/index under the local contract. The group roster has its own revision and remains fixed during an epoch unless the human explicitly changes it at a settled boundary. The fact that three eligible panes are visible does not enable N=3 dispatch before that capability is released.

Initially every selected planner is a required participant. Optional advisors or quorum rules are future choices, not implicit behavior. Validate that registrations are distinct executions, not two aliases for the same pane/session. Planning membership must not be inferred from whichever consoles happen to be visible.

#### Entry conditions

Require a clean project state, eligible selected group, common canonical current directory/worktree/index, and no conflicting project writer: no staged changes, unstaged tracked changes, or nonignored untracked project files. Record the current branch or detached state, starting code, and brief revisions. The workspace stays visible when dirty, but Plan dispatch is refused with useful paths. Unselected agents sharing the underlying checkout must not be running conflicting work. Recheck rather than moving them automatically. Never stage, stash, reset, discard, commit, or switch branches around user work.

Set up the planning exclusion before the clean-state test. The controller verifies each exact output path read-only (working specification: `git check-ignore -q -- <path>` once per path, because a multi-path call exits 0 when any one path is ignored, plus `git ls-files -- <path>` to confirm it is not already tracked) and refuses if any path is unignored or already tracked. The human establishes a narrow `.gitignore` rule outside the run, or a repository-local exclude entry that dirties nothing and travels nowhere. The controller does not write Git configuration or ignore rules. The separate confirmed branch-setup exception in [ADR-0013](ADR-0013-confirmed-branch-setup.md) does not authorize ignore-rule edits or Git mutation during planning.

Reject symlinks, special files, or parent paths that escape the canonical worktree. Validate safe registry/task IDs, canonical parents, and collisions before dispatch and before any controller capture or permitted output write. Do not turn a user-supplied label into a filesystem path. Rechecks narrow path races; ordinary same-user filesystem access is not hostile-agent isolation.

A clean check is a point-in-time observation. Recheck project content and HEAD before refinement and implementation; interference triggers reconciliation rather than being blamed automatically on the last completing agent.

#### File layout and ownership

```text
.codercrew/
├── plans/                           # Narrowly ignored, untracked drafts
│   └── <task-id>/
│       ├── draft-<agent-a-id>.md
│       ├── draft-<agent-b-id>.md
│       ├── draft-<agent-c-id>.md      # Present when a third planner is selected
│       ├── ...                       # One initial draft per selected planner
│       └── plan.md                   # Unified plan, after the draft barrier
└── relay-log.md                      # Tracked implementation history
```

There are at most **N initial drafts plus one unified working plan**, regardless of refinement-turn count. N=2 uses up to three files; later N=3 uses up to four. Solo uses its one draft and, when promoted to the common editing surface, `plan.md`; it needs no fake second draft or peer report. A controller copy/promotion of already captured text can avoid a needless synthesis model call. File count follows selected membership, not every available agent in the directory. Historical snapshots and result records live in the controller store, not new per-turn files.

The `draft-` prefix reserves `plan.md` safely even when an agent is registered as `plan`. Safe IDs must be unique under the host's filename comparison rules. Display labels may change without renaming an active assignment. The captured completion also carries registration generation, source session, assignment ID, and planning epoch; a reused filename does not make an old result current.

Ignore only `.codercrew/plans/`, not all of `.codercrew/`. An ignore rule is neither a read restriction nor protection against force-adding a file. Plan turns must not run staging, commit, merge, or branch-switch operations. The agent's own native scratch files are not additional CoderCrew report files; provider-native output locations must be declared and mediated by its adapter, not treated as broad project-write permission.

#### Step A: independent drafts with a complete-roster barrier

The controller creates all selected assignments from the frozen brief, baseline, group/roster revision, and epoch, after checking the enabled member-count limit. `maxConcurrentDrafts` separately limits active execution and begins at 1 during rollout. Initially select N=1 or N=2 even if more candidates are discovered; later support larger rosters without changing this assignment model. Each eligible assignment receives only its designated output path and common inputs.

```text
Read the shared task brief and existing project code.
Write only your assigned draft; do not implement the change.
Do not read any other participant's draft or newly generated findings yet.
Do not modify project files, another draft, plan.md, the index, or the tracked log.
Do not stage, commit, switch branches, or approve a native transition into coding.
Finish through the assigned completion protocol, identifying your exact output.
```

Withhold every peer's new content until **all required draft assignments are finalized**. This applies to summaries, result messages, and task-context updates as well as files. The human can inspect drafts, but is told that sharing another draft with an unfinished planner defeats the cooperative independence claim. Existing long-lived agent context can also contain prior design ideas; do not claim complete epistemic independence.

A draft is finalized only when the assigned result, captured content, permissions, and lifecycle evidence are valid. A file appearing, an unchanged timestamp, or a quiet terminal is not enough. Store completed results by `(epoch, roster revision, registered instance, assignment ID)`, not by a count of arriving callbacks. Three duplicate events from one agent are not three completed planners.

If a planner fails, is canceled, has an unsupported adapter, or exhausts its quota, show that member as blocked. Do not silently reduce N or reveal the group early. The human can retry with a new assignment identity or explicitly change membership at a safe boundary. A membership change records a new revision, preserves available evidence, and invalidates old agreement/transition eligibility. Already revealed content cannot be made unseen by renaming an epoch.

#### Human guidance and shared requirements

Keep a shared task composer and per-agent consoles. Shared requirements or acceptance changes create a new brief revision applicable to all planners. Completed drafts for an old brief are shown as stale, not counted as current without a new correlated reaffirmation or revision. The controller pauses synthesis while required inputs are stale.

Agent-specific guidance is visibly queued and applied at the next safe assignment boundary. It does not silently change the global brief or inject a second prompt into an active turn. Unexpected desktop typing is treated according to the adapter's correlation policy; when reliable correlation is lost, pause and reconcile. Mid-turn supersession or nested assignments require separate lifecycle support and are deferred.

For parallel drafts, queued work for A must not block B or C merely because their output appears later, but shared brief changes affect the whole epoch. Dispatch identity, source session, and allowed output remain specific to each assignment.

#### Output validation: sequential and parallel rules differ

**Correction retained from the design review:** the rule that every nonassigned plan file must be unchanged at every completion is valid for sequential drafting, but false under concurrent drafting. If A completes while B is legitimately updating B's assigned file, B's change is expected. Expanding the same rule to three planners would create more false alarms, not more safety.

Use phase-scoped validation:

| Area | Rule |
| --- | --- |
| Tracked project content, HEAD, index, and nonignored untracked files | Must match the epoch's clean baseline throughout Plan. Obtain changed-path diagnostics from the inspection, not from a hash alone. |
| Completing assignment's draft | Capture stable, bounded content after its execution settles; validate path and assignment; associate the exact bytes with the result. |
| Drafts owned by other currently active assignments | They may change under their own grants. A difference is not attributed to the completing agent and is not itself a violation. |
| Finalized drafts | Immutable until explicitly reopened through a new assignment; changing one invalidates the affected result. |
| Unassigned paths, idle drafts, and plan.md before synthesis | Must not change. Unexpected files are reported, not adopted as extra outputs. |
| Unified-plan refinement | Only one granted writer; every other plan artifact is protected. |

Record ownership intervals and the set of allowed outputs when assignments start and finish. Revalidate the aggregate file set and every finalized hash before opening the draft barrier. A settled assignment cannot continue changing its file while claiming a completed snapshot.

**Detection limit:** filesystem snapshots alone cannot establish who wrote another active planner's file, prove nobody read it, or detect a temporary write that was restored. Skills establish cooperative restrictions; narrow native permissions or an adapter-mediated output writer can strengthen them. Where those are unavailable, label the assurance accurately. Do not claim the validator proves per-writer attribution. A captured file hash is artifact evidence, not a security boundary.

#### Native CLI capabilities and a provider-neutral adapter

CoderCrew's Plan phase is not a vendor's plan-mode switch. Each adapter must establish safe planning permissions, an allowed output path or supported output capture, correlated execution/result evidence, and prevention of premature implementation. Never grant unrestricted project edits merely to get a draft written.

Separate these concepts in registration and history:

| Concept | Example | Role |
| --- | --- | --- |
| Registered instance ID | `gemini-main` | Stable controller identity and assigned output owner. |
| Adapter kind/version | Gemini CLI, installed version recorded | How to dispatch and interpret lifecycle/result data. |
| Model/provider | Runtime-reported Gemini model, or unknown | Attribution and configuration, not turn identity. |
| Instance generation/session | Registration generation and runtime session | Reject stale events and distinguish restarts. |
| Capability profile | Planning output, correlation, handoff evidence | Determines eligible operations; unverified fields do not authorize automation. |

**Previously recorded external context:** Gemini CLI's official Plan Mode documentation describes planning-only write locations, configurable plan storage, and approval that can start implementation. Its hook reference describes `BeforeAgent`/`AfterAgent` with prompt, response, and session information. These are adapter integration points, not evidence that CoderCrew's Gemini adapter exists or is tested. This integration context is retained from the source, not newly verified in this documentation migration. [S3](../SOURCES.md#source-3)[S4](../SOURCES.md#source-4)

Do not reuse Claude's `prompt_id`, Stop schema, or background arrays as mandatory Gemini fields. Map documented native evidence into a normalized contract; mark unsupported correlation or activity evidence unknown. A final-response callback is not proof that every tool, hook-induced retry, or background writer is quiescent. A model hosted by another runtime uses that runtime's contract rather than automatically becoming a Gemini CLI instance.

A read-only output or supervised planning capability can be useful before an adapter qualifies for automatic handoff. Unsupported automation should be visible before starting an unattended run. Native plan approval cannot bypass the CoderCrew checkpoint, and required permission prompts must be handled under explicit user authority.

#### Step B: synthesis and sequential group refinement

When every required draft is finalized for the same inputs, freeze their captured versions. Exactly one designated participant reads the full set and writes `plan.md`. The human can choose the starting idea or provide synthesis guidance; a new supervisory agent is unnecessary. The goal is one coherent approach, not equal inclusion of all drafts.

The synthesizer submits the unified revision as its recommended plan. Other planners then review that captured version in a deterministic sequence. For N>2, use a configured roster order and select a member lacking a current endorsement; do not alternate only between the last two agents. Reading all initial drafts during this step is now intentional.

Only the assigned planner may edit `plan.md`. Code investigation can remain read-only. Review targets are the captured version plus brief/baseline/roster identity, not incoming Git state.

```text
Required planners: A, B, C
A synthesizes and recommends v1.         Endorsed v1: A
B accepts v1 unchanged.                  Endorsed v1: A, B
C improves v1 to v2 and recommends v2.   Endorsed v2: C
A accepts v2 unchanged.                  Endorsed v2: C, A
B accepts v2 unchanged.                  Endorsed v2: C, A, B
All required members endorse v2.         Evaluate the exit checkpoint.
```

One unchanged acceptance by C would be sufficient only if A and B already endorsed that exact version. Old endorsements are not copied forward when the text changes. The N=2 case naturally reduces to the earlier two-agent relay.

#### Solo planning is a one-member specialization

For N=1, dispatch one plan assignment and capture its completed recommendation. The app can promote that exact captured draft to `plan.md` through the validated document-output path, then let the user request refinements from the same agent. A second synthesis/review call is not required merely to imitate the multi-agent procedure. Same-agent follow-up feedback is self-review and must be labeled as such.

The normal solo outcome is **Plan ready**, not independent consensus. Its own explicit recommendation for the current brief/baseline counts as the sole required member's planning result, but not as an independent validation of that result. Require the same settled lifecycle, artifact, scope, and approval rules. With the human checkpoint on, wait for approval; with it off and automatic continuation explicitly authorized, a valid solo plan can transition as preauthorized. Do not silently block solo forever waiting for an imaginary peer, and do not manufacture two endorsements from the same instance.

A solo improvement changes the current plan version and invalidates stale human approval just as any other edit does. Reaching a limit, asking a question, or returning incomplete output is not a reason to start implementation. A later switch to a two-member group is an explicit membership change, not a background discovery update.

#### Result channel and stable capture

Retain the source's working result convention where the adapter can support it: `PLAN-OUTCOME: complete` for draft/synthesis completion, and `PLAN-OUTCOME: accept|object` for refinement, followed by a bounded human explanation. Read it only from the correlated runtime result, never arbitrary screen text. A structured helper payload is an equivalent proposed transport; its acknowledgment, identity, and recovery must be specified and tested.

The controller, not an agent-authored flag, derives document changes from captured content. Keep the input revision reviewed, the output revision if edited, the author recommendation, and the review decision distinct. Capture detailed objection findings from the same identified result; a one-line parser must not discard the actionable explanation.

A valid result can be displayed while lifecycle evidence remains unresolved, but it is not yet eligible for ownership transfer or the draft barrier. Missing/invalid results, partially written files, unsettled assignments, and unknown activity remain incomplete. Result and lifecycle messages may arrive in either order; correlate and combine them once. A snapshot read is bounded and verified against the settled output before being promoted to an authoritative revision.

#### Decisions, agreement, and stopping

**Proposed default for N >= 2:** every required member must endorse the same `(epoch, brief revision, code baseline, group/roster revision, plan revision/hash)` before automatic agreement. A majority, the last two reviewers, or a mere unchanged file cannot substitute for the set. For N=1 the same version tuple binds the solo recommendation and gate, but the UI records **Plan ready (solo)** rather than independent agreement.

| Result | Meaning |
| --- | --- |
| Author recommends a new unified revision | Author endorses that plan; it is not approval of future implementation. |
| Reviewer accepts current revision without edits | Add its endorsement for that exact version; continue until the required set is complete. |
| Reviewer accepts the input and produces an improved plan | New revision; record the editor's recommendation. Previous-version endorsements remain history only. |
| Reviewer objects without edits | Record blockers against the version; pause or use the explicitly chosen correction policy. |
| Reviewer objects and changes the shared plan | Inconsistent under the proposed objection contract; preserve evidence and reconcile. |
| File unchanged but result missing, failed, or interrupted | No agreement or completion. |
| Human edits text, changes requirements, or changes required membership | Invalidate approvals/transition eligibility that no longer match; capture a new applicable version. |

Formatting edits also create new text versions in the initial exact-version policy. Avoid preference-only churn; do not infer semantic equivalence to reuse votes. Reverting to older content does not automatically resurrect approval from an older epoch or revision.

An objection stays unresolved until a subsequent identified review or explicit human decision resolves it. Do not remove it just because the author supplied a correction. Bounded attempts, refinement turns, and repeated-reversal diagnostics prevent infinite negotiation. A limit triggers a human decision, not forced consensus. The default initially avoids weighted votes and variable quorums; a later advisor policy must be explicit.

### Plan approval, phase transition, and final-plan retention

#### Two independent controls

| Control | Meaning |
| --- | --- |
| **Automatic collaboration** | Eligible planning and implementation turns proceed without a click, within the run's limits. |
| **Require my approval before implementation** | Plan agreement must pause at a human checkpoint before entering Implementation. |

The checkpoint is optional; checked by default is the recommended initial UI default. The policy is stored on the server for the run; browser preferences can initialize it but are not the live authority. Changing required membership or the gate is an explicit policy revision, not a convenience checkbox used to exclude a dissenting agent silently. When every required member endorses the current plan (or the one-member group has a valid current solo recommendation):

| Automatic collaboration | Require approval | Next state |
| --- | --- | --- |
| On | On | Await the user's approval; do not begin implementation. |
| On | Off | Freeze the agreed plan and transition automatically, provided all other validation and scope checks pass. |
| Off | On | Await the user's approval; later implementation follows its manual settings. |
| Off | Off | Await an explicit continuation action; a waived approval does not itself enable dispatch. |

Unchecking approval is advance authorization for the normal transition, not permission to bypass blockers, expand scope, erase findings, or override safety and permission requirements. Do not turn the checkpoint off silently to keep automation moving.

#### Human control at the checkpoint

The user sees the unified plan, the selected group's initial draft(s), per-member endorsement or solo-ready status, blockers, assumptions, known limitations, and the implementation group and branch choice, with three actions:

```text
Approve & implement
Request changes
Stop
```

A human may proceed despite missing endorsements or agent disagreement; record that as a deliberate override with the unresolved risk and affected members, not as agreement. This overrides plan judgment, not unresolved active writers, unsafe delivery, or ungranted permissions. Approval applies to the exact version the user saw; a plan edited after display needs review or a fresh approval.

#### Freeze and authorize a specific version

Before the transition, establish that all planning actions and writes have finished or been reconciled, that the expected plan and brief revisions are current, and that the project baseline has not changed. Preserve a final-plan snapshot:

```text
Task and run identity
Planning baseline code revision
Shared brief revision
Final plan revision / content hash / full text
Planning epoch and required roster revision
Per-participant endorsements and unresolved findings
Authorization: human approval OR previously selected automatic policy
Policy revision, implementation group/roles, and adapter eligibility
Bound workspace/instance identities, selected branch, and branch-consent record when needed
Transition identity and timestamp
```

These are working data concepts. A path or a hash alone is insufficient once ignored drafts may be cleaned up; the frozen text is the implementation input, not another mutable plan file. Record the transition once, then dispatch the first implementation action. Concurrent approval clicks, repeated agreement events, reconnects, or a restart must not create a second implementation start.

#### Implementation policy and scope

Select an eligible implementation group before automatic transition: one member means solo work; two distinct members use Peer relay or Worker + reviewer with explicit roles/first actor. A later larger planning group does not force every planner into implementation. For example, Codex + Claude + Gemini can plan, then Codex/Claude can implement while Gemini remains unscheduled and settled. All selected implementation members must already operate in the same canonical workspace; the app neither relocates nor restarts them. A planner without verified implementation capability does not acquire edit authority merely by endorsing a plan.

Resolve the branch choice independently. Existing suitable branches are reused; main/the primary branch requires explicit continuation or confirmation of a new task branch; detached HEAD needs a named branch before commit-based implementation. The app may collect this choice in advance but performs any create-and-switch only after all affected activity settles and the exact baseline/consent still matches. Waiving plan approval does not waive branch consent. Unresolved branch setup leads to a visible setup-wait state, not a failed plan or an automatic branch change. Full rules are in [ADR-0013](ADR-0013-confirmed-branch-setup.md).

The implementation prompt names the frozen plan, task requirements, current code baseline, selected role, and allowed scope. Plan acceptance is not code acceptance; implementation review and final task-level checks still apply. A material departure from the approved approach should be surfaced. Returning to Plan is an explicit phase boundary after implementation writers are settled, and returning from dirty in-progress code needs its own reconciliation policy, not automatic cleanup.

#### Draft retention versus implementation input

The N drafts and the editable unified plan remain ignored during implementation. The planning roster is quiescent before the implementation group gains project-write authority. The ignored files are not incoming code changes, and implementation turns must not modify them to bypass approval. Preserve the frozen plan and authorization record before deleting any working draft; retention depth for intermediate snapshots is an open detail. For remote implementation, the controller delivers the frozen plan with the task or records it once in a tracked implementation-start entry; neither is yet mandatory ([ADR-0018](ADR-0018-remote-publication-and-history.md)).

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
