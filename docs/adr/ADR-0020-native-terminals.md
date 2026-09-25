# ADR-0020: Native terminal transport and shared keyboard authority

Status: accepted direction; implementation proposal. Setup enables its flag; a missing flag means off.

Use xterm.js over a ticket-authenticated WebSocket owned by the same Next
ControlPlane. The per-card HTTP streaming candidate failed the six-connection
browser control-capacity gate. Use node-pty and native tmux attachment, preserving
raw bytes, terminal sizing and tmux navigation.

Observation defaults read-only. The human approved captured-text fallback wherever
native observation could resize workers after the tmux 3.5a probe exposed the
all-clients-ignored sizing behavior. Do not change discovered/global options.
Writable input requires the one server-wide keyboard authority. Persist its
manual barrier and affected whole-run checkpoint holds before input is possible.
Release/disconnect/restart are not reconciliation or continuation. Never persist
raw keystrokes or replay uncertain input. Legacy owners retain their existing
settlement/takeover boundary.

A writer's deliberate tmux session navigation is followed and labelled; it never
changes the workflow target, and the server-wide hold already covers it. Observers
never follow. Loss of the original target closes the attachment without falling
back to another session.

Strict settlement requires agent activity only for agent panes and process
evidence for every pane. Non-agent directory changes alone are allowed. When
strict checks cannot settle the record, an explicit human inspection decision
with a bounded note may release the server barrier, acknowledging possible prior
and background effects. Refuse it while any keyboard, delivery, setup or launch
operation remains live or unresolved. Keep every affected run's keyboard hold,
checkpoint and fault; its review or takeover stays separate. Recovery is available
even with no remaining agents or with feature flags off.

The terminal view, keyboard focus, control recipient and writer are independent.
One AltCLI control pane retains drafts per target. See
[the protocol](../TERMINAL-PROTOCOL.md) for limits, recovery and deployment checks.
This amends ADR-0001's optional terminal boundary and extends ADR-0019; it does
not weaken exact lifecycle/result correlation or authorize automatic acceptance.
