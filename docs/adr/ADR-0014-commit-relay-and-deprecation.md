# ADR-0014: Commit relay and staged deprecation of uncommitted relay

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: ADR-0010 and ADR-0011 only for the new handoff path. The existing review-handoff skill and pinned compatibility behavior remain intact.

## Context

Mutable staging state is not an immutable handoff. Record the completed contribution and its review judgment together, while retaining the currently operating staging protocol during migration.

## Decision

## Deprecate the uncommitted relay mode

### Original contract

In the supplied `review-handoff` skill:

- During ordinary alternation, the index contains accepted incoming work and unstaged changes represent the next contribution.
- An explicit HEAD or index baseline overrides automatic selection; otherwise unstaged or untracked work selects the index baseline and HEAD is used to review already-staged incoming work.
- Accepting incoming work stages the reviewed content before any reviewer improvement; the reviewer's own improvements remain unstaged.
- A strong objection leaves the index and worktree untouched.
- Unrelated or unreviewed changes are never swept into staging.

These are the existing skill's rules, not the commit-mode rules (source note in [Sources, superseded alternatives, and interpretation](../SOURCES.md#sources-superseded-alternatives-and-interpretation)).

### Positioning

This mode is **deprecated**. It remains a local, supervised option for unfinished work that the user does not yet want to publish as a committed checkpoint, and the migration fallback while commit relay proves itself on real hosts. It is not a second product direction, and it is not chosen by change size: the useful distinction is whether the user wants a persistent handoff checkpoint. New history, multi-host, and role-based capabilities go to commit relay only. Keep the skill contracts separate: "never stage your own improvement" and "commit your outgoing improvement with a log entry" must never be competing instructions for one turn.

### Deprecation contract

Every behavior listed below was verified present at the pinned baseline `46f228b` ([Product purpose, retained architecture, and comparison with the reference implementation](../SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)): the skill and its four outcome values in `hooks/protocol.mjs`, the digest gate and objection-to-author path in `WorkflowStore`, and the run gates of ADR-0011. The freeze is against that commit; a later baseline must be re-pinned before the freeze is re-asserted.

