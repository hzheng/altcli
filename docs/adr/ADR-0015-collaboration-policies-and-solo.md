# ADR-0015: Shared collaboration policies and solo execution

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: The participant/action scope of ADR-0011 when the new policies are implemented.

## Context

One controller should support peers who improve, a fixed worker/reviewer group, and useful solo work without representing one instance as two peers.

## Decision

## Unify execution and separate collaboration policies

One controller, common identity/decision concepts, history, budgets, and duplicate/recovery machinery serve both phases, with phase-specific artifact adapters and validators. Both implementation policies share the implementation report schema. No policy and no phase requires another service.

| Action | Responsibility | Project-edit permission |
| --- | --- | --- |
| `work` | Implement an instruction or revise a proposal. | Yes, within task scope. |
| `review` | Evaluate the exact incoming proposal and report a decision. | No; only the relay-log entry may change. |
| `review_and_improve` | Evaluate incoming work; after accepting it, optionally improve it. | Yes after acceptance; none on objection. |

The policy answers, deterministically and without a third model: who acts next, which action they perform, whether they may change project content, and whether the result continues, finishes, waits for a click, or needs a person. Roles belong to a run or phase, not to an agent; Git authorship is not role assignment.

Planning adds "draft independently", "synthesize the shared plan", and "review/improve the shared plan". The draft roster is N-sized; synthesis and refinement each have one assigned writer. Whether these are separate enums or phase-qualified uses of `work` and `review_and_improve` is an implementation choice; their permissions are fixed: a draft action writes only its assigned file, shared refinement writes only `plan.md`.

| Concern | Plan | Commit-mode implementation |
| --- | --- | --- |
| Review target | Captured plan revision/hash and brief version | Explicit code baseline/candidate SHAs |
| Editable output | Assigned ignored draft or unified plan | In-scope project files according to role |
| Decision record | Structured controller-held result | Appended entry in the tracked log |
| Version history | Controller snapshots/records | Git commits plus log |
| Initial concurrency | N assigned drafts, at most `maxConcurrentDrafts` active (parallel execution added in the last planning step) | One writer/publisher per task workspace |
| Later progression | Sequential peer refinement and approval checkpoint | Peer relay or fixed worker/reviewer policy |

Document storage is not a third user-facing relay mode; the phase supplies artifact and permission rules. Multi-agent planning extends the existing phase rather than adding an N-agent supervision product. Initial implementation groups have one or two distinct members: solo work for one; peer or fixed worker/reviewer cooperation for two. More-than-two-agent implementation remains deferred. A group is the participant abstraction, not a requirement to add two role slots.

### One-member groups: solo execution without fictitious peers

A solo group contains one registered instance exactly once. It uses the same phase permissions, task/branch identity, lifecycle/result validation, clean-entry checks, committed log, history, and recovery as the corresponding new workflow. It does not schedule "the other member" as itself, fabricate two approvals, or enable Worker + reviewer with identical IDs.

