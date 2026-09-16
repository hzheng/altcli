# CoderCrew architecture decisions

| Record | Status | Scope |
| --- | --- | --- |
| [ADR-0001](docs/adr/ADR-0001-tmux-web-controller.md) | Accepted direction; stack questions resolved by ADR-0002 | External tmux controller, manual first, optional full terminals and later supervisor |
| [ADR-0002](docs/adr/ADR-0002-timedgoal-aligned-typescript-stack.md) | Selected for this scaffold | TimedGoal-aligned TypeScript stack, web workspace, SQLite, HTTP boundary, iOS reservation |
| [ADR-0003](docs/adr/ADR-0003-manual-dispatch-boundary.md) | Selected for this scaffold; process check and registration amended by ADR-0004, global reservation amended by ADR-0005 | Input safety, persistent manual ownership, uncertainty, and explicit human release |
| [ADR-0004](docs/adr/ADR-0004-observed-process-identity-and-console-registration.md) | Selected for this scaffold | Process identity observed at registration, denylist instead of allowlist, console-managed registration of any number of panes |
| [ADR-0005](docs/adr/ADR-0005-projects-relay-pairs-and-per-worktree-turns.md) | Selected for this scaffold | Confirmed agent type, projects derived from worktree roots, named relay pairs, manual turn reserved per worktree, pane preview |
| [ADR-0006](docs/adr/ADR-0006-no-root-manifest.md) | Selected for this scaffold; amends ADR-0002's root forwarding manifest | `web/` owns every npm task; root `scripts/` are plain `node` or one thin gate; no root package.json |
| [ADR-0007](docs/adr/ADR-0007-tmux-by-default.md) | Selected for this scaffold; amends ADR-0002's mock default and ADR-0003's opt-in input | tmux is the default adapter and input is on; `CODERCREW_ENABLE_INPUT=false` is the read-only switch; mock is a test adapter |
| [ADR-0008](docs/adr/ADR-0008-deliveries-settle-themselves.md) | Selected for this scaffold; amends ADR-0003's release step | Delivered commands settle at once; only uncertain deliveries hold the worktree until acknowledged; no confirmation dialogs |
| [ADR-0009](docs/adr/ADR-0009-turn-complete-events-from-cli-hooks.md) | Selected for this scaffold; first Phase 3 deliverable | Turn-complete events from Claude Code's Stop hook and Codex's notify; idle/working per pane, partner hand-off, readiness pre-tick; never a send |
| [ADR-0010](docs/adr/ADR-0010-outcome-line-and-auto-relay.md) | Selected for this scaffold; Phase 3 | The skill's final `RELAY-OUTCOME:` line, read from the CLI's own final message; outcome-routed hand-offs; opt-in auto-relay that continues only on accept_and_improve |

The [roadmap](ROADMAP.md) defines delivery order. An accepted design is not proof that
its implementation passed acceptance testing. See [VALIDATION.md](VALIDATION.md).

Keep meaningful changes in new ADRs. The exact original roadmap and ADR are in
[docs/history/2026-09-13](docs/history/2026-09-13/).
