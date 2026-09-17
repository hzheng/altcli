# CoderCrew architecture decisions

The current execution boundary is **[ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md)**.
Earlier records explain the design's evolution; their superseded statements are
not claims about the current implementation.

| Record | Current interpretation |
| --- | --- |
| [ADR-0001](docs/adr/ADR-0001-tmux-web-controller.md) | External tmux controller; human-first workflow, optional terminal extension and later supervisor |
| [ADR-0002](docs/adr/ADR-0002-typescript-web-stack.md) | TypeScript web stack, web workspace and SQLite; root wrapper later removed |
| [ADR-0003](docs/adr/ADR-0003-manual-dispatch-boundary.md) | Original manual ownership and uncertain-delivery contract; extended by later records |
| [ADR-0004](docs/adr/ADR-0004-observed-process-identity-and-console-registration.md) | Observed process checks and explicit pane registration; instance generations added by ADR-0011 |
| [ADR-0005](docs/adr/ADR-0005-projects-relay-pairs-and-per-worktree-turns.md) | Multiple sessions and named pairs; actual Git root/index identity now required by ADR-0011 |
| [ADR-0006](docs/adr/ADR-0006-no-root-manifest.md) | Only web/package.json; root scripts run repository operations |
| [ADR-0007](docs/adr/ADR-0007-tmux-by-default.md) | tmux product default; host read-only switch and separate mock testing |
| [ADR-0008](docs/adr/ADR-0008-deliveries-settle-themselves.md) | Delivery-only holds remain transport details; superseded as execution authority by ADR-0011 |
| [ADR-0009](docs/adr/ADR-0009-turn-complete-events-from-cli-hooks.md) | Original hook channel; informational-only and prompt-inference assumptions superseded |
| [ADR-0010](docs/adr/ADR-0010-outcome-line-and-auto-relay.md) | Defines the skill's final outcome line; browser scheduler and transcript fallback superseded |
| [ADR-0011](docs/adr/ADR-0011-server-owned-relay-runs.md) | Server-owned runs, explicit immutable pairs, correlated events, persistent execution ownership and safe config installation |

See [ROADMAP.md](ROADMAP.md) for implementation versus remaining acceptance, and
[VALIDATION.md](VALIDATION.md) for executed checks. Original roadmap/ADR documents
remain under [docs/history/2026-09-13](docs/history/2026-09-13/), and pre-hardening
operating documents under [docs/history/2026-09-16-pre-hardening](docs/history/2026-09-16-pre-hardening/).
