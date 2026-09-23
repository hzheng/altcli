# ROADMAP

## Project: AltCLI

**Recorded:** September 13, 2026  
**Updated:** September 16, 2026  
**Status:** Starter scaffold prepared and locally validated with the test adapter and against a private tmux server. Phase 1 acceptance with real coding-CLI sessions remains pending. Source files do not imply a tested release.  
**Architecture record:** [ADR-0001: tmux-backed web controller](docs/adr/ADR-0001-tmux-web-controller.md)

## Goal

Build a small web controller for existing AI coding-agent sessions, typically Codex and Claude Code, running in tmux. Provide one place to read their output, send instructions, and initiate the existing `relay` review workflow. Make the same interface usable from an iPhone through Tailscale.

Keep the human in control first. Add deterministic relay automation later, followed by an optional third AI supervisor.

## Decisions and boundaries

| Area | Current direction | Status |
| --- | --- | --- |
| Project name | AltCLI: the crew is Codex, Claude Code, and the developer | Confirmed September 16 |
| Backend | Node.js with TypeScript source | Confirmed September 14 |
| Frontend | TypeScript; React / Next.js App Router for the scaffold | TypeScript confirmed; Next.js App Router selected |
| Worker sessions | Keep the coding CLIs running in tmux; register any number of panes from the console's live pane list | Confirmed; multi-pane registration September 15 |
| Main interface | Central reading panel and central command submission | Confirmed |
| Remote access | Reach the web interface from an iPhone through Tailscale | Planned product requirement |
| Development order | Build incrementally; defer the third AI | Confirmed |
| Initial terminal integration | Backend reads snapshots and sends commands directly through tmux | Working implementation plan |
| Pane identity | Exact tmux identity plus the process name observed at registration; shells and generic interpreters are denied | Selected September 15, ADR-0004 |
| Projects and pairs | Sessions group by worktree root; named relay pairs must share that root; one in-flight or unacknowledged command per worktree | Selected September 15, ADR-0005 and ADR-0008 |
| ttyd | Do not require a separate ttyd service in the initial architecture | Working implementation plan |
| Full interactive terminals | Add only when needed; xterm.js and node-pty are candidates | Optional, deferred |
| Frameworks and storage | Next.js / React / Tailwind; SQLite via better-sqlite3; Vitest and Playwright | Scaffold selection, ADR-0002 |
| Snapshot updates | Polling; replace current pane snapshots | Initial implementation choice |
| Native iOS | Reserve ios/ and a versioned HTTP contract; no native implementation yet | Deferred |

The user subsequently confirmed TypeScript for both the frontend and backend and requested a Next.js web stack. The starter therefore selects Next.js App Router, React, Tailwind, SQLite, Vitest, and Playwright. See [ADR-0002](docs/adr/ADR-0002-typescript-web-stack.md). These later choices settle the original open stack decisions without changing the staged product rollout.

## First useful release

Complete Phases 1 and 2 before adding an AI supervisor. The first release should allow this workflow:

1. Open the web interface on a desktop or iPhone.
2. Read the current output of every registered agent.
3. Select an agent, such as Codex or Claude Code, and send `relay` or a single-line instruction.
4. Inspect the response and decide what to do next.
5. Close and reopen the browser without stopping either agent.

This release is a human-operated remote console, not an autonomous development system. It does not need a normalized conversation timeline or a full browser terminal to be useful.

## Phase 0: Record the design and choose the minimum implementation details

### Deliverables

- [x] Record the current roadmap.
- [x] Record the initial architecture decision.
- [x] Choose the frontend framework and Node.js server framework, or explicitly choose no framework.
- [x] Choose the backend source language and the smallest suitable persistence implementation.
- [x] Choose how the frontend receives snapshots: polling, server-sent events, or WebSocket.
- [x] Define how existing tmux targets are registered and validated on the development host.

### Exit criteria

The implementation choices are explicit, and a developer can build Phase 1 without introducing an AI supervisor, a separate terminal service, or a distributed architecture.

## Phase 1: Local manual reading and control

### Scope

Run one Node.js backend on the same host as the existing tmux sessions. Build a responsive TypeScript web interface. Integrate directly with tmux through a narrow adapter.

### Scaffold inventory (not acceptance)

The starter contains a responsive console for any number of registered panes grouped
into projects, a registration form fed by the live tmux pane list with pane previews and
a confirmed agent type, named relay pairs, mock and tmux adapters, authenticated API
routes, a SQLite audit store, UUID-based duplicate suppression, and a per-worktree
per-worktree hold for in-flight and uncertain deliveries. It does not automate turn-taking. Smoke,
unit, build, browser, and private-tmux-server checks pass locally; real coding-CLI
sessions and phone acceptance remain unverified. See [VALIDATION.md](VALIDATION.md).

