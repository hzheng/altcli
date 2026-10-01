# ADR-0020: Native terminal transport and shared keyboard authority

> October 1, 2026: [ADR-0024](ADR-0024-registered-repositories-and-managed-workspaces.md) moves app terminals to a dedicated tmux endpoint and adds a copyable attach command, in later increments; concurrent writers and the manual barrier are unchanged, and navigating never enrolls a destination.

Status: accepted direction; implementation proposal. Setup enables its flag; a missing flag means off.

## Current contract and amendment precedence

The latest September 29 follow-up below governs current input: **Terminal / Display**
is the only acquisition control, multiple connections may write even to one pane,
and new writers may join a recovery period while automation remains held. Native
interleaving is an accepted risk; application-caused duplication, misrouting,
stale replay and unannounced automated input are not. Git cannot undo every native
command or external effect. Earlier single-writer, first-input queue and local-only
browser handoff rules are retained below as dated history, not current instructions.

Use xterm.js over a ticket-authenticated WebSocket owned by the same Next
ControlPlane. The per-card HTTP streaming candidate failed the six-connection
browser control-capacity gate. Use node-pty and native tmux attachment, preserving
raw bytes, terminal sizing and tmux navigation.

Observation defaults read-only. The human approved captured-text fallback wherever
native observation could resize workers after the tmux 3.5a probe exposed the
all-clients-ignored sizing behavior. Do not change discovered/global options.
Writable input uses per-connection grants under one server-wide manual-input barrier.
The one exception is Global AI's own app-role terminal: no project, run or automated
delivery uses it, so its input stays outside the barrier. Its input bytes are directed
to its own pane, independently of its read-only display client, so tmux client
navigation cannot carry that exemption into workspace terminals
([GLOBAL-AI](../GLOBAL-AI.md#native-input-and-recovery)).
The September 29 amendment below supersedes the earlier single-writer controls. Persist its
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
The checkpoint's explicit **Review input and continue** action may acknowledge displayed
manual-input consequences, stop the writers and record the human inspection decision,
then submit the separate checkpoint review without ending the run. Each operation keeps
its existing server checks; refusal, uncertainty or a changed checkpoint/view stops the
sequence. Viewing a queued handoff never resumes it.
The browser records its fixed acknowledgement wording as that note when the user takes control;
neither a checkbox nor a typed note is required (September 27 update below).

The selected agent (the terminal shown and the control recipient, chosen together),
keyboard focus and writer are independent.
Copy mode and synchronized input block automated dispatch without removing a live,
verified CLI from its workspace group or unmounting its terminal. Keep the reason
visible so the owner can use the native keyboard to leave copy mode. Process,
instance and directory checks still apply; observation is not readiness.
The shared Control frame retains separate drafts/composers per agent. Parallel shows
them all and holds selection; Focus shows one and follows the next working agent.
The Agent selector chooses the viewed agent and recipient together; selection
revokes readiness and sends nothing. Plan setup addresses the whole group.

## Earlier strict browser handoff

This describes the earlier browser handoff. Its command-bound strict settlement
API remains supported, but the September 29 follow-up replaces the browser action
sequence with acknowledged stops and human inspection, including remote writers.

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

## Historical amendments

Read these chronologically: later amendments explicitly supersede earlier controls.

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

September 29 amendment (approved direct-input plan): remove Claim/Take keyboard and transfer.
Only the first trusted human key, composition commit, paste, soft key or mouse-protocol input
admits a writer. Observation, focus, selection, scrolling history and terminal-generated replies
never admit one. A separate real textarea captures pre-grant text/IME; public xterm APIs encode
queued keys and paste after the writer generation is ready. Both the correlated HTTP result and
socket writer frame are required; reset alone grants nothing. Bound pending intents to the exact
connection, host boot and view, discard them on cancellation, and never replay uncertain input.
Captured-only observation keeps this entry field without changing tmux sizing policies.

Keep one backend and at most one persistent attachment per connection, with the existing eight
host/four session limits. Multiple browsers, tabs and terminals may type, even at the same pane;
native tmux interleaving and sizing apply. Show the actual destination and effective window size.
The first writer takes the original all-pane snapshot and whole-run holds once. Later writers
join that period without recapturing checkpoints or weakening the global automation barrier.
Disconnect/restart retains evidence and requires inspection before any new admission; another
already live writer can continue. No inactivity timeout transfers input or settles the period.

Stop typing here and Stop typing in this browser name exact connection generations and retain
the barrier. A checked Send freezes the complete local writer set, refuses pending input,
remote writers, recovery or affected checkpoints, then strictly reconciles with exact
period/writer revisions. Any intervening input invalidates that confirmation. The existing
command-bound settlement checks remain in force through delivery. This does not resume held
runs. A plain stop may accept newer byte revisions because it only removes authority; it never
accepts a replacement generation.

Schema 18 preserves each legacy period's ID, original snapshot, run references, revisions and
byte evidence separately, revokes all old grants and retains recovery. Version-2 terminal opens
and explicit host-boot checks refuse old tabs. Roll out only at a settled backend restart. Native
and browser evidence is recorded with this proposal; physical Safari/IME, remote transport and
installed-provider acceptance remain separate release gates.

September 29 follow-up, at the owner's direction: one **Terminal / Display** toggle in each
terminal's tool row replaces the entry field. Terminal is one deliberate request for input on that
connection, with no pre-grant queue; Display releases it and keeps watching. Keys, paste, soft keys
and mouse reports reach the pane only in Terminal mode; focus, output and clicks in Display admit
nothing. A toggle on a failed or closed connection first replaces it with a fresh observer (nothing
is replayed), then requests input; Terminal chosen while a connection is opening starts once it is
connected, and focus is not pulled back if the user moved elsewhere meanwhile. New input may join
an unsettled period that requires recovery or began before a restart: the period keeps its
evidence, recovery flag and automation barrier and adopts the current boot. This replaces
"requires inspection before any new admission" above; automation still waits for reconciliation.

Every action has one readiness check beside it. While something holds the checkout, the same
check lists each consequence of proceeding: controller runs it ends, an older delivery hold or
uncertain-request warning it clears, every terminal writer it stops (other browsers and tabs
included; they switch to Display) and the manual input it records as accepted by human
inspection. The acknowledgement is bound to the exact holds (run and command, delivery, request,
and each record's revision and writer generations), so a replacement revokes it even when the
listed consequences read the same. The action performs those steps in that order before it
starts, as Take control does: each is its own checked request, the first refusal or unknown
result stops the rest, and nothing is sent or retried. A change to the draft, target, view or
agent activity while the holds are cleared, or the composer or confirmation going away (Lock,
another workspace), cancels the action after them; the recorded decisions stand. A successful
send clears a draft only if it still holds what was sent. This replaces the checked local batch handoff: remote writers, recovery and
affected checkpoints no longer block Send, and runs a period paused stay paused for checkpoint
review. Projects applies the same single acknowledgement to squash, update, rebase, reset, rename,
Finish branch, removal, discard and launch. A squash refused only because agents or processes may
be working can be previewed and confirmed with an explicit activity acknowledgement that its
consent digest covers (ADR-0013). Read-only hosts, stale reads, unconfirmed CLI identity, copy
mode or synchronized input, detached HEAD, unresolved setup and Git refusals remain blockers that
no acknowledgement clears. Control access stays the reference that explains every hold and keeps
Take control, stops and recovery; nothing there is required first.

September 29 image attachments (M4A/M4B), from an endorsed Plan: images are file uploads, never terminal
bytes, base64 input or host clipboard changes. A PNG or JPEG pasted or picked in a Terminal-mode card
uploads over authenticated HTTP to private storage outside every workspace; the upload types, grants
and sends nothing. An explicit **Insert** is one image intent in the connection's ordered input lane,
sharing its generation, sequence, receipts and manual-input evidence. Immediately before the write the
server rechecks the writer's actual pane and session, the registered Claude Code or Codex process and
directory, and the image bytes, records the image's use, then writes the single-quoted absolute path as
one bracketed paste and never Enter; tmux forwards the paste markers only to a program that enabled
bracketed paste. Refusals before the write are definite; a failed write or lost response is uncertain
and never resent. This narrows but does not remove tmux's inspection/write race or interleaving with
other writers, and a reference never establishes that a model read the image. Control reuses uploads
for plain Send, new committed work and a Plan's shared brief: admission freezes and pins immutable
descriptors, every later assignment of the run carries them, and plain Send's prompt names an input
manifest instead of an image path, so exact prompt correlation is unchanged. Images that may have been
used never expire in this increment; a full quota refuses new uploads. The protocol records which CLI
versions a probe verified; other CLIs are refused.

## Proposed image completion work

Proposed future direction, not implemented: drop input through the same bounded,
target-bound upload path; reference-aware management and deliberate release of
eligible used images; and explicit app-conversation/job scope after a text-only
app-assistance release. Preserve explicit Insert without Enter and no uncertain
replay. Never evict active/uncertain references, and never promise provider-data
retraction. The pixel-decoding versus structural-validation contract remains
[open](../OPEN-DECISIONS.md#proposed-app-wide-assistance-and-completion-choices).
These extend the September 29 scope rather than recategorizing its exclusions as
regressions. See the [roadmap](../../ROADMAP.md#proposed-app-wide-assistance-and-completion-work).

See
[the protocol](../TERMINAL-PROTOCOL.md) for limits, recovery and deployment checks.
This amends ADR-0001's optional terminal boundary and extends ADR-0019; it does
not weaken exact lifecycle/result correlation or authorize automatic acceptance.
