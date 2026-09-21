# Validation layers

**Scope:** the existing suite description below is retained. The [acceptance scenarios](#acceptance-scenarios) are requirements for future collaboration increments, not a claim that those tests exist or pass. See [VALIDATION](../VALIDATION.md) for recorded executed checks.

Run the repository gate from the root; no root package.json is required.

```bash
npm --prefix web ci
./scripts/check.sh
./scripts/check.sh --e2e
```

The gate checks skill installation (read-only), dependency-free setup/hook/config
regressions, transport smoke tests, workflow tests against better-sqlite3, full
TypeScript, Vitest and production build. The e2e gate adds Playwright against mock
servers. Each viewport has a separate store. Mobile Chromium emulation is not
physical Safari/Tailscale validation.

## Focused checks

```bash
node --test scripts/review-regressions.test.mjs
node --test scripts/setup.test.mjs
cd web
npm run test:smoke
npm run test:workflow
npm test
npm run typecheck
npm run build
npm run e2e
```

Setup/hook/config tests use temporary homes only. Setup tests run the real hook
and skill installers in a copied fixture, but stub npm rather than install or
download dependencies. The HTTP hook smoke test invokes the
real hook with a fake tmux metadata executable and a loopback test server; it does
not launch a coding CLI. It proves current-message preference, start/stop binding,
overlapping-start refusal and no lagging-transcript reuse.

Workflow tests use simulated terminal transport and real SQLite. They cover exact
pair routing, duplicate and reordered lifecycle delivery, current-command binding,
source acknowledgment/session identity, unknown background state, delivery races,
long-running work beyond history limits, budget, restart and human takeover. Git
identity tests create disposable repositories, subdirectories and linked worktrees.

Browser tests cover explicit readiness, registration, pair selection, server
progression with a locked page, multiple views, pause/takeover, uncertainty and
unauthorized reads. Assertions use explicit correlated hook fixtures; they do not
pretend those are actual installed Codex/Claude payloads.

## Host acceptance still required

Use a disposable repository and private tmux socket first. Start with a harmless
read/echo process to check transport, then actual installed Codex and Claude Code.
Inspect process metadata, output and exact submitted prompt including command
marker. Confirm current hook fields and background-state evidence; missing fields
must pause rather than be faked for the test.

Exercise permission dialogs, queued/partial input, native CLI restarts, backend
restart, two clients, and physical iPhone disconnection. Record the exact commit,
CLI/tmux/Node versions, commands and observed outcomes. Final task-level tests and
Git delta review remain required after a relay chain ends.

A green CI checks the implementation and fixtures, not the host's process identity,
background-task observability or private-device security boundary.

---

## Acceptance scenarios

Use behavior-based tests and label capability stage. N=3/N>3 model tests preserve the target design, but do not mean the first UI release can dispatch more than two selected members. Workspace discovery can list any number in either stage.

### Workspace, group, and branch scenarios

| Scenario | Expected behavior |
| --- | --- |
| Multiple panes in attached or detached tmux sessions | Discovery inspects panes on the configured socket, not only visible terminal clients. |
| Same cwd contains Codex, Claude, a shell, and a dev server | Only the two eligible coding agents count toward the suggested group; others are visible diagnostics as appropriate. |
| Workspace contains 0, 1, exactly 2, or 3+ eligible instances | No runnable group; solo; both preselected; all selected respectively. Every session has a checkbox; larger selections persist without first-two truncation. |
| Discovery lists many agents before N-agent dispatch is enabled | Inventory/selection are complete within configured scope; Start enforces the execution cap. |
| Two registrations refer to one actual execution | Cannot form a two-member group or provide two planning endorsements. |
| User deliberately deselects one of two suggested agents | Solo is allowed on the new workflow; polling does not restore the second selection. |
| One-member implementation group | One worker identity, no automatic self-relay or fabricated peer approval. |
| User requests self-review | Labeled non-independent and bounded; no automatic endless correction cycle. |
| Start/phase selects a worker and reviewer with the same instance ID | Refused server-side, not converted into a virtual pair. |
| Equivalent path spellings resolve to one cwd | One workspace grouping; exact underlying worktree/index still checked. |
| `/repo` and `/repo/web` are task groups beneath one worktree | Selected local group cannot mix them under the same-directory rule; concurrent conflicting runs share a lock and are refused. |
| Same repository but distinct linked worktrees | One project with distinct worktree/index identities and independent task ownership; not combined into a local group. |
| Separate clones have the same origin, or no remote exists | Group by canonical common Git directory, not URL or display name; separate clones have disambiguated task-path namespaces. |
| Worktree switches branch or detaches HEAD | Identity remains branch-independent; current path and branch/detached state are displayed. |
| Worktree has no panes, or its directory becomes unavailable | Git inventory keeps it visible with setup guidance or a diagnostic; no agent readiness is invented. |
| Newly created/explicitly used project has no agents after restart | Remembered project identity and Git worktree inventory restore visibility without a disk scan. |
| Worktree creation is previewed or a project opened | No Git/configuration mutation, directory creation, dispatch or run change. |
| Confirmed new task-worktree creation from a dirty checkout | Create only at the confirmed commit; source branch, staged/unstaged/untracked files and index remain unchanged. |
| Creation has stale source identity, branch, commit, path, invalid name, symlink or existing destination | Refuse/reconfirm before Git; no overwrite or environment copying. |
| Duplicate/concurrent creation confirmations | One durable operation owns project setup; identical IDs return existing state, changed inputs conflict. |
| Creation fails after Git starts, or backend restarts while applying | Retain uncertain owner; no automatic retry, cleanup or rollback. |
| Human inspects uncertain creation | Read-only verification of exact clean success or complete absence; partial/changed/unreadable results remain owned. |
| Removal of a linked task worktree is previewed | Read-only: named non-integration branch, clean tracked/nonignored state, no hidden index flags, no pane in the directory, no run/delivery/setup owner, and exact ancestry or a single matching squash commit on local main/default; anything else is a precise refusal, including a pane in the checkout whose directory was deleted. A stale pane in a deleted directory elsewhere blocks nothing. |
| Confirmed removal | Persist the owner and exact consent, revalidate live occupancy and Git evidence, then run one non-force `git worktree remove`; the branch, commits and run history are kept and ignored files are deleted only after the warning. |
| Removal fails after Git starts, the backend restarts, or the response is lost | Retain the uncertain owner; inspection verifies complete absence or the unchanged original checkout and never retries or force-removes; the browser keeps its pending confirmation until a recorded result exists. |
| Registered pane moves to another worktree while no run owns either checkout | Rediscovered under its saved name in the verified new placement; the next explicit edit or Start persists it and drops it from old groups. Missing process evidence, a changed pane identity, or ownership of either checkout is shown as the blocker instead of a rebind. |
| Dirty, unknown-runtime, or blocked workspace | Remains visible/readable; Start shows a precise precondition failure. Recheck performs no repair. |
| A new pane appears during a run | Available inventory changes; frozen group/roles/next actor do not. |
| Selected pane disappears, restarts, or changes cwd | Mark unavailable/pause; no automatic substitute, following, restart, or reduction to solo. |
| User opens/pins another workspace | Viewing changes only; no agent dispatch or branch mutation. |
| One of three same-worktree agents is not selected | It is unscheduled but visible as a potential writer; activity is reconciled before conflicting work or branch setup. |
| Current branch is main/configured primary | Explicit create-new or stay-current choice; staying says where commits land. |
| Current branch is feature/X while unrelated branches also exist | Actual checked-out branch is used; other branches do not trigger arbitrary selection. |
| Detached HEAD at a valid baseline | Plan may remain read-only; commit implementation waits for confirmed named-branch setup or user checkout. |
| No baseline commit exists | User preparation required; no automatic initial commit or fabricated history. |
| Plan approval is waived but branch consent is absent | Wait for branch choice; no mutation or code dispatch. |
| User confirms branch creation while planners are still executing | Record pending intent; do not switch underneath them. Revalidate at a settled boundary. |
| Branch name exists, is invalid, or baseline/workspace changed since consent | Reject/reconfirm; no force/reset or implicit adoption. |
| Two devices confirm branch setup, or restart occurs after an ambiguous operation | One scoped operation; inspect/reconcile actual state rather than blindly replaying. |
| Confirmed branch creation succeeds | Verify branch and unchanged baseline, bind group/branch, then dispatch once. |
| User chose to stay on main | No new branch; all normal clean-entry/lineage/ownership checks still apply. |
| Task finishes | Do not auto-merge, delete branch/worktree, remove environment files, or provision another directory. |
| Older stored pair configuration is migrated | Membership/history stays intact under group terminology; vendor event pairing is not renamed semantically. |

### Implementation scenarios

| Scenario | Expected behavior |
| --- | --- |
| Local proposal plus log entry | Exactly one handoff commit; the next review names that candidate explicitly. |
| Accept with log only | No artificial new proposal or metadata review loop. |
| Peer accepts and improves | Incoming candidate accepted; new edits still require peer review. |
| Objection with log only | Accepted baseline not advanced; reason available to the author. |
| Correction after objection | Review covers the revised proposal against the last accepted baseline, not only the repair commit. |
| Reviewer-only participant edits a test or config file | Role violation, even outside application source. |
| Optional advice on an accepted proposal | No forced revision loop. |
| Worker revises after actionable objection | Same roles; revised candidate returns to the reviewer. |
| Send with continuation preference on | No automatic successor. |
| Send & review with later continuation off | Initial review occurs; later cycles need a manual action. |
| Log-only `work` entry after Send & review | No review scheduled; chain ends or waits; `acceptedSha` unchanged. |
| Empty Review/Relay context | Reviews the assigned incoming revision; nothing inferred from terminal state. |
| Two overlapping selected/saved groups in a workspace | The frozen phase group bound to the run controls routing; creation order and discovery order do not. |
| Two browsers see the same publication; browser switches project, locks, or disconnects | One successor; policy and consumption independent of the viewing selection. |
| Commit-relay manual handoff | Advances without a recovery takeover; the deprecated mode remains unchanged. |
| Role change during an active turn | New policy waits for a boundary; old permissions govern that turn. |
| More than 30 unrelated recent commands | Active execution still tracked. |
| Worker interrupted or publication incomplete | No fabricated entry; no replay. |
| Restart after publication but before observation | Published result recovered without double execution. |
| Log tampering, multiple new entries, wrong parent, or competing publication | Refused or paused for reconciliation; no force-push or hidden rebase. |
| Entry `parent` differs from the commit's actual parent | Lineage mismatch; publication refused as competing. |
| Handoff commit published but staged, unstaged, or non-ignored untracked work remains | Leftover digest is nonempty; run pauses and names the paths. |
| Final `RELAY-OUTCOME` line contradicts the committed entry | Inconsistent turn; pause; the prose never wins. |
| Source hook notification lost | Artifact can be rediscovered; no ownership transfer until equivalent correlated lifecycle evidence or explicit human reconciliation is available. The required evidence is not tied to one vendor transport. |
| Commit exists but another writer is active | Snapshot existence is not safe ownership transfer. |
| Uncommitted (deprecated) run active on a worktree | A commit-relay run on the same index is refused until it is reconciled or taken over. |
| Task starts in commit relay with a dirty worktree | Refused with the paths shown; nothing staged, stashed, reset, committed, or discarded. |
| Remote worker receives the task | Fetches exact committed code and log without shared paths or index. |
| No PR configured | Local and remote publication still operate. |

Planning and transition scenarios:

| Scenario | Expected behavior |
| --- | --- |
| User starts directly in Implementation | No forced planning step, placeholder drafts, or fabricated approval. |
| Dirty project at Plan entry | Paths explained; refused until resolved; no automatic stash/reset/commit. |
| A project writer is already active | None of the selected planning roster is launched into that owned workspace. |
| Draft path not ignored, or already tracked, at Plan entry | Refuse to dispatch and report the setup mismatch; the controller writes no ignore rule. |
| Draft path or an existing parent is a symlink, special file, or resolves outside the worktree | Refuse before dispatch or capture; an ignored path is not authority to write through it. |
| Agent labels similar or containing path characters | Registry-derived safe IDs map to distinct controller-assigned files. |
| Draft file appears but no completed result exists | Incomplete; no premature cross-review. |
| Draft file exists but the turn ended without `PLAN-OUTCOME: complete` | Assignment incomplete; barrier closed. |
| First agent finishes earlier | Its new result remains withheld from all unfinished required planners until the complete-roster barrier opens. |
| One of N planners fails or is interrupted | Partial work preserved; its required slot remains incomplete; no automatic reduction to N-1. |
| Duplicate completion from one planner | Cannot fill another required slot, increase the completion cardinality, or create multiple synthesis actions. |
| Planning turn edits a project file, the index, or the tracked log | Project digest differs at completion; run pauses and names the paths. |
| Another active planner changes its own draft before A completes | Allowed under that assignment; does not create a false violation at A's completion. |
| A finalized or unassigned draft changes | Invalidate the affected result or pause; do not silently attribute the change to the completing agent. |
| A is observed writing B's draft through a mediated output path | Refuse the write or pause under the explicit path permission; snapshots alone do not prove attribution when B is also active. |
| Human types guidance directly into a planner's pane | Uncorrelated start pauses the run; guidance goes through the controller. |
| N draft assignments with a concurrency cap smaller than N | Exact per-assignment delivery; no more than the cap active, while the barrier still requires all N results. |
| All N required drafts finalize for current inputs | Originals frozen; exactly one synthesis; one unified-plan writer thereafter. |
| Plan unchanged with no explicit accept | Not agreement. |
| N=2: author recommends v3 and peer accepts v3 unchanged | Agreement on v3, subject to the checkpoint; task not complete. |
| N=3: A recommends v3 and B accepts, while C has not reviewed | Endorsements 2/3; no automatic agreement. |
| C changes v3 to v4 | Only C's explicit recommendation counts for v4; A and B must review v4. |
| Reviewer edits v3 to v4 | Previous endorsement does not apply to v4. |
| Plan objection with no edits | Reason and findings recorded; the unchanged file is not acceptance. |
| Refinement limit or oscillation | Pause/escalate; no forced agreement. |
| Human changes the shared brief | All required planners receive the revision at a boundary; stale drafts and endorsements do not satisfy current barriers. |
| Human submits agent-specific guidance while its planner is active | Guidance is visibly queued for the next boundary; no second prompt is injected into the active source turn. |
| Project baseline changes during planning | Reconcile before refinement or implementation. |
| Native CLI cannot write the assigned path, or offers to start implementation | Use supported capture or expose the limitation; the phase checkpoint cannot be bypassed. |
| Agreement with approval required | Wait; no code work. |
| Agreement, automatic collaboration on, approval off | Frozen authorized plan; implementation starts exactly once if all checks pass. |
| Approval off but automatic collaboration off | Await manual continuation. |
| Unresolved blocker with approval off | No automatic transition. |
| Human proceeds despite disagreement | Override and remaining objections recorded. |
| Plan changes after being displayed for approval | Stale approval rejected or new version reviewed. |
| Two devices approve or observe agreement together; browser closes while approval is required | One transition and one implementation start; checkpoint persists with no implicit consent. |
| Drafts cleaned up after transition | Frozen final text and authorization remain available. |
| Remote worker fetches implementation commits | Final-plan content supplied explicitly. |
| Return to planning from in-progress code | Writers settled and explicit reconciliation; no silent reset. |

Solo planning additionally tests one captured recommendation, optional promotion to the unified file, no unnecessary synthesis call, visible non-independent plan-ready status, both approval settings, no imaginary second completion, and no infinite self-review loop. Solo code output and optional self-review never count as independent acceptance merely because an event was recorded.

Additional multi-agent and adapter scenarios:

| Scenario | Expected behavior |
| --- | --- |
| Later 3+ planning capability enabled, including a Gemini-backed instance | N independent assignments and distinct outputs, one unified plan, no new workspace or supervisor; initial release otherwise requires selecting at most two. |
| Two registrations alias one live pane/session | Refused as distinct concurrent planners; aliases are not independent required results. |
| Agent label is `plan`, contains separators, or collides case-insensitively | Safe prefixed mapping has no collision with plan.md; unsafe or ambiguous paths are refused. |
| Same CLI/model used by multiple legitimate instances | Instances remain distinct; model metadata never serves as the assignment key. |
| Gemini event lacks Claude-only fields | Correct adapter applies its verified contract; fields are neither fabricated nor demanded from the wrong vendor. |
| Gemini completion cannot establish safe handoff evidence | Visible unsupported/unknown state; no automatic activity-clear claim. |
| Native planner can write only its own plans directory | Supported adapter capture or narrowly authorized output mapping; no broad project-write grant. |
| Native approval action would start coding early | Not approved before the app-level authorization gate. |
| One rejected or quota-limited planner is still required | Group waits or a human explicitly revises roster; no majority shortcut. |
| Human removes or replaces a planner | Settle its execution, record roster revision, invalidate stale transition/approval, preserve old evidence. |
| Old callback arrives after retry or registration replacement | Reject or retain as history; cannot satisfy the new assignment. |
| Plan returns to older text after further edits | Earlier-version/epoch approval is not resurrected merely by a matching hash. |
| Existing guidance is queued when all original drafts finish | Current required updates are resolved before synthesis; queue is not lost at the barrier. |
| Large roster exceeds configured planning budget | Warn/refuse or request deliberate budget change; no silently skipped reviewers. |
| Three planners converge, two chosen for Implementation | Only the implementation group receives code turns; all planning endorsements remain in history. |
| Auto-approved transition consumes a stale roster or brief | Refused; exact current versions are required. |
| Two tabs alter settings or approve simultaneously | One authoritative policy revision and transition; no double start. |
| Controller sees an extra unpublished commit during a first-release turn | Parent/single-commit contract violation; no hidden squash/reset. |

Automated fixtures, mock tmux tests, real tmux tests, installed-agent tests, and physical iPhone/Tailscale tests are reported separately; passing one category does not imply the others.

### Result-transport interpretation

Scenarios naming `PLAN-OUTCOME` assume the final-line transport. [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md#result-channel-and-stable-capture) also permits an equivalent correlated structured helper. Under that explicit adapter choice, test the same required identity, decision, findings, content, and lifecycle evidence rather than requiring both transports. A missing valid result is always incomplete.
