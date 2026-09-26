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
The browser records the inspection checkbox's acknowledgement as that note;
typing additional text is not required.

The selected agent (the terminal shown and the control recipient, chosen together),
keyboard focus and writer are independent.
Copy mode and synchronized input block automated dispatch without removing a live,
verified CLI from its workspace group or unmounting its terminal. Keep the reason
visible so the owner can use the native keyboard to leave copy mode. Process,
instance and directory checks still apply; observation is not readiness.
One AltCLI control pane retains drafts per target. Its recipient is the agent
selected above the terminals, which starts on a working agent and is then held until
the owner chooses another; Plan setup addresses the whole group.

An explicit Implementation action may hand off this browser's connected keyboard
when there is exactly one manual session and no affected run checkpoints. Its
readiness confirmation covers all host panes and names the keyboard owner and
control recipient. Stop local input, reject pending input and changed keyboard
revisions, then perform strict settled release before submitting the chosen new
action. Bind the settlement to that exact command and recheck its evidence through
admission, branch setup and delivery. Native activity, keyboard changes or restart
invalidate it. Pane-mode changes revoke both Plan and Implementation readiness,
including when a mode clears before the next workspace discovery poll.
Settlement failure, uncertainty or changed draft/target/activity/view sends nothing
and preserves the draft. Another browser's ownership and unresolved manual records
still require separate recovery. Normal dispatch gates apply after release; this
does not resume held runs or transfer keyboard authority.

September 25 update: the browser presents the one writer as a single **Keyboard** selector in
the shared terminal area instead of per-card buttons. Choosing a pane still asks for the same
confirmation and uses the broker's serialized acquire/transfer; it never grants from an effect,
never releases one pane before acquiring another, and a cancelled or outdated choice sends
nothing. **Nobody** is the plain release; the strict settled release stays a separate confirmed
action. Keyboard acquisition also waits while a Finish branch step may be acting on sessions or
Git ([ADR-0013](ADR-0013-confirmed-branch-setup.md#confirmed-closing-of-launched-sessions)).

See
[the protocol](../TERMINAL-PROTOCOL.md) for limits, recovery and deployment checks.
This amends ADR-0001's optional terminal boundary and extends ADR-0019; it does
not weaken exact lifecycle/result correlation or authorize automatic acceptance.
