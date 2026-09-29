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
settlement/takeover boundary. September 28 update: branch-scoped Stage relay runs are not legacy owners, so
they no longer block keyboard acquisition server-wide. They take a faulted hold: the current turn may finish
but schedules nothing, and the run continues only through takeover. A pre-upgrade staging run still refuses
native input and names its checkout. A held Implementation or Plan run's checkpoint is captured after the
completing Claude Stop hook exits, and again on later lifecycle evidence, once every checkout agent reports
settled activity; until then the controller card says which agents are unsettled and that takeover is the
recovery. Members of a paused relay show the pause rather than an idle or waiting-for-partner badge; a
working member keeps its native state.

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
The browser records its fixed acknowledgement wording as that note when the user takes control;
neither a checkbox nor a typed note is required (September 27 update below).

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

September 26 update: outside Plan the terminals and the one control pane share a frame behind a
**Terminal / Control** switch. The hidden surface stays mounted, so connections, keyboard
generations and drafts survive; a hidden terminal admits no new input, and switching sends nothing
and revokes readiness. The run's actual phase decides the layout, so an owned Plan run keeps the
Plan layout, whose side placement and phone drawer remain Plan-only. The Keyboard selector moves
from the shared terminal area into **Control access**, the one panel that gathers every
confirmation which takes control or enables an action: keyboard, manual-input reconciliation,
pause and takeover, checkpoint and handoff continuation, status and workspace resets,
uncertain-result acknowledgements and each action's readiness check. Each stays its own request
with its own confirmation; nothing is batched, retried or chained. Takeover names the command it
was confirmed for, so a run that moved on refuses it without side effects.

September 26 follow-up: at the owner's request, **Control access** sits immediately left of
connection status in each page heading. A separate ⌨️ status reports the server-wide keyboard
owner and has no ownership controls. **Claim keyboard** lives at the terminal where input is
needed; its confirmation names the current owner, intended target and affected runs. This
supersedes the selector placement above, while preserving one serialized acquire/transfer,
changed-view cancellation, no automatic grants and no replay of uncertain results. Plain and
settled release remain in Control access alongside reconciliation. An explicit claim does not
send terminal input or continue a held run.

Later on September 26: the claim is a ⌨️ icon tool in each terminal's tool row, right after the
status badge, with its confirmation below the row. The page heading's status row reads Control
access entry, then the ⌨️ keyboard status, then connection status. The September 27 usability
follow-up also permits **Go to Control access** beside implementation readiness hints. It opens
the same panel and focuses the visibly labelled checkbox; **Return to action** goes back to
the composer. Navigation alone neither confirms readiness nor sends work.

September 27 update, at the owner's request: the user cannot be prevented from acting outside the
app, so taking control is one explicit confirmation after a plain list of what to notice (an
agent that may still be working, a request or delivery that may have reached a terminal, earlier
manual input that may have run commands or left background work). **Take control…** lists its
steps and then runs them in a fixed order: clear the uncertain-request warning, end this
checkout's controller runs (each with its observed command), release an older delivery hold, and
record the human inspection decision on unresolved manual input. This supersedes the earlier
"nothing is batched or chained" rule for these steps only: each remains its own request with its
server checks and expected identity, the first refusal or unknown result stops the rest and is
reported with what already happened, and nothing is retried. Takeover still never interrupts a
worker or claims success. Checkpoint and blocked-handoff continuation and **Mark <agent> Ready**
are single clicks whose text states what they attest; each action keeps its one readiness check.
Runs in other worktrees keep their own holds.

See
[the protocol](../TERMINAL-PROTOCOL.md) for limits, recovery and deployment checks.
This amends ADR-0001's optional terminal boundary and extends ADR-0019; it does
not weaken exact lifecycle/result correlation or authorize automatic acceptance.
