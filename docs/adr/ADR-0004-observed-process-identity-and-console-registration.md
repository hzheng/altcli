# ADR-0004: Observed process identity, console-managed registration, any number of panes

**Date:** September 15, 2026  
**Status:** Selected for the scaffold; live-host acceptance pending  
**Amends:** ADR-0003's process-name check and registration procedure; ADR-0001's two-agent framing

## Context

ADR-0003 required the pane's foreground process name to equal `codex` or `claude`.
On the development host, tmux reports the kernel's short process name, and the
native Claude Code install is a symlink to a version-named binary
(`~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.272`). The running
process therefore reports `2.1.272`, and the scaffold refused the Claude pane for
both capture and input. Codex's cask binary is named `codex` and would have passed.

Registration also required a host-side CLI with the web server stopped, because the
CLI and the server opened the SQLite store from two processes. The console listed
exactly two fixed agents.

## Decision

### Identity is observed at registration, never assumed

At registration, the human picks a pane from the live `tmux list-panes -a` listing,
and the controller records the pane's exact identity plus the foreground process
name **observed at that moment** as `expectedCommand`. Before every capture and
before every send, the adapter re-reads the pane and requires the same identity and
the same process name, exactly as it already required the same pane, pane PID,
server PID, server start time, and socket.

A **denylist** replaces the allowlist: shells and generic interpreters (`sh`, `bash`,
`zsh`, `fish`, `login`, `tmux`, `node`, `bun`, `python*`, and the others in
`web/src/core/policy.ts`) can never be registered, and a registration that names one
is refused at preflight even if the pane still shows it. An npm-installed CLI that
reports `node` is refused on purpose; use the native binary. Do not shrink the list
to pass a check.

This keeps ADR-0003's stance: a process name is a transport check, not proof of
identity. Re-register after restarting or updating a CLI; the process name, pane PID,
or pane ID will have changed anyway.

### Registration and removal happen in the running server

`POST /api/v1/sessions` and `DELETE /api/v1/sessions/{id}` replace the
`session:register` script and its `tsx` dependency. Both operations run in the one
backend process, so the "stop the server before registering" rule is gone. Both are
refused while a manual turn is reserved, so ownership cannot change under an
in-flight command. Registration sends no input and stages nothing.

The agent id is a lowercase slug derived from the human label (`Claude Code` ->
`claude-code`). Re-registering the same label re-points that id at a new pane and
keeps its place and command history. One pane cannot be registered twice.

### Any number of panes

The console renders one panel and one target button per registration and shows
every live pane on the configured tmux server in the registration picker,
including panes it refuses, so the operator can see why a pane is not eligible.
ADR-0005 scopes the manual-turn reservation to each worktree root and adds
projects, pairs, and a confirmed agent type on top of this registration model.

## What this does not change

Terminal text is still observation, not authorization. Snapshots are still
replaced, never accumulated. The controller still never runs Git mutation, never
replays uncertain commands, and never sends input in mock mode or while
`ALTCLI_ENABLE_INPUT=false`. The store schema is unchanged; existing rows remain
valid.

## Considered and deferred

Recording the executable path of the pane's root process (`ps -p <pane_pid> -o comm=`)
would tie identity to the real binary instead of a 16-character name. It is only
meaningful when the pane was started with `exec <cli>`, and it adds a platform-specific
`ps` call to every poll. Reconsider if name collisions are observed in practice.

Reading the tty's foreground process group directly would also identify the CLI
without relying on names, at the cost of more platform-specific process inspection.
