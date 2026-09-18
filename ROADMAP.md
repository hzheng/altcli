# CoderCrew roadmap

Updated September 16, 2026. Source implementation and acceptance are separate.
Current architecture: [ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md).
Historical pre-hardening roadmap: [snapshot](docs/history/2026-09-16-pre-hardening/ROADMAP.md).

## Phase 1: Manual web console

Implemented source: TypeScript frontend/backend in one Next.js workspace; direct
tmux capture and guarded input; explicit pane registration and instance generation;
canonical worktree grouping; named pair selection; authenticated API; SQLite delivery
records; explicit readiness; uncertainty without replay. No root package.json.

Acceptance remaining: re-run real installed Codex and Claude sessions after hook
updates, including permission dialogs, CLI exits, partial input, Unicode, and
same-worktree discipline. Do not equate mock tests with that acceptance.

## Phase 2: Private iPhone access

Implemented source: responsive console and server-owned workflow state. A page can
reconnect and inspect current runs without reconstructing ownership in the browser.

Remaining: production HTTPS Tailscale Serve configuration, narrow tailnet policy,
physical Safari/iPhone disconnect/reconnect and simultaneous desktop access; token
lifecycle and host availability review. Native iOS remains reserved under ios/.

## Phase 3: Deterministic review coordination

Implemented source in the hardening PR: persisted runs and executions; explicit
immutable participants; unique command and source-turn correlation; idempotent event
receipts; one atomic next-turn plan and dispatcher claim; persistent turn budget;
execution ownership separate from transport; pause and human takeover; restart
pauses without replay. Browser views never implement the scheduler.

Current Stop payload replaces lagging transcript fallback. Missing/active background
state pauses; legacy follow-up events cannot advance anything. Codex notify carries no
quiescence evidence, so the server supplies differential process evidence for Codex
turns (processes newly associated with the pane that survive completion). With the
run's continuation policy enabled, an actionable strong objection becomes a bounded
instruction to the author and changed corrective work returns to review.

Remaining acceptance: installed-version hook fixtures and supervised mixed-agent
relay, complete fault-injection sequence, non-browser lifecycle intake, restart and
two-device verification. Remaining features: Git fingerprints for review outcomes
(the worktree digest currently gates only Send & relay handoffs), handoff scope
validation, final task-level review/test automation, and deliberate resume
semantics. Do not make these automatic by trusting outcome prose alone.

## Optional later branches

Full browser terminal (xterm.js/node-pty) only when snapshot interaction proves
insufficient. Third AI supervisor only after deterministic ownership and reliable
lifecycle evidence; advisory first, bounded actions, no unrestricted terminal tool.
Native Swift/iOS consumes the host API later; it does not execute local coding CLIs.

## Release gate

All regression/build/browser checks green; host acceptance documented against an
exact commit and CLI versions; backups and installer recovery verified; remaining
limitations visible in README and SECURITY. Keep the PR draft until that evidence
supports its intended use. No timetable or autonomous milestone is implied.