The checkboxes below remain open until the behavior is verified in the intended environment.

### Deliverables

- [ ] Register the existing coding-CLI panes from the console's live tmux pane list, recording a label, a confirmed agent type, the exact tmux identity, the observed process name, and the repository association; refuse shells and generic interpreters.
- [ ] Group sessions by worktree root, name the relay pair for each worktree, and refuse a pair whose sessions do not share one root.
- [ ] Display separate output panels in one interface, with clear attribution and a mobile-friendly single-column or tabbed layout.
- [ ] Read bounded pane snapshots through `tmux capture-pane`; show capture time, connection state, and whether the display is stale.
- [ ] Replace each displayed snapshot rather than append it as a new conversation message.
- [ ] Provide one command composer with an explicit target selector and a `Relay` action.
- [ ] Deliver a single-line instruction through the tmux adapter. Multiline paste, special keys, and full terminal input are outside the initial scope.
- [ ] Separate command receipt, tmux delivery, and agent completion in the UI. A successful delivery is not proof that the agent finished the task.
- [ ] Record command IDs and delivery outcomes. Never silently replay a command whose delivery is uncertain.
- [ ] Refuse missing or changed targets, including a foreground process that no longer matches the registered name; surface ambiguous target state instead of blindly typing into a pane.
- [ ] Bind the backend to localhost and protect command-submission endpoints. Invoke tmux with argument arrays, not shell-concatenated user input.
- [ ] Keep controller metadata and logs outside the working repository.

### Operating boundary

The human decides when an agent is ready and which agent receives the next instruction. The application must not infer review acceptance or automatically advance the relay from terminal text or Git status.

Where two agents share a worktree and index, operate one writing turn at a time; the controller holds a worktree while a command is in flight or its delivery is uncertain, and the readiness confirmation before each send is the human's check that the previous turn finished. This is an operating rule, not a claim that the controller can prevent every external edit or background process from writing.

### Exit criteria

Both sessions are readable and controllable from one local page. Explicit commands reach only the selected registered target. Browser reconnection and backend restart do not terminate the workers or automatically resubmit uncertain commands. The existing desktop terminals remain usable.

## Phase 2: Private iPhone access

### Scope

Expose the same web application privately through Tailscale. Keep all controller operations on the host; the browser is a client, not the owner of the workflow.

### Deliverables

- [ ] Configure private access through Tailscale Serve while keeping the backend bound to localhost. Public exposure through Funnel is not part of this plan.
- [ ] Restrict access to the intended user and document the application's authentication and authorization boundary.
- [ ] Protect state-changing requests against cross-site requests and validate origins for any WebSocket endpoint.
- [ ] Make output reading, agent selection, command submission, and delivery status comfortable on an iPhone.
- [ ] Reload authoritative server state after reconnection; do not replay browser-side pending commands automatically.
- [ ] Test phone disconnection, page reload, stale output, and accidental repeated submission.
- [ ] Document host availability requirements and how to restart the backend service without restarting the agent sessions.

### Exit criteria

The user can inspect both agents and manually conduct a relay from an iPhone without exposing a public terminal endpoint. Disconnecting the phone does not stop the agents or lose the server's command records.

**Milestone:** Stop and use this version in real work before expanding the architecture.

## Phase 3: Deterministic relay coordination

### Scope

Automate mechanical turn-taking only after the manual console is reliable. Use explicit handoff records and a deterministic state machine, not a third AI.

### Deliverables

- [ ] Define run IDs, turn IDs, handoff IDs, agent ownership, task scope, and explicit workflow states, attached to a registered relay pair and its worktree reservation.
- [x] Add a small handoff-reporting helper around the existing skill without changing its staging rules implicitly: the skill now ends with a `RELAY-OUTCOME:` line, read by the turn-complete hook from the CLI's final message (ADR-0010).
- [x] Ingest turn-complete events from the CLIs' own hooks instead of inferring completion from screen text: `hooks/altcli-turn-complete.sh` is Claude Code's `Stop` hook and Codex's `notify` command and posts the pane's tmux identity and the CLI's session id to `POST /api/v1/events` (ADR-0009). A missing or unmatched event means unknown, never complete. The console shows idle/working, hands the target to the pair partner, and pre-ticks readiness; it does not send. Repository fingerprints and automatic advancement remain open.
- [x] Preserve the skill's four outcomes: no incoming handoff, strong objection, accept without improvement, and accept and improve. They are the only values the outcome line may carry; the console routes on them.
- [ ] Advance only from a validated outgoing handoff. Do not treat already-accepted staged work as a new pending turn. Auto-relay (ADR-0010) advances only on a reported `accept_and_improve`; validating that report against index and worktree fingerprints remains open.
- [ ] Associate handoffs with repository snapshots or fingerprints that cover the relevant index, worktree, and in-scope untracked content.
- [ ] Add a persistent command queue, duplicate suppression, delivery acknowledgments where available, and recovery for uncertain delivery.
- [ ] Enforce one scheduled writer, while treating external edits and unfinished write-capable background work as reasons to pause.
- [ ] Add explicit manual takeover, resume, and pause-after-turn controls. An immediate interrupt requires reconciliation before another handoff.
- [ ] Add configurable turn limits and clear pause conditions for objections, errors, unexpected repository changes, and exhausted budgets. Auto-relay pauses on objections, missing outcomes, non-delivered sends, held worktrees, and a fixed 20-turn cap (ADR-0010); a configurable limit and repository-change detection remain open.
- [ ] Add a final task-scoped review and check step before marking the overall task complete. A settled relay is not, by itself, proof that the task meets its requirements.

