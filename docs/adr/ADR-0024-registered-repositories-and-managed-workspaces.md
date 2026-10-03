# ADR-0024: Registered repositories, app-created task workspaces and recorded agents

Date: October 1, 2026

Status: accepted direction through an endorsed two-planner Plan (run `76b37b3a`, brief revision 1, plan
revision 1), with the transition into Implementation authorized by that run's automatic policy rather than a separate
human checkpoint. **Implementation in progress:** this record (I0) and the registry, upgrade gate and migration (I1)
are implemented locally; increments I2–I7 below are not. Until I2 lands, the runtime still lists projects and
enrolls agents through discovery as [ADR-0012](ADR-0012-workspace-discovery-and-groups.md) describes, and the
statements below that change user-visible behavior are design, not shipped behavior.

## Context

AltCLI derives its structure from observed host state. Every state read lists every pane on the configured tmux
server, inspects each distinct directory and its Git identity, groups the results into workspaces and proposes
registrations; the project view lists every worktree Git reports. That makes AltCLI answer whether an observed pane
is a participant, an unrelated session or Helper merely because it is visible, and it inspects unrelated directories
on every poll. Agents launched by AltCLI itself only become agents through the same discovery.

An external review proposed the reverse: register repositories explicitly, create task workspaces through the app
and manage only the agent instances the app launched. Two planners refined it into the endorsed plan; this record is
its canonical home.

## Decision

**Records determine membership; live inspection determines condition.** A pane, directory, branch name, tmux
socket or Git worktree listing never establishes membership by itself. A record never proves readiness: an
unavailable observation is Unknown, not Stopped, and Idle/Ready describe native evidence, not permission to send.

| Resource | How it enters AltCLI | AltCLI's responsibility |
| --- | --- | --- |
| Registered repository | The owner adds it and confirms a base checkout, a local integration branch and optional default agents | Remember identity and choices; source for new task workspaces |
| Base checkout | Part of registration: any existing non-bare checkout of the repository, on any branch, linked or not | None beyond inspection. Registration grants no ownership, reset, branch switch or removal authority |
| Task workspace | A confirmed, verified worktree creation | Task lifecycle: launches, Plan, Implementation, reuse, integration, Finish, removal or discard |
| Workspace agent | A confirmed launch into an active task workspace | Identity, observation, group membership, closing and cleanup |
| App-wide instance | Helper start (later, the Background assistant) | Its own record and lifecycle; never workspace membership |
| Anything else | Hand-started panes, extra windows, unrecorded worktrees, any session on either tmux server | Never enrolled, stopped or deleted; inspected read-only at operation boundaries |

### Product boundary

- New launches, plain Send, Plan, Implementation and committed review require an active app-created task
  workspace. The base checkout has no agent or task-execution controls.
- New Stage relay starts and in-place branch creation (`branch.newBranch`) leave the normal flow. This amends the
  product-entry rules of [ADR-0014](ADR-0014-commit-relay-and-deprecation.md) (D51) and the existing-checkout branch
  exception of [ADR-0013](ADR-0013-confirmed-branch-setup.md) (D46). The staging skill, its protocol, records and
  recovery of earlier runs are preserved; nothing relocates Stage relay onto task branches.
- One explicitly selected local integration branch per repository drives creation baselines and every
  integration and reuse check (squash, update, rebase, reset, Finish facts and removal evidence). main or the
  recorded default is only a suggestion; the base checkout's current branch is a different fact. Squash still
  commits in the clean, unowned checkout that has the selected branch checked out, which need not be the base;
  locating it is verification, not enrollment. A missing integration branch is a diagnostic, never a fallback to main.
- **Create & launch** is one exact preview and one confirmation with separately recorded effects: creation runs
  once and is verified before any launch; each launch has its own outcome; partial success remains; unknown effects
  are never replayed; zero selected agents means Create only.
- Membership comes from an app launch with the expected supported CLI. A later replacement process, a move to
  another checkout or a hand-started CLI never silently renews authority; manual (shell) profiles stay terminals.
- Desktop attachment, several browsers and phone access remain supported under the existing concurrent-writer
  rules of [ADR-0020](ADR-0020-native-terminals.md). No exclusive keyboard claim returns. Login, trust and startup
  prompts keep today's launch reservation and inspection; generalized startup input remains the separate B1 proposal.

### Native access

| Activity | Behavior |
| --- | --- |
| Attach from a desktop terminal or another browser | Supported: the same instance. The Console offers a server-built **Copy attach command** |
| Rename the tmux session | Identity is the recorded server, session, window and pane plus the full launch marker; names are labels |
| The CLI exits | The agent shows Exited; the workspace stays, with launch and cleanup actions |
| Another session starts in the same directory | Not enrolled; an outside writer at boundaries |
| An agent moves, or the workspace branch changes | Reported as a mismatch; runs pause at existing binding checks. ADR-0012's moved-pane rebinding is removed |
| Windows or panes are added to an app session | Not participants; cleanup and Finish preview the changed layout |

### Outside writers at operation boundaries

