# ADR-0001: Build a tmux-backed web controller for Codex and Claude Code

> **September 14 follow-on:** CoderCrew is the project name. TypeScript is now confirmed for both sides, and the user requested TimedGoal stack alignment and an iOS reservation. [ADR-0002](ADR-0002-timedgoal-aligned-typescript-stack.md) resolves the original open stack choices; [ADR-0003](ADR-0003-manual-dispatch-boundary.md) records the scaffold's manual dispatch boundary. The historical wording below is retained; it is not the latest stack-selection status. The exact original is archived under `docs/history/2026-09-13/`.

**Date:** September 13, 2026  
**Status:** Accepted direction; implementation options explicitly marked below remain provisional.  
**Scope:** Initial architecture and staged evolution.  
**Related document:** [ROADMAP.md](../../ROADMAP.md)

## Context

The user normally runs Codex and Claude Code in separate terminals and alternates their reviews by typing `relay` in one terminal, waiting for its result, and then typing `relay` in the other.

The existing `review-handoff` skill defines how incoming changes are reviewed and accepted into the Git index. A reviewer's subsequent improvements remain unstaged for the next reviewer. The workflow already works and should be preserved rather than replaced by a new agent runtime.

The intended improvement is a standalone web controller that provides:

1. A central reading interface and central command submission.
2. Private, portable control from an iPhone through Tailscale.
3. Later automation of routine intervention, potentially assisted by a third AI.

The user prefers tmux, has selected Node.js for the backend and TypeScript for the frontend, and wants to build step by step. The third AI is explicitly deferred.

The architecture question is whether the controller needs ttyd, should embed terminal libraries, or can initially communicate with tmux directly.

## Decision

### 1. Confirmed product and technology choices

Use Node.js for the web backend and TypeScript for the frontend. Keep the two worker agents in existing tmux sessions. Provide a central web interface for reading output, selecting a worker, and sending `relay` or another instruction.

Develop the human-operated controller first. Plan private iPhone access through Tailscale. Defer the third AI until the controller is useful and reliable without it.

The frontend framework, backend source language, Node.js framework, storage engine, and browser update transport are not selected by this decision.

### 2. Initial implementation plan: direct tmux integration

Start with a backend adapter that reads pane snapshots and delivers explicit commands through tmux. The planned primitives are `capture-pane` for reading and `send-keys` for delivery.

The first interface is a central console with agent-attributed output panels and a shared command composer. It is not yet a full terminal emulator or a reconstructed conversation transcript.

Do not require ttyd as a separate service. A custom backend is already needed for target registration, application state, command routing, and later relay coordination. Direct tmux operations are the smaller starting boundary for this limited interface.

This is the working implementation plan, not a prohibition on using ttyd later.

### 3. Keep tmux worker lifetime independent of the web application

The backend connects to already-running agents. It must not start duplicate Codex or Claude Code processes when a browser connects.

Closing a browser, losing a phone connection, or restarting the controller must not intentionally terminate worker sessions. Session creation and destruction are outside the initial scope.

### 4. Keep full terminal support optional

When snapshots and prompt submission are insufficient, evaluate an embedded terminal path:

```text
Browser terminal component, potentially xterm.js
                      |
                  WebSocket
                      |
                 Node.js backend
                      |
              PTY library, potentially node-pty
                      |
               tmux attachment client
                      |
              Existing worker session
```

xterm.js and node-pty are candidate implementation components, not dependencies required by the initial release. This extension would attach a client to an existing session rather than launch another worker.

### 5. Keep relay mechanics deterministic

The controller should remain useful without an AI supervisor. Initial dispatch is manual. Later automatic turn-taking must be based on explicit handoffs, validated state, and bounded policies.

Terminal text is observation, not authorization. A pane containing "done" is not sufficient evidence to advance the relay. Likewise, a staged diff is not sufficient evidence that a new handoff exists.

An optional supervisor may later interpret findings and propose permitted actions. It must not replace the controller's ownership rules, delivery checks, or stop conditions.

## Initial architecture

