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

A keyboard writer is a full tmux client, so it may deliberately navigate to another
session. The attachment then follows: the status line shows the actual session,
pane and command and notes the navigation. The card's agent and the Control
target do not change, and the server-wide manual hold still covers every session.
A session reached by navigation keeps its own lifetime settings. If it uses
`destroy-unattached`, detaching the browser there (release, close or Lock) can
destroy it, just as a desktop client leaving it would.

The ⌨️ status reports the active input connection count and shared automation hold. There is
no exclusive keyboard owner. Each connected terminal offers an input field, including captured-only
observation. The first trusted key, IME commit, paste, soft key or mouse-protocol event requests
`acquire` with an idempotent request ID, exact observer generation and `expectedBootId`.
Focus, copy/selection, history scrolling and terminal-generated replies never acquire input.
The pre-grant textarea preserves human intent separately from xterm's mixed `onData` stream.
Pending intents are bounded at 256 KiB and 2,048 events and tied to the connection and view. After both the
matching HTTP response and socket writer frame, queued keys/paste use public xterm APIs and the
new generation's parsed modes. Native attachments advertise the per-client `sync` capability;
the broker waits for the first synchronized redraw's end before the writer frame (five-second
limit). This changes no tmux sizing or global option. The byte boundary follows
[tmux 3.5a’s synchronized-output implementation](https://github.com/tmux/tmux/blob/3.5a/tty.c#L1569);
xterm 6 supports those sequences. Response/frame order is immaterial; reset alone is insufficient.
Cancellation, changed view/focus, disconnect or uncertainty drops unsent intents and retains
any already created manual barrier. No input is replayed into a replacement generation.

Writers may coexist in this or another browser, even on one pane. Native tmux interleaving and
size negotiation still apply. Each connection has one attachment, replaced on promotion or stop;
no extra persistent service is created. The first writer durably records the all-pane snapshot
and whole-run holds before input. Later writers join the same healthy period without overwriting
original checkpoints, snapshots or aggregate byte evidence. Acquisition remains serialized with
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

Checked Implementation Send/commit/review can stop all writers in this page when there is one
healthy period, no affected run checkpoints, and no remote writer. It freezes every local queue
before sending one batch; pending input/paste refuses the action. `confirmReady: true` requires
exact aggregate and writer revisions, so bytes admitted after confirmation refuse settlement.
Strict inventory/activity/background-work/checkpoint checks must succeed before ordinary dispatch.
A failed check still stops those writers and retains the barrier and reason. The `handoffRequestId`
binds successful settlement to the exact frozen command; `keyboardSettlement` carries the returned
period ID/revision through admission, branch setup and delivery checks. New activity, keyboard
changes or restart invalidate it. A changed draft, target, activity or view cancels dispatch and
preserves the draft; an uncertain response is never retried. Other browsers and held runs require
their separate stop/recovery actions. Reconciliation never continues a run.

Schema 18 migrates each legacy period independently, preserving its original IDs, snapshots,
run references, revisions and byte evidence, with no surviving live grant. Unresolved records
remain barriers until explicitly reconciled. The original singleton fields are archival metadata;
`writers` is current authority, `live` is their aggregate and `recoveryRequired` prevents new joins.
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
The browser separates terminal view, DOM focus, AltCLI command recipient and
keyboard grant. Control-pane drafts, including the Plan brief, stay editable while
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

Each card's badge is a compact emoji whose accessible name is one of: **Typing enabled** ⌨️,
**Disconnected** 🔌, **Manual CLI/shell** ⚠️ (the registered CLI process was replaced,
for example it exited to a shell), **Observing · manual input unresolved** or **held** ⚠️, or
**Observing** 👁️. Help text (on hover, keyboard focus and tap) says what it means and what to do;
actionable failures stay visible in the status line. The page's connection indicator works the
same way (🟢 Connected, 🔴 Not current, ⏳ Connecting); it is not agent activity or readiness. The status
line shows the actual pane, foreground command and effective window size. If focus
moved elsewhere while a keyboard grant was pending, the terminal does not take
focus back; it discards unsent first input and reports the cancellation. With native terminals
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
**Screen reader mode** ♿ and **Paste text** 📋. **Expand terminal** enlarges the
existing surface in the page without opening a new connection or changing keyboard ownership.
The former visible focus-escape button is gone (September 25 decision); the shortcut and its
on-focus hint remain. A focus outline identifies the active surface. Snapshot timestamps appear only alongside the captured-text fallback.
Multiline paste into a terminal without bracketed-paste support requires a
warning confirmation because newlines can execute immediately; paste above
16 KiB also requires confirmation. **Paste text** reads the clipboard only on
that explicit click. A first paste enables input; multiline/large first paste asks before admission. A delayed result is
discarded if focus, input, view or grant changed. Clipboard denial falls back to
the keyboard/system Paste action. Accepted text uses xterm's single paste path,
without an added Enter. No image attachment channel is enabled.

**Screen reader mode** enables xterm's accessible output tree explicitly. It
defaults off because xterm 6 disables its emoji/`insertText` fallback in that mode;
ordinary key events remain usable. Turn it off when a software keyboard cannot
enter text, or use Captured text for reading. This option does not establish
physical screen-reader or Safari/IME acceptance.

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
