# Local setup and real tmux sessions

[TESTING.md](TESTING.md) is the ordered path from a fresh clone to here; run its
automated checks, mock walkthrough, and `cat`-pane dry run before section 2.

## 1. Validate the mock starter first

```bash
cd codercrew
nvm use
node scripts/setup.mjs
npm --prefix web ci
node scripts/install-skills.mjs
./scripts/check.sh
cd web && npm run dev
```

Visit `http://127.0.0.1:8787`. Enter the generated token from `web/.env.local`.
The mock panels are clearly labeled; they never perform real reviews. The setup
script creates no tmux sessions and installs no skill; `node scripts/install-skills.mjs`
links the relay skill into the CLIs' skill directories separately.

`web/package-lock.json` is committed and CI uses `npm ci`; prefer
`npm --prefix web ci` for clean installs. If a dependency version cannot be
resolved, choose compatible installed versions deliberately and record the change
in ADR-0002. Do not
ignore an installation failure. On macOS, a native better-sqlite3 build may require
Xcode Command Line Tools.

## 2. Prepare the host

CoderCrew and tmux must run on the same host and under the same Unix user. Start
with an awake macOS or Linux development machine. This starter does not support
Windows without an appropriate Linux environment, remote tmux hosts, or a web
backend hosted in a cloud/serverless environment.

Check tmux on the host:

```bash
tmux -V
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}  #{pane_id}  #{pane_current_command}  #{pane_current_path}'
```

Use existing sessions. If you need to create two deliberately, these are manual
examples, not commands CoderCrew runs for you:

```bash
# Run in separate desktop terminals. Replace the repository path.
tmux new-session -s codercrew-codex -c /absolute/path/to/project 'exec codex'
tmux new-session -s codercrew-claude -c /absolute/path/to/project 'exec claude'
```

`exec` avoids leaving an interactive shell behind when the agent exits. It does
not make terminal input atomic or prove an agent is ready. Do not use `-d` to detach
another person's client, enable synchronized panes, or run two writing turns on
one shared worktree. These launch examples assume the CLIs are already installed
and authenticated; CoderCrew does not manage those accounts.

## 3. Register panes from the console

tmux is the default adapter, so `web/.env.local` needs no change for a normal
setup. For a cautious first pass you can add `CODERCREW_ENABLE_INPUT=false` to make
the console read-only (captures only) and remove it later. Set `CODERCREW_TMUX_BIN`
only if tmux is absent from the backend's PATH; use an absolute binary path, not a
shell fragment. If you use a non-default tmux server, set its absolute socket path
in `CODERCREW_TMUX_SOCKET`. Restart the server after editing the file.

Start the server (`cd web && npm run dev`) and unlock the console. With nothing
registered, the add-pane panel is the page; later, **+ Add pane** opens it, locked
to the current project (press **Change** to add to another repository). Step 1
lists every pane on the tmux server as `session:window.pane · pane ID · process ·
directory`; panes already registered, running a shell, or outside the project say
so instead of offering **Select**. With no project chosen yet, the first pane you
select fixes it, or pick a repository from the **Project** menu. Selecting a pane
reveals step 2: a read-only preview of its last lines
so similar panes can be told apart, a label (its slug becomes the agent id shown in
history, e.g. `Claude Code` -> `claude-code`; reusing an existing label re-points
that registration, and the form says so), the suggested agent type, and, under
*Advanced*, the repository root (the project's, shared by every pane registered
into it) and the relay prompt. Press **Register pane**. Repeat for the second agent;
the panel stays open until the project has two.

Sessions registered with the same repository root form one **project**. The console
shows one tab per project when there is more than one, and each project reserves its
own hold: a relay in one worktree does not block instructions in another.
The **Relay pairs** strip appears once a project has two sessions; **+ New pair**
asks only for a name when there are exactly two. The server refuses a pair whose
sessions do not share the root. A pair groups and validates only; it never sends
input or advances a turn. **Show** narrows the view to its two panels.

Registration records the pane ID and PID, tmux server PID and start time, socket,
the **process name observed at that moment**, agent type, repository, and relay
prompt. It does not send input or stage files. Two labels cannot share a pane;
registering an existing label again re-points it at the new pane. Registration,
removal, and pair changes are refused while a worktree has a command in flight or
an unacknowledged uncertain delivery. A paired session cannot be removed or moved to another
repository until its pair is removed. Use **Remove** on a panel to forget a pane;
the agent keeps running.

