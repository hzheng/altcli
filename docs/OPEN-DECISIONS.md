# Open collaboration decisions

This register preserves unresolved choices and explicitly proposed defaults from the reviewed design. Do not resolve them implicitly while implementing an unrelated increment. Related accepted boundaries are indexed in [Architecture_Decision](../Architecture_Decision.md).

## Open choices and intentionally deferred work

| Topic | Current position |
| --- | --- |
| Relay-log path and metadata encoding | Decided September 20, 2026: the journal is AltCLI app data (`handoff_journal`, one schema-1 result per turn, exported through `/api/v1/history/export`). A tracked mirror is an explicit per-start preference with a configurable nonignored relative path (default `RELAY-LOG.jsonl`, one appended JSON line per turn); ignore rules are not modified. |
| Complete entry schema | Local schema 1 is specified by `HandoffEntry` in the JSON-only contracts and OpenAPI; see ADR-0014's implementation update. Broader schema evolution remains future work. |
| Git publication owner | Agent/authorized helper publishes; controller validation stays read-only. The narrow confirmed new-branch setup exception is implemented locally and recorded in [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md); it does not authorize controller commits. |
| Safe completion evidence | Published artifact distinct from process quiescence; CLI-specific background-work policy unresolved. |
| Peer objection automation | Decided September 20, 2026: commit-mode peer relay routes an actionable objection to the author automatically, like worker/reviewer, unless the run's `pauseOnObjection` agreement holds it for Next turn ([Peer relay behavior](adr/ADR-0015-collaboration-policies-and-solo.md#peer-relay-behavior)). |
| Worker disagreement and no-op output | Local log-only work ends the chain without advancing acceptance and retains findings. `needsHuman: true` explicitly pauses for human direction; acceptance cannot set it. Never self-acceptance. |
| Manual next-turn API and state | Plan and Implementation use `waiting` and POST `/api/v1/runs` with `continue`, `expectedCommandId`, and readiness confirmation for assigned successors. Plan approval/changes use a separate exact-version decision endpoint. The deprecated mode remains frozen. |
| Dirty working-directory support | Deferred for commit relay because same-file ownership cannot be reconstructed safely after publication. Stage relay (formerly the deprecated mode) retains its existing baseline rules on main/default; re-planning after unfinished code still needs an explicit policy. |
| Multi-commit turns and merge commits | One handoff commit per turn first; broader support needs lineage rules. |
| Publication uncertainty and restart reconciliation | Never replay blindly; detailed recovery states to implement. |
| Participant replacement mid-task | Explicit reconciliation, not a pane-ID hot swap. |
| Automatic-turn budget | The local sequential release shares an explicit default-20 automatic-turn budget across Plan and Implementation, with no phase-transition reset. Larger-roster attempt/refinement/run limits remain open. |
| Final integration and log retention | Journal retention is local: each handoff commit's patch is archived at publication and before worktree removal, and exports are the backup. How exported history travels with a PR or to another host, and any pruning policy, remain open. |
| Shared remote, hosting provider, PR timing | Optional and separate; local first. |
| Multi-host worker-control transport | Required beyond Git exchange; not selected. |
| Per-turn CI and final acceptance gate | Focused versus full validation agreed; mandatory checks open. |
| AI supervisor and native iOS | Remain deferred. Separate app-wide Global AI and Background assistant roles are proposed under ADR-0022/0023 below, with only Global AI's A1 read increment implemented ([guide](GLOBAL-AI.md)); they neither replace the controller nor mandate another reviewer. Additional ordinary planners remain a distinct planned capability, without changing the initial one/two-member execution limit. |

Planning details still to specify:

| Topic | Current position |
| --- | --- |
| Plan directory and filenames | Local schema 1 uses `<data directory>/plans/<run-UUID>/draft-<agent-id>.md` plus `plan.md`, outside the checkout (moved from an ignored `.altcli/plans/` on September 21, 2026). Solo initially uses its captured draft as the shared version and creates plan.md only for requested refinement. No per-turn project report files. |
| Ignore-rule setup | Resolved: none. Plan documents live outside the checkout, so planning requires and inspects no ignore rule. A tracked relay-log mirror still must not be ignored; the default journal needs no project file. The controller does not edit ignore rules. |
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

