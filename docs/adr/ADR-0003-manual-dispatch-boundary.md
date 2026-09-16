# ADR-0003: Make manual dispatch explicit, durable, and non-replaying

**Date:** September 14, 2026  
**Status:** Selected for the scaffold; live-host acceptance pending

## Context

Both coding agents may share one worktree and index. The user's `review-handoff`
skill owns staging and code-review semantics. Terminal snapshots cannot reliably
establish that a turn finished, an input prompt is empty, or no background process
is still writing. A network failure can also occur after input was already sent.

## Decision

Give each submission a UUID v4 and persist its resolved destination/text before
attempting input. An existing UUID with the same payload returns its stored result
without resending; reuse with a different payload fails. Never automatically replay
commands after HTTP errors, restarts, or uncertain tmux delivery.

Reserve one manual turn in SQLite before dispatch. This is intentionally global
for the two-agent starter, even when their repositories differ. Keep that reservation
after transport success. The user must inspect both agents and explicitly release
the expected command ID before another writing instruction can be sent. Release
is not task completion, approval, cancellation, or proof of filesystem isolation.

The API uses these transport states:

| State | Meaning |
| --- | --- |
| `recorded` | Request and manual reservation stored; no dispatch claimed |
| `sending` | Durable boundary crossed before a terminal input attempt |
| `delivered` | tmux/mock transport returned success; no completion inferred |
| `uncertain` | Some input may have arrived; inspect before continuing |
| `rejected` | Preflight failed before any delivery attempt |

On backend initialization, a reserved `recorded` or `sending` command becomes
`uncertain`; it is never replayed. A rejected preflight releases its reservation.
For delivered or uncertain commands, only explicit human reconciliation releases
ownership. The UI does not automatically retry POST requests. A network-ambiguous
request ID remains visible until the human acknowledges inspection.

Require server-owned registration of exact pane identity, tmux server PID/start time
and socket, expected CLI command, and repository root. Revalidate before input and
before Enter. Refuse missing identity, a shell or generic interpreter, copy mode,
synchronized input, dead panes, or a different working directory tree. Input is
single-line, size-limited, and excludes terminal control characters.

Invoke tmux with `execFile` and argument arrays, never a shell-interpolated command.
The implementation uses `send-keys -H` with hex-encoded UTF-8 bytes so arbitrary
prompt text, including trailing semicolons, does not become tmux parser syntax.
Enter is a separate, revalidated operation. Actual CLI behavior still requires
manual verification on the user's host.

Keep every API read and write behind an explicit bearer token, origin/host checks,
and loopback binding. Do not depend solely on the absence of public routing.

## What this cannot guarantee

A command name is not cryptographic proof of process identity. There remains a
check/use race between inspection, typing, and Enter. Native CLIs may temporarily
foreground child tools or expose ambiguous process names; the starter fails closed
rather than treating generic `node` or a shell as sufficient. It does not detect
permission dialogs, queued input, hidden background writers, or external terminal
interference. The human must confirm an empty, ready input prompt each time.

The manual reservation coordinates this controller's dispatches only. It does not
lock files or revoke access from desktop terminals. A coding agent can itself
perform powerful actions under its existing permissions. Never use this scaffold
for unattended operation or claim it is a security sandbox.

Run one backend instance per store. Registration changes should be made with the
web server stopped and no active manual turn. Multi-process deployment and
agent-level acknowledgments need a later design, not optimistic inference.

## Consequences

The extra readiness checkbox and release step intentionally preserve human
intervention in this stage. They are not a substitute for the future explicit
handoff state machine. In return, the first remote interface does not pretend
that a successful HTTP response or an empty `git diff` is a completed review.

The controller must never run `git add`, commit, reset, restore, clean, or edit
managed source as a dispatch side effect. Root `SKILL.md` remains unchanged.
