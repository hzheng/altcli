# ADR-0011: Server-owned runs and correlated lifecycle evidence

Date: September 16, 2026
Status: Proposed implementation in the review-hardening PR; live CLI acceptance pending.
Supersedes: ADR-0008's use of delivery release as the only worktree gate;
ADR-0009/0010's informational-only events, prompt-only correlation and browser-owned
continuation. Earlier decisions remain historical context.

## Context

The manual console evolved into automatic turn-taking. Browser state, identical
`relay` prompts, a lagging transcript, and a 30-command history window cannot be
execution authority. Multiple pages must observe one run, not start competing
continuations. A displayed pair must not differ from the actual routing pair.

## Decision

Keep one Node/Next.js process and SQLite database. Add ControlPlane and
WorkflowStore, rather than a separate service. Existing Controller is the internal
transport/read-model helper; HTTP handlers expose ControlPlane only.

A run freezes its participant registrations, explicit pair ID, canonical worktree
and standard index identity, current command, continuation policy and turn budget.
A registration has a UUID generation separate from its human label/slug. Rebinding
is deliberate and forbidden while the worktree is owned. Paused runs retain their
ownership until a validated completed chain or explicit human takeover releases it.

### Three distinct records

1. A command delivery receipt says whether tmux accepted the input, rejected the
   target, or left delivery uncertain. It never means task completion.
2. An execution identifies the command, CLI session and source turn. It remains
   operationally visible until resolved, independently of bounded recent history.
3. A relay run identifies participants, ownership, policy, and consumed transitions.

The server atomically records a completion receipt, advances the current turn,
increments the budget, and plans one next command. A compare-and-set claim permits
one dispatcher to deliver a planned command. Duplicate lifecycle deliveries return
the persisted receipt. Contradictory duplicates pause rather than reinterpret an
already consumed event. A completion arriving during transport is buffered until
delivery is established. No uncertain delivery is replayed.

### Correlation, not guesses

A unique command marker is appended to the dispatched prompt. Its exact echoed
text must also match; leftover input with a valid marker is still rejected. Claude's
UserPromptSubmit hook records a source-turn ID for the specific command and sends
an acknowledgment: the CLI's native `prompt_id` (Claude Code 2.1.196 or later),
which the matching Stop carries too, so a Stop that closes another prompt, such as
one interrupted earlier, is never paired with this command. Without a native ID a
generated UUID is used and overlapping starts fail closed. Stop uses only
`last_assistant_message` for that response, never an unanchored transcript
fallback.

The local hook slot records whether its start used native or legacy pairing,
separately from the HTTP event context. Native pairing requires the same valid
`prompt_id` on Stop; a missing or malformed ID is not permission to fall back to
session-only matching. Legacy fallback is allowed only when both start and Stop
omit the field. A present-but-invalid start is reported without command correlation,
so it cannot authorize advancement. A rejected Stop leaves the active slot untouched
so a later correctly identified Stop can still complete it.

Slots written before pairing provenance was recorded are ambiguous and cannot
complete a turn after this hook upgrade. Install while idle, or reconcile an
outstanding run through the existing pause/takeover flow before the next command.
Native prompt pairing fixes the interrupted hook-slot problem; it does not prove
that interrupted/background writers stopped or release server execution ownership.

Codex binds the exact command echo at native `UserPromptSubmit`, keyed by pane,
session and native turn ID. Its later `notify` completion must match that binding.
Unmarked steering within the same native turn preserves the binding; a different
marked command makes it ambiguous. A new unmarked turn cannot reuse the previous
command. Missing, changed or ambiguous bindings never advance execution.

This corrects the earlier assumption about `notify.input-messages`: Codex 0.155.1
builds it from sampling history, not just the current turn. It is ignored for
correlation; neither its final message nor a unique historical marker proves the
current command. See the versioned [turn implementation](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/session/turn.rs)
and [hook implementation](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/hook_runtime.rs).
The native start hook is installed in Codex's `hooks.json`; legacy notify remains
the completion signal because a native Stop hook may still block or continue work.