| Rule | Meaning |
| --- | --- |
| Frozen behavior | The `review-handoff` skill, its four `RELAY-OUTCOME` values, the worktree-digest gate on Send & relay, the objection-to-author correction instruction, and the run gates of ADR-0011 keep working as verified at the pinned compatibility baseline. |
| No new capabilities | Do not add worker/reviewer, solo self-relay, N-agent dispatch, explicit review ranges, remote publication, or PR features to the staging protocol. Workspace-first discovery, group terminology, compatibility/migration notices, and registration adapters may wrap the existing behavior without changing its meaning. Do not route an unsupported one-member/new-phase group into it. Bug fixes preserving the staging contract remain allowed. |
| Labeled in the UI | The handoff selector shows it as deprecated and states what it lacks; it is not the default for a new task. |
| One mode per run | A run records its implementation handoff mode before implementation dispatch and does not change it mid-execution. Plan always uses document handoff, so its authorized phase transition is not an accidental implementation-mode switch. The existing ownership lock on the worktree's canonical index prevents an uncommitted run and a commit-relay run from coexisting on one worktree. |
| Migration on one worktree | Before the first commit-relay run: reconcile or take over any uncommitted run, then have the human commit or discard the leftovers. Commit relay requires a clean index and non-ignored worktree at the expected branch tip ([Commit-based handoff contract](ADR-0014-commit-relay-and-deprecation.md#commit-based-handoff-contract), [User-prepared workspaces, branch consent, and remote operation](ADR-0012-workspace-discovery-and-groups.md#decision)); it never adopts a deprecated run's index/worktree state as an implicit first candidate. |
| Removal criteria | Remove the mode from the app only after commit relay has passed the host-acceptance items of [Acceptance scenarios](../TESTING.md#acceptance-scenarios) for peer relay and worker/reviewer on the supported installed implementation adapters (initially the configured Codex/Claude group), and after a deliberate decision that no remaining use case needs an uncommitted checkpoint. Removal from the app does not delete the skill from this repository. |
| Documentation | README, SETUP and SKILLS keep describing it while it exists, with the deprecation stated in the same place. |

Planning is not this fallback: ignored plan-file refinement is a phase-specific document handoff that does not reuse the index/worktree algorithm merely because neither uses commits. Three instruction contracts stay distinct: planning documents, uncommitted implementation relay, committed implementation relay.

## Commit-based handoff contract

**In commit-based Implementation, one completed turn publishes one handoff commit** containing one appended relay-log entry and any project changes permitted by the assigned action and decision. A report-only turn is meaningful work: acceptance without edits and objection with findings produce commits even when application files are unchanged, and no empty commit is needed because the log changes.

A task contains many turns and commits on one recorded implementation branch, normally a dedicated task branch, and at most one PR for the whole task. A user may explicitly continue on main/the configured primary branch instead; the same lineage and ownership checks still apply, and no automatic merge is implied. "Every completed turn" does not mean every tool action or partial attempt; an interrupted execution must not fabricate an acceptance to produce a commit. **First-release lineage rule:** each handoff is exactly one direct, single-parent commit on the expected task-branch tip. Do not create unreported intermediate commits on that active branch during the turn. Arbitrary new commits are not publications. The supplied text permitted local checkpoints while also requiring the handoff commit's parent to equal the turn's original parent; these cannot both hold when checkpoints advance the same branch. Multi-commit turns need a separate starting-base-to-final-head contract and remain deferred. No controller reset or history rewriting is introduced to hide extra commits.

A helper may validate and publish the result under the agent's authorized context. The agent following the commit-relay skill stages and commits its own handoff; the controller validates that publication read-only. Whichever component commits must preserve unrelated user work. The controller does not stage or commit on the agent's behalf, create worktrees, or prepare the tracked log by silently editing source files.

**V4 authority amendment:** the prior blanket prohibition on controller Git mutation is narrowed only for explicitly confirmed **creation and checkout of a new branch at the validated current commit** at a settled setup boundary. [ADR-0013](ADR-0013-confirmed-branch-setup.md) records this exception; implementation remains pending. Preparing the tracked log remains an authorized human/agent/helper setup step. The exception does not grant existing-branch switching/reset, stash/reset/clean, force-push, commits, merge, rebase, deletion, or worktree lifecycle authority. No turn changes its branch underneath active workers.

The first release starts and dispatches every commit-relay turn only when the index and non-ignored worktree are clean at the expected branch tip. That precondition is what prevents an agent's handoff commit from sweeping pre-existing user hunks into publication; a post-commit digest cannot retroactively provide that ownership boundary. Users with intentional uncommitted work either reconcile it themselves before commit relay or keep using the deprecated local mode. The controller never stashes, resets, discards, or commits it.

## One tracked append-only relay log

Use one ordinary Git-tracked file on the task branch, working path `.codercrew/relay-log.md`. The path is a proposal; the single-file, append-only behavior is the agreed direction. It is the collaboration journal, separate from the product's release `CHANGELOG.md`, and Plan turns do not append to it.

```text
Worker writes files and appends an entry in its checkout.
    ↓
The commit records the project state and relay log together.
    ↓
For remote operation, the commit is pushed to the selected remote branch.
    ↓
The next worker fetches the commit, including the log.
```

The log must not be ignored or kept only in CoderCrew's database: a tracked log travels with the code, and with a PR it is a file in the branch, not a PR comment. Runtime metadata (databases, tokens, sockets, diagnostics) stays outside managed worktrees regardless.

Each completed commit-mode turn appends exactly one structured entry; earlier entries are never rewritten, and corrections are new entries. Sequential turn ownership is what makes one growing file appropriate: competing publications are a coordination conflict, not an invitation to merge fragments. `.codercrew/plans/` is excluded narrowly while the log stays tracked; a one-time implementation-start record may carry the approved plan when that transfer format is selected.

## What the log records and what Git supplies

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

### Working entry schema

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

### Illustrative entry

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

### Rules

- The entry references input revisions that already exist. The commit's own SHA is obtained after the commit; inserting it into the file it identifies changes the contents being identified.
- Git author and agent identity stay separate; several agents may share a Git author. Record the model only when the runtime supplies it.
- The log is authoritative for protocol data; the commit message is a readable summary. Commit trailers and empty commits were considered and not chosen.
- The same applies to the final `RELAY-OUTCOME` line the deprecated mode relies on. In commit relay the committed entry is the result channel; a final structured line can remain an optional summary, but is not required for a valid result. If explicitly supplied, compare its **normalized meaning** against decision plus project diff: legacy `accept_without_improvement` is consistent with `decision: accept` and a log-only turn. Contradictory structured claims pause; arbitrary explanatory prose is not a second machine-authoritative result. The committed entry never loses to a guessed outcome from screen text.

## Revision identity and review scope

A commit means **recorded**, not **accepted**; a pushed commit is not accepted either. The controller needs distinct revision concepts:

| Reference | Meaning |
| --- | --- |
| `taskBaseSha` | Starting baseline for the whole task. |
| `acceptedSha` | Latest project state accepted under the protocol. |
| `candidateSha` | Proposed project state awaiting review. |
| `reviewBaseSha` / `reviewHeadSha` | Explicit endpoints for the review being requested. |
| `expectedParentSha` | Branch tip on which the next publication is expected to build. |
| `publishedCommitSha` | Commit containing the completed turn's new report and permitted changes. |

These need not all be stored fields if some are derived reliably; their meanings must stay distinct.

### Acceptance does not approve the reviewer's new edits

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

### Rejection changes the next review range

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

### Plan versions are not implementation SHAs

A plan candidate has a document revision/content hash and a code SHA for its planning baseline. Endorsements and phase authorization bind the exact plan revision, brief, baseline, planning epoch, and required roster revision. Approval from one of N planners applies only to its recorded version; the latest two endorsements is not group agreement. Agreement on a plan never advances `acceptedSha`; the first implementation candidate still requires the applicable code review or explicit human verification in solo use. A solo planning recommendation is not independent code acceptance.

## Review decisions and derived change status

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