### Exit criteria

A normal handoff can advance to the other agent without a human retyping `relay`. Duplicate events do not create duplicate turns. Empty handoffs, objections, ambiguous state, and limits stop advancement visibly. A controller restart does not create a second writer or silently replay an uncertain command.

## Optional branch: Full browser-terminal interaction

This branch may be taken after Phase 1 when actual use shows that snapshots and command submission are insufficient. It is not a prerequisite for deterministic relay automation.

- [ ] Evaluate xterm.js for browser rendering and node-pty for a backend terminal connection to a tmux attachment client.
- [ ] Attach to existing worker sessions rather than launch duplicate coding agents.
- [ ] Define input ownership when desktop and browser clients are both attached.
- [ ] Handle resizing, buffering, reconnection, and attachment cleanup without killing worker sessions.
- [ ] Retain the simpler reading-and-command interface for mobile use.

Do not add ttyd merely because the application uses tmux. Reconsider it only if a separately operated web-terminal service is demonstrably simpler than embedding the required functionality.

## Phase 4: Optional third AI supervisor

### Scope

Introduce an AI supervisor only after the controller and relay protocol work without it. Begin with advisory recommendations, not autonomous terminal control.

### Deliverables

- [ ] Provide the supervisor with a task brief, constraints, structured handoffs, and relevant evidence.
- [ ] Record proposed actions and the user's accepted, modified, or rejected decisions.
- [ ] Delegate only categories of routine intervention that have proved useful and fit explicit policy.
- [ ] Expose bounded controller actions rather than unrestricted shell or terminal access.
- [ ] Keep permission changes, destructive actions, scope expansion, and unspecified product decisions behind explicit authorization.
- [ ] Preserve all manual functionality when the supervisor is disabled or unavailable.

### Exit criteria

The supervisor reduces repetitive intervention without owning the scheduler or silently changing the task's goals. Deterministic rules continue to enforce ownership, limits, and stopping conditions.

## Future native iOS client

- [x] Reserve `ios/` and document the host/client boundary.
- [x] Add JSON-only TypeScript contracts and an initial HTTP OpenAPI description.
- [ ] Validate the web API in real use before freezing a native-client contract.
- [ ] Decide native authentication/pairing and secure credential storage.
- [ ] Implement and test a native client only after an explicit decision to begin it.

The first phone milestone remains the web UI over Tailscale. No SwiftUI project,
Swift code generation, or standalone iOS agent runtime is implied.

## Existing review-handoff contract

The supplied `review-handoff` skill remains the source of truth for reviewing and staging code:

- An explicit HEAD or index baseline takes precedence. Otherwise, the skill selects the baseline from repository state.
- Accepted incoming changes are staged before the reviewer makes improvements.
- The current reviewer's outgoing improvements remain unstaged for the next reviewer.
- Strong objections leave the index and worktree untouched.
- Unrelated or unreviewed changes must not be swept into staging.

The controller coordinates delivery and ownership. It does not independently stage, commit, reset, or rewrite changes. Any future change to the skill's contract must be a separate, explicit decision.

## Scope guardrails

Do not make the first release depend on a native iOS app, cloud hosting, multiple backend services, an external message broker, autonomous agent startup, terminal transcript reconstruction, or AI-generated summaries. These are not current requirements.

Evidence that would justify expanding the design includes repeated need for interactive permission handling, unreliable snapshot-based reading, or well-understood manual decisions that can be safely delegated.

## Source of this roadmap

This document records the September 13, 2026 design discussion and the user-supplied `review-handoff` skill, now kept at `skills/review-handoff/SKILL.md` and installed from there. Unselected technologies and later-stage features are intentionally labeled as open, optional, or deferred.
