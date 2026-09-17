# ADR-0005: Agent type, projects by worktree, named relay pairs, per-worktree manual turns

**Date:** September 15, 2026  
**Status:** Selected for the scaffold; live-host acceptance pending  
**Amends:** ADR-0003's global manual-turn reservation; extends ADR-0004's registration model

## Context

ADR-0004 made the number of registered panes open-ended and derived each agent id
from its label. Three gaps remained once several instances coexist:

- Nothing recorded *which* CLI a pane runs. The observed process name (`codex`,
  `2.1.272`) is a transport check, not a type, and Phase 3 hook ingestion must map a
  Claude Code `Stop` event or a Codex `notify` event to the right session.
- Similar panes were hard to tell apart in the picker without seeing their screens.
- ADR-0003 reserved one manual turn for the whole controller "for the two-agent
  starter". With two projects, a ten-minute relay in one worktree blocked a one-line
  instruction in the other for no reason: the reservation exists to protect a shared
  index, and different worktrees do not share one.

## Decision

### Agent type is a confirmed field

`SessionRegistration.agentType` is `codex`, `claude`, or `other`. The registration
form suggests it from the observed process name (`codex` -> codex; `claude` or a
version string -> claude; anything else -> other) and the human confirms. It is
display and routing metadata; it grants nothing and is never used as an identity check.

### A project is a worktree root

Sessions registered with the same real repository root form one project. Projects
are derived, not stored: there is no project table, id, or endpoint. The console's
primary tabs are named relay pairs, labeled with the root basename in parentheses.
Selecting a pair selects its project and scopes the target buttons and panels to
that pair. The full root path is shown beneath it.

### Named relay pairs

`POST /api/v1/pairs` records a named pair of two registered sessions, and
`DELETE /api/v1/pairs/{id}` forgets it. A pair is grouping and validation only: it
does not automate turns, choose the next target, or send anything. Creation requires
both sessions to be registered with the **same repository root**; that is the
worktree, hence the index. A linked `git worktree` has a different root and correctly
fails. No git command is invoked; the controller stays git-free (AGENTS.md).

A paired session cannot be removed or re-pointed to another repository until the pair
is removed. Selecting the pair's tab filters the project view to the pair's two panels
so the operator sees exactly the relay in progress.

### The manual turn is reserved per worktree

The `control` singleton becomes a `reservations` table keyed by repository root.
`POST /api/v1/commands` reserves the target's worktree; commands to sessions in
another root proceed independently. Release still names the exact command id, which
identifies its reservation. Recovery after a restart marks every in-flight
reservation's command `uncertain`, one per worktree.

Registration, removal, and pair changes are refused only in a worktree whose turn
is reserved, so an in-flight command's ownership cannot change underneath it while
unrelated projects stay editable.

The store migrates a version-1 database in place: sessions receive a suggested
`agentType`, the single `control` reservation moves to `reservations` under its
command's repository, and `control` is dropped.

### Pane preview

`GET /api/v1/panes/preview?paneId=%25N` returns the last twelve lines of any live
pane. It is read-only, applies no identity check (nothing is registered yet), and
exposes that pane's screen to the token holder, who could already register and read
it. The pane id travels as a query parameter because `%` in a path segment is
re-encoded by some proxies.

## What this does not change

One writing instruction at a time per worktree remains the operating rule; the
controller still cannot see desktop typing or background writers. Terminal text is
still observation, not authorization. Pairs are the unit Phase 3's deterministic turn
state machine will attach to, but no turn advancement is inferred or automated here.

## Considered and deferred

Storing projects explicitly, with names and settings, was deferred until something
needs more than the root path. Validating shared index via `git rev-parse` was
rejected in favor of the root-path rule to keep git out of the controller.
Per-pair reservation was rejected because two pairs on one worktree share the index.
