# Security and operational boundary

**Current versus target:** the lifecycle boundary below originated at `46f228b`; later local Plan/Implementation and setup support is recorded in [VALIDATION](../VALIDATION.md). [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md) owns the two narrow controller Git-write exceptions: confirmed new-branch checkout and separately confirmed task-worktree creation. No general Git-write API exists.

CoderCrew controls coding agents with their existing host privileges. It is not a
sandbox, process attestation system or lock against external filesystem writers.
A malicious agent running as the same Unix user can access the token or tmux socket.

## Access

The backend binds to 127.0.0.1. Every API read/write, including hook intake and run
actions, requires the 256-bit owner bearer token. Exact host/origin allowlists,
cross-site refusal, bounded JSON and literal terminal arguments remain enforced.
Output is displayed as React text. Do not introduce HTML interpretation or a
shell-execution endpoint. The token grants read access to all pane previews on the
configured tmux server, even panes not registered as workers.

Keep token/config/store backups private. Setup uses restrictive file modes; browser
tokens remain only in memory. Never use NEXT_PUBLIC_* for a secret. Hook posting is
restricted to loopback; ordinary remote access uses private Tailscale Serve, not
public Funnel. Production CSP, device pairing/revocation and rate-limit hardening
remain acceptance work, not claimed protections.

## Delivery and execution

The transport reservation protects delivery only. A separate server-owned run
retains execution ownership across clean deliveries. Only current correlated
completion plus explicit clear background-work evidence can schedule another
participant. Missing evidence pauses. No outcome line alone proves quiescence or
correct Git staging. No terminal text is parsed as an authorization signal.

Events carry exact command nonce and prompt echo, pane/server/socket identity,
source session and turn. Claude requires a matching start acknowledgment; old
follow-up events cannot complete a newer turn. The session is pinned within a
command, not across the registration. Event dedup and next-command creation are transactional.
The owner token is the trust boundary; these event identities are correlation, not
cryptographic attestation of a CLI.

One backend process per database is supported. Startup pauses active runs and
never replays uncertain sends. A browser is an observer/controller client, never
the scheduler. Locking or closing it does not pause the server. Multiple views
share the same run policy and budget. Use the run's Pause action before takeover.

Pause does not interrupt an in-flight send or running/background process. Explicit
takeover requires the human to inspect all participants, stop writers and reconcile
partial input. It releases ownership without recording task success. External
terminal typing remains outside the controller's filesystem authority; unmarked
Claude starts pause affected runs when the hook reports them. There is no guarantee
of observing every external command or descendant writer.

## Git and lifecycle limits

Pairs require canonical root/gitdir/standard-index identity. Custom per-worker
GIT_INDEX_FILE and related overrides are unsupported and must not be used. Pane
identity and process-name checks narrow but do not eliminate the check/use race.

Codex notify does not supply background-work proof, so the server compares the
processes under or attached to the pane before delivery and at completion. This
detects surviving work in the pane's process tree or on its controlling terminal;
it is not process attestation and cannot prove the absence of deliberately detached
work. An unreadable process table remains unknown and pauses. Claude versions
without current Stop response/background fields also pause. Installed-version and
real-agent acceptance is required before leaving a run unattended.

## Installation and storage

The hook installer validates both edit plans first, preserves unrelated entries,
refuses unsupported TOML, backs up changed files with mode 0600 and atomically
replaces each file. Two files are not a single transaction; retain backups until
validation succeeds. Concurrent external edits and configuration formats outside
the supported subset require manual reconciliation.

SQLite version 7 prevents old runtimes from ignoring phase-aware runs or uncertain worktree-creation ownership. Delivery
history, lifecycle inbox, run/turn records and prompt text are plaintext outside
managed worktrees. Workflow/audit retention is not yet pruned. Raw screen snapshots
are not stored. Hook correlation context is private local data. No runtime log or database
should be committed. The future tracked implementation relay log is a distinct
protocol artifact defined by ADR-0014, not permission to commit runtime data. The original review skill remains responsible for staging;
the staging controller issues no Git mutations and does not independently prove its outcome.

---

## Validation and permissions

### Workspace and group readiness before any new run

Validate the selected workspace against current pane discovery, not a cached display label: exact instance identities/generations; eligible adapters; distinct members; enabled member-count limit; common canonical cwd; common local worktree/index; clean-entry requirements; and no conflicting owner. Unknown/non-agent panes are not automatically selected. Surface relevant unselected agents sharing the checkout and reconcile potential writers.

Validate one-member groups as solo, not two references to one instance. Worker + reviewer requires distinct identities; Peer relay also needs two. Enforce these server-side. The later N-agent Plan policy is enabled only after its complete-roster, adapter, and recovery checks are accepted; discovering three panes alone does not enable it.

Branch setup uses [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md)'s separate confirmed operation. Publication validation remains read-only, and run inspection does not implicitly authorize creating a branch or fixing the environment.