The composer has three ways to send. **Send** is a conversation with the selected
agent: no outcome line is expected, and nothing is relayed when it finishes, even
with auto-relay on. **Send & relay** delivers the same text as work whose result is
the next thing to review: when the agent finishes, the console relays to the partner
by itself, whether auto-relay is on or not (unless the partner may still be working
or you are typing, in which case it only moves the target and says why). **Relay**
sends the registered relay prompt, the literal word `relay` by default; text in the
box turns it into `relay: <text>`, a relay with context. The auto-relay checkbox
only decides whether a chain keeps going on later `accept_and_improve` outcomes.
Where that shorthand is not established, set the relay prompt to something like
`Use the review-handoff skill to review the incoming handoff. Follow its baseline and staging rules.`
That prompt still requires the skill to be discoverable by the target CLI. See
[SKILLS.md](SKILLS.md). Registration does not install anything into the target repo.

## 4. Verify read-only behavior

Unlock the console. Compare each output panel with its actual desktop terminal.
Confirm labels, pane IDs, repository paths, timestamps, and clearly disabled input.

The adapter requires the pane's foreground process name to equal the name it
observed at registration. tmux reports the kernel's short process name: the Codex
cask binary reports `codex`, while the native Claude Code install is a symlink to a
version-named binary and reports its version, for example `2.1.272`. That is
expected; the picker shows it. A pane that reports a shell or generic interpreter
(`zsh`, `bash`, `node`, `python3`, ...) cannot be registered, and a registered pane
that later shows one is refused until you re-register. An npm-installed CLI that
reports `node` is refused on purpose; use the native binary. After restarting or
updating a CLI, re-register its pane.

A capture also refuses stale identity, dead panes, copy mode, synchronized input,
or a directory outside the registered repository. Foreground child tools can cause
a temporary unavailable panel; that is not proof the session died. Avoid changing
pane metadata or respawning the target while a command is being sent.

## 5. The first supervised input

Only after the earlier checks pass (and, if you ran read-only, after removing
`CODERCREW_ENABLE_INPUT=false` and restarting). Confirm on the desktop that the
selected CLI is at an **empty input prompt**, not a permission dialog, and that no
other writing turn or write-capable background work is active. Send an innocuous
instruction first, such as `Reply only READY without using tools or changing files.`

CoderCrew types the text, waits 300 ms, re-checks the pane, then presses Enter:
Codex treats a fast burst of characters as a paste and would otherwise turn the
Enter into a newline inside its composer. If a CLI ever shows your instruction
with an extra empty line and nothing submitted, press Enter in that terminal once.

A `delivered` record means the terminal transport accepted input, not that the
agent complied or completed work. Read the pane; the readiness box you tick before
the next send is your confirmation that the agent finished and is at an empty
prompt. Only an `uncertain` delivery (transport failure after typing began, or a
backend restart mid-send) holds the worktree until you press **I checked the
terminal** in the console, after fixing anything half-typed. Nothing is resent.

Then validate `relay` with a controlled change and your original skill installed.
The controller itself never stages, commits, cleans, resets, or edits the worktree.

## 6. Let the CLIs report when a turn ends

Both CLIs can tell CoderCrew when a turn finishes, from their own lifecycle, not
from screen text: Claude Code through a `Stop` hook, Codex through its `notify`
command. One script serves both, `hooks/codercrew-turn-complete.sh`; it posts the
pane's exact tmux identity (`$TMUX_PANE`, `$TMUX`) to the local console, exits 0
always, and does nothing outside tmux.

```bash
node scripts/install-hooks.mjs          # merges into ~/.claude/settings.json and ~/.codex/config.toml
node scripts/install-hooks.mjs --check  # verifies both
```

Codex allows one `notify` command; if you already have one (for example the Codex
Computer Use client) the installer keeps it and chains it after CoderCrew's hook
with the same JSON. Restart each CLI afterwards; hooks are read at startup. If a
restart changes a pane, re-register it.