```text
Desktop browser / iPhone browser
                 |
      TypeScript web interface
                 |
        Application API and updates
                 |
          Node.js controller
          |       |        |
     Agent     Command   State and
   registry    records   event records
          \       |        /
               tmux adapter
                 |
          Existing tmux server
          |                 |
      Codex target    Claude Code target
          \                 /
           Existing review-handoff workflow
```

During local development, the browser connects locally. The planned remote path places private Tailscale access in front of the same localhost-bound backend. The phone does not run the scheduler or own worker sessions.

### Component responsibilities

| Component | Responsibility | Not its responsibility |
| --- | --- | --- |
| TypeScript frontend | Show attributed output, freshness, delivery status, and explicit controls | Infer task completion from screen text or run the relay loop |
| Node.js controller | Validate requests and targets; route commands; retain application state; later coordinate turns | Independently stage or rewrite the agents' changes |
| tmux adapter | Resolve registered targets, capture output, and deliver input | Judge whether code is correct or a review is accepted |
| Existing workers and skill | Implement, review, stage accepted incoming work, and report findings | Own the controller's scheduling or authorization policy |
| Future supervisor | Interpret evidence and propose bounded actions | Obtain unrestricted terminal control or expand its own authority |

## Operational rules

### Target identity and input safety

Register exact tmux targets with their logical agent labels and repository association. Do not route solely by a human-readable window title that may change or be reused.

Before sending input, validate that the registered target still exists and still represents the intended worker. If this cannot be established, require reconciliation rather than sending blindly. A pane can outlive the coding CLI and return to a shell.

Pass tmux arguments directly to a child process without shell interpolation. Keep initial input to single-line prompts. Multiline paste and special-key handling require their own tested behavior.

### Command state

Distinguish at least:

- Request received by the controller.
- Delivery attempted or accepted by the terminal transport.
- Worker execution or completion, when there is explicit evidence.
- Delivery uncertain or failed.

These are not equivalent states. Assign command IDs and preserve delivery records. After a crash or network interruption, do not assume that retrying is safe. The manual phase can ask the user to reconcile uncertainty; automation will require stronger acknowledgment and duplicate-suppression handling.

### Reading model

A pane capture is a screen snapshot, not a sequence of newly emitted conversation messages. Replace the current snapshot and display its timestamp and staleness.

Do not use repeated snapshots to invent a reliable event history. A structured handoff record is a separate data source to introduce with deterministic relay automation.

### Shared worktree ownership

The relay assumes the agents may share a working tree and Git index. Schedule only one writing turn at a time once automation is added, and use the same operating discipline during manual control.

An ownership flag is not filesystem isolation. External terminal input and write-capable background work can violate it. Unexpected state changes require a pause. Manual takeover must suspend automatic dispatch until the user returns control.

### Preservation of the review-handoff skill

The skill remains responsible for baseline selection, review scope, staging, and outgoing edits. Preserve its exact outcome categories:

| Skill outcome | Controller interpretation for later automation |
| --- | --- |
| No incoming handoff | Stop advancing; do not infer overall task success |
| Strong objection | Pause for resolution; the skill must leave index and worktree untouched |
| Accept without improvement | End the current relay chain because there is no outgoing improvement; overall task completion still needs its own checks |
| Accept and improve | Consider another turn only after the outgoing handoff and session state are validated |

The controller must not independently run staging, commit, reset, or cleanup operations as a side effect of dispatch. A change to the skill's baseline rules or staging contract requires a separate decision.

### Persistence and repository hygiene

Keep controller metadata outside the source worktree. The existing skill uses untracked files when selecting its default baseline, so adding controller files to the repository could alter the workflow unintentionally.

Keep enough server-side state to recover registrations and explain command delivery. Select the simplest appropriate implementation before coding; SQLite was suggested but is not yet adopted. Raw output retention can be bounded and should not be confused with durable workflow records.

### Private remote access

The planned deployment is one backend on the development host, bound to localhost, with private Tailscale access. Tailscale Serve is the proposed exposure mechanism; public Funnel exposure is not part of the plan.

