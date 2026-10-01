# Native terminal protocol

Setup writes `ALTCLI_ENABLE_TERMINAL=true` and `ALTCLI_ENABLE_AGENT_LAUNCH=true`
into a new `web/.env.local`; a missing line means off. Change either only at a
settled host restart. Use the project
`npm run dev` / `npm run start` commands in `web/`; they run `server.ts`, a
loopback-only custom Next host. A plain `next start` cannot serve the terminal
upgrade route. The host never creates another ControlPlane or SQLite store:
Next's process singleton exposes a small gateway through `globalThis`.

## Connection and output

1. Mounting a terminal opens observation by posting `protocol: 2`, a target, dimensions and a page-memory
   browser UUID to `/api/v1/terminals`, using the usual bearer and origin checks.
2. The response contains a ten-second, single-use ticket and connection ID.
   Connect to `/api/v1/terminals/socket`, with no query string, and send
   `{"ticket":"…"}` as the first JSON frame within five seconds. Missing/null or
   foreign Origin and foreign Host are rejected. Neither token nor ticket belongs
   in a URL, log or browser storage.
3. `reset` establishes a new stream generation. `out` carries generation,
   contiguous sequence, raw byte count and base64 bytes. `active` labels the actual
   attached pane/session and the effective tmux window size (`size`, for example
   `120x40`), which other clients may also influence. `keyboard`, `hb` and
   `closed` report authority/liveness.
4. After the `xterm.write(bytes, callback)` callback, send
   `{"type":"processed","generation":"…","sequence":1,"processedBytes":123}`.
   The cumulative byte count must equal the server's credit record. Receiving a
   WebSocket message alone never acknowledges rendering.
5. Send `{"type":"heartbeat","generation":"…"}` every ten seconds. Thirty
   seconds without renewal closes the owned attachment. Reconnect is observation
   only, with a fresh generation and screen, never an input replay.

Limits: eight connections per host, four per session; 16 KiB raw output frames;
1 MiB outstanding plus queued raw bytes, with one bounded 64 KiB in-flight PTY
chunk. The broker pauses/resumes its attachment at high/low watermarks (256 KiB
low), never SIGSTOPs the worker. Ten seconds without processed credit while output
is outstanding disconnects a slow consumer. Credit/queue entries are also bounded.
Incoming WebSocket controls are limited to 16 KiB, without compression. Input
uses bearer-authenticated HTTP, at most 4 KiB per frame, 32 KiB server queue and
256 KiB per second. Browser paste/queue is bounded at 256 KiB. Input sequences
are contiguous and receipts are limited to the latest 64 in one generation.
Conflicting/expired duplicates or uncertain responses are never replayed.
Browser input queues belong to one connection generation. A late success or
failure from a retired generation cannot stall or revoke the new keyboard. A grant
or release replaces the generation while output acknowledgments and heartbeats for
the old one may still be in flight; the server ignores those for the connection's
last few retired generations (any other generation still closes it), and a keyboard
decision completes in the browser only once the new generation's reset is applied.
Leaving the terminal, changing views or collapsing an expanded terminal drops
unsent queued text. One input event (for example a paste above 4 KiB) spans several
frames. If its first frame was already sent, its remaining frames are still sent,
so a bracketed paste is never truncated. Bytes already admitted may still take effect and remain
covered by the manual hold.
Resize requests are debounced by 120 ms in the browser, with one in flight. The
server independently permits one per connection per 100 ms, with one native
inspection in flight, returning 429 on excess. Dimensions clamp to 20–500 columns
and 5–200 rows. Hidden terminals send no zero-sized resize.

## Observation, keyboard and recovery

An observer attaches with tmux `read-only,ignore-size` only after the session's
windows are verified as manually sized. Automatically sized windows use captured
text: tmux 3.5a otherwise counts ignored clients when no ordinary client supplies a
size. Never alter discovered/global window sizing or lifetime options to make
observation work. A changed sizing policy, server or pane identity closes the
attachment, as does an observer client that tmux moved to another session. The
target pane leaving its original session, or that session ending, closes even a
navigated writer; nothing falls back to another session. Incompatible
`destroy-unattached` settings refuse attach.