The skill ends every review with one literal line, `RELAY-OUTCOME: <outcome> —
<one sentence>`, and the hook reads that line from the CLI's own record of its
final message (Codex's `last-assistant-message`, Claude Code's transcript), never
from the screen. The panel then shows the outcome and the sentence: **ACCEPTED +
IMPROVED**, **ACCEPTED, NOTHING TO HAND OFF**, **OBJECTION — reason**, or **NO
INCOMING HANDOFF**. An objection moves the target back to the author with an
instruction prefilled ("… rejected your handoff: reason. Address it, then hand off
again") for you to review and send; a completed chain stays put and says so; a
missing line is reported as such and never guessed. Claude Code can end a turn
before its transcript has the final entry; the panel then reads *reading its
RELAY-OUTCOME line…* for a moment while a detached helper waits for it, and the
console holds the hand-off (auto-relay waits too) rather than guessing. You can
take over at any time; after 45 s without a line it reports that and stops.
A turn is credited to a console command only when the prompt the CLI recorded
equals that command's text. Text left in a pane's input line changes what the CLI
receives (a stray `xxx` makes `relay` arrive as `xxxrelay`); the pane then shows
*answered a different prompt*, the command stays open, and nothing is handed off.
Clear the input line, or type the command in the terminal yourself, and take over.

**Auto-relay** is a checkbox in the composer, on by default. When a reviewer
reports `accept_and_improve`, the console sends `relay` to the other agent without
a click, counting the turn. On anything else it does not continue, and says why:
an objection, a completed chain, nothing to review, a missing outcome line, a
partner that may still be working, a send that was not `delivered`, a held
worktree, a stale connection, or 20 automatic turns in a row. The box stays
ticked through all of that; only you change it, and an untick is remembered by
the browser. The first turn of a chain is always yours, and each send of yours
starts a new chain.

What you get: each panel shows **IDLE · turn ended HH:MM:SS** or **WORKING ·
since HH:MM:SS** (only once that CLI's hook has reported at least once, so a host
without hooks is never called "working" forever); when the target's hook reports
that a command sent to it has finished, the composer moves to its relay partner:
the other session when the project has exactly two, otherwise the one its pair
names; and the readiness box is pre-ticked unless the console has a reason to
think the target is busy, that is, something was sent to it from here and its own
hook has not reported a turn end since. It stays a suggestion, and the label says
which case applies: untick it if the terminal shows a permission prompt or a
half-typed line. The console never presses Relay for you. An event from an unregistered
pane is shown as a notice, which is how you notice a stale registration.

## Manual acceptance checklist

- [ ] Every registered panel matches its real desktop pane, including Unicode output.
- [ ] Wrong or missing access tokens cannot read output or issue commands.
- [ ] A command reaches only the selected agent, once.
- [ ] Typing quotes, backslashes, semicolons, Unicode, and `$()` is literal input,
      not host-shell or tmux command parsing. Test with harmless text only.
- [ ] A stale pane identity or returned shell refuses input, and a shell pane cannot be registered.
- [ ] Registering, re-registering, and removing a pane never sends input, and both are refused while that worktree's turn is reserved.
- [ ] A pair is refused for sessions on different repositories; a paired session cannot be removed until the pair is.
- [ ] A reserved turn in one project leaves another project's composer available.
- [ ] After `node scripts/install-hooks.mjs` and a CLI restart, finishing a turn flips the panel to IDLE and moves the target to the other agent.
- [ ] A review ending in `RELAY-OUTCOME: strong_objection — …` shows the reason on the panel and prefills the instruction to the author; auto-relay does not continue and stays ticked.
- [ ] An uncertain delivery blocks further sends and registration changes in that worktree until acknowledged; a clean delivery does not.
- [ ] Copy mode, synchronized input, unexpected cwd, and unavailable tmux fail closed.
- [ ] Reusing a request ID never delivers the same command a second time.
- [ ] An interrupted delivery remains uncertain and is never replayed automatically.
- [ ] Reloading the browser does not stop agents or resend the last command.
- [ ] Restarting the backend retains registrations, audit records, and unresolved ownership.
- [ ] Existing desktop terminals remain usable; all manual intervention is reconciled.
- [ ] The actual `review-handoff` skill stages only accepted incoming changes and
      leaves the current reviewer's improvements unstaged.

## Recovery

If delivery is uncertain, inspect the desktop terminal for partial text, a changed
foreground process, a waiting permission dialog, or an already-submitted command.
Do not issue another command with a new ID merely because the first HTTP request
failed. Do not delete the database to conceal the uncertainty. Reconcile in the
terminal, then press **I checked the terminal** in the console. Read-only mode
still allows that acknowledgement.

Restarting or recreating tmux, or restarting a CLI, invalidates registered
identities; re-register from the console only after reconciling outstanding work
and acknowledging any uncertain delivery. Keep one backend process per data directory. Clustered
deployments are not supported. Desktop writes and external background work are
outside the hold.

When local verification is complete, use a production build before configuring
[Tailscale access](TAILSCALE.md). Host availability and CLI permissions remain your
responsibility; CoderCrew does not restart or supervise the agents yet.
