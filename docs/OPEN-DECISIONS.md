# Open collaboration decisions

This register preserves unresolved choices and explicitly proposed defaults from the reviewed design. Do not resolve them implicitly while implementing an unrelated increment. Related accepted boundaries are indexed in [Architecture_Decision](../Architecture_Decision.md).

## Open choices and intentionally deferred work

| Topic | Current position |
| --- | --- |
| Relay-log path and metadata encoding | Single tracked append-only file agreed; working path `.codercrew/relay-log.md`; parser/schema to finalize. |
| Complete entry schema | Identity, action, revisions, judgment, reasons, evidence, `parent` and `base` agreed conceptually; exact required fields and versioning open. |
| Git publication owner | Agent/authorized helper publishes; controller validation stays read-only. The narrow confirmed new-branch setup exception is recorded in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md); its implementation is pending and it does not authorize controller commits. |
| Safe completion evidence | Published artifact distinct from process quiescence; CLI-specific background-work policy unresolved. |
| Peer objection automation | Preserve actionable-objection routing where verified in the legacy baseline; worker/reviewer routing is part of the new design. Adopting the same rule for commit-mode peer relay is recommended, not decided ([Peer relay behavior](adr/ADR-0015-collaboration-policies-and-solo.md#peer-relay-behavior)). |
| Worker disagreement and no-op output | Never self-acceptance; log-only work returns to the human ([Review decisions and derived change status](adr/ADR-0014-commit-relay-and-deprecation.md#review-decisions-and-derived-change-status)); exact reporting/escalation encoding open. |
| Manual next-turn API and state | Commit relay and Plan need no takeover for normal progression; enum and endpoint open. The deprecated mode remains frozen. |
| Dirty working-directory support | Deferred for commit relay because same-file ownership cannot be reconstructed safely after publication. The deprecated mode retains its existing baseline rules; re-planning after unfinished code still needs an explicit policy. |
| Multi-commit turns and merge commits | One handoff commit per turn first; broader support needs lineage rules. |
| Publication uncertainty and restart reconciliation | Never replay blindly; detailed recovery states to implement. |
| Participant replacement mid-task | Explicit reconciliation, not a pane-ID hot swap. |
| Automatic-turn budget | The default-20 implementation budget is verified in source at `46f228b`. Proposed planning attempt/refinement/run limits must account for N; numeric defaults remain open. |
| Final integration and log retention | How main history and the review archive are preserved. |
| Shared remote, hosting provider, PR timing | Optional and separate; local first. |
| Multi-host worker-control transport | Required beyond Git exchange; not selected. |
| Per-turn CI and final acceptance gate | Focused versus full validation agreed; mandatory checks open. |
| AI supervisor and native iOS | Deferred. Third/additional ordinary planners remain a planned capability, distinct from the initial one/two-member selection limit and not a supervisor. |

Planning details still to specify:

| Topic | Current position |
| --- | --- |
| Plan directory and filenames | Ignored directory, N drafts plus one unified plan. Proposed `draft-<safe-id>.md` mapping avoids plan.md collisions; exact path is a working convention. |
| Ignore-rule setup | Narrow exclusion required and verified read-only; `.gitignore` versus local exclude is the human's choice. |
| Plan completion API/helper | Preserve source's `PLAN-OUTCOME` convention where supported; normalize via provider-specific correlated runtime result or equivalent helper. Capture full bounded findings and artifact versions. Exact API/acknowledgment/recovery needs implementation. |
| Guidance during drafting | Boundary-queued correlated assignment in the first release. Safe mid-turn supersession or nesting is deferred rather than ambiguously binding one completion to two commands. |
| Native CLI plan-mode integration | Per-adapter host tests for output capture, correlation, allowed writes, activity evidence, and native approval. Gemini is a planned adapter target, not claimed implemented support. |
| Agreement schema | Recommended initial rule is all required N members endorsing the current tuple; exact representation of recommendations, blocker resolution, and human overrides needs specification. No implicit quorum. |
| Plan objection repair routing | Sequential peer refinement chosen; automatic return-to-author versus escalation open. |
| Plan refinement budget | Bounded, persistent, and N-aware; draft attempts, refinement turns, overall cap, and numeric defaults remain proposed implementation choices. |
| Approval setting | Run-level optional gate; default checked recommended; live change/withdrawal semantics to define. |
| Plan snapshots and cleanup | Frozen final text and authorization retained; intermediate retention depth and cleanup timing open. |
| Task-branch timing | Branch choice may be collected up front; any confirmed create/check-out occurs only at a clean settled setup boundary, typically before Implementation. Plan waiver does not replace consent. Exact operation persistence/recovery schema remains to implement. |
| Final-plan transfer | Controller task input or a one-time tracked implementation-start record; ignored drafts never assumed to sync. |
| Remote planning | Needs explicit draft transport; same-workspace local planning first. |
| Generalized phases | Only Plan and Implementation; no workflow editor. |
| Planning versus implementation membership | First selected groups contain 1 or 2; N-shaped model retained. Later Plan may select 3+ while Implementation stays solo or 2 with explicit roles. N-agent code scheduling remains deferred. |
| Required versus advisory planning members | Initially all selected planners are required. Advisor/weighted/quorum options need separate product decisions. |
| Draft concurrency limit | N-shaped model now; initial selectable membership cap 2 and draft concurrency 1 are separate rollout constraints. Increase either only after its tests; numeric final concurrency default remains open. |
| Concurrent-write assurance | Correct snapshot validation excludes legitimate active peer outputs. Strong per-writer enforcement requires mediated writes or runtime permissions; same-user instructions are not isolation. |
| Capability verification record | Adapter/version/capability scope, observed evidence, and manual fallback policy need storage/UI design. |
| Reference implementation | Pinned at `46f228b` by the relay review of the supplied design ([Product purpose, retained architecture, and comparison with the reference implementation](SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)). Re-pin before using shipped-code assertions against a later baseline. |

None of this reopens the central choice: lightweight ignored planning documents, an optional approval gate, then the selected implementation collaboration and handoff mechanism.

### Workspace/group details still to implement

| Topic | Decided boundary and remaining detail |
| --- | --- |
| Workspace ownership | User prepares worktree, dependencies, branch placement, and agent cwd; app does not auto-provision or clean them. No open auto-worktree choice in this version. |
| Discovery schema | Canonical cwd cards plus underlying worktree/index identity and exact pane binding are required; stable workspace IDs, refresh interval, and configured-socket discovery UI remain to implement. |
| Process identification | Eligible adapters count toward groups; unknowns need identification. Runtime-specific process detection and how to confirm unsupported installs are not settled by a name match. |
| Group persistence and rename | Product term is group; use distinct-member arrays and versioned run snapshots. Exact tables/endpoints, migration from old pair IDs, and temporary compatibility aliases remain implementation details. |
| Group defaults | 1 solo, 2 preselected, 3+ choose 2/solo initially. Discovery capacity is not the enabled dispatch limit; later N-planning rollout must be explicit. |
| Primary-branch metadata | Show checked-out branch and known/configured primary. Exact metadata source and fallback for ambiguous default need a documented policy; never silently switch. |
| Branch operation | New branch plus checkout at the consented current commit only. Name validation, operation receipt, idempotency, timeout recovery, and audit UI need implementation; no force/reset or worktree API is authorized. |
| Branch-consent lifetime | Consent is scoped to the shown workspace/branch/baseline/name. Changed inputs require revalidation/new choice; whether to remember a stay-on-primary preference for later tasks remains an explicit UX choice, not implicit permission. |
| Solo self-review | Plain solo work is in scope. A separately requested, clearly labeled self-review is optional; no autonomous self-revision loop or fake independent approval is selected. |
| N-agent release gate | Keep N-capable assignments/endorsements now; the user-facing planning cap is lifted only with explicit acceptance. Gemini adapter eligibility is independent of group size. |
| External writers | Detect known conflicting runs and expose unselected same-worktree agents. Exact external activity evidence remains adapter/host-specific; do not claim OS isolation. |
