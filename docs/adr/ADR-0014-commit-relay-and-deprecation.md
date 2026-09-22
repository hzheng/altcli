# ADR-0014: Commit relay and staged deprecation of uncommitted relay

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

### Contextual pane actions (September 21, 2026)

The console places one action group under each agent pane; every control's first
delivery goes to the agent above it. **After send** exposes the existing `kind: work`
contract in the UI. *Commit* submits `kind: work` with `handoff: false` and
`autoContinue: false`. *Commit & relay* submits `kind: work` with `handoff: true`: the
server schedules the peer's initial review of the new candidate only after validated
publication with changed project content, even when later automatic collaboration
is off. The review range is the pre-send HEAD through the published commit. The UI
never sends `reviewBase` with `kind: work`; the server does not validate it for new
work, and whether it should refuse one is an open follow-up. Uncommitted input is
captured by the initial worktree fingerprint and included in that first commit
(ADR-0013). A work turn with no project change publishes a report (a journal-only
commit when the tracked log is mirrored) and relays nothing. Solo offers no relay;
under Worker + reviewer only the worker's card sends and only the reviewer's card
reviews. Existing-commit **Relay [agent]** sits in the reviewing agent's own card.
Snapshot **Commit** and **Commit current changes & relay [peer]** sit under the
author's **Current changes** with a separate optional handoff note, so a Send
instruction is never sent as snapshot context. Request bodies for Commit, Commit
current changes & relay, Relay, Start Plan and Next turn are unchanged; no server
contract changed.

### Journal as app data (September 20, 2026)

This update supersedes the tracked-log requirement in [One tracked append-only
relay log](#one-tracked-append-only-relay-log) below, which is retained as design
provenance. What is preserved is separated by where it belongs:

| Where | What |
| --- | --- |
| Repository | Accepted design rationale, relevant tests, usage documentation, and important limitations, promoted into the appropriate documents as part of finishing a task. |
| CoderCrew history (app data) | The detailed journal: agent turns, reviewed commit ranges, findings, intermediate plans, reported validation, and each handoff commit's archived patch. |
| PR or final task summary | A concise explanation of the result and significant decisions, drawn from that history. |

Consequently a commit-mode turn no longer has to commit `RELAY-LOG.jsonl`. The
result channel is an external result file named in the assignment
(`resultPath`, beside the assignment JSON under the controller data directory, as
Plan already does): the agent writes one `HandoffEntry` object there before
finishing. The controller validates it against the immutable identity, reads Git
read-only, and records the validated publication in the `handoff_journal` table
as a `JournalRecord`, together with the commit's patch (`HandoffArchive`: the
`git apply`-able patch including binary data when it fits 1 MiB and is storable
as UTF-8 text, otherwise its diffstat marked incomplete). Publications recorded before this table existed
are backfilled from the turn ledger at startup and archived when their commit is
still present. Report-only turns (acceptance without improvements, objection,
question, blocked report) publish **no commit**: HEAD stays at the assigned parent
and the journal records it; empty commits are refused. A turn that changed project
content still publishes exactly one direct, single-parent commit on the assigned
parent. The Review-baseline default now comes from the journal: the newest
first-parent commit at which the recipient completed a turn, or the task baseline.

Tracking the full journal in the repository remains an **explicit project
preference**: with `logPath` set on Start, the agent also appends the identical
entry as one JSON line to that tracked, nonignored file inside the handoff commit,
so every turn (report-only included) commits, and the controller requires the
mirrored line to equal the published result. Ignore rules are still never edited.

Because cloning the repository cannot recover app history, `GET
/api/v1/history/export` (and **Export history** in Status) returns every run, turn
and journal record, optionally for one worktree root. Before a confirmed worktree
removal, the controller archives any journal entry on that worktree whose commit
has not been archived yet; commit hashes alone do not preserve intermediate
revisions after squash integration and branch deletion. The removal message
reports how many commits were archived. The database version is 9; older servers
refuse it rather than misread a run without a tracked log.

### Local implementation update (September 19, 2026)

The new implementation path now realizes the one-direct-commit contract below;
installed-agent acceptance remains pending. It originally defaulted to
`RELAY-LOG.jsonl`, with a validated user-selectable relative path, so the existing
`.codercrew/` ignore rule needs no mutation; since the September 20 update above,
that tracked mirror is opt-in. The proposed Markdown metadata representation
below is retained as design provenance; the implemented encoding is UTF-8 JSON,
schema 1, exactly one result per completed turn (one appended line per turn when
mirrored). Existing mirrored bytes must remain unchanged, and log files/symlinked
parents/ignored paths are checked.

