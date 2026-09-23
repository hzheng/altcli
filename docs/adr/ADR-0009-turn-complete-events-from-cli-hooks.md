# ADR-0009: Turn-complete events come from the CLIs' own hooks, never from screen text

**Date:** September 15, 2026  
**Status:** Selected for the scaffold; implements the first Phase 3 deliverable  
**Extends:** ADR-0001's "terminal text is observation, not authorization"

## Context

After a relay the operator had to read the pane to know when the agent was done
and whose turn was next. A sentinel line in the skill ("print RELAY_DONE") was
considered and rejected: a model can forget or paraphrase it, print it early, or
the string can appear in any file it cats, including the skill file itself in the
repository under review. This project refuses screen prose as a completion signal.

Both CLIs emit a real end-of-turn event without the model's cooperation: Claude
Code runs `Stop` hooks when the main agent finishes responding, and Codex runs its
`notify` command with `agent-turn-complete`. Inside tmux both inherit `$TMUX_PANE`
and `$TMUX`, which identify the pane exactly.

## Decision

- One POSIX script, `hooks/altcli-turn-complete.sh`, serves both CLIs. It posts
  `{source, paneId, socketPath, cwd, sessionId}` to `POST /api/v1/events` on
  loopback with the console token read from `web/.env.local`, exits 0 always,
  never prints, and does nothing outside tmux. Codex allows one `notify` command,
  so the script accepts `--then CMD ARGS...` and runs the previous command with the
  same JSON after posting.
- `node scripts/install-hooks.mjs` merges the hook into `~/.claude/settings.json`
  (`hooks.Stop`) and `~/.codex/config.toml` (`notify`, chaining an existing one).
  `--check` verifies without writing.
- The controller matches an event to a registered pane by exact tmux identity
  (pane id and, when present, socket path), ties it to the last command delivered
  there, and keeps the latest event per session plus the latest unmatched event.
  Events are stored in a bounded table (store version 3).
- The console derives per pane: **idle** when the hook spoke after the last send,
  **working** when a send followed the hook's last report, and **unknown** until
  the hook has reported at least once, so a host without hooks is never shown as
  working forever. When the current target's hook reports a fresh turn end that
  closes a command sent to it, the target moves to its relay partner: with exactly
  two sessions in the project, the other one; otherwise the one its pair names.
  Events already present when the page loaded do not trigger this. Readiness is
  pre-ticked unless the console has a reason to think the target is busy (a
  command was sent to it from the console and its hook has not reported since);
  the label states which case applies and the human can untick it.

## What events do not do

They never send input, clear a hold, release an uncertain delivery, or advance a
turn. The readiness confirmation and the Relay click remain the human's. An event
for an unregistered pane is surfaced as a notice, not acted on.

## Consequences

One click per relay (Relay), with the target already on the right agent and the
box already ticked in the common case. The signal is deterministic and per pane,
and it degrades honestly: without hooks the console behaves exactly as before.
Automatic advancement is still a separate decision (roadmap Phase 3).
