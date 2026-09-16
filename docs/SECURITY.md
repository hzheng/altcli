# Security and operational boundary

CoderCrew controls coding agents with their existing host privileges. It is not a
sandbox, process attestation system or lock against external filesystem writers.
A malicious agent running as the same Unix user can access the token or tmux socket.

## Access

The backend binds to 127.0.0.1. Every API read/write, including hook intake and run
actions, requires the 256-bit owner bearer token. Exact host/origin allowlists,
cross-site refusal, bounded JSON and literal terminal arguments remain enforced.
Output is displayed as React text. Do not introduce HTML interpretation or a
shell-execution endpoint. The token grants read access to all pane previews on the
configured tmux server, even panes not registered as workers.

Keep token/config/store backups private. Setup uses restrictive file modes; browser
tokens remain only in memory. Never use NEXT_PUBLIC_* for a secret. Hook posting is
restricted to loopback; ordinary remote access uses private Tailscale Serve, not
public Funnel. Production CSP, device pairing/revocation and rate-limit hardening
remain acceptance work, not claimed protections.

## Delivery and execution

The transport reservation protects delivery only. A separate server-owned run
retains execution ownership across clean deliveries. Only current correlated
completion plus explicit clear background-work evidence can schedule another
participant. Missing evidence pauses. No outcome line alone proves quiescence or
correct Git staging. No terminal text is parsed as an authorization signal.

Events carry exact command nonce and prompt echo, pane/server/socket identity,
source session and turn. Claude requires a matching start acknowledgment; old
follow-up events cannot complete a newer turn. Pinned session changes require
reconciliation/rebinding. Event dedup and next-command creation are transactional.
The owner token is the trust boundary; these event identities are correlation, not
cryptographic attestation of a CLI.

One backend process per database is supported. Startup pauses active runs and
never replays uncertain sends. A browser is an observer/controller client, never
the scheduler. Locking or closing it does not pause the server. Multiple views
share the same run policy and budget. Use the run's Pause action before takeover.

Pause does not interrupt an in-flight send or running/background process. Explicit
takeover requires the human to inspect all participants, stop writers and reconcile
partial input. It releases ownership without recording task success. External
terminal typing remains outside the controller's filesystem authority; unmarked
Claude starts pause affected runs when the hook reports them. There is no guarantee
of observing every external command or descendant writer.

## Git and lifecycle limits

Pairs require canonical root/gitdir/standard-index identity. Custom per-worker
GIT_INDEX_FILE and related overrides are unsupported and must not be used. Pane
identity and process-name checks narrow but do not eliminate the check/use race.

Codex notify versions may omit background-work proof. Those events are unknown
and pause, even when the reviewer reports accept_and_improve. Claude versions
without current Stop response/background fields also pause. No missing field is
converted into an empty list. Installed-version and real-agent acceptance is
required before leaving a run unattended.

## Installation and storage

The hook installer validates both edit plans first, preserves unrelated entries,
refuses unsupported TOML, backs up changed files with mode 0600 and atomically
replaces each file. Two files are not a single transaction; retain backups until
validation succeeds. Concurrent external edits and configuration formats outside
the supported subset require manual reconciliation.

SQLite version 4 prevents old runtimes from silently opening the new store. Delivery
history, lifecycle inbox, run/turn records and prompt text are plaintext outside
managed worktrees. Workflow/audit retention is not yet pruned. Raw screen snapshots
are not stored. Hook correlation context is private local data. No log or database
should be committed. The original review skill remains responsible for staging;
the controller issues no Git mutations and does not independently prove its outcome.