### Project identity and task-worktree creation

Projects use canonical local Git common directories, not remote URLs. Worktree/index
identities still own execution; never replace that lock with the shared project key.
Git worktree inventory can show empty or unavailable checkouts without claiming any
agent is ready. Discovery and navigation do not mutate Git or save registrations.

Confirmed creation is constrained to a known project, revalidated source identity,
exact committed baseline, new branch and unused destination under the task-worktree
root. Normal bearer/origin checks and host input enablement apply. Use argument
arrays, disable hooks for setup, and reject branch/path collisions, destination
symlinks and overlap with known checkouts or controller metadata. The source may
be dirty because no source file/index is copied or changed. Do not copy ignored
secrets, install dependencies, launch/move agents or edit ignore rules.

Persist the operation and a project-scoped setup owner before Git. Identical requests
return their recorded result, and restart never replays creation. A failure after
attempting Git retains uncertain ownership until explicit read-only reconciliation.
No automatic rollback, branch deletion, worktree removal or cleanup is permitted.
These checks do not prevent a malicious same-user path race or configured Git
filters from running during an ordinary checkout; use trusted repository settings.

### Validate implementation publication, not just its existence

| Area | Intended validation |
| --- | --- |
| Identity | Expected run, bound workspace and group/membership revision, turn, exact participant generation, action, and policy revision. |
| Branch lineage | Recorded checked-out implementation branch, expected publication parent and task history; no silent branch following, divergence, or rewritten turns, including when main was explicitly chosen. |
| Review scope | Recorded baseline/head match the proposal actually assigned. |
| Log | Exactly one valid new entry; previous entries preserved; required fields and judgment valid. |
| Project diff | This turn's changes outside the exact log path. |
| Permission | Reviewer-only and objection turns do not alter project content. |
| Pre-existing work | Clean entry and pre-dispatch checks prevent earlier user work from being swept into a handoff. |
| Task scope | Enforce a controller-assigned path allowlist when an implementation action defines one. Planning file assignments use the separate phase-specific checks below. Otherwise show the complete project diff for review rather than claiming semantic scope can be inferred automatically. |
| Duplication | Not already consumed; competing publications for one turn are a conflict. |
| Evidence | Reported checks and limitations attributable to the revision evaluated. |
| Leftovers | Post-publication leftover digest is empty ([Publication, hooks, and completion evidence](adr/ADR-0017-phase-orchestration-and-evidence.md#publication-hooks-and-completion-evidence)). |
| Consistency | An explicitly supplied structured summary agrees semantically with decision plus derived diff; no duplicate result line is required ([What the log records and what Git supplies](adr/ADR-0014-commit-relay-and-deprecation.md#what-the-log-records-and-what-git-supplies)). |

Fast-forward publication is the starting policy; divergence pauses for reconciliation rather than force-push, reset, or rebase. A protocol violation is never "repaired" by rewriting user changes or laundering reviewer edits into a report-only result.

### Trust and human authority

A structured acceptance is a judgment, not proof of correctness, and a log entry does not cryptographically prove which model authored the work. Keep the narrow terminal interface, explicit targets, authentication/origin controls, read-only option, and no automatic retry of uncertain delivery; never add a generic shell endpoint. Permission escalation, destructive actions, scope expansion, and unresolved product choices require explicit human authority. Same-user agents already have the filesystem, credentials, and tmux socket: scheduling checks and skill instructions are not operating-system boundaries.

### Plan validation and permissions

Before Plan entry: validate the clean project, common brief/baseline, selected group size under the enabled limit, N distinct eligible registrations in the same canonical cwd/worktree/index, complete required roster, safe distinct filenames, and narrow ignore/untracked state. Native output constraints are adapter-specific and cannot be bypassed by broadly enabling edits.

During drafting: allow disjoint active output grants only. At a completion, verify the completing artifact and protected project state while permitting other active owners to change their own assigned drafts. Frozen/idle/unassigned artifacts remain protected; unexpected files are not silently included. Before synthesis, verify the complete finalized manifest and that no draft writers remain active. Underlying snapshots do not prove who wrote an active peer's file or prevent reads.

During refinement: one writer, exact input/output versions, and an endorsement set for the required roster. On every change, invalidate stale approvals. Agreement from two agents cannot complete a later N-agent plan unless those two are the explicitly chosen required set under a new human-authorized roster revision. N=1 produces a version-bound solo recommendation and uses the approval gate without claiming an independent endorsement.

Before implementation: consume an exact-version human approval or a valid preauthorized agreement once, with all planning activity settled. Preserve final text, membership, findings, and authority. An ignored draft accidentally committed during implementation is a protocol violation, not a reason to exclude more paths from project review.

Validate the actual file schema as well as hashes: expected regular file, bounded size, acceptable text encoding, no unexpected path indirection, and supported result fields. File content is untrusted display data; a plan instruction cannot grant itself runtime permissions or approve a phase transition.
