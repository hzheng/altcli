# Review resolution map

Review baseline: `83554366020a2a3a39bb4fa289b0391140f114e8` (September 16, 2026).
This document maps every recommendation to code, regression coverage, or an explicit
remaining limit. It is not a claim of a completed live-agent security audit.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| P1 stale Claude transcript | Current Stop message only; no transcript fallback; background evidence gate | Hook protocol tests and isolated real-hook HTTP smoke test |
| P1 wrong selected partner | Explicit pair frozen into server run | Overlapping-pair regression and browser pair selection |
| P1 ambiguous command/event binding | Unique command marker, exact prompt echo, full instance/session identity, source-turn acknowledgment, persisted dedup | Repeated relay, late event, missing identity, changed session/turn, leftover input, buffered completion tests |
| P1 browser orchestration | Server-owned runs, durable event receipts and single dispatcher claim | Concurrent observers, browser lock/reconnect, persisted budget and restart tests |
| P1 installer corruption | Conservative multiline string-array parsing; preserve individual foreign hook entries; preflight, backup and atomic replacement | Mixed Claude groups, multiline/literal TOML, unsupported syntax and isolated installer tests |
| P2 directory is not worktree identity | Canonical Git root/gitdir/index discovery | Subdirectory, unrelated repository, unborn index and linked worktree fixtures |
| P2 bounded history as authority | Active execution ledger separate from recent deliveries | Long task plus 35 other-project commands |
| P2 documentation drift | Current capability table, ADR-0011, setup/security/testing rewrite and immutable history snapshots | Current docs and API contract reviewed with source |

Also retained: TypeScript/Next.js/SQLite, no root npm manifest, narrow tmux transport,
explicit uncertainty, no automatic retry, server-only terminal access, output as
untrusted React text, and no third AI or native iOS implementation.

The inherited tests for obsolete prompt-only correlation and browser auto-relay
were replaced with tests of the new guarantees. They were not merely disabled.

## Explicit remaining limits

- Codex notify lacks background-work evidence, so the server uses a before/after
  process comparison scoped to the pane. Unreadable or unavailable evidence pauses;
  deliberately detached work remains outside this observational boundary. Installed
  CLI versions and the complete mixed-agent run still need host acceptance.
- Standard Git index identity only; custom worker environment overrides are not
  attested. External desktop input and child-process writes remain an operational
  boundary, not filesystem isolation.
- No Git mutation/fingerprint validation of the reported review delta and no final
  task-level test runner. A completed chain still needs human final verification.
- One backend process per store. Restart pauses instead of automatically resuming.
- Conservative TOML edits may refuse valid but unsupported top-level syntax. Both
  plans are checked first; no unsupported document is rewritten heuristically.
- Production security hardening, token pairing/lifecycle and physical iPhone tests
  remain separate acceptance work. No permissive public deployment is introduced.
