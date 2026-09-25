# Native terminal protocol

Setup writes `ALTCLI_ENABLE_TERMINAL=true` and `ALTCLI_ENABLE_AGENT_LAUNCH=true`
into a new `web/.env.local`; a missing line means off. Change either only at a
settled host restart. Use the project
`npm run dev` / `npm run start` commands in `web/`; they run `server.ts`, a
loopback-only custom Next host. A plain `next start` cannot serve the terminal
upgrade route. The host never creates another ControlPlane or SQLite store:
Next's process singleton exposes a small gateway through `globalThis`.

## Connection and output

1. An explicit **Open terminal** action posts a target, dimensions and a page-memory
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
failure from a retired generation cannot stall or revoke the new keyboard.
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
pane and command and notes the navigation. The card's agent and the AltCLI control
target do not change, and the server-wide manual hold still covers every session.
A session reached by navigation keeps its own lifetime settings. If it uses
`destroy-unattached`, detaching the browser there (release, close or Lock) can
destroy it, just as a desktop client leaving it would.

**Take keyboard** requires explicit confirmation and creates a fresh writable
attachment. It participates in normal tmux sizing. There is one writer across the
configured server, and a durable manual barrier holds AltCLI dispatch, setup and
launch before claim. It does not stop an already computing worker or external
terminal clients. All current modern runs get whole-run input holds. Legacy runs
must settle or be deliberately taken over first.

Release stops admission and drains admitted input. **Release and record settled**
also performs fresh inventory, activity, background-work and checkpoint checks.
A failed check still releases the keyboard, retaining the barrier and reason.
Disconnect, Lock, expiry and restart always retain the barrier. Transfer/recovery
creates a new generation and preserves earlier evidence. No raw terminal bytes
are stored: only ownership, identities, affected commands, timestamps and counts.

Implementation actions in the control pane can combine a checked settled release
with a new Send, commit or review. This is available only for this browser's
connected agent terminal, one live manual session, and no affected run checkpoints.
The readiness checkbox confirms empty prompts and no background writers across
all host panes and names both the released keyboard and the control recipient.
The click stops local input and refuses pending input or paste. Its `releaseSettled`
request includes `expectedRevision` as well as `expectedGeneration`; input after
confirmation rejects the release. `expectedRevision` is optional for standalone
settled release and invalid for acquire or plain release. Strict reconciliation
must succeed before the new request is submitted through ordinary dispatch gates.
For a combined action, `handoffRequestId` binds settlement to the frozen command.
The returned manual session revision travels with that command as `keyboardSettlement`.
The server checks it at admission, before branch setup and immediately before
delivery. New native lifecycle observations, keyboard changes or a backend restart
invalidate it. Only the initial command uses this evidence; correlated successors
use their normal lifecycle gates. A duplicate command still returns its receipt.
There is no retry on an uncertain release; changed draft, target, activity or view cancels
the pending send and retains the draft. Other browsers, disconnected/unresolved
records and held runs retain their separate recovery actions.
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

After inspecting the host, **Record a human inspection decision…** provides a
separate recovery path, including when no agents remain or feature flags are off.
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
the reason shown. Ctrl+Shift+Escape moves focus to AltCLI control. Touch keys and
one-shot Ctrl/Alt modifiers send bytes only under a grant; modifiers clear on
blur, view change and revocation. The visual viewport refits for mobile keyboards
and rotation. Alternate-screen wheel-to-arrow translation is suppressed when
mouse reporting is off. OSC clipboard/title changes are consumed; HTTP(S) links
require explicit confirmation. Output is never controller instructions or HTML.

Each card's badge states one of: **Keyboard here**, **Disconnected**, **Controlled
in another browser**, **Keyboard in another terminal** (another card of this page),
**Manual CLI/shell** (the registered CLI process was replaced, for example it exited
to a shell), **Observing · manual input unresolved**, or **Observing**. The status
line shows the actual pane, foreground command and effective window size. If focus
moved elsewhere while a keyboard grant was pending, the terminal does not take
focus back; it reports **Keyboard ready for <name>** instead. With native terminals
enabled, Settings also shows the server-wide keyboard scope and the terminal limits.

The one AltCLI control pane has alternate placements, never a second composer:
- **Control below / Control beside:** on windows at least 1280 px wide, the pane
  can sit beside the terminal stage. The choice is remembered in this browser;
  narrower windows stack it below.
- **Open control drawer:** at phone widths, the same pane opens as a bottom
  drawer. Escape or **Close drawer** returns focus to the toggle.
- **Use <agent> in control pane:** each terminal card's shortcut changes only the
  control target, revokes readiness and focuses the pane. It sends nothing.

**Expand terminal** enlarges the existing surface in the page without opening a
new connection or changing keyboard ownership. **Focus AltCLI control** is a
visible alternative to Ctrl+Shift+Escape. A focus outline identifies the active
surface. Snapshot timestamps appear only alongside the captured-text fallback.
Multiline paste into a terminal without bracketed-paste support requires a
warning confirmation because newlines can execute immediately; paste above
16 KiB also requires confirmation. **Paste text** reads the clipboard only on
that explicit click, under the current keyboard grant. A delayed result is
discarded if focus, input, view or grant changed. Clipboard denial falls back to
the keyboard/system Paste action. Accepted text uses xterm's single paste path,
without an added Enter. No image attachment channel is enabled.

**Screen reader mode** enables xterm's accessible output tree explicitly. It
defaults off because xterm 6 disables its emoji/`insertText` fallback in that mode;
ordinary key events remain usable. Turn it off when a software keyboard cannot
enter text, or use Captured text for reading. This option does not establish
physical screen-reader or Safari/IME acceptance.

## Launch

Project entry accepts an existing absolute directory, canonicalizes Git common
metadata and remembers empty checkouts. Missing tmux is an empty inventory only
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

Successful siblings are retained. Generic startup, immediate exit and uncertain
steps keep reservations until exact inspection or an explicit human decision.
Startup is not readiness. Missing markers, server replacement and name reuse are
never adopted; current absence cannot prove no execution. Human reconciliation
records a note acknowledging possible prior/background effects. It never retries,
removes sessions, deletes worktrees or rewrites history. A new launch needs a new
preview. Mock launches are labelled simulated and appear in mock discovery.

## Deployment acceptance

Use private tmux sockets and fixture repositories first. Check the actual remote
proxy's WebSocket upgrades and buffering, HTTP input latency under output load,
Safari/IME/touch behavior, disconnect/restart and installed CLI lifecycle evidence
before enabling the flags on a deployed host. Repository tests are not evidence
of a real coding agent or physical phone being accepted.
