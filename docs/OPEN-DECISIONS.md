# Open collaboration decisions

This register preserves unresolved choices and explicitly proposed defaults from the reviewed design. Do not resolve them implicitly while implementing an unrelated increment. Related accepted boundaries are indexed in [Architecture_Decision](../Architecture_Decision.md).

## Open choices and intentionally deferred work

| Topic | Current position |
| --- | --- |
| Relay-log path and metadata encoding | Decided September 20, 2026: the journal is CoderCrew app data (`handoff_journal`, one schema-1 result per turn, exported through `/api/v1/history/export`). A tracked mirror is an explicit per-start preference with a configurable nonignored relative path (default `RELAY-LOG.jsonl`, one appended JSON line per turn); ignore rules are not modified. |
| Complete entry schema | Local schema 1 is specified by `HandoffEntry` in the JSON-only contracts and OpenAPI; see ADR-0014's implementation update. Broader schema evolution remains future work. |
| Git publication owner | Agent/authorized helper publishes; controller validation stays read-only. The narrow confirmed new-branch setup exception is implemented locally and recorded in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md); it does not authorize controller commits. |
| Safe completion evidence | Published artifact distinct from process quiescence; CLI-specific background-work policy unresolved. |
| Peer objection automation | Decided September 20, 2026: commit-mode peer relay routes an actionable objection to the author automatically, like worker/reviewer, unless the run's `pauseOnObjection` agreement holds it for Next turn ([Peer relay behavior](adr/ADR-0015-collaboration-policies-and-solo.md#peer-relay-behavior)). |
| Worker disagreement and no-op output | Local log-only work ends the chain without advancing acceptance and retains findings. `needsHuman: true` explicitly pauses for human direction; acceptance cannot set it. Never self-acceptance. |
| Manual next-turn API and state | Plan and Implementation use `waiting` and POST `/api/v1/runs` with `continue`, `expectedCommandId`, and readiness confirmation for assigned successors. Plan approval/changes use a separate exact-version decision endpoint. The deprecated mode remains frozen. |
| Dirty working-directory support | Deferred for commit relay because same-file ownership cannot be reconstructed safely after publication. The deprecated mode retains its existing baseline rules; re-planning after unfinished code still needs an explicit policy. |
| Multi-commit turns and merge commits | One handoff commit per turn first; broader support needs lineage rules. |
| Publication uncertainty and restart reconciliation | Never replay blindly; detailed recovery states to implement. |
| Participant replacement mid-task | Explicit reconciliation, not a pane-ID hot swap. |
| Automatic-turn budget | The local sequential release shares an explicit default-20 automatic-turn budget across Plan and Implementation, with no phase-transition reset. Larger-roster attempt/refinement/run limits remain open. |
| Final integration and log retention | Journal retention is local: each handoff commit's patch is archived at publication and before worktree removal, and exports are the backup. How exported history travels with a PR or to another host, and any pruning policy, remain open. |
| Shared remote, hosting provider, PR timing | Optional and separate; local first. |
| Multi-host worker-control transport | Required beyond Git exchange; not selected. |
| Per-turn CI and final acceptance gate | Focused versus full validation agreed; mandatory checks open. |
| AI supervisor and native iOS | Deferred. Third/additional ordinary planners remain a planned capability, distinct from the initial one/two-member selection limit and not a supervisor. |

Planning details still to specify:

| Topic | Current position |
| --- | --- |
| Plan directory and filenames | Local schema 1 uses `.codercrew/plans/<run-UUID>/draft-<agent-id>.md` plus `plan.md`, all ignored/untracked. Solo initially uses its captured draft as the shared version and creates plan.md only for requested refinement. No per-turn project report files. |
| Ignore-rule setup | Narrow exclusion required and verified read-only; `.gitignore` versus local exclude is the human's choice. This repository's `.gitignore` has excluded `.codercrew/` wholesale since the initial commit, which also hides the once-proposed `.codercrew/relay-log.md`. A tracked mirror there would first need the broad rule narrowed to `.codercrew/plans/`, or another nonignored log path; the default journal needs no ignore change. The controller does not edit ignore rules. |
| Plan completion API/helper | Local schema 1 uses the strict external `<commandId>.result.json` from the assignment, published before lifecycle completion. Matching hooks, activity evidence and stable artifact capture acknowledge it once. Missing/invalid/late results pause without polling or replay. Native provider result integration remains future work. |
| Guidance during drafting | Local Request changes is available at a captured, settled plan boundary, with an explicit target and new shared brief revision. Guidance queues during initial drafting, mid-turn supersession and nesting remain deferred. |
| Native CLI plan-mode integration | Per-adapter host tests for output capture, correlation, allowed writes, activity evidence, and native approval. Gemini is a planned adapter target, not claimed implemented support. |
| Agreement schema | Local contracts persist required-member endorsements for the exact current plan/brief, retain historical endorsements and unresolved objections, and record a deliberate human override reason separately from agreement. No implicit quorum. |
| Plan objection repair routing | Sequential peer refinement is implemented. Objections wait for human Request changes or an explicit override; automatic repair routing remains open. |
| Plan refinement budget | Local sequential release assigns each initial draft once and uses the explicit shared automatic-turn budget (default 20, 1–200) across Plan and Implementation. It never resets on approval. Separately budgeted retries and larger-roster policies remain future choices. |
| Approval setting | Local run-level gate defaults checked, independently from automation. Exact-version approval and deliberate overrides are implemented; changing the live gate/membership remains deferred. |
| Plan snapshots and cleanup | Local final text/authority and captured per-execution results are retained in SQLite; ignored artifacts remain protected throughout Implementation. Cleanup and pruning are not implemented. |
| Task-branch timing | Branch choice may be collected up front; any confirmed create/check-out occurs only after planning settles and the final text/authority is frozen. Plan waiver does not replace consent. Local setup has a persisted once-only claim; automatic ambiguity recovery remains deferred. |
| Final-plan transfer | Local Implementation assignments include the frozen plan and authorization from controller storage, never just a mutable path/hash. Remote transfer remains future work. |
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
| Project/worktree ownership | Explicit confirmed task-worktree creation is now in scope under ADR-0013, defaulting to ~/.codercrew/<repo-name>/<branch-name>. Users still own environments and agent placement; automatic provisioning and cleanup remain excluded. |
| Discovery schema | Projects use canonical common Git directories; each lists branch-independent worktree identities, including empty checkouts, then canonical-cwd task groups. Explicitly used/created projects persist. Additional hosts/sockets and automatic retention policies remain deferred. |
| Process identification | Eligible adapters count toward groups; unknowns need identification. Runtime-specific process detection and how to confirm unsupported installs are not settled by a name match. |
| Group persistence and rename | Product term is group; use distinct-member arrays and versioned run snapshots. Exact tables/endpoints, migration from old pair IDs, and temporary compatibility aliases remain implementation details. |
| Group defaults | All eligible agents are selected initially, with a checkbox on every row and inline names. Larger selections persist; execution still requires one or two. Later N-planning rollout must be explicit. |
| Primary-branch metadata | Show the checked-out branch and default recorded locally in `origin/HEAD`, without fetching. When absent, the configured integration list still applies; never silently switch. Forge-backed metadata remains deferred. |
| Integration branches | Accepted and implemented locally: the default branch and `CODERCREW_INTEGRATION_BRANCHES` are creation bases only, refused as implementation branches on the server and in the picker; existing task branches carry a confirmed baseline; squash integration is the recommended completion path and is offered locally as a confirmed one-commit squash into the integration branch's own checkout (ADR-0013, September 20, 2026). Protected-branch discovery from a forge and remote publication remain future work. |
| Setup operations | Existing-checkout branch setup retains its clean/settled worktree owner. Separate task-worktree creation persists exact consent and a project setup owner, and exposes read-only uncertain-result inspection. Confirmed unused integrated-worktree removal, confirmed squash integration and confirmed forced discard have their separate ADR-0013 authorities. No automatic removal, automatic retry or rollback is authorized; force is used only by the explicitly confirmed discard. |
| Branch-consent lifetime | Consent is scoped to the shown workspace/branch/baseline/name. Changed inputs require revalidation/new choice; no stay-on-integration preference is permitted by the current policy. |
| Solo self-review | Plain solo work is in scope. A separately requested, clearly labeled self-review is optional; no autonomous self-revision loop or fake independent approval is selected. |
| N-agent release gate | Keep N-capable assignments/endorsements now; the user-facing planning cap is lifted only with explicit acceptance. Gemini adapter eligibility is independent of group size. |
| External writers | Detect known conflicting runs and expose unselected same-worktree agents. Exact external activity evidence remains adapter/host-specific; do not claim OS isolation. |
