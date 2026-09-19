# CoderCrew roadmap

**Documentation update: September 19, 2026.** The existing milestones below describe the `46f228b` source baseline. The [migration sequence](#migration-and-implementation-sequence) is planned work, not completion evidence. Task phases Plan/Implementation are distinct from the older milestone headings.

Updated September 16, 2026. Source implementation and acceptance are separate.
Current architecture: [ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md).
Historical pre-hardening roadmap: [snapshot](docs/history/2026-09-16-pre-hardening/ROADMAP.md).

## Phase 1: Manual web console

Implemented source: TypeScript frontend/backend in one Next.js workspace; direct
tmux capture and guarded input; explicit pane registration and instance generation;
canonical worktree grouping; named pair selection; authenticated API; SQLite delivery
records; explicit readiness; uncertainty without replay. No root package.json.

Acceptance remaining: re-run real installed Codex and Claude sessions after hook
updates, including permission dialogs, CLI exits, partial input, Unicode, and
same-worktree discipline. Do not equate mock tests with that acceptance.

## Phase 2: Private iPhone access

Implemented source: responsive console and server-owned workflow state. A page can
reconnect and inspect current runs without reconstructing ownership in the browser.

Remaining: production HTTPS Tailscale Serve configuration, narrow tailnet policy,
physical Safari/iPhone disconnect/reconnect and simultaneous desktop access; token
lifecycle and host availability review. Native iOS remains reserved under ios/.

## Phase 3: Deterministic review coordination

Implemented source in the hardening PR: persisted runs and executions; explicit
immutable participants; unique command and source-turn correlation; idempotent event
receipts; one atomic next-turn plan and dispatcher claim; persistent turn budget;
execution ownership separate from transport; pause and human takeover; restart
pauses without replay. Browser views never implement the scheduler.

Current Stop payload replaces lagging transcript fallback. Missing/active background
state pauses; legacy follow-up events cannot advance anything. Codex notify carries no
quiescence evidence, so the server supplies differential process evidence for Codex
turns (processes newly associated with the pane that survive completion). With the
run's continuation policy enabled, an actionable strong objection becomes a bounded
instruction to the author and changed corrective work returns to review.

Remaining acceptance: installed-version hook fixtures and supervised mixed-agent
relay, complete fault-injection sequence, non-browser lifecycle intake, restart and
two-device verification. Remaining features: Git fingerprints for review outcomes
(the worktree digest currently gates only Send & relay handoffs), handoff scope
validation, final task-level review/test automation, and deliberate resume
semantics. Do not make these automatic by trusting outcome prose alone.

## Optional later branches

Full browser terminal (xterm.js/node-pty) only when snapshot interaction proves
insufficient. Third AI supervisor only after deterministic ownership and reliable
lifecycle evidence; advisory first, bounded actions, no unrestricted terminal tool.
Native Swift/iOS consumes the host API later; it does not execute local coding CLIs.

## Release gate

All regression/build/browser checks green; host acceptance documented against an
exact commit and CLI versions; backups and installer recovery verified; remaining
limitations visible in README and SECURITY. Keep a runtime-feature PR draft until that evidence
supports its intended use. No timetable or autonomous milestone is implied.

---

## Migration and implementation sequence

This retains the source protocol ordering: commit relay before Plan, and sequential planning before concurrent drafting. V4 adds a workspace/group entry-layer increment and narrow branch-consent setup; these do not require a new orchestrator or auto-worktree manager. Initial phase groups are solo or two members, while the registry and assignment model remain N-shaped. Larger planning groups and concurrent drafting have separate release gates. No implementation or CI status is claimed. The reference baseline is pinned in [Product purpose, retained architecture, and comparison with the reference implementation](docs/SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation); re-pin before compatibility work against a later revision.

### Mapping from the reference run model

| Reference-baseline concept described by the source | Proposed evolution |
| --- | --- |
| Earlier `RelayRun`, participants, explicit two-member association, `autoContinue`, budget, pause, run status | Evolve to workspace-bound group snapshots with member arrays, solo semantics, task phase, planning epoch/step, roster revision, and phase-specific roles. Do not equate available workspace inventory with the group, or a planning group with the implementation selection. |
| One `currentCommandId` | Retain for sequential code/refinement turns. Introduce an N-shaped draft-assignment map with concurrency=1 first; later permit multiple active members rather than overwriting one ID. |
| Canonical local-index workspace lock | Retain as local competing-run exclusion. Within the run grant disjoint draft paths. Future remote task/publication ownership is not an absolute-path comparison. |
| Command marker, prompt echo, source-turn correlation, instance/session binding, deduplication, dispatcher claim | Retain invariants. Native fields and evidence extraction are runtime-specific, including Gemini; do not copy one vendor's schema into every adapter. |
| Claude Stop-payload background evidence and Codex differential process evidence, both present at `46f228b` ([Product purpose, retained architecture, and comparison with the reference implementation](docs/SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)) | Retain as the lifecycle evidence for those adapters; unknown remains unknown. Host acceptance of the observational Codex evidence for unattended use is still open. |
| `RELAY-OUTCOME` final line | Preserve for the frozen legacy mode. New Plan uses correlated structured results or the proposed `PLAN-OUTCOME` convention; commit relay uses the committed entry. |
| Four legacy outcome values | Legacy only. New review decisions are accept/object plus observed changes; planning work completion is not an acceptance of implementation. |
| Read-only worktree digest | Reuse inspection concepts for Plan baseline checks and code leftovers. Parallel validation needs active-output exceptions and explicit attribution limits. |
| `relay`/`instruction` plus initial-handoff intent | Phase-qualified assignments; shared user intentions and mode-aware labels remain. |
| Actionable-objection correction path, present at `46f228b` | Preserve the legacy contract; automatic peer correction remains a recommendation for the new path ([Peer relay behavior](docs/adr/ADR-0015-collaboration-policies-and-solo.md#peer-relay-behavior)). |
| Restart pauses and never blindly replays | Extend recovery to N assignments, frozen snapshots, endorsements, and unique phase transitions. |
| No controller Git mutation | V4 explicitly amends this only for confirmed new-branch creation/check-out at a clean settled boundary. Publication stays read-only; agent/helper commits stay separate; worktree/environment management stays with the user. |

### Entry-layer increment: workspace discovery, groups, and consent

Replace per-pane/named-association onboarding with read-only tmux workspace discovery and a group picker. The primitives exist at `46f228b`: the adapter lists every pane on the configured socket with `list-panes -a` (detached sessions included) and reports each pane's command and cwd; `resolveWorktree` returns the canonical root, git directory, and index for a cwd; and the process policy identifies known Codex and Claude commands, refuses a denylist of shells and generic interpreters, and otherwise reports `other`. The increment adds adapter-backed eligibility checks for `other` processes, grouping by canonical cwd, checked-out branch inspection, and the picker itself. Use canonical cwd for cards, canonical worktree/index for locks, and stable instance IDs for membership. Show all candidate agents without permitting unknown processes or unsupported cardinalities to run. Initial defaults: one becomes solo; two are preselected; three or more require a deliberate choice of two or solo. Group validation is server-side.

Preserve historical data and live-run identities through a versioned migration from any earlier pair-based storage/API. The current target UI, new schema, and documentation use `Group`/`groupId` (working names). Exact table/endpoint names and temporary backward-compatible aliases are implementation choices. Do not rewrite the meaning of historical events, collapse real members, or modify vendor prompt/turn correlation merely because its English term is also "pairing." Removing the setup wizard does not remove exact registration or lifecycle binding. Legacy behavior can be reached through a compatibility mapping rather than being silently generalized to solo.

Add branch status display and explicit primary-branch/detached handling. Implement the new-branch operation under [ADR-0013](docs/adr/ADR-0013-confirmed-branch-setup.md)'s narrow authority: one consent and one settled transition, no force/reset or auto-provisioning. Missing directories or mismatched agents yield Recheck diagnostics.

**Exit:** workspace cards reflect eligible panes and actual cwd/branch; selection defaults work for 0/1/2/3+; selected groups freeze at Start; different-directory cards sharing an index cannot start conflicting runs; no Git write occurs on discovery or workspace opening. Existing-worktree and environment setup remains the user's responsibility. This increment can precede or accompany Step 1 without adding new behavior to the legacy staging protocol.

### Step 1: local commit relay

Specify log path/schema, clean entry/pre-dispatch, exact parent and review ranges, one direct handoff commit, permitted diff, leftovers, and publication. Use the user-prepared workspace and recorded implementation branch with existing tmux agents. Implement plain solo work and two-member peer relay, normal manual waiting, bounded continuation, and unique result consumption. Solo never schedules a duplicate instance as its peer. Write a separate commit-relay skill; do not modify the legacy staging contract.

**Exit:** proposals and report-only reviews behave correctly; wrong parents, hidden intermediate commits, leftovers, contradictory structured results, and duplicates are handled explicitly. No user work is adopted automatically; routine manual progression needs no takeover.

### Step 2: fixed worker/reviewer implementation

Use `work`, `review`, and `review_and_improve` with persistent roles in a two-member implementation group and mode-aware UI. A one-member group remains solo; reject identical worker/reviewer IDs. Planning membership is not required yet.

**Exit:** the reviewer cannot publish project edits; actionable findings return to the worker; revised work returns to the reviewer; optional advice and no-op work do not create unbounded loops. Evaluate deprecation-removal criteria only after installed-host acceptance, not just source changes.

### Step 3: policy changes and implementation recovery

Apply role, policy, and gate changes at safe boundaries, preserve budgets/findings, and test multiple browsers, ambiguous delivery, published artifacts, and restart.

**Exit:** no display-driven routing, no replay of uncertain commands, and persistent policy after reconnect/restart.

### Step 4: N-capable phase, assignment, and adapter model

Represent Plan/Implementation, group snapshots, an N-shaped required planning roster/assignment map, epoch and brief versions, safe paths, capabilities, and a separate one- or two-member implementation selection. Start with selectable N=1 or N=2 and draft concurrency=1, not hard-coded vendor/participant fields. Define provider-specific result/lifecycle normalization and output capture, with Gemini retained as an ordinary eligible-adapter target rather than a supervisor.

**Exit:** the registry/model can represent three or more available instances without a new mode, while initial run validation still rejects selected groups above the release cap. Duplicate aliases are rejected; ignore/capability checks and solo semantics work; Plan grants no code/staging/branch permission. Provider data is not fabricated.

### Step 5: sequential planning for the enabled group sizes

Dispatch the roster sequentially while withholding peers' results; validate every assigned draft and the complete-roster barrier. Synthesize once, then refine with one writer across a deterministic roster order. Track current-version endorsements from all required members.

**Exit:** test solo and N=2 end to end, plus model-level N=3/N>3 barrier/endorsement fixtures without claiming larger UI groups are enabled. Duplicate/failed/partial results do not fill other slots; stale acceptance does not count; text changes invalidate applicable approvals. Solo becomes plan-ready, not independently agreed. Guidance stays correlated and boundary-queued.

### Step 6: human checkpoint, branch gate, and implementation group

Implement independent approval/automation settings, exact-version approval, overrides, final-plan retention, and one durable transition into a validated solo or two-member implementation group. Keep branch consent separate; a missing branch choice waits explicitly. Apply confirmed creation only after planners settle and validate it before code dispatch.

**Exit:** supported solo/two-member groups honor all four approval/automation combinations and branch consent, without stale/double dispatch. A future larger planning group can be mapped in tests to one/two implementation members; extras remain unscheduled and settled. Direct implementation invents no plan record and no branch is changed under active agents.

### Step 7: controlled enablement of 3+ planning and concurrent drafts

Enable 3+ user-selectable planning members only after the N-shaped state model, required-roster barrier, same-version endorsements, group UI, and recovery pass acceptance. Test N=3 and N>3, including a verified Gemini-capable runtime. This is separate from enabling more concurrent executions. Raise draft concurrency only after per-assignment ownership, lifecycle handling, and aggregate validation pass. Deliveries may remain serialized while distinct draft executions overlap; project/Git writers remain sequential. N-agent implementation is not enabled by either switch.

**Correct Step 5's sequential validation for concurrent execution:** active owners can change their own files; frozen/unassigned paths and project content remain protected. Do not keep the "every nonassigned draft unchanged" assertion across overlapping executions.

Exercise the chosen Gemini runtime's real plan-output permissions, event correlation, native approval behavior, cancellation, and activity evidence alongside the other supported CLIs. Where automatic-ready evidence is absent, keep the adapter's limitation explicit rather than changing missing evidence to clear.

**Exit:** all required finalized results open the barrier once; legitimate peer draft writes do not cause false positives; canceled or late attempts cannot count for replacements; synthesis starts only after all required outputs and activity are settled. Validate one real mixed-provider task with three planners before claiming multi-agent host acceptance.

### Step 8: remote publication, optional PR, and remote workers

Publish/fetch exact code handoffs through a designated remote; optionally link one PR per task; handle divergence and ambiguous publication. Then add host-aware dispatch, local execution grants, adapter eligibility, environment setup, and transfer of frozen plans.

**Exit:** no worker consumes an unpublished commit, no comparison of unrelated absolute index paths, and no PR requirement for transport. Multi-host planning additionally needs explicit N-draft transfer/barrier semantics; ignored files never become a remote protocol by assumption.

Native iOS, richer terminals, **AI supervision**, generalized workflow construction, advisor/quorum planning policies, N-agent implementation, and parallel alternative implementations remain later choices. A third or fourth ordinary planner is explicitly in scope and is not part of that supervisor deferral.