The exact schema is `HandoffEntry` in `web/src/contracts/implementation.ts` and
`shared/openapi.yaml`: the controller supplies the immutable `identity` object
(schema/run/command/turn/policy/registration/action/phase and exact revisions).
The agent copies those fields and adds model, decision, reason, needsHuman,
summary, and checks. Work uses null decision/reason. `needsHuman` is the explicit
escalation encoding: it pauses automation and retains ownership; an acceptance
cannot also require a blocking human decision. Project changes are derived from
Git, excluding only the reserved tracked log when one is kept. Any supplied legacy outcome must agree.

New staging starts are disabled unless the host opts in with
`CODERCREW_ENABLE_LEGACY_RELAY=true`. Existing staging runs, hooks, and the legacy
skill retain their protocol. No automatic migration adopts their uncommitted work.

**Plain Send clarification (September 19, 2026).** Plain Send is outside the
committed-handoff contract: it delivers the user's instruction with correlation,
exact group/instance confirmation, fixed-worker targeting where selected, and the
same canonical execution lock. It has no automatic successor, branch setup, or
handoff assignment and does not automatically authorize a commit. It may operate
with uncommitted files. The September 20 clarification below also permits
unfinished input for the first committed work turn.
The existing committed solo/API work path and Plan-to-Implementation transition
retain their one-commit contract. This does not enable the deprecated staging
relay or change its skill.

For local relay handoffs, the agent uses `git -c core.hooksPath=/dev/null commit`.
This per-command override prevents repository hooks, including commit-msg, from
blocking or rewriting intermediate handoffs. It changes neither hook files nor
persistent Git configuration. Required validation still runs before publication;
normal hooks apply to final integration. An explicit conflicting repository rule
must be reported, not silently overridden. Initial work and reviews that change project
content publish exactly one direct handoff commit; report-only reviews publish
none unless the project mirrors the journal into a tracked log.

Relationship: ADR-0010 and ADR-0011 only for the new handoff path. The existing review-handoff skill and pinned compatibility behavior remain intact.

## Context

Mutable staging state is not an immutable handoff. Record the completed contribution and its review judgment together, while retaining the currently operating staging protocol during migration.

## Decision

### Deprecate the uncommitted relay mode

#### Original contract

In the supplied `review-handoff` skill:

- During ordinary alternation, the index contains accepted incoming work and unstaged changes represent the next contribution.
- An explicit HEAD or index baseline overrides automatic selection; otherwise unstaged or untracked work selects the index baseline and HEAD is used to review already-staged incoming work.
- Accepting incoming work stages the reviewed content before any reviewer improvement; the reviewer's own improvements remain unstaged.
- A strong objection leaves the index and worktree untouched.
- Unrelated or unreviewed changes are never swept into staging.

These are the existing skill's rules, not the commit-mode rules (source note in [Sources, superseded alternatives, and interpretation](../SOURCES.md#sources-superseded-alternatives-and-interpretation)).

#### Positioning

This mode is **deprecated**. It remains a local, supervised option for unfinished work that the user does not yet want to publish as a committed checkpoint, and the migration fallback while commit relay proves itself on real hosts. It is not a second product direction, and it is not chosen by change size: the useful distinction is whether the user wants a persistent handoff checkpoint. New history, multi-host, and role-based capabilities go to commit relay only. Keep the skill contracts separate: "never stage your own improvement" and "commit your outgoing improvement with a log entry" must never be competing instructions for one turn.

#### Deprecation contract

Every behavior listed below was verified present at the pinned baseline `46f228b` ([Product purpose, retained architecture, and comparison with the reference implementation](../SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)): the skill and its four outcome values in `hooks/protocol.mjs`, the digest gate and objection-to-author path in `WorkflowStore`, and the run gates of ADR-0011. The freeze is against that commit; a later baseline must be re-pinned before the freeze is re-asserted.