A workspace keyboard writer is a full tmux client, so it may deliberately navigate to another
session. The attachment then follows: the status line shows the actual session,
pane and command and notes the navigation. The card's agent and the Control
target do not change, and the server-wide manual hold still covers every session.
A session reached by navigation keeps its own lifetime settings. If it uses
`destroy-unattached`, detaching the browser there (release, close or Lock) can
destroy it, just as a desktop client leaving it would.

The ⌨️ status reports the active input connection count and shared automation hold. There is
no exclusive keyboard owner. Global AI's own terminal is the exception to everything about the
hold below: it requests input automatically once connected, shows no toggle, and its `acquire`
returns `manualSession: null` without joining any manual-input period. Its display client
is read-only; ordered input frames use `send-keys -H` with its exact original pane,
so tmux prefixes go to Helper's CLI and cannot navigate the client into another session.
An externally moved display client closes instead of following. Pending writes drain
before close, and uncertain writes are never replayed. Other terminals' holds and
in-flight automation do not block Helper input. Elsewhere, the
**Terminal / Display** toggle is the only input request,
including from captured-only observation. Terminal requests `acquire` with an idempotent request
ID, exact observer generation and `expectedBootId`; Display releases that connection's writer.
There is no first-key input field or pre-grant queue. Focus, copy/selection, history scrolling,
paste in Display and terminal-generated replies never acquire input. The browser enables typing
only after the matching HTTP result, socket writer generation and already-received output are
processed, so input uses the current terminal modes. Native attachments advertise the per-client `sync` capability;
the broker waits for the first synchronized redraw's end before the writer frame (five-second
limit). This changes no tmux sizing or global option. The byte boundary follows
[tmux 3.5a’s synchronized-output implementation](https://github.com/tmux/tmux/blob/3.5a/tty.c#L1569);
xterm 6 supports those sequences. Response/frame order is immaterial; reset alone is insufficient.
View changes, disconnect or uncertainty drop unsent queued input and retain any already created
manual barrier; an event already partly sent still drains as described above. No input is
replayed into a replacement generation. A pending grant does not pull focus back after the user moves elsewhere.

Writers may coexist in this or another browser, even on one pane. Native tmux interleaving and
size negotiation still apply. Each connection has one attachment, replaced on promotion or stop;
no extra persistent service is created. The first writer durably records the all-pane snapshot
and whole-run holds before input. Later writers join the same period without overwriting
original checkpoints, snapshots or aggregate byte evidence, including when joining an unsettled
period that needs recovery. Acquisition remains serialized with
setup, delivery and other keyboard decisions; existing writers have independent input queues.
Legacy owners still need settlement/takeover. Current modern turns can finish while held but
cannot dispatch a successor; branch-scoped Stage relay keeps its fault/takeover rule.

The terminal's **Terminal / Display** toggle posts `acquire` or `release` for its own connection;
a toggle on a failed or closed connection first opens a fresh observer connection. The toggle is the
pane's only typing/viewing indicator; a status badge beside it appears only for other states
(disconnected, replaced CLI, held or unresolved manual input). An action's acknowledgement freezes
the local queues it stops and posts `/api/v1/terminals/stop` with period ID, boot ID and the exact connection, generation and
writer revision set. Plain stop accepts subsequent byte revisions, drains admitted work and
retains the barrier; a replacement generation is always refused. Another browser's writers are
stopped only by an action's acknowledgement that lists them. Disconnect, expiry, Lock and restart
retain the barrier and mark the period for recovery; new writers may still join it, and other
existing writers remain live. Metadata contains identities,
checkpoints, times and byte counts, never raw input. Stopped writer details may be pruned on join;
the period retains its aggregate counts and initial targets for cleanup checks.

**Strict settlement API:** the command-bound `handoffRequestId` / `keyboardSettlement` path
retains its narrower contract: one healthy period, no affected run checkpoints and no remaining
unselected writer. A caller freezes its selected local queues before sending one checked
batch stop; pending input/paste refuses the action. `confirmReady: true` requires
exact aggregate and writer revisions, so bytes admitted after confirmation refuse settlement.
Strict inventory/activity/background-work/checkpoint checks must succeed before ordinary dispatch.
A failed check still stops those writers and retains the barrier and reason. The `handoffRequestId`
binds successful settlement to the exact frozen command; `keyboardSettlement` carries the returned
period ID/revision through admission, branch setup and delivery checks. New activity, keyboard
changes or restart invalidate it. A changed draft, target, activity or view cancels dispatch and
preserves the draft; an uncertain response is never retried. This is distinct from the current
browser's human-inspection sequence below. Settlement alone never continues a run.

**Current browser actions:** the action's acknowledgement lists the exact holds it clears,
including remote writers, recovery records and any controller runs it ends. It stops all listed
writers, records the human input decision, then attempts the chosen action through its normal
checks. A changed view/draft/target or refusal/uncertain response cancels the rest; already
recorded decisions stand. **Review input and continue** clears only the manual holds before a
separate saved-checkpoint review, keeping that run. An automatic checkpoint may dispatch its
eligible queued turn; a waiting checkpoint needs **Next turn** afterward.
**Take control** ends the run instead. Neither viewing a result nor merely releasing or
reconciling a manual record sends a successor. See the browser action descriptions below.

Schema 18 migrates each legacy period independently, preserving its original IDs, snapshots,
run references, revisions and byte evidence, with no surviving live grant. Unresolved records
remain barriers until explicitly reconciled. The original singleton fields are archival metadata;
`writers` is current authority and `live` is their aggregate. `recoveryRequired` retains the
automation barrier; new writers may join while preserving that evidence and adopting the current boot.
Protocol-2 opens and host-boot checks make older tabs fail closed. Adopt only at a settled restart;
older servers refuse this schema instead of interpreting concurrent writers as one owner.

Copy-mode and synchronized-input changes revoke Plan and Implementation readiness
on the state poll, even when workspace discovery has not changed. Clearing the mode
requires a fresh readiness confirmation.

Reconciliation never resumes a run. Validated original checkpoints need their
existing explicit review action; previously paused/faulted runs need takeover.
The settled check requires unchanged pane identities, known idle/ready activity
and unchanged directories for agent panes, and no new surviving processes across
all panes. Ordinary shells and editors need process evidence, not agent activity;
their directory changes alone do not fail settlement. The original foreground
command must also remain unchanged, guarding shell `exec` with an unchanged PID.
Older non-agent snapshots lacking that evidence need a human decision. Panes that
disappear or exit during manual input, unknown agent activity, and changed
checkpoints retain the barrier. A pane that had already exited when the keyboard
was granted (such as a remain-on-exit launch pane) has no process tree to read; it
neither blocks the grant nor fails settlement while it stays exited.

In the browser, an action's readiness acknowledgement, or **Take control…** in Control access,
records this human decision for every unresolved record after one confirmation, including when no agents remain or feature flags are
off. Its notes say that earlier input may have run commands or left background work; the fixed
acknowledgement wording is recorded as the decision note, with no checkbox or typed note.
`POST /api/v1/terminals/reconcile` accepts either `confirmReady: true` for the
settled check, or `confirmInspected: true` with a nonblank single-line `note`
(at most 1,000 characters). Both require the current `manualSessionId`,
`expectedRevision` and an idempotent `requestId`. The human decision records
possible prior/background effects and releases only that server-wide barrier;
affected runs retain their keyboard holds, checkpoints and faults. It does not
certify settlement or send anything. Any live keyboard, in-flight operation, or
unresolved delivery/setup/launch refuses reconciliation. Never clear SQLite rows
by hand.
The browser selects the viewed agent and Control recipient together; DOM focus and
keyboard grants remain separate. Native tmux navigation can change a writer's actual
destination without changing that selected agent. Control-pane drafts, including the Plan brief, stay editable while
a keyboard or manual barrier holds dispatch; only their actions are blocked, with
the reason shown. Ctrl+Shift+Escape leaves terminal focus for the visible Terminal/Control switch
(or the Control access entry); the terminal shows this hint while it has
focus, and it never sends input or changes keyboard ownership. Focus moves on the
shortcut's first key release, so xterm also sees that release and does not ignore the
next inserted text (IME, emoji, phone keyboards) when the user returns. Touch keys and
one-shot Ctrl/Alt modifiers send bytes only under a grant; modifiers clear on
blur, view change and revocation. The visual viewport refits for mobile keyboards
and rotation. Alternate-screen wheel-to-arrow translation is suppressed when
mouse reporting is off. OSC clipboard/title changes are consumed; HTTP(S) links
require explicit confirmation. Output is never controller instructions or HTML.

The mode toggle shows ordinary typing/viewing state. A separate compact badge appears for
**Disconnected** 🔌, **Manual CLI/shell** ⚠️ (the registered CLI process was replaced,
for example it exited to a shell), **Observing · manual input unresolved** or **held** ⚠️, or
other exceptional states; ordinary **Typing enabled** and **Observing** badges are omitted while
the toggle is available. Help text (on hover, keyboard focus and tap) says what it means and what to do;
actionable failures stay visible in the status line. The page's connection indicator works the
same way (🟢 Connected, 🔴 Not current, ⏳ Connecting); it is not agent activity or readiness. The status
line shows the actual pane, foreground command and effective window size. If focus
moved elsewhere while a keyboard grant was pending, the terminal does not take
focus back. The toggle queues no first input. With native terminals
enabled, Settings also shows the server-wide keyboard scope and the terminal limits.

The worktree group row keeps **Agents** immediately left of local **Settings**, including
in Stage relay. Agents expands the checkout status table; Settings edits the phase’s
branch and collaboration choices. Global Settings holds preferences and host configuration.

The shared Control frame keeps a separate composer for each agent:
- **Terminal / Control:** outside Plan the terminals and Control share one frame, and the switch
  shows one of them (Terminal first, remembered per workspace until Lock). The run's actual phase
  decides, so an owned Plan run keeps the Plan layout. The hidden surface stays mounted: terminals
  keep their connections and keyboard generation, a hidden terminal admits no new input event (an
  event already partly sent still drains), and Control keeps its drafts. Switching sends nothing and
  revokes readiness; the selected agent's status stays in the frame header.
- **Control below / Control beside** (Plan only): on windows at least 1280 px wide, the pane
  can sit beside the terminal stage. The choice is remembered in this browser;
  narrower windows stack it below.
- **Open control drawer** (Plan only): at phone widths, the same pane opens as a bottom
  drawer. Escape or **Close drawer** returns focus to the toggle.
- **Agent selector:** the tabs above the terminals choose the terminal shown and the
  control recipient together (Plan setup addresses the whole group). In Parallel,
  clicking a card's heading or focusing its controls does the same. Parallel shows all agent
  controls, side by side on wide screens and stacked on phones; Focus shows one. Each keeps
  its own draft, and only the active card shows its readiness check, beside its actions.
  Selection starts on a working agent. In Focus it
  then follows the next agent that starts working; in Parallel it is held. Either way it
  revokes readiness and sends nothing; it never selects the keyboard writer.
- **Readiness:** each action's one check sits beside it and is offered only while the Console
  shows that action. While a controller run, an uncertain delivery or request, or manual input
  holds the checkout, the check lists each consequence and the action clears those holds in the
  Take control order (plus stopping every live writer) before it starts; the first refusal or
  unknown result stops, and nothing is sent or retried. The check is bound to the holds' exact
  identities (commands, deliveries, record revisions, writer generations); a draft, target, view
  or activity change while they are cleared, or the composer unmounting (Lock, another workspace),
  cancels the action, and only the sent draft is cleared.
- **Control access:** one nonmodal panel under the page heading, opened from its entry in the
  page heading's status row (entry, then the ⌨️ input status, then connection status) on every tab
  and reachable with no agents. It explains every hold and holds typing stops, manual-input
  reconciliation, the controller's run card with pause and one-click checkpoint or handoff
  continuation, a list of what to notice, one **Take control…** confirmation (ending this
  checkout's controller run, clearing an uncertain-request warning, releasing an older delivery
  hold and recording the decision on earlier manual input, in that order), one-click **Mark
  <agent> Ready** and workspace reset. Nothing there is required before an action; opening or
  closing the panel changes nothing.

Terminal tools are icon buttons that keep their full accessible names, with help on hover and
focus, and a **?** legend that also works by tap: **Reconnect** 🔄 (observe only), **Captured text** 📄 / **Show terminal** 🖥️, **Expand terminal** ⤢ / **Collapse terminal** ⤡,
**Screen reader mode** ♿, **Paste text** 📋 and **Attach image** 🖼️. **Expand terminal** enlarges the
existing surface in the page without opening a new connection or changing keyboard ownership.
The former visible focus-escape button is gone (September 25 decision); the shortcut and its
on-focus hint remain. A focus outline identifies the active surface. Snapshot timestamps appear only alongside the captured-text fallback.
Multiline paste into a terminal without bracketed-paste support requires a
warning confirmation because newlines can execute immediately; paste above
16 KiB also requires confirmation. **Paste text** reads the clipboard only on
that explicit click in Terminal mode; it does not enable input. Multiline/large paste asks before sending. A delayed result is
discarded if focus, input, view or grant changed. Clipboard denial falls back to
the keyboard/system Paste action. Accepted text uses xterm's single paste path,
without an added Enter. Image files take the separate attachment path below; a paste that carries them types no text.

**Screen reader mode** enables xterm's accessible output tree explicitly. It
defaults off because xterm 6 disables its emoji/`insertText` fallback in that mode;
ordinary key events remain usable. Turn it off when a software keyboard cannot
enter text, or use Captured text for reading. This option does not establish
physical screen-reader or Safari/IME acceptance.

## Image attachments

A screenshot is a file, not keystrokes. In a card in **Terminal** mode, pasting an image (or
choosing **Attach image** 🖼️, the picker for phones and denied clipboards) uploads it to this host;
nothing is typed, granted, focused or submitted by the upload. Display mode, a hidden card, a disabled
host or a terminal that is not a registered Claude Code or Codex instance uploads nothing and says why.
A paste carrying both an image and text asks which to use; Cancel pastes the text through the usual
checks, and the same paste never does both. HTML and URLs are never read or fetched. The picker is bound
to the connection, generation, view and target at the click; files returned after any of them changed
are discarded. Drag and drop is not supported.

`POST /api/v1/attachments` takes one raw PNG or JPEG body with JSON metadata in the `x-altcli-upload`
header (a client request ID, the canonical workspace root, an optional display name). Authentication
precedes any read or allocation; a read-only host refuses. Limits are fixed AltCLI bounds, not provider
limits: 10 MiB per image, four images and 20 MiB per tray or draft, 40 million pixels, two concurrent
uploads per host, and 512 MiB and 1,000 retained files per host. The server checks structure without
decoding pixels. For PNG: the signature, a valid first IHDR (dimensions, bit depth and color type,
compression, filter, interlace), every chunk's length and CRC, only known critical chunks, no animation
chunks, a palette for indexed color, one contiguous run of image data, and IEND as the last bytes. For
JPEG: the start marker, every segment inside the file, one frame header with nonzero dimensions, a scan
after it and an end-of-image marker; bytes after that first end marker (such as appended MPF images) are
stored but not inspected. The declared type must match. Files are written exclusively (`0600`) under
`<data directory>/attachments/` (`0700`, an ordinary directory outside every workspace) only after
validation, and published by a no-clobber link. A retry of the same request ID with the same bytes
returns the stored receipt; different bytes conflict. Nothing retries automatically.

Each thumbnail states what AltCLI observed: Uploading, Ready to insert, Inserting, **Reference inserted**
or **Insertion uncertain**. **Insert** is one explicit intent in the connection's ordered input lane
(`POST /api/v1/terminals/{id}/input` with `image`), sharing its generation, sequence and receipts; typed
input must finish sending first. The server rechecks the boot, the registered CLI process and its
directory, and the image's bytes, then takes fresh evidence that the writer still shows the original
pane in the original session as its last step before the write (a writer that navigated tmux, even while
the image was being prepared, is refused). Without awaiting anything further it rechecks authority,
records the image's use and the manual-input evidence and writes `ESC[200~'<absolute path>'ESC[201~`,
never Enter. tmux forwards the
paste markers only to a program that enabled bracketed paste. A refusal before the write returns the
image to Ready; a failed write or lost response is uncertain and never resent. These checks narrow, but
do not remove, tmux's inspection/write race and interleaving with other writers. Removing an inserted
preview only hides it: it does not retract the text or any copy the provider received.

On September 29, 2026 a probe on this host (tmux 3.5a, a private socket, a disposable image) observed the
single-quoted, backslash-escaped and raw path forms, including spaces and Unicode, become `[Image #1]` in
Claude Code 2.1.285 (auto permission mode, `--no-chrome`) and Codex 0.159.0 (`--no-daemon`); after a
manual submit both described the image correctly. That is the verified reference; other CLIs are refused.
A reference in the prompt is not evidence that a model read the image, and remote SSH or container panes
cannot read a host path.

Control reuses the uploads for plain Send, new committed work and a Plan's shared brief (other Control
fields stay text-only and say so). An instruction or brief is required with images. Pending or failed
uploads and recipients other than Claude Code or Codex block the action before any hold is cleared.
Adding, removing or replacing an image, or an upload finishing, revokes the readiness check. Uploads
belong to the page draft, so one that finishes after its composer was hidden by a phase, view or
workspace switch still reaches the draft.
Admission freezes ordered descriptors (path, media type, size, dimensions, SHA-256) and pins them with
the run; every later assignment carries them, and bytes are rechecked before each dispatch, pausing the
run with ownership retained if they changed. Plain Send's prompt names an input manifest
(`<assignments>/<command>.input.json`) that holds the instruction and descriptors, so no image path is
typed where a CLI could turn it into an image token and change the exact prompt that correlation checks.
In the same probe both CLIs read such a manifest and inspected its image outside the checkout without a
permission prompt in those configurations; other permission modes may ask.