Full pane/server/socket identity, registered generation and CLI kind must agree.
The registration pins the physical worker; the CLI's logical session is pinned
only within a command through its start acknowledgment,
so a chat reset between commands (Codex `/new`, Claude `/clear`) needs no
re-registration. Old follow-up outcomes, absent identities and ambiguous payloads
remain nonauthoritative. A session or turn change inside a command pauses the run.

After ownership and delivery reservations are released, read-only discovery may
offer a fresh registration generation for a restarted supported CLI in the same
exact pane, canonical directory and worktree. Saved names and group membership
remain intact. The next explicit Plan/Implementation/Send action validates the
displayed generation and binds it; viewing or reconciliation alone never writes
the replacement or replays a command. Concurrent registration changes invalidate
the candidate. Owned runs retain their frozen instances, and uncertain processes
or changed pane/directory identities require inspection. The deprecated staging
transport retains its existing registration contract.

Display activity is independent of execution ownership. Native hooks attach the
foreground CLI pid and start timestamp to their exact session/turn binding and
retain them in the matching completion, including manual terminal turns without
a command marker. The server verifies the current pane/process and records live
activity separately from the workflow ledger. Older/duplicate starts, mismatched
completions and replaced processes cannot overwrite newer activity. Working may
survive pause/takeover; Idle requires a matching settled native completion.
Codex notify runs after Stop hooks finish: background servers, watchers and
tasks are not evidence that Codex is still answering after that completion.
Claude keeps its source-specific Stop/background guards, since [Stop hooks can
continue the agent](https://code.claude.com/docs/en/hooks#stop-decision-control).
Controller safety checks remain separate: Idle does not certify checkout readiness
or clear background work. Missing turn evidence,
including after backend restart, remains Unknown. These observations never
release ownership, replay commands or advance a run; lifecycle authority for
those actions remains unchanged.

Codex's [native Interrupt hook](https://learn.chatgpt.com/docs/hooks#interrupt)
provides an exact session/turn cancellation signal. The hook verifies the current
pane and CLI against its saved binding, marks that binding interrupted, and sends
`turn_interrupted` without claiming completion. Display activity becomes Interrupted;
an owned, correlated assignment is durably interrupted and its run paused, retaining
ownership. This is not a successful TurnEvent or a handoff. Late completion cannot
consume a publication, release ownership or schedule a peer. Duplicate/stale
interruptions cannot overwrite a newer native turn. Events during terminal delivery
are buffered until delivery is established. A fresh interruption can recover display
after backend restart only against the exact interrupted binding; historical records
are never replayed. An owned interrupted execution remains visible after restart.
Web Pause remains a scheduler operation, not a native process interrupt.

An explicit status reset provides human recovery for a quiet CLI whose activity
was lost on restart. The user confirms an empty prompt with no background writers;
the server checks the displayed registration, live pane/CLI identity, activity
timestamp and absence of workflow/transport ownership. Only Unknown may become
Ready, labeled as human-confirmed rather than a native completion. Configuration
is preserved; no terminal input, Git operation, history replay or run transition
occurs. Delayed callbacks from before this observation boundary cannot overwrite
it; a new native turn resumes normal tracking. The confirmation remains ephemeral,
so a subsequent backend restart still requires fresh evidence or another reset.

A new completion received after backend restart may recover display activity by
matching the hook's current native binding file: exact session, turn, pane, CLI
pid and start time. No transcript or historical event is consulted. A different
binding, unreadable file or unverifiable current CLI identity cannot certify
Idle. A missing pre-turn process baseline does not invalidate an exact native
completion for display; background-process evidence still gates workflow
continuation independently. Workflow recovery remains paused and retains ownership.

Codex browser-tool infrastructure is identified by its installed executable,
specific REPL kernel/app-server arguments and native node_repl ancestry. Those
persistent services do not count as unfinished task workers; arbitrary commands
and workers beneath them still do. Arguments are inspected transiently and are
never returned in API process records or persisted in workflow evidence.

Native SessionStart for startup/resume can report Ready before the first prompt;
this only means the current CLI initialized, not that a task completed or that
background work is clear. Compaction is excluded, and late startup cannot replace
an observed turn. Lifecycle observation works before browser discovery and while
the terminal is in copy mode or synchronized-input mode. Those input restrictions
still prohibit delivery. Hook delivery diagnostics retain bounded metadata only
(event, pairing presence, process id, HTTP status and time), never raw payloads.

A response can end while background work remains. Only explicit clear evidence
can release execution ownership or schedule the next worker automatically. Missing
background-task/cron fields are unknown, not empty. Claude relies on those payload
fields. Codex notify does not carry them, so for Codex only the server records the
processes under or attached to the pane before delivery and compares them with a
fresh process-table read at completion. A newly associated surviving process is
active; unreadable evidence is unknown. This is observational evidence, not proof
against deliberately detached work, and it never substitutes for Claude's in-process
task report.

### Human policy and browser lifetime

A browser may remember the user's default continuation preference. Starting a run
still requires a selected target, an explicit pair for automatic handoff, and human
readiness confirmation covering all participants. The chosen policy lives in the
run thereafter. Changing views, opening another browser, locking a page, or closing
it cannot alter routing or create a second advancement.

Plain Send never relays. Send & relay requests one review, scheduled only when a
read-only worktree digest (HEAD, index entries, unstaged content, untracked file
contents) taken just before delivery differs from the one taken at the correlated
completion; an unchanged worktree, typically a worker that asked for more
information or declined, completes the run without a review, and an unreadable
digest pauses it. Worker prose is never used to decide whether an instruction
produced reviewable changes; the structured review outcome and reason govern
review routing. Further reviews depend on the run's continuation preference.
`accept_and_improve` continues to the partner's review. An actionable
`strong_objection` continues to the partner as a
normal correction instruction with handoff enabled; if that instruction changes
the worktree, the server returns it to relay review. An objection without a reason
or continuation permission pauses, and other outcomes end the chain. Every scheduled
review or correction consumes the same persisted automatic-turn budget (default 20,
chosen at start). A completed chain is not a completed task.

Pause prevents subsequent scheduling; it does not interrupt an in-flight send or
running agent. Explicit takeover requires inspecting and stopping all writers and
reconciling partial input, then releases ownership without claiming success. A
backend restart pauses owned runs and never replays them. There is no automatic
resume after restart in this first implementation.

### Git and installation boundaries

Discover canonical root, git directory and standard index with read-only Git
commands. Non-Git panes can be observed or manually addressed, but cannot form a
review pair. Two linked worktrees do not share an index. Per-process Git environment
overrides are unsupported: the human must confirm normal index usage.

Global hook configuration edits validate both plans before either is written,
preserve unrelated entries, create private backups and atomically replace each
file. This is per-file atomicity, not a transaction across two config files.
Conservative TOML handling supports ordinary single/multiline string arrays and
refuses unsupported top-level constructs rather than corrupting the document.

## Consequences and limits

The controller is useful without a third AI and retains the original tmux lifetime,
raw output and skill staging behavior. State-machine tests can exercise workflows
without real coding agents; this does not prove installed CLI compatibility.

There is no hostile-agent isolation, filesystem lock against external writers,
authenticated process attestation, multi-process scheduler support, or proof that
an agent's reported outcome matches the Git delta. Task-level Git fingerprints and
final test automation remain follow-up work. A same-user agent can access the
controller's token or socket. Unsupported lifecycle evidence pauses rather than
being treated as safe. The private iPhone milestone requires physical-device and
Tailscale testing, not just a mobile Chromium viewport.


### Publication observation and terminal input gates

A correlated completion validates the frozen participants, CLI process, canonical
working directory, and published artifact without requiring terminal input to be
enabled. Copy mode and synchronized input do not invalidate a committed handoff
or captured plan document. Delivery still checks the destination pane with the
full input gates, including immediately before submission. A peer whose input is
blocked must not receive a command, but that does not erase the validated artifact.
