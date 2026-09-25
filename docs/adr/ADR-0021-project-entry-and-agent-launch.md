# ADR-0021: Explicit repository entry and agent session launch

Status: accepted direction; implementation proposal. Setup enables its flag; a missing flag means off.

An explicit absolute repository path adds metadata through canonical Git common
directory identity. No scan, clone, dummy tmux server or Git mutation is implied.
Users prepare environments. AltCLI may explicitly launch versioned executable +
argv profiles in a main or linked checkout, after a captured preview and human
confirmation. This amends the agent-placement boundary in ADR-0012/ADR-0013;
existing branch/worktree and end-of-task consents remain separate.

Launch has durable per-checkout reservations shared with Start, keyboard input
and setup. Configure an inert placeholder's safe lifetime and exact full-UUID
marker before executing an arbitrary program once. Verify literal arguments,
absolute executable and the actual child environment, including old tmux state.
Never source shell configuration implicitly, store controller credentials in a
profile, retry an uncertain spawn, adopt a reused name or delete successful
siblings. Observed startup is not readiness. Uncertainty survives restart until
inspection or a recorded human decision; history is retained.

tmux retains execution argv in pane metadata. Launch therefore omits API keys,
OAuth tokens and proxy environment variables, including values inherited by an
existing tmux server. Use CLI credential stores; profiles requiring credential
or proxy environment variables are unsupported. Only nonsecret host settings
and configuration paths enter the launch argv.

See [the protocol](../TERMINAL-PROTOCOL.md) for API, environment and recovery rules.
Remote/provider/mobile acceptance remains separate from fake and private-fixture
validation. Setup enables the feature flags; a missing flag means off.