Unreferenced uploads are drafts, reclaimed after 24 hours or deleted by **Remove**
(`DELETE /api/v1/attachments/{id}`, refused once any use is recorded). Images that may have been used
never expire in this increment, and a full quota refuses new uploads with the retained size and count:
there is no in-app release yet, and deleting files by hand breaks recorded references. History exports
keep descriptors, not image bytes; back up the attachment directory with the host data. Lock forgets
previews and drafts; server-side references remain.

Drop input, used-reference management/release, the pixel-decoding decision and explicit
app-conversation/job scope are [proposed follow-ups](adr/ADR-0020-native-terminals.md#proposed-image-completion-work),
not capabilities of these endpoints. Active or uncertain references must not be evicted as a
quota workaround; deleting a copy cannot retract provider data.

## Launch

Project entry accepts an existing absolute directory, typed or chosen with **Browse…**, a
read-only, bounded host directory listing (`POST /api/v1/directories`: immediate folders only,
hidden ones on request, symbolic links shown with their destination, `.git` presence only as a
hint). Git classifies the listed directory itself: main or linked checkout, actual branch and
the locally recorded default branch; a linked worktree offers its verified main checkout. Adding
sends the shown checkout, repository and branch, and the host refuses when any changed. It
canonicalizes Git common metadata and remembers empty checkouts. Missing tmux is an empty inventory only
for a verified absent-server response; permission and malformed metadata failures
remain errors. No dummy session is created.

Profiles store a versioned executable and literal argv (32 arguments, 1 KiB each,
4 KiB total). Saving never runs a program. Presets are explicit editor choices.
A two-minute server-held preview binds checkout/index/common directory, branch,
HEAD, profile revision, absolute executable, environment digest and full launch
UUIDs. Confirmation records the batch and every checkout reservation atomically
before the first possible effect. It never switches an existing checkout.

Each item sequentially creates an inert placeholder, configures session lifetime,
session-local mouse reporting and remain-on-exit, stores/verifies its full marker and exact identities, then
issues one direct-argv respawn. `/usr/bin/env` guarantees a multi-argument tmux
invocation; trailing semicolons receive tmux-specific escaping. No implicit shell
or login files. Launch clients strip control/framework/Git override variables.
At execution, all old server/session environment names except fresh TMUX identity
are removed, then a narrow host environment is supplied: PATH, locale, home/user,
CLI configuration directories and SSH agent socket. API keys, OAuth tokens and
all proxy environment variables are omitted. Prepare CLI credential stores;
profiles requiring credential or proxy environment variables are unsupported
by this launch path. Explicit
absolute `ALTCLI_ENV` and loopback `ALTCLI_URL` references are retained, never the
controller bearer token. Launch records retain an environment digest, while tmux
retains the nonsecret launch settings in `pane_start_command`. Never put secrets
in profile arguments or these settings.

A session is named `<profile>-<branch>` (slugged), numbered `-2`, `-3`… when that name is live on
the server or held by an unsettled launch anywhere on the host; confirmation refuses a previewed
name taken since instead of renaming it. The name is never identity.

Successful siblings are retained. Generic startup, immediate exit and uncertain
steps keep reservations until exact inspection or an explicit human decision.
Startup is not readiness. Missing markers, server replacement and name reuse are
never adopted; current absence cannot prove no execution. Human reconciliation
records a note acknowledging possible prior/background effects. It never retries,
removes sessions, deletes worktrees or rewrites history. A new launch needs a new
preview. Mock launches are labelled simulated and appear in mock discovery.
Launch cards in Projects expose status and recovery, without embedded terminals.
Open the checkout in Console to view and control its discovered agents; startup
that has not exposed a supported agent yet remains inspectable in host tmux.
Scoped browser access to the exact startup launch is
[proposed, not implemented](adr/ADR-0021-project-entry-and-agent-launch.md#proposed-launch-completion-work);
the existing launch-ID target does not bypass unresolved launch reservations.

Live launched sessions are closed by **Finish branch** on a linked task worktree
([ADR-0013](adr/ADR-0013-confirmed-branch-setup.md#confirmed-closing-of-launched-sessions)):
`POST /api/v1/projects/worktrees/finish/preview`, `…/finish` (confirm), `…/finish/continue` (the
removal or discard step) and `…/finish/reconcile` (inspect, record a decision, or stop before the
Git step). Only sessions proven by server identity, session ID and full launch marker, wholly
inside the worktree, are closed, by session ID; survivors and uncertain results keep the owner.
A closed launch is retired from terminal and discovery targets and keeps its history.

For a recorded launch, `POST /api/v1/launches/{id}/cleanup/preview` captures
the original session's current evidence. `POST …/cleanup` requires that preview's
request ID and digest plus `confirmInspected: true`, acknowledging possible
background effects. A `live` preview additionally requires `confirmStop: true`,
acknowledging interruption. Only the original unshared single pane can be removed;
tmux rechecks its process PID for live closing or dead status for dead cleanup,
and refuses new windows/splits or a changed marker.
Verified absence can retire an already-killed session without touching a reused
name. The decision and launch reservation are durable before execution. Duplicates
return the recorded operation, and `POST …/inspect` verifies uncertain cleanup
without retrying removal. Conflicting owners are refused; a
keyboard targeting another pane keeps its existing barrier and checkpoints.
Cleanup hides retired cards while keeping their records. See the
[ADR-0021 cleanup extension](adr/ADR-0021-project-entry-and-agent-launch.md).

## Deployment acceptance

Use private tmux sockets and fixture repositories first. Check the actual remote
proxy's WebSocket upgrades and buffering, HTTP input latency under output load,
Safari/IME/touch behavior, disconnect/restart and installed CLI lifecycle evidence
before enabling the flags on a deployed host. Repository tests are not evidence
of a real coding agent or physical phone being accepted.