None of this reopens the central choice: lightweight planning documents kept outside the checkout, an optional approval gate, then the selected implementation collaboration and handoff mechanism.

### Workspace/group details still to implement

| Topic | Decided boundary and remaining detail |
| --- | --- |
| Project/worktree ownership | Explicit confirmed task-worktree creation is now in scope under ADR-0013, defaulting to ~/.altcli/<repo-name>/<branch-name>. Users still own environments and agent placement; automatic provisioning and cleanup remain excluded. October 1, 2026: [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md) moves agent placement to AltCLI, which launches agents only into task workspaces it created (later increments); environments stay the user's. |
| Discovery schema | Projects use canonical common Git directories; each lists branch-independent worktree identities, including empty checkouts, then canonical-cwd task groups. Explicitly used/created projects persist. Additional hosts/sockets and automatic retention policies remain deferred. October 1, 2026: [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md) replaces this as the target with registered repositories and recorded task workspaces; it stays current until ADR-0024's I2 increment lands. |
| Process identification | Eligible adapters count toward groups; unknowns need identification. Runtime-specific process detection and how to confirm unsupported installs are not settled by a name match. |
| Group persistence and rename | Product term is group; use distinct-member arrays and versioned run snapshots. Exact tables/endpoints, migration from old pair IDs, and temporary compatibility aliases remain implementation details. |
| Group defaults | All eligible agents are selected initially, with a checkbox on every row and inline names. Larger selections persist; execution still requires one or two. Later N-planning rollout must be explicit. |
| Primary-branch metadata | Show the checked-out branch and default recorded locally in `origin/HEAD`, without fetching. When absent, the configured integration list still applies; never silently switch. Forge-backed metadata remains deferred. |
| Integration branches | Accepted and implemented locally: the default branch and `ALTCLI_INTEGRATION_BRANCHES` are creation bases only, refused as implementation branches on the server and in the picker; existing task branches carry a confirmed baseline; squash integration is the recommended completion path and is offered locally as a confirmed one-commit squash into the integration branch's own checkout (ADR-0013, September 20, 2026). Protected-branch discovery from a forge and remote publication remain future work. |
| Setup operations | Existing-checkout branch setup retains its clean/settled worktree owner. Separate task-worktree creation persists exact consent and a project setup owner, and exposes read-only uncertain-result inspection. Confirmed unused integrated-worktree removal, confirmed squash integration and confirmed forced discard have their separate ADR-0013 authorities. No automatic removal, automatic retry or rollback is authorized; force is used only by the explicitly confirmed discard. |
| Branch-consent lifetime | Consent is scoped to the shown workspace/branch/baseline/name. Changed inputs require revalidation/new choice; no stay-on-integration preference is permitted by the current policy. |
| Solo self-review | Plain solo work is in scope. A separately requested, clearly labeled self-review is optional; no autonomous self-revision loop or fake independent approval is selected. |
| N-agent release gate | Keep N-capable assignments/endorsements now; the user-facing planning cap is lifted only with explicit acceptance. Gemini adapter eligibility is independent of group size. |
| External writers | Detect known conflicting runs and expose unselected same-worktree agents. Exact external activity evidence remains adapter/host-specific; do not claim OS isolation. |

### Stage relay and reusable task worktrees (September 27, 2026)

