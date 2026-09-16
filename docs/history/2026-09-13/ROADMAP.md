# ROADMAP

## Project: Relay Controller (working name)

**Recorded:** September 13, 2026  
**Status:** Planning. No implementation is implied by this document.  
**Architecture record:** [ADR-0001: tmux-backed web controller](ADR-0001-tmux-web-controller.md)

## Goal

Build a small web controller for two existing AI coding-agent sessions: Codex and Claude Code, running in tmux. Provide one place to read their output, send instructions, and initiate the existing `relay` review workflow. Make the same interface usable from an iPhone through Tailscale.

Keep the human in control first. Add deterministic relay automation later, followed by an optional third AI supervisor.

## Decisions and boundaries

| Area | Current direction | Status |
| --- | --- | --- |
| Backend | Node.js | Confirmed |
| Frontend | TypeScript | Confirmed |
| Worker sessions | Keep Codex and Claude Code running in tmux | Confirmed |
| Main interface | Central reading panel and central command submission | Confirmed |
| Remote access | Reach the web interface from an iPhone through Tailscale | Planned product requirement |
| Development order | Build incrementally; defer the third AI | Confirmed |
| Initial terminal integration | Backend reads snapshots and sends commands directly through tmux | Working implementation plan |
| ttyd | Do not require a separate ttyd service in the initial architecture | Working implementation plan |
| Full interactive terminals | Add only when needed; xterm.js and node-pty are candidates | Optional, deferred |
| Frameworks and storage | Frontend framework, Node.js framework, backend language, and persistence implementation remain open | Not selected |

TypeScript is confirmed for the frontend. Node.js does not, by itself, settle whether the backend source will be TypeScript or JavaScript. React and SQLite were suggestions, not finalized choices.

## First useful release

Complete Phases 1 and 2 before adding an AI supervisor. The first release should allow this workflow:

1. Open the web interface on a desktop or iPhone.
2. Read the current output of both registered agents.
3. Select Codex or Claude Code and send `relay` or a single-line instruction.
4. Inspect the response and decide what to do next.
5. Close and reopen the browser without stopping either agent.

This release is a human-operated remote console, not an autonomous development system. It does not need a normalized conversation timeline or a full browser terminal to be useful.

## Phase 0: Record the design and choose the minimum implementation details

### Deliverables

- [x] Record the current roadmap.
- [x] Record the initial architecture decision.
- [ ] Choose the frontend framework and Node.js server framework, or explicitly choose no framework.
- [ ] Choose the backend source language and the smallest suitable persistence implementation.
- [ ] Choose how the frontend receives snapshots: polling, server-sent events, or WebSocket.
- [ ] Define how existing tmux targets are registered and validated on the development host.

### Exit criteria

The implementation choices are explicit, and a developer can build Phase 1 without introducing an AI supervisor, a separate terminal service, or a distributed architecture.

## Phase 1: Local manual reading and control

### Scope

Run one Node.js backend on the same host as the existing tmux sessions. Build a responsive TypeScript web interface. Integrate directly with tmux through a narrow adapter.

### Deliverables

- [ ] Register the existing Codex and Claude Code targets, including their agent labels, exact tmux target identities, and repository association.
- [ ] Display separate output panels in one interface, with clear attribution and a mobile-friendly single-column or tabbed layout.
- [ ] Read bounded pane snapshots through `tmux capture-pane`; show capture time, connection state, and whether the display is stale.
- [ ] Replace each displayed snapshot rather than append it as a new conversation message.
- [ ] Provide one command composer with an explicit target selector and a `Relay` action.
- [ ] Deliver a single-line instruction through the tmux adapter. Multiline paste, special keys, and full terminal input are outside the initial scope.
- [ ] Separate command receipt, tmux delivery, and agent completion in the UI. A successful delivery is not proof that the agent finished the task.
- [ ] Record command IDs and delivery outcomes. Never silently replay a command whose delivery is uncertain.
- [ ] Refuse missing or changed targets; surface ambiguous target state instead of blindly typing into a pane.
- [ ] Bind the backend to localhost and protect command-submission endpoints. Invoke tmux with argument arrays, not shell-concatenated user input.
- [ ] Keep controller metadata and logs outside the working repository.

### Operating boundary

The human decides when an agent is ready and which agent receives the next instruction. The application must not infer review acceptance or automatically advance the relay from terminal text or Git status.

Where both agents share a worktree and index, operate one writing turn at a time. This is an operating rule, not a claim that the controller can prevent every external edit or background process from writing.

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

- [ ] Define run IDs, turn IDs, handoff IDs, agent ownership, task scope, and explicit workflow states.
- [ ] Add a small handoff-reporting helper around the existing skill without changing its staging rules implicitly.
- [ ] Preserve the skill's four outcomes: no incoming handoff, strong objection, accept without improvement, and accept and improve.
- [ ] Advance only from a validated outgoing handoff. Do not treat already-accepted staged work as a new pending turn.
- [ ] Associate handoffs with repository snapshots or fingerprints that cover the relevant index, worktree, and in-scope untracked content.
- [ ] Add a persistent command queue, duplicate suppression, delivery acknowledgments where available, and recovery for uncertain delivery.
- [ ] Enforce one scheduled writer, while treating external edits and unfinished write-capable background work as reasons to pause.
- [ ] Add explicit manual takeover, resume, and pause-after-turn controls. An immediate interrupt requires reconciliation before another handoff.
- [ ] Add configurable turn limits and clear pause conditions for objections, errors, unexpected repository changes, and exhausted budgets. The default limit is not yet selected.
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

This document records the September 13, 2026 design discussion and the user-supplied `review-handoff` skill in `SKILL.md`. Unselected technologies and later-stage features are intentionally labeled as open, optional, or deferred.