Treat the application as privileged because it can issue instructions to coding agents. Restrict access to the intended user, protect state-changing requests, validate origins, and avoid a generic shell-execution endpoint. Agent output and command records may contain sensitive repository data, so retention and access should be deliberate.

An awake, reachable host is an operational dependency. The backend, not the iPhone browser, owns persistent state and later orchestration.

## Alternatives considered

### A. Use ttyd alongside the custom backend

**Role:** A separately operated service supplies browser-terminal access while the custom backend manages controller behavior.

**Benefit:** Reuse a finished terminal-access layer instead of building its connection lifecycle.

**Tradeoff:** Adds a service to supervise and an authentication, routing, and UI integration boundary. It does not eliminate the custom controller needed for relay coordination.

**Disposition:** Optional shortcut, not required for the chosen snapshot-and-command starting point.

### B. Embed xterm.js and node-pty immediately

**Role:** The application owns full browser-terminal rendering and its connection to a tmux attachment client.

**Benefit:** Integrated interactive terminals without a separate ttyd service.

**Tradeoff:** Requires input-ownership policy, terminal sizing, buffering, reconnection, and attachment cleanup before the first useful manual console.

**Disposition:** Defer until real usage requires full terminal interaction.

### C. Use direct tmux snapshots and explicit command delivery

**Role:** The backend reads the existing panes and sends human-selected instructions.

**Benefit:** Closest to the current workflow and limited to the immediate reading-and-relay requirement.

**Tradeoff:** Not a full terminal or structured transcript; some interactive prompts may still require the desktop terminal or a later terminal extension.

**Disposition:** Initial implementation plan.

### D. Replace the workflow with non-interactive workers or an agent-native API

**Role:** A new runtime or structured API becomes the primary worker interface.

**Benefit:** Potentially richer machine-readable execution state.

**Tradeoff:** Changes the user's preferred long-lived interactive tmux workflow and introduces a migration that is unnecessary for the first release.

**Disposition:** Not selected. Keep the adapter boundary narrow enough to evaluate other integrations later.

### E. Start with a third AI as the controller

**Role:** Another model reads the two workers and determines what to do next.

**Benefit:** May eventually reduce interpretation-heavy human intervention.

**Tradeoff:** Does not solve command delivery, session identity, ownership, recovery, or authorization. Adds dependency and uncertainty before the manual console exists.

**Disposition:** Deferred. Any future supervisor operates through the deterministic controller.

## Consequences

### Benefits

The first release preserves the existing workflow and directly targets the user's current friction. It does not require a terminal service or multi-agent framework. The same interface can support desktop and iPhone use. Manual control remains available regardless of whether AI supervision is later added.

### Costs and limitations

The application still needs reliable target identification, command-delivery tracking, secure endpoints, and reconnection behavior. Snapshots may be less comfortable than a full terminal for some agent interfaces. Reading a screen does not establish semantic worker readiness or completion. Sharing an index requires operational discipline even with scheduling controls.

### Revisit triggers

Revisit the terminal integration when snapshot reading or interactive prompts repeatedly obstruct use. Revisit the adapter when a structured worker interface provides a clear advantage without undermining the desired session workflow. Revisit persistence when measured requirements exceed the initial store. Introduce AI supervision only after routine decision categories and safe delegated actions are understood.

## Open implementation choices

The following are intentionally not approved by this ADR: a React commitment, TypeScript backend source, a particular Node.js framework, SQLite, WebSocket as the default update transport, exact tmux registration format, command and handoff schemas, the automatic turn-limit default, a supervisor model, or a native iOS app.

Resolve only the choices required for the next roadmap phase. Record material architecture changes in subsequent ADRs rather than silently rewriting this decision's scope.

## Sources and interpretation

This ADR records the September 13, 2026 conversation and the user-provided `review-handoff` skill in `SKILL.md`, particularly its baseline rules, outcomes, and handoff invariants. It is a design record, not a claim that the controller or any integration has already been implemented or tested.
