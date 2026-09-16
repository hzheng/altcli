# ADR-0010: The reviewer's outcome line, and auto-relay that continues only on it

**Date:** September 16, 2026  
**Status:** Selected for the scaffold; Phase 3 deliverables "handoff-reporting helper" and a first turn-taking automation  
**Extends:** ADR-0009 (turn-complete events); amends the skill's Output section

## Context

Turn-complete events say *that* a review ended, not *how*. The skill defines four
outcomes, and the two that matter most for what happens next, a strong objection
and an acceptance with nothing left to hand off, leave the index and worktree
untouched, so Git state alone cannot tell them apart from "nothing to review".
The reviewer itself knows; the question was how to hear it without trusting
screen text.

## Decision

- The skill's Output section now requires one literal final line:
  `RELAY-OUTCOME: <outcome> — <one sentence>`, with `<outcome>` one of the four
  names the skill already defines. This is the only change to the skill, and it is
  additive.
- The hook reads that line from the CLI's own record of the final message: Codex's
  `last-assistant-message` in the notify payload, Claude Code's transcript file
  named in the Stop payload (the last assistant message, joined across streamed
  entries). The last matching line wins, so a quoted example earlier in the message
  does not count. Screen captures are never parsed. A missing or unknown line is
  reported as no outcome.
- Claude Code's Stop hook can fire before the transcript holds the entry that ended
  the turn. The hook never waits: it posts the turn end at once with `settled:
  false` and spawns a detached waiter that re-reads the transcript until the last
  assistant entry has a `stop_reason` other than `tool_use` (up to 30 s), then
  posts a follow-up `outcome` event that completes the turn record in place. The
  server marks a turn **pending** only when it closed a relay and the record was
  unsettled; an instruction never waits. The console does not hand off while
  pending, auto-relay waits rather than stops, the composer stays usable so the
  human can take over, and after 45 s without a line the console reports it
  missing and stops automation. Codex's payload carries the message, so it is
  always settled.
- The console shows the outcome and sentence on the pane and routes the hand-off
  by it: `accept_and_improve` moves the target to the partner; `strong_objection`
  moves it to the author with a prefilled instruction quoting the reason, for the
  human to send; `accept_without_improvement` and `no_incoming_handoff` stay put
  and say the chain ended; no outcome moves the target but says the line was
  missing.
- Auto-relay is a checkbox, on by default; only the human changes it, and an
  untick is remembered by the browser. When on, an `accept_and_improve` from the
  current target sends `relay` to the partner with the same command path as a
  click (identity re-check, hold, UUID, no replay), the checkbox standing in for
  the per-send readiness tick. It does not continue, and states the reason, on
  any other outcome, a missing line, a partner not presumed idle, a send that is
  not `delivered`, a held worktree, a stale connection, a read-only console, or
  after 20 automatic turns in a row; it never unticks itself, because a box the
  console resets is one the human cannot rely on. The first turn of a chain is
  always the human's, and each human send starts a new chain.

### Instructions, and instructions that hand off

A direct instruction (**Send**) is a conversation with one agent: no outcome line
is expected and finishing it relays nothing, whatever the auto-relay checkbox says.
A work request whose result should be reviewed next (**Send & relay**) carries
`handoff: true` on the command record; when the agent finishes, the console relays
to the partner by itself, whatever the checkbox says, through the same guarded
path as any automatic send. The checkbox only governs whether a chain continues on
later `accept_and_improve` outcomes. Text typed before **Relay**
is sent as `relay: <text>`, a relay with context; the global rule maps the
`relay:` prefix to the skill as well as the bare word.

### Which command a turn answered

A turn end is tied to a console command by the turn's **prompt**, as the CLI
recorded it (Codex's `input-messages`; the last human-typed user entry in Claude
Code's transcript, skipping the `isMeta` skill text it injects), matched against
the delivered command's text. "Latest delivered command" was wrong whenever the
agent was busy or its input line was not empty: leftover text turns a delivered
`relay` into `xxxrelay`, the agent answers that, and the relay was being credited
with a turn that never ran the skill. A turn whose prompt matches nothing leaves
the command open: the pane says *answered a different prompt*, the session stays
*working*, no hand-off happens, and auto-relay does not continue. Without a prompt (an older
hook) the latest delivery is assumed, as before.

## What this does not do

It does not validate the reported outcome against Git. A reviewer that claims
`accept_and_improve` while staging nothing would keep an auto-relay going until a
partner reports otherwise; index and worktree fingerprints (roadmap Phase 3) are
the planned check. It does not run the final task-level review; a completed chain
is reported, not judged.

## Consequences

The relay's decisions now come from a structured, deterministic channel with a
human-readable reason, and automation can be switched on for the boring middle of
a chain while every exception returns control to the person. The hook wrapper
locates a node binary at run time, so the registered command survives node
upgrades and nvm-less environments.
