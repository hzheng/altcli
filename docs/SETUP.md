# Local setup and upgrade

Use Node 24 and tmux on the same awake host as the coding CLIs. Run one backend per
store, as the same user who owns the tmux socket. Start with read-only captures.

```bash
node scripts/setup.mjs
npm --prefix web ci
# Set CODERCREW_ENABLE_INPUT=false in web/.env.local for the first checks.
cd web && npm run dev
```

Open http://127.0.0.1:8787 and enter the generated token. Register each intended
pane using its preview, label and agent type. The server resolves its canonical
Git root and standard index; starting in a subdirectory is supported. A parent
directory holding unrelated repositories cannot validate a relay pair. Non-Git
panes may be read or addressed individually but cannot form a review pair.

## Upgrade from the earlier console

Stop the backend and inspect both workers; resolve outstanding work before the
upgrade. Back up the external SQLite store including its WAL/SHM consistently.
Version 4 rejects downgrade into older code. Existing real registrations need
explicit rebinding so they gain instance-generation and canonical Git identity.
Mock fixtures are upgraded only for automated tests.

```bash
node scripts/install-skills.mjs
node scripts/install-hooks.mjs
node scripts/install-hooks.mjs --check
```

Restart both CLIs after updating hooks. The installer supports CLAUDE_CONFIG_DIR
and CODEX_HOME, preserves foreign hook entries/notifiers, and prints private backup
paths. Unsupported TOML is refused before either config is edited. Normalize that
configuration manually or restore a backup; do not delete other settings to force
installation. Configure the relay and relay: global rule documented in
[SKILLS.md](SKILLS.md). Command markers are correlation metadata.

Re-enable input only after read-only checks. Restart the backend after configuration
or server-code edits; hot reload intentionally retains the live singleton.

## Manual and paired runs

Create and explicitly select a named pair. Check both workers have empty prompts,
no permission dialogs or background writers, and use the standard Git index. Tick
readiness before starting. Keep desktop input out of that owned worktree.

Send never relays. Send & relay requests one review, but only when the worker
changed the worktree (read-only Git digest before delivery versus at completion);
a worker that only asked a question or changed nothing ends the run with no review,
and an unreadable digest pauses it. The continuation preference governs subsequent
accept_and_improve handoffs. Relay starts a review. The selected
pair and policy are copied into a server run; later viewing changes cannot redirect
it. The maximum number of automatic turns (default 20, set in the composer) is
frozen into the run and enforced on the server.

A finished response with unknown or active background work pauses. Claude supplies
that evidence in its current Stop payload. Codex notify does not, so the server
compares the processes under or attached to the pane before delivery and at
completion. An unreadable process table or changed pane identity remains unknown.
Inspect workers and use Pause / take over, then explicit ownership release, before
a new manual start.

Pause prevents further scheduling but does not interrupt processes or retract input.
A backend restart pauses all owned runs without replay. Closing or locking a browser
does not pause them. Final task-level verification remains manual.

An old pre-upgrade uncertain delivery can be acknowledged through the console's
legacy delivery notice after terminal inspection; it does not release an active
server run. Do not send a replacement command merely because an HTTP response failed.

## Acceptance checklist

Verify wrong-pane/shell/copy-mode/synchronized-input refusal; exact Unicode input;
CLI exit before Enter; duplicate POST; stale/duplicate/wrong-session hooks; explicit
pair routing; both browsers open; browser lock/reload; pause and restart with
unresolved work. Then run a supervised real Codex/Claude relay against a disposable
repository and record versions, commit and results in VALIDATION.md.

Use [TESTING.md](TESTING.md) before [TAILSCALE.md](TAILSCALE.md). Never expose a
development server publicly or treat mock completion fixtures as CLI compatibility.