Human-approved plan decisions recorded in [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md#branch-scoped-stage-relay-september-27-2026), [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md#reusable-task-worktrees-update-rename-and-move) and D51–D52.

| Topic | Current position |
| --- | --- |
| Stage relay branches | Decided and implemented locally: literal `main` and the recorded default; with no recorded default only `main`; other integration branches allow neither relay contract. |
| Legacy flag | Decided and implemented: `ALTCLI_ENABLE_LEGACY_RELAY` keeps its name, absent means enabled, explicit false disables with a visible notice. Renaming the variable remains a possible later cleanup. |
| Pre-upgrade staging runs | Decided and implemented: completion recorded, no further dispatch, held for takeover. |
| Pairless staging starts | Decided and implemented: refused for new starts; plain Send covers single instructions. |
| Stage relay copy | Working labels **Stage relay**, **Commit relay**, **Send … & stage-relay to …**, **Stage-relay review by …**; exact copy open. |
| Final commit after Stage relay | Human action or explicit plain Send instruction; a dedicated confirmed "commit staged fix" UI is open. Plan-to-Stage-relay is not planned. |
| Worktree reuse | Decided and implemented locally: Update from main (fully integrated moves and replay of unintegrated commits), Rebase onto main and Reset to main (September 28, safe equivalents of `git rebase main` and `git reset --hard main` behind one Align with main chooser) and branch rename, with the plan-approval objections resolved as recorded in ADR-0013. Directory move: accepted direction, **not implemented**. Open: recording a continue-task/new-task intent at update time; whether an uncertain update or rename should also block keyboard acquisition (like the other setup operations, only the running operation does). |
| Squash with content filters | Squash preview still refuses every configured merge driver and any configured content filter selected by effective attributes, so LFS repositories cannot squash from the app. The September 27 review correction restores normal configured Git status behavior for discovery, clean-entry/publication checks and worktree lifecycle operations; these do not refuse LFS repositories. The public squash endpoint refreshes that ordinary discovery too. Only squash-specific status/merge reads preflight selected filters, initialized submodules and external filesystem-monitor hooks. Supporting filtered squash itself remains open; ordinary status is not a command-free sandbox. |
| Worktree reuse details | Open: recovery-ref deletion and restore UI; app-supervised conflict resolution instead of refusal; external-squash boundary selection; dropping redundant commits; signed-commit replay; LFS/filter support; a metadata-only "new task" segment without Git change; combined stop/move/relaunch; provider conversation resume; carrying display names to relaunched agents; primary-checkout operations; remote rename or push. |

### Terminal input follow-ups

[ADR-0019](adr/ADR-0019-terminal-input-and-checkpoints.md) defines manual literal input and the whole-run checkpoint. Native input acknowledgments, permission-dialog semantics, portable capability/version records, safe automatic consumption of queued prompts, and autonomous app control remain deferred. Prompt equality, recent history and a pending reservation cannot resolve native attribution. Installed-provider compatibility must be observed; the manual controls do not certify same-turn steering or dialog semantics.

The approved September 29 direct-input plan permits concurrent connection writers under the
existing global manual barrier (ADR-0020). Worktree-scoped automation, idle release, extra
terminal services and pane-directed input remain outside this change. October 1, 2026: the owner
decided worktree-scoped holds with pane-directed workspace input
([ADR-0020 amendment](adr/ADR-0020-native-terminals.md#october-1-amendment-worktree-scoped-manual-input), D55),
accepting the loss of tmux bindings in browser workspace terminals; implemented locally, with installed-host acceptance still open. Idle release
and extra terminal services remain open.

## Native transport implementation evidence

The approved WebSocket alternative replaces the HTTP-stream candidate after its
browser connection-limit failure. The owner approved captured text wherever native
observers could resize workers. ADR-0020/0021 own these decisions; they do not settle
larger-group rollout or provider capability questions. Deployment acceptance through
the actual remote proxy, physical Safari/IME and installed CLI versions remains
open. The owner chose on September 24 to have setup enable
both flags.

## Proposed app-wide assistance and completion choices

These choices concern the remaining proposed work and acceptance of
[ADR-0022](adr/ADR-0022-app-wide-ai-instances.md) and
[ADR-0023](adr/ADR-0023-app-tools-and-delegated-authority.md). A1's current Codex or
Claude Code instance and read-only MCP contract are documented in [GLOBAL-AI](GLOBAL-AI.md);
installed-provider acceptance remains open. Recording these choices does
not authorize unattended launch, change human approvals or lift current deferrals.
The [roadmap](../ROADMAP.md#proposed-app-wide-assistance-and-completion-work) gives
recommended order, not accepted schemas or provider guarantees.

| Choice | Recommended starting point and unresolved boundary |
| --- | --- |
| Runtime and model support | One verified structured CLI adapter first; separately establish invocation, auth/billing, model attribution, permission and MCP behavior for installed versions. No permanent model catalog or universal subscription guarantee. Decided October 2 ([ADR-0022 amendment](adr/ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant)): Claude Code is the first Background candidate, enabled only after a disposable probe; Codex later. Background profiles accept only that adapter today. The probe has not run. |
| Process and conversation lifecycle | Reusable supervised runner with bounded jobs and exact scoped conversation identities; persistent conversation versus fresh/resumed jobs remains an adapter choice. Decided October 2 ([ADR-0022 amendment](adr/ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant)): one recorded Background instance in tmux on Helper's endpoint resolver; a fresh structured invocation per job; the host as sole scheduler; explicit Inspect and Resume after a restart. Not implemented. |
| MCP transport and authentication | A1 implements a stdio bridge to the same host's loopback endpoint with a separate read capability and a fixed read-tool set. Every read tool now declares an output schema the host enforces, and reads take an explicit principal (Helper host-wide, or a job scoped to one attention item). Installed-provider interoperability remains unverified; the Background job endpoint and delegated tool contracts remain open. |
| Global AI self-interference | A1 settles its own side: Global AI's terminal is outside the manual-input barrier, so typing there holds no automation ([GLOBAL-AI](GLOBAL-AI.md#native-input-and-recovery)). Still open: how a future effectful call handles holds created in agent terminals without bypassing other writers or changing unknown evidence. |
| App-owned tmux socket | Decided October 1, 2026 by [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md): app sessions and Helper use a dedicated `<data directory>/tmux.sock` endpoint, with `ALTCLI_TMUX_SOCKET` as an absolute override and boundary checks still covering the default server; never a claim of filesystem isolation. Not implemented (increment I4). |
| Initial delegation and approval migration | Small useful action set with exact previews/receipts; separate owner-authorized policy and delegated record. Preserve existing human-only Plan settings. Risk overrides need explicit supported scope, not fabricated inspection. |
| Unattended shell/environment | Minimal required access; determine and disclose cooperative versus enforced boundaries. No inherited broad host authority or unrestricted app shell tool. |
| Native permission prompts | Defer universal automatic answering. Only verified adapter-specific mechanisms may support a later explicit policy. |
| Notifications | In-app deterministic delivery first; external destinations, content privacy, retry/uncertainty and destination-change behavior need explicit configuration and tests. In-app deterministic attention is implemented locally ([guide](BACKGROUND-ASSISTANT.md)); toasts, OS push and external destinations remain open. |
| Budgets and retention | Measured job/tool/time limits and bounded context/activity retention; unavailable quota stays unknown. Background v1 defaults adopted October 2 ([ADR-0022 amendment](adr/ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant)): 20 s settle, one job, 10 starts an hour at least 30 s apart, a 120 s deadline, 12 tool calls, one automatic attempt per version, a stop after three failures. Attention keeps open items and 200 resolved within seven days. |
| Image validation | Keep today's documented structural checks until an explicit decision chooses bounded server decoding or retains that limited contract; browser decoding alone does not cover direct API callers. |
| Used-image release | Reference-aware management and informed eligible release; never evict active/uncertain use or promise retraction from a provider. Exact retention policy remains open. |
| App-wide image scope | Later explicit conversation/job destinations, separate from workspace-private uploads; no dummy workspace or automatic broadcast. |
| Host environment profiles | Optional named allowlists and secret references with redacted, configuration-bound preview; today's credential/proxy omissions remain. |
| Create & launch | Accepted October 1, 2026 by [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md) as the ordinary path: one consent with separate durable creation/launch results, zero agents meaning Create only; no guessed destination, rollback of successful siblings or uncertain retry. Not implemented (increment I5). |
| Workspace UI redesign | Current linked Agent selection, Parallel per-agent composers and Focus following are documented behavior. Any independent target model or changed focus-follow policy needs a separate decision; an older scratch layout does not silently supersede current behavior. |

Fixture identity/PID follow-ups are source-supported investigations in
[TESTING](TESTING.md#fixture-reliability-follow-ups), not proof of one root cause
for every historical CI failure. Startup interaction needs the separate
[launch authority design](adr/ADR-0021-project-entry-and-agent-launch.md#proposed-launch-completion-work).