For Plan, see [Optional Plan phase in one shared workspace](ADR-0016-plan-phase-and-approval.md#optional-plan-phase-in-one-shared-workspace)'s solo specialization. For Implementation, the default action is `work` followed by normal completion or a human question. A changed result is a published candidate, not an independently accepted result. A separate user-requested self-review may use `review`, tagged as self-review; it is not a peer review and does not arm an endless automatic work/review loop. Keep review provenance visible and require the selected task-level/human checks rather than promoting self-assessment to independent acceptance. Exact optional self-review UI is secondary; plain solo work is sufficient initially.

Automatic collaboration can still perform a preauthorized Plan-to-Implementation transition for a solo group when every gate passes. It cannot create a peer successor that does not exist. Direct Send remains standalone in either cardinality. Group cardinality and collaboration controls must be validated server-side, not merely hidden in the browser.

**Capability boundary, working specification:** an adapter can declare inspected/tested support for registered-session dispatch, plan output capture, exact request/result association, lifecycle/activity evidence, and safe phase transition. The controller enables actions from those capabilities, not from a name such as `gemini` or from the model's own claim. A common normalized result can include `assignmentId`, registration generation, source session/turn identity where available, input/output artifact references, decision, and activity evidence. Exact APIs are open; absent evidence must not be fabricated.

## Peer relay behavior

This implementation policy requires a group of **two distinct eligible instances**. Both may review and improve project content; a one-member group uses the solo rules rather than relaying to itself:

```text
A: work
    ↓
B: review_and_improve
    ↓
A: review_and_improve
    ↓
B: review_and_improve
```

With automatic continuation enabled:

| Completed review | Next action |
| --- | --- |
| Accept with project improvements | Send the new proposal to the other peer as `review_and_improve`. |
| Accept with only a log entry | Finish this review chain; final task-level verification remains. |
| Object with only a log entry | Provide the findings to the author without layering reviewer edits onto rejected work; whether the correction is dispatched automatically follows the continuation policy, below. |
| Invalid or uncertain result | Pause; do not infer success or publish a successor. |

At `46f228b` the shipped uncommitted mode returns an actionable objection to the author as a bounded correction instruction (verified in [Product purpose, retained architecture, and comparison with the reference implementation](../SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)). Under that behavior, an objection returns to the author as a bounded correction instruction when continuation is on, and returns changed work to the reviewer (ADR-0011; the deprecated mode keeps this). Whether commit-mode peer relay adopts the same rule was not finalized. The recommended default is to adopt it, so that peer relay and worker/reviewer differ only in who may edit project content and whether roles alternate, and an objection is not the one outcome that always needs a click. An objection without an actionable reason, or with findings outside the delegated scope, pauses for the human in either policy.

In commit relay, when continuation is manual, the controller makes the valid next handoff explicit and waits; a deliberate manual handoff is not error recovery. Shared-plan refinement borrows sequential peer behavior across its selected N-member roster, but compares plan versions, and plan acceptance routes to the checkpoint rather than finishing the run. The deprecated mode keeps the verified reference-baseline pause/takeover behavior under [Deprecate the uncommitted relay mode](ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode)'s frozen contract.

## Worker and reviewer behavior

This implementation policy requires **two distinct group members**, with one worker and one reviewer. The same instance cannot fill both roles. The assignment is persistent for the run or policy revision:

```text
Worker:   Codex
Reviewer: Claude Code
```

```text
Worker implements or revises a proposal.
    ↓
Reviewer evaluates it without project edits.
    ├── Accept → finish the review chain.
    └── Object with actionable, in-scope findings
              ↓
         Worker revises the proposal.
              ↓
         Reviewer evaluates the revised proposal.
```

Roles do not swap after each turn. "Reviewer does not change anything" means no project changes; the reviewer still appends and commits its log entry, which is how the controller learns its conclusion. With automatic continuation, actionable findings return to the worker and a completed revision returns to the reviewer without a click; missing requirements, permission expansion, or decisions outside delegated scope return to the human.

The worker explains its treatment of findings and publishes evidence; a dispute or an inability to address a blocking finding is not self-approval (encoding open). Advisory feedback is distinguishable from blocking findings so that preference-only comments do not force another editing turn. If a reviewer publishes project edits, the controller refuses the handoff as a role violation rather than switching to peer relay or accepting the edits because they look useful.

A run may plan with three or more peer participants and then explicitly select two eligible instances for this fixed-role loop; the worker/reviewer assignment becomes active only at the authorized phase boundary.

## Role changes and phase boundaries

The user may switch between peer relay and worker/reviewer, or swap worker and reviewer, during a task without a new branch. Apply the change at a boundary:

```text
Request a collaboration or role change.
    ↓
Prevent scheduling additional turns under the old policy.
    ↓
Let the active turn finish, or reconcile an explicit interruption.
    ↓
Record the new policy revision and role assignments.
    ↓
Continue under the new revision.
```

An executing turn keeps the permissions under which it started; a peer allowed to edit is not retroactively judged a reviewer because a dropdown changed. Represent task phase, planning step, and policy revision explicitly: a role change increments the policy revision without changing the phase, and Plan to Implementation additionally requires the authorization gate. A phase or role change never resets the budget, erases unresolved findings, or grants permissions silently. Rebinding a restarted worker or replacing a participant requires explicit reconciliation (exact behavior open). During Plan, all selected N participants are initial proposers; refinement has one assigned writer at a time. Implementation roles take effect only after the authorized transition.

**Workspace discovery versus group membership:** new or disappearing panes update the inventory only. The run stores a group ID/membership revision and exact instance generations. Changing the selected group for the next task does not change an active run. Adding, removing, replacing, or moving a current member requires a settled boundary and explicit reconciliation; group reduction to solo is not automatic recovery. A required planner's failure cannot be converted into agreement by a background roster refresh.

If a bound member changes current directory, branch context, runtime/session identity, or worktree, pause rather than following or relocating it. The user restores the intended placement or explicitly prepares a new eligible group. Renaming a display label alone does not rewrite historical assignment identity. Branch setup is a separate consented transition and never part of a mid-turn role dropdown change.

**Planning membership changes:** add/remove/replace a required planner only through an explicit boundary-controlled policy change. Persist the new roster revision; invalidate stale agreement and approvals; do not reinterpret existing callbacks as results of the replacement instance. Preserve old drafts in controller history before reusing their working paths. Cancel or settle every affected assignment before reclaiming its file. The initial implementation requires all selected members, so dropping an unavailable or dissenting agent is a visible human choice, not an automatic quorum reduction.

A model configuration change is also not an identity-free operation. Record the actual runtime/model used by each turn; explicitly requested provider/model changes apply at boundaries. Built-in provider fallback is recorded when observable, and otherwise remains unknown rather than guessed. Different model labels are not evidence of independent votes from different sessions.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