| Rule | Meaning |
| --- | --- |
| Frozen behavior | The `review-handoff` skill, its four `RELAY-OUTCOME` values, the worktree-digest gate on Send & relay, the objection-to-author correction instruction, and the run gates of ADR-0011 keep working as verified at the pinned compatibility baseline. |
| No new capabilities | Do not add worker/reviewer, solo self-relay, N-agent dispatch, explicit review ranges, remote publication, or PR features to the staging protocol. Workspace-first discovery, group terminology, compatibility/migration notices, and registration adapters may wrap the existing behavior without changing its meaning. Do not route an unsupported one-member/new-phase group into it. Bug fixes preserving the staging contract remain allowed. |
| Labeled in the UI | The handoff selector shows it as deprecated and states what it lacks; it is not the default for a new task. |
| One mode per run | A run records its implementation handoff mode before implementation dispatch and does not change it mid-execution. Plan always uses document handoff, so its authorized phase transition is not an accidental implementation-mode switch. The existing ownership lock on the worktree's canonical index prevents an uncommitted run and a commit-relay run from coexisting on one worktree. |
| Migration on one worktree | Before the first commit-relay run: reconcile or take over any uncommitted run. The human may explicitly use Commit to snapshot current changes; it captures the unfinished input. Existing-candidate review requires a clean index and non-ignored worktree at the expected branch tip ([Commit-based handoff contract](ADR-0014-commit-relay-and-deprecation.md#commit-based-handoff-contract), [User-prepared workspaces, branch consent, and remote operation](ADR-0012-workspace-discovery-and-groups.md#decision)); it never adopts a deprecated run's index/worktree state as an implicit first candidate. |
| Removal criteria | Remove the mode from the app only after commit relay has passed the host-acceptance items of [Acceptance scenarios](../TESTING.md#acceptance-scenarios) for peer relay and worker/reviewer on the supported installed implementation adapters (initially the configured Codex/Claude group), and after a deliberate decision that no remaining use case needs an uncommitted checkpoint. Removal from the app does not delete the skill from this repository. |
| Documentation | README, SETUP and SKILLS keep describing it while it exists, with the deprecation stated in the same place. |

Planning is not this fallback: ignored plan-file refinement is a phase-specific document handoff that does not reuse the index/worktree algorithm merely because neither uses commits. Three instruction contracts stay distinct: planning documents, uncommitted implementation relay, committed implementation relay.

### Commit-based handoff contract

**In commit-based Implementation, one completed turn publishes one result and at most one handoff commit** containing the project changes permitted by the assigned action and decision. A report-only turn is meaningful work: acceptance without edits and objection with findings are recorded in the journal without a commit (September 20, 2026 update; originally the appended log entry made every turn a commit, which remains the behavior under the tracked-log preference).

A task contains many turns and commits on one recorded implementation branch, normally a dedicated task branch, and at most one PR for the whole task. A user may explicitly continue on main/the configured primary branch instead; the same lineage and ownership checks still apply, and no automatic merge is implied. "Every completed turn" does not mean every tool action or partial attempt; an interrupted execution must not fabricate an acceptance to produce a commit. **First-release lineage rule:** each handoff is exactly one direct, single-parent commit on the expected task-branch tip. Do not create unreported intermediate commits on that active branch during the turn. Arbitrary new commits are not publications. The supplied text permitted local checkpoints while also requiring the handoff commit's parent to equal the turn's original parent; these cannot both hold when checkpoints advance the same branch. Multi-commit turns need a separate starting-base-to-final-head contract and remain deferred. No controller reset or history rewriting is introduced to hide extra commits.

A helper may validate and publish the result under the agent's authorized context. The agent following the commit-relay skill stages and commits its own handoff; the controller validates that publication read-only. Whichever component commits must preserve unrelated user work. The controller does not stage or commit on the agent's behalf or prepare the tracked log by silently editing source files. Task-worktree creation is separately confirmed setup under ADR-0013, never a turn-publication side effect.

**Setup authority:** [ADR-0013](ADR-0013-confirmed-branch-setup.md) permits confirmed new-branch checkout at a settled boundary with clean or explicitly captured initial work and separately confirmed task-worktree creation at an exact committed baseline. Preparing the tracked log remains an authorized human/agent/helper step. Neither exception grants existing-branch switching/reset, stash/reset/clean, force-push, commits, merge, rebase, deletion or automatic worktree lifecycle. No turn changes its branch underneath active workers.

**Initial snapshot clarification (September 20, 2026).** Separate Send, Commit and
Relay actions remain distinct in committed Implementation. The Relay button adapts
to checkout state as described below. Commit snapshots all current staged, unstaged
and nonignored untracked project changes as they stand and stops without peer review.
It does not finish pending requests; optional text is handoff context. The first
`work` assignment carries `commitOnly: true`, preserving the existing handoff-log
schema. The agent may append the log but must not edit project content. Incomplete
work is described in the summary and is not itself a human-decision blocker.
The controller still never stages or commits on the agent's behalf.

Commit sets `handoff: false` and `autoContinue: false`, including solo mode. Each
button names its recipient: selected agent/fixed worker for Send and Commit,
other member/fixed reviewer for Relay. Relay offers a baseline selector whose
earliest, default candidate is derived from the handoff journal (originally from
the tracked relay log committed at HEAD): the newest first-parent commit after
the task baseline at which the recipient completed a turn, or the task baseline itself when the recipient has none on
this branch. Every later commit through HEAD's parent is a further candidate, the
last one being the last commit only. Git author and date are never consulted. A
typed baseline requires a read-only commit-list preview before it can be sent.
The baseline is excluded. A changed HEAD or baseline invalidates the preview and
readiness. Relay requires a clean checkout and project changes in the range;
changing or previewing a baseline creates no run and sends nothing. Existing API
`work` requests and Plan transitions keep their previous contracts.

**Adaptive Relay (September 20, 2026).** On a dirty checkout, the button reads
**Commit current changes & relay [peer]** and submits `kind: commit` with
`handoff: true`. The selected agent/fixed worker snapshots the captured changes
without implementing pending requests, using the same `commitOnly` assignment.
The controller validates publication and settled lifecycle evidence before
dispatching the peer/fixed reviewer for the exact selected-baseline..snapshot
range. The initial review is authorized even when later automatic collaboration
is off. The baseline selector stays available, including current HEAD for reviewing
only the current changes. Read-only previews with `commitPending: true` include
HEAD as a candidate and allow an empty committed portion; the pending snapshot
may supply the project proposal. `reviewBase` on a commit with handoff preserves
the selected baseline, bounded by the task baseline and pre-snapshot HEAD. The
completed full range must contain a project proposal before a peer is dispatched. Plain Commit keeps `handoff: false` and
`autoContinue: false`. Solo mode has no relay action. Dirty input alone no longer
disables the relay button; readiness, branch, ownership, identity and publication
gates remain, and clean/dirty transitions revoke prior readiness.

Readiness authorizes the full current snapshot. The controller captures its
worktree fingerprint, persists it with the run, and rechecks it at setup and
immediately before dispatch. The agent verifies the captured input. A changed
snapshot blocks delivery and retains ownership; it never silently refreshes the
input. An already modified tracked relay log, when the project keeps one, must be reconciled or another log path
selected. Secret screening and unresolved conflicts can block publication rather
than force a commit. Clean checkouts use either explicit Relay action.

Plan-to-Implementation and existing API `work` requests retain their ordinary
implementation assignment semantics. Existing-candidate review and every later
turn require a clean checkout. Every publication still requires exactly one
direct commit and no uncommitted leftovers; completion does not certify task success.


### One tracked append-only relay log

*Superseded as the default by [Journal as app data](#journal-as-app-data-september-20-2026); retained as provenance and as the contract of the opt-in tracked mirror.*

Use one ordinary Git-tracked file on the task branch, working path `.codercrew/relay-log.md`. The path is a proposal; the single-file, append-only behavior is the agreed direction. It is the collaboration journal, separate from the product's release `CHANGELOG.md`, and Plan turns do not append to it. This repository currently ignores `.codercrew/` wholesale, so that proposed path first requires the human setup decision recorded in [OPEN-DECISIONS](../OPEN-DECISIONS.md#open-choices-and-intentionally-deferred-work); the controller does not rewrite ignore rules during a run.

```text
Worker writes files and appends an entry in its checkout.
    ↓
The commit records the project state and relay log together.
    ↓
For remote operation, the commit is pushed to the selected remote branch.
    ↓
The next worker fetches the commit, including the log.
```

The original argument was that the log must not be kept only in CoderCrew's database, because a tracked log travels with the code. The September 20, 2026 update reverses that default: the journal is app history with export and pre-cleanup archiving, enduring knowledge is promoted into repository documents, and a tracked mirror is an explicit preference for projects that need the audit trail in Git. Runtime metadata (databases, tokens, sockets, diagnostics) stays outside managed worktrees regardless.

Each completed commit-mode turn appends exactly one structured entry; earlier entries are never rewritten, and corrections are new entries. Sequential turn ownership is what makes one growing file appropriate: competing publications are a coordination conflict, not an invitation to merge fragments. Plan documents live in CoderCrew's data directory, so no exclusion can hide the log; a one-time implementation-start record may carry the approved plan when that transfer format is selected.

### What the log records and what Git supplies

The log describes what the agent did or concluded; Git supplies the committed changes. Plan results reuse identity/decision concepts with a document revision, planning epoch, brief and roster revision, and a controller record instead of a commit SHA/log entry. They do not require N concurrent planners to append to one shared file.

| Information | Source |
| --- | --- |
| Run, turn, assigned action, participant, policy revision | Controller-assigned identifiers carried in the log. |
| Reviewed baseline and incoming candidate | Exact revision references supplied by the controller and recorded in a review entry. |
| `accept` or `object`, findings, rationale | Reviewer's structured report. |
| Agent identity and model identity | Registered agent/runtime information, never inferred from the Git author. |
| Files and content changed in the turn | Git diff of the handoff commit against its parent, excluding the log. |
| Handoff commit SHA and Git author | Git metadata. |
| Checks performed and unresolved limitations | Reported evidence, distinguished from independently captured results. |

#### Working entry schema

```text
schema_version
run_id
group_id / group_revision  or equivalent binding through run_id; do not duplicate inconsistent state
turn                   controller-assigned sequence number; must be the next expected one
policy_revision
action                 work | review | review_and_improve
phase                  implementation
agent_id
registration_generation  identifies the particular registered instance
adapter_kind             runtime/CLI family, distinct from the model
model                    actual configured/reported value, or unknown
parent                 the branch tip this turn started from; must equal the handoff commit's parent
base                   required for work: the accepted revision this proposal builds on
review_base            required for a review
review_head            required for a review
decision               accept | object, for completed reviews only
reason                 required for an objection
addresses              optional for work: run/turn or finding IDs whose objections this revision answers
summary                explanation of a proposal or optional improvements
checks                 what actually ran, and its outcome
```

Field names and required/optional status are a working specification. Markdown with a rigorously defined metadata block is suitable; whether that block is YAML, JSON, or another strict encoding is open. The controller never interprets prose to find a decision.

A work turn is a proposal, not self-approval: it identifies its input through `base`, may cite findings through `addresses`, and never carries `decision: accept`. `parent` lets the validator confirm lineage without trusting the agent: the recorded parent, the commit's actual parent, and the controller's `expectedParentSha` must agree, or the publication is competing.

#### Illustrative entry

A formatting illustration, not a parser contract:

```markdown
## Turn 4

schema_version: 1
run_id: sync-fix-001
turn: 4
phase: implementation
policy_revision: 1
action: review
agent_id: claude-main
model: <known runtime model ID, or unknown>
parent: <full expected publication-parent SHA>
review_base: <full accepted-baseline SHA>
review_head: <full incoming-candidate SHA>
decision: object
reason: Retrying after partial success can duplicate a completed operation.

### Required correction

Preserve completed operation IDs across retries and add a partial-success test.

### Checks

<Commands actually run, their results, and any checks not performed.>
```

The metadata is small; the explanation may be long.

#### Rules

- The entry references input revisions that already exist. The commit's own SHA is obtained after the commit; inserting it into the file it identifies changes the contents being identified.
- Git author and agent identity stay separate; several agents may share a Git author. Record the model only when the runtime supplies it.
- The log is authoritative for protocol data; the commit message is a readable summary. Commit trailers and empty commits were considered and not chosen.
- The same applies to the final `RELAY-OUTCOME` line the deprecated mode relies on. In commit relay the committed entry is the result channel; a final structured line can remain an optional summary, but is not required for a valid result. If explicitly supplied, compare its **normalized meaning** against decision plus project diff: legacy `accept_without_improvement` is consistent with `decision: accept` and a log-only turn. Contradictory structured claims pause; arbitrary explanatory prose is not a second machine-authoritative result. The committed entry never loses to a guessed outcome from screen text.

### Revision identity and review scope

A commit means **recorded**, not **accepted**; a pushed commit is not accepted either. The controller needs distinct revision concepts:

| Reference | Meaning |
| --- | --- |
| `taskBaseSha` | Permanent starting baseline for the whole task: the confirmed or inferred task baseline, distinct from each round's review range. |
| `acceptedSha` | Latest project state accepted under the protocol. |
| `candidateSha` | Proposed project state awaiting review. |
| `reviewBaseSha` / `reviewHeadSha` | Explicit endpoints for the review being requested. |
| `expectedParentSha` | Branch tip on which the next publication is expected to build. |
| `publishedCommitSha` | Commit containing the completed turn's new report and permitted changes. |

These need not all be stored fields if some are derived reliably; their meanings must stay distinct.

#### Acceptance does not approve the reviewer's new edits

```text
C0  Task baseline
 |
C1  Codex proposal
 |
C2  Claude accepts C1, adds improvements, and publishes its entry
 |
C3  Codex accepts C2 and publishes a log-only entry
```

At C2, C1 is accepted and C2's new project changes await review. At C3 the tip holds a newer report, but the reviewed candidate was C2; a log-only commit is not a fresh proposal.

#### Rejection changes the next review range

```text
C0  Last accepted baseline
 |
C1  Initial proposal
 |
C2  Objection entry only
 |
C3  Author's correction plus entry
 |
C4  Review acceptance entry only
```

The review of the corrected proposal covers project content from **C0 to C3**, including the unresolved findings about C1; reviewing only C2 to C3 validates a repair without evaluating the revised proposal. The publication parent may include report-only commits and is not necessarily the accepted baseline or the candidate. A final task-scoped review considers the cumulative change from `taskBaseSha` to the final candidate; a settled review chain is not proof that the requirements were satisfied.

#### Plan versions are not implementation SHAs

A plan candidate has a document revision/content hash and a code SHA for its planning baseline. Endorsements and phase authorization bind the exact plan revision, brief, baseline, planning epoch, and required roster revision. Approval from one of N planners applies only to its recorded version; the latest two endorsements is not group agreement. Agreement on a plan never advances `acceptedSha`; the first implementation candidate still requires the applicable code review or explicit human verification in solo use. A solo planning recommendation is not independent code acceptance.

### Review decisions and derived change status

A completed review reports one of two judgments against the assigned artifact and phase:

- **`accept`:** the incoming proposal is acceptable; advisory comments may remain nonblocking.
- **`object`:** the incoming proposal needs correction or a decision; the report gives a reason and actionable findings when possible.

`accept_and_improve` and `accept_without_improvement` are not authored values in the new protocol. Derive those descriptions from judgment plus project diff in Implementation, and from judgment plus plan-content change in Plan.

Two comparisons stay distinct: the **review range** (baseline and candidate SHAs the reviewer evaluates) and **this turn's project diff** (handoff commit against its parent, excluding only the reserved log path; source, tests, configuration, and project documentation all count as project content).

| Judgment | Turn changes project content? | Meaning |
| --- | --- | --- |
| Accept | No | Incoming proposal accepted; no new improvements. |
| Accept | Yes | Incoming proposal accepted; new project changes proposed. Allowed only for `review_and_improve`. |
| Object | No | Proposal rejected; report carries the findings. |
| Object | Yes | Protocol violation under the chosen objection rule. Pause for reconciliation. |

Acceptance and objection can both be log-only, so the diff cannot replace the judgment. A missing outcome, malformed entry, interrupted execution, or failed review is not acceptance; "no incoming proposal" is a workflow condition, not a positive judgment. Encoding for no-op and unsuccessful attempts is open.

**Log-only work turns, working specification.** At `46f228b`, Send & relay schedules review only when the worktree digest changed during the instruction; an unchanged worktree ends the run so the human can answer the worker's question with a plain Send. Commit relay keeps that rule with the commit diff as the test: a `work` turn whose handoff commit changes project content outside the log is a candidate and goes to review; a log-only `work` entry ends the chain, or waits for the human when continuation is manual, and its `summary` is shown as the worker's question or report. A log-only `work` entry that answers an objection is a dispute or an inability to comply and returns to the human, never to the reviewer as a revision. A log-only work entry never advances `acceptedSha` and does not prove overall task success. Preserve its question/report and outstanding findings. This rule concerns newly proposed code, not a separately requested review of an existing candidate.

**Phase-specific completion.** A peer/reviewer implementation acceptance with no project changes can finish its review chain. A plan acceptance adds one endorsement of the exact current revision; multi-agent agreement requires the full selected set. A solo planner publishes its own recommendation and reaches the same approval policy without an invented peer. Solo implementation can complete the assigned work without claiming independent acceptance or automatically advancing `acceptedSha`. No case bypasses a required human gate or proves overall task correctness.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