Normal inventory is record-based. Operations that already inspect checkout occupants (removal, discard and Finish
removal; squash activity; checkpoint capture; Finish previews) inspect a finite endpoint set: the app endpoint,
the user's default tmux endpoint (resolved without inherited `TMUX`) and previous endpoints recorded for affected
resources. Each pane is queried through its own socket; absence differs from unreadable inventory; nothing foreign
gains membership or is closed. Update, rebase, reset and rename keep their warned confirmation without a new
activity veto. This covers the known tmux boundary, not every editor or process: it is not filesystem isolation.

### Dedicated tmux endpoint

AltCLI uses `-S <canonical data directory>/tmux.sock` by default, keeping `ALTCLI_TMUX_SOCKET` as an absolute
override, validated for private ordinary parents and a conservative path length. The effective endpoint is
persisted; changing it passes the same settled-store gate. One resolver serves delivery, inspection, launch,
terminals, Helper, cleanup and diagnostics, with no fallback to the default server. Commands that may start the
server use the nonsecret launch-environment allowlist; each launched child is still cleaned of inherited tmux
environment. A sanitized start is not a credential-free guarantee against user tmux configuration. Helper runs on
the same endpoint; a session there is not managed merely because it shares the socket. This resolves the
app-owned socket choice in [OPEN-DECISIONS](../OPEN-DECISIONS.md).

### Upgrade

The store upgrades only from a settled state, checked before anything is written: no run owner, unresolved delivery
or input, unreconciled manual input, launch or cleanup reservation, launch or cleanup still awaiting inspection (a
released reservation does not settle a launch later seen starting, exited or uncertain), applying or uncertain
setup, squash, update, rename, removal, discard or Finish, and no uncertain Helper start. A refusal changes nothing
and names each blocker; the previous version settles them. The previous schema is copied privately before migration.
Migration invents no choices: persisted projects become repositories awaiting confirmation; verified creations
become task workspaces only when saved records from their lifetime prove one identity, otherwise `pending`; launches
link only to a workspace whose exact identity they recorded during its lifetime. Hand-started agents and unrecorded
worktrees stay history; adopting them remains deferred. No legacy execution mode runs beside the new architecture.
Rollback is a settled restoration of a compatible backup and binary.

## Amended and superseded records

| Record | Change |
| --- | --- |
| [ADR-0004](ADR-0004-observed-process-identity-and-console-registration.md) | Pane registration and discovery enrollment are superseded once I2 lands; identity checks remain |
| [ADR-0012](ADR-0012-workspace-discovery-and-groups.md) | Discovery-derived projects, worktree cards from Git inventory, moved-pane rebinding and user-owned agent placement are superseded; common-directory identity, groups and frozen snapshots remain |
| [ADR-0013](ADR-0013-confirmed-branch-setup.md) | AltCLI places agents in workspaces it created; in-place branch creation leaves the normal flow; integration uses the selected branch |
| [ADR-0014](ADR-0014-commit-relay-and-deprecation.md) | New Stage relay starts leave the normal flow (D51 product entry); the contract and history remain |
| [ADR-0020](ADR-0020-native-terminals.md) | Terminals attach on the dedicated endpoint; navigation never enrolls its destination |
| [ADR-0021](ADR-0021-project-entry-and-agent-launch.md) | Registration confirms base and integration choices; launch is the only way an agent enters; Create & launch is accepted |
| [ADR-0022](ADR-0022-app-wide-ai-instances.md) | Helper and the Background assistant are recorded app-wide instances on the dedicated endpoint |

## Increments

Dependency order, not a commit count. Each records what actually ran in its commit message.

| Increment | Scope | Status |
| --- | --- | --- |
| I0 | This record and the amendments above | Implemented October 1, 2026 |
| I1 | Schema 20: the settled-store gate and private backup, read-only `npm --prefix web run upgrade:check`, repository settings (pending until confirmed; `POST /api/v1/projects/settings`), task-workspace records written by verified creation and maintained by verified rename, update, removal and discard (a recreated path is a new record), launch role and workspace links, backfill | Implemented locally October 1, 2026; no user interface yet, and listing, admission and discovery are unchanged |
| I2 | Registry-backed inventory and record-derived agents; shared server admission for every start, launch, edit, terminal and lifecycle path; compatibility endpoints; Helper reads; mock fixtures | Not implemented |
| I3 | Boundary occupant inspection across the finite endpoint set | Not implemented |
| I4 | Dedicated endpoint, its persisted transition, Helper and transport paths, attach command; the transition also covers a recorded Background instance ([ADR-0022 amendment](ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant)) | Not implemented; must not land before I3 |
| I5 | Create & launch with frozen launch intent and separate durable outcomes | Not implemented |
| I6 | Registration, New task, workspace and history surfaces; every integration path using the selected branch | Not implemented |
| I7 | Full checks, disposable installed-provider acceptance and documented settled deployment | Not implemented |

## Consequences

The ordinary flow becomes Add repository, New task, Create & launch, Plan or Implementation, then explicit
integration or Finish. A workspace stays visible with no running agents. Owners lose enrollment of hand-started
agents and new base-checkout quick fixes; continuing Stage relay, arbitrary adoption or phone-only startup recovery
would need a revised decision, not an undocumented bypass. A registry and a dedicated server certify neither
operating-system isolation, exclusive filesystem use nor the absence of background work. Performance gains are
expected from not inspecting unrelated directories, but none is claimed until measured.
