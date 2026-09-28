# Local setup

Use Node 24, tmux and Git 2.40 or newer on the same awake host as Codex and
Claude Code; project discovery reads `git worktree list --porcelain -z`, which
older Git rejects. Run one backend per store, as the user who owns the tmux
socket. Keep this clone available: installed hooks and skills point into its main
checkout. The installers resolve that checkout themselves and refuse to install
from a linked worktree, where `--check` still verifies the main installation, so a
disposable task worktree never owns the host's configuration.

## Install and start

The interactive-terminal dependencies are pinned in `web/package.json`.
Native browser input and session launching use the optional host flags described
[below](#optional-native-terminals-and-launch). Use Node 24
for both installation and execution; `better-sqlite3` is built for that Node ABI.
If a directory-specific shell configuration changes Node after `cd web`, run
`npm --prefix web …` from the repository root instead. After changing Node
versions, run `npm --prefix web rebuild better-sqlite3 node-pty`.

On supported Unix hosts the project postinstall step makes node-pty's packaged
`spawn-helper` executable. This fixes the macOS arm64 prebuild in node-pty 1.1.0;
it touches only that installed package's helper. Platforms without a compatible
prebuild require node-pty's native build toolchain. The recorded M0 checks cover
macOS arm64/Node 24; Linux native acceptance is still required.

From the repository root:

```bash
node scripts/setup.mjs
```

This installs the web dependencies, installs and checks the CLI hooks and skill
links, and creates `web/.env.local` with a private access token. An existing
`web/.env.local` is not overwritten. Hook changes preserve unrelated settings and
create private backups; skill links never replace real directories. Both installers
respect `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Unsupported hook configuration or
conflicting skill directories stop setup with a diagnostic; resolve it and rerun.
In a linked task worktree the same command installs that worktree's web
dependencies, verifies the main checkout's hook and skill installation instead of
reinstalling, and copies the main checkout's `web/.env.local` rather than minting a
token: the installed hook posts the main checkout's token, so a backend started
from the worktree must accept it. Run one backend per store at a time.

Restart the coding CLIs to load the hooks and skills. For the first checks, set
`ALTCLI_ENABLE_INPUT=false` in `web/.env.local`, then start the console:

```bash
cd web && npm run dev
```

Codex needs both the native `UserPromptSubmit` entry in `~/.codex/hooks.json`
(or `$CODEX_HOME/hooks.json`) and the `notify` command in `config.toml`.
For Codex 0.157+, launch it with `codex --no-daemon` inside tmux. The shared
background server is enabled by default in that version; its hooks do not inherit
the terminal's `TMUX`/`TMUX_PANE`, so AltCLI cannot attribute turns to that pane.
This affects prompts submitted directly in xterm as well as Control commands.
The Codex launch preset includes `--no-daemon`; add it to existing profiles under
Settings → Launch profiles, then let current work finish before relaunching. A profile
whose executable is `codex` (including an absolute path) without the flag is marked **needs
--no-daemon** in the saved-profile row, warned about in its editor, where **Add
--no-daemon** inserts it, and in the launch preview before any session starts.
A Codex adapter hint on a shell or wrapper instead shows manual verification
guidance. Check the command that actually starts Codex; AltCLI does not parse
the wrapper or offer to prepend a Codex option to its arguments.
Changing a profile does not change an already running session. A manual Reset
status does not repair missing hooks: its Ready observation remains until new
native evidence arrives. See the [Codex changelog](https://learn.chatgpt.com/docs/changelog)
for the background-server default and `--no-daemon` option (available since 0.156).
Both CLIs also install SessionStart for startup/resume, so fresh sessions can
report Ready before their first prompt. Trust the additional Codex SessionStart
hook through `/hooks`. Ready is a session observation, not task completion.
Codex also installs Interrupt with its native three-second timeout limit. It
reports the exact cancelled turn as Interrupted and pauses its relay; it never
certifies completion or background-process quiescence. Trust this hook through
`/hooks` after upgrading, along with the other AltCLI hooks.
Metadata-only hook delivery diagnostics live beside turn bindings as `*.status`
files under `~/.local/share/altcli/hook-turns/`; they contain no prompt,
response, token or raw error text.
Native hooks must be enabled (`features.hooks`, enabled by default in Codex
0.155.1). To update only hook installation, run `node scripts/install-hooks.mjs`
from the main checkout while the CLIs are idle, then restart Codex and use `/hooks` to review and trust
the AltCLI UserPromptSubmit, SessionStart and Interrupt hooks before the next command. Codex skips new or
changed native hooks until trusted; see [hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
A turn that
started without this native binding cannot be completed by searching notification
history; reconcile any old owned run through Pause and Take control in Control access.

Open http://127.0.0.1:8787 and enter the token from `web/.env.local`. Verify pane
captures before setting `ALTCLI_ENABLE_INPUT=true` and restarting the backend.
After configuration or server-code changes, settle active deliveries before
restarting; hot reload retains the running controller.

The **Settings** tab shows the configuration in effect and the variable behind each
value: `ALTCLI_TMUX_BIN` (default `tmux`, resolved through PATH; the tab shows
where), `ALTCLI_TMUX_SOCKET`, `ALTCLI_DATA_DIR` (default
`~/.local/share/altcli`, with the adapter mode appended), the task worktree root
`~/.altcli/<repo>/<branch>`, `ALTCLI_INTEGRATION_BRANCHES` (default
`main,master`; each project's detected default branch is always added),
`ALTCLI_ADAPTER`, `ALTCLI_ENABLE_INPUT`, `ALTCLI_ENABLE_LEGACY_RELAY`,
`ALTCLI_ALLOWED_ORIGINS`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. They are read
once at start; edit `web/.env.local` (or the shell) and restart the host to change
one. The tab never shows the access token.

## Select a project, worktree and group

Start a coding CLI in tmux inside your repository. AltCLI discovers its local
project through Git's shared metadata directory and lists all its worktrees,
including those without agents. Linked worktrees in other folders stay in the
same project; separate clones stay separate even with identical origin URLs.
Projects used by an explicit name/membership edit, Start or creation are remembered
after restart. Merely browsing is read-only and retains discoveries only for the
current backend process. Prepare dependencies and agent sessions yourself;
AltCLI does not clone repositories, move agents or configure environments.

In **Projects**, select a project. Worktrees fill one column with the main checkout
first. Click a worktree heading to expand or collapse its controls; each starts
collapsed and keeps your choice when you Recheck. Choose **Open console** inside
the worktree to open its console.
**Create task worktree** sits beside the Worktrees heading; its form opens below
that row, above the worktree list.
Each worktree card has its own **Agents & group** disclosure for names and
members, whichever worktree Console shows. Start agents in the worktree's root
directory: a pane in a subdirectory is listed under panes not in a discovered
workspace instead.
Selection is shown by its border/background, not a separate Selected button.

Console's **Project** and **Worktree** dropdowns switch the current view directly.
Switching projects opens the first worktree with a live coding agent (main checkout
first when it has one). Projects without agents remain listed as disabled
**no agents** options. Worktrees without agents can still be viewed using the
Worktree dropdown. Switching preserves each task group's drafts, clears readiness,
and leaves running work in progress.

Every eligible agent has a checkbox; all are included initially. One selected
agent is a solo group, two a pair, and three or more a larger group. Checkbox
changes save immediately. Larger groups can be selected, but Plan/Implementation
execution currently supports only one or two members and displays that limit.
There is no Register, Create group or Use group step. The **Name** column defaults
to the agent label; edit it inline and press Enter or leave the field to save,
or Escape to cancel. Names do not change tmux sessions or historical runs.
Discovery and opening a card are read-only; exact instance bindings are checked
internally and persisted only on an explicit edit or Start.
All selected members must run in the worktree's root
directory and share its Git worktree/index. Separate linked
worktrees can run independent tasks concurrently; shared databases, ports and
other environment resources remain your responsibility.

### Create a task worktree

Choose **Create task worktree**, select a starting checkout, and enter a new
branch name. **Preview worktree** displays the exact committed baseline and
destination, defaulting to `~/.altcli/<repo-name>/<branch-name>`. Branch slashes
become nested directories; same-named separate clones get distinct namespaces.
Confirm the displayed details, then choose **Create confirmed worktree**. Existing
branches, paths and symlinked destination components are refused rather than
overwritten. Host read-only mode disables creation.

The source checkout is not switched. It may be dirty: staged, unstaged, untracked,
ignored and environment files stay there and are not copied into the clean new
worktree. Start coding CLIs in the new directory and Recheck; collaborators must
use the same directory. Creating a worktree neither starts Plan/Implementation
nor installs dependencies or copies secrets. Empty and finished worktrees remain
visible; completion never deletes or merges them automatically.

If creation is uncertain, inspect the destination and branch, then use **Inspect
creation result**. It verifies an exact clean result or verified absence; partial
results retain the project setup hold for human reconciliation. No Git command is
retried and nothing is rolled back or deleted automatically. A failed operation
may leave empty parent directories.

When a task is finished, each linked task worktree offers three confirmed
actions. Idle panes do not block squash; a disabled button shows its reason.
Choose a through-commit SHA to integrate a prefix, with one edited commit message
per batch; leave it empty to integrate the remainder after the last recorded batch.
**Squash into main** shows the exact squash commit that would land on
local main/default (in the checkout that has it checked out, which must be clean
and free of runs), with the commits involved and an editable message; confirm to
perform it under the repository's normal hook policy. **Check removal** verifies
integration and removes the clean, unused directory while keeping the branch.
**Discard…** deletes the directory and the branch without integration evidence:
it lists the commits and uncommitted changes that would be lost, archives the
handoff journal first, and requires typing the branch name. Check removal and
Discard stay clickable while agents, runs or deliveries occupy the worktree: a
hint names the occupant, and clicking shows the server's exact refusal (a pane
inside the checkout, modified files, missing integration evidence, or installed
CLI hooks or skill links that still point into the worktree; reinstall them from
the main checkout first). Only a
read-only host, a request in flight or unreadable state disables them. All three
record a durable result; an uncertain one is inspected, never retried.

To reuse a prepared task worktree instead of removing it, use **Update from main**
on a clean checkout. It moves the branch onto local main/default in place,
keeping the directory, ignored files such as dependencies, and the agents. A
branch main already contains moves to main. Commits after the last squash batch,
or all commits when nothing is integrated, are replayed on top. The preview lists
them and refuses conflicts. A rewritten branch keeps its old tip under
`refs/altcli/preserved/`, which you delete yourself when no longer needed; give
agents fresh instructions afterwards. **Rename…** renames the task branch in place,
uncommitted work included. Both refuse published branches, since the app never
pushes, and need idle agents in the worktree.

Dirty or unavailable workspaces remain readable, but Plan and Implementation
starts are disabled until the index and nonignored worktree are clean. The console
lists staged, unstaged and untracked files. Commit intended changes on your task
branch, then **Recheck** and confirm readiness again. Creating a branch alone does
not clean the checkout. To review that work after committing, choose a **Review
baseline** and use **Relay [peer]**. To review an uncommitted quick fix instead,
use Stage relay on `main` or the default branch. Keep unrelated changes separate or
create another clean task worktree.
AltCLI never automatically stages, commits, combines, stashes or discards them.

Before Start, check all agents
sharing the checkout, including unselected agents: prompts must be empty, with no
permission dialogs or background writers. Confirm readiness explicitly. Selecting
a workspace never starts or redirects a run. Renaming and saved
membership changes are blocked while a run owns the checkout.

## 1 · Plan

No ignore rule is needed. Drafts and the shared plan are written to
`<data directory>/plans/<run-ID>/` (by default
`~/.local/share/altcli/<mode>/plans/`), beside the assignment and result files,
so planning never writes into the checkout. Planners need write access there just
as they already do for their result files.

Choose **1 · Plan**, enter the shared brief, and choose the implementation roles.
The same workspace group participates in both phases. The collapsible **Collaboration
settings** panel holds the optional tracked relay log, **Automatic collaboration**, the automatic turn budget,
**Pause on a reviewer objection** (off by default) and **Require my approval before
implementation**; these are independent controls, and approval is required by default.
Branch consent can be supplied now or at the checkpoint. Planning never changes
branches or project code.

One or two planners draft independently, one at a time. Peer drafts are withheld
until all drafts are finalized, then the group refines one shared plan. Solo work
produces a plan-ready result, not independent agreement.

At the checkpoint, inspect the captured plan and endorsements, then approve,
request changes or stop. Changes invalidate earlier endorsements; proceeding
despite disagreement requires an override reason. Waiving approval does not enable
automation or grant branch consent. The final plan and authorization are retained
for Implementation, and the automatic-turn budget carries across both phases.

Planning uses the `plan-handoff` skill and a correlated result file. Its output
restrictions are cooperative, not a native CLI sandbox. Unsupported permissions
or uncertain completion pause the run rather than grant broader write access.

## 2 · Implementation

Choose **2 · Implementation** to start coding directly, or enter it from Plan.
Choose solo work, peer collaboration, or fixed worker/reviewer roles. Confirm the
displayed branch and commit. On a task branch, continue there and confirm its
recorded baseline when it cannot be inferred; on the default branch or a configured
integration branch (`ALTCLI_INTEGRATION_BRANCHES`, default `main,master`, plus
the local `origin/HEAD`) only a new task branch or task worktree is offered, and
the server refuses anything else; detached HEAD requires a new named branch. Branch
creation occurs at a settled boundary, with clean entry or captured initial changes, separately from Plan approval.
Integrate accepted results yourself, preferably by squash merge or pull request.
AltCLI never switches to an existing branch, stages, commits, stashes or resets
your work.

The assigned agent uses `commit-handoff` to publish one result per completed turn
to AltCLI's handoff journal, plus one commit when it changed project content;
report-only turns commit nothing. Each agent card under its pane holds that
agent's actions. **Send** performs one standalone instruction without an automatic
commit, branch change, or relay; its **After send** choice can instead ask the agent
to publish its result as one handoff commit (**Send & commit**) and, in a pair, to have
the peer review exactly that commit (**Send & commit → relay**).
With a relay follow-up, **Relay note for [peer]** carries your note to the reviewer.
Leave the instruction empty on a dirty checkout and the button becomes **Commit
current changes [agent]**: it snapshots all staged, unstaged and nonignored
untracked changes as they stand, then stops, without finishing pending requests;
with the relay follow-up it becomes **Commit current changes & relay [peer]**.
**Relay [peer]** reviews every commit after the selected
**Review baseline**: the earliest candidate (default) is the newest commit on this
branch at which the journal records a completed turn of the recipient's, or the
task baseline when it records none; the latest is the last commit only; **Another commit…** previews a typed
baseline before sending. On a dirty checkout, the button becomes **Commit current
changes & relay [peer]**: the selected worker snapshots the current changes,
and the controller sends the selected baseline through the new snapshot for review
after validating its commit and settled completion. The baseline selector remains
available; current HEAD selects only the current changes. No instruction text is
required for this action; readiness and active-run gates still apply. Clean
checkout review requires project changes in the selected range.
Send and Commit name the worker whose card they sit in; Relay sits in the
receiving peer's or designated reviewer's own card.
The collapsible **Collaboration settings** panel, under **Settings** in the
settings bar above the panes, holds the agreement for
subsequent turns: automatic collaboration, the turn budget, and whether a reviewer
objection pauses for you (by default it is routed straight back to the author).
It also offers **Also track the journal in the repository**: an explicit project
preference that mirrors every journal entry into a tracked, nonignored JSON-lines
file (default `RELAY-LOG.jsonl`) inside each handoff commit, so report-only turns
commit too. Otherwise use **Next turn**.
A completed chain still needs final task-level verification.

The handoff journal (turns, reviewed ranges, findings, reported checks, archived
handoff patches) is AltCLI data under the controller data directory, not part
of the repository. **Export history** in Command history downloads the current
worktree's runs, turns and journal as JSON; keep such exports with your backups,
because cloning the repository cannot recover them. Removing a task worktree in
Projects archives any handoff commit the journal has not archived yet before the
checkout is deleted. Promote enduring knowledge into the repository's own
documents as part of finishing a task.

## Pause and recovery

Unknown completion, background work or changed agent identity pauses the run.
An Implementation run paused only at its completion/background gate offers
**Recheck and relay** after inspection. It requires current correlated clear
evidence and revalidates the publication and checkout; refreshing the page never
resumes it. See [the handoff recovery rules](WORKFLOWS.md#a-published-handoff-waiting-for-completion).
Inspect the agents, then use **Take control…** in **Control access** (one confirmation) before manual intervention; **Pause the controller** there only stops scheduling.
Pause prevents further scheduling but does not interrupt workers or retract input;
explicit takeover releases ownership after inspection. Never send a replacement
command just because an HTTP response failed.

A backend restart pauses owned runs without replay. Closing or locking a browser
does not pause them. Resolve outstanding work before starting another run.

## Stage relay on main

The supervised two-agent staging flow runs as **Stage relay** on `main` or the
recorded default branch, and nowhere else. Implementation's Control offers it by
default there, beside **Commit relay**. It needs no Settings preference, and it is
on unless `web/.env.local` sets `ALTCLI_ENABLE_LEGACY_RELAY=false`. Older templates
wrote that line; remove it or set it to `true`, then restart after active
deliveries settle. The run is bound to the branch and commit shown at start and
pauses if either changes. Its `relay` instruction rule and staging contract are
documented in [SKILLS.md](SKILLS.md#mapping-relay-to-the-skill). This option does
not change Plan or committed Implementation, which stay on task branches.

## Verify before regular use

Follow [TESTING.md](TESTING.md), then exercise Plan and Implementation with real
Codex/Claude sessions in a disposable repository. Check wrong-pane/shell/copy-mode
refusal, Unicode input, duplicate requests, stale hooks, background activity,
approval and branch consent, two browsers, pause and restart. Record actual CLI
versions, commit and results in [VALIDATION.md](../VALIDATION.md); mock tests do not
establish installed-agent compatibility.

Use [TAILSCALE.md](TAILSCALE.md) for private remote access. Never expose a development
server publicly. See [WORKFLOWS.md](WORKFLOWS.md) for behavior and
[ROADMAP.md](../ROADMAP.md) for remaining capabilities and acceptance work.

## Optional native terminals and launch

`node scripts/setup.mjs` writes `ALTCLI_ENABLE_TERMINAL=true` and
`ALTCLI_ENABLE_AGENT_LAUNCH=true` into a new `web/.env.local`. A missing line means
false, so an older file needs both lines added before those features appear.
Change either only at a settled boundary;
`ALTCLI_ENABLE_INPUT=false` still prevents keyboard grants, launch, project and
profile writes. Use `npm run dev` / `npm run start` in `web/` (the custom loopback
host), not bare Next commands. Install dependencies through the normal project
setup on the intended Node runtime; node-pty is loaded only for real attachments.

Prepare CLI credential stores, dependencies and hooks yourself. Launch omits API
keys, OAuth tokens and proxy environment variables to keep them out of tmux's
retained argv. Profiles requiring those environment variables are unsupported.
Agents you already run in tmux inside a checkout need none of this; they are
discovered as described in [Select a project, worktree and group](#select-a-project-worktree-and-group).
To launch agents from AltCLI:

1. In **Projects**, enter the absolute path of the repository's main checkout under
   **Main/default starting checkout** (or choose **Browse…**, open the folder and
   **Select this directory**), check the branch shown, and choose **Add project**.
2. In **Settings → Console preferences → Launch profiles**, choose **New ▾** and then
   **Claude preset**, **Codex preset** or **Other**. The preset fills the label, the executable
   name and the adapter hint. Add literal arguments with **Add argument**, keep
   **Enabled** checked, and choose **Save profile**. The executable is a name found
   on PATH or an absolute path; there is no shell parsing, and saving runs nothing.
3. In **Projects**, choose **Launch agents…** on the checkout's card (empty/new
   worktrees included; **Create task worktree** can open it for the new one).
   **Add agent** adds one profile selector for one session. Add another agent for
   each additional CLI (up to six); **Remove agent** removes that entry.
4. **Preview launch** lists each session name (`<profile>-<branch>`, numbered `-2`, `-3`…
   when taken), the
   literal executable and arguments and the commit. Resolve any listed blocker,
   then confirm with **Launch N sessions** before the two-minute preview expires.
5. Each launch card uses the agent's saved display name, with its original tmux
   session name shown separately after a rename, and shows status and recovery actions. **Refresh launch status**
   checks the recorded process and shows its result and check time beside the
   button, including unchanged results. This does not establish agent activity
   or readiness. An unresolved launch also offers
   **Reconcile after host inspection…**. Nothing is retried.
6. Choose **Open console** in the expanded worktree. Discovered agents appear there with their
   terminal views; the ticked agents form the group (use **Recheck** if one is
   missing). Use the ⌨️ **Claim keyboard** tool at the agent's terminal and confirm the displayed owner/transfer warning to
   answer prompts. If startup has not exposed a supported agent yet, inspect its
   tmux session on the host. Startup is not readiness.

Use **Clean up…** on a launch card when its tmux pane is dead, its recorded
session has already been killed, or you want to stop its agent. Preview the exact session, acknowledge possible
background processes, then choose **Remove dead session** or **Remove launch card**.
For a running session, acknowledge the interruption and choose **Close agent**.
Cleanup retains history and never targets a replacement session with the same name.
If the result is uncertain, use **Refresh launch status**; it checks the
original session without repeating removal. Shared windows or extra panes need
Finish branch or host inspection. A keyboard on another pane may remain active;
its reconciliation barrier is kept.

Before enabling on a deployed host, follow [TERMINAL-PROTOCOL](TERMINAL-PROTOCOL.md)
and the private-fixture tests, then supervised installed-CLI acceptance. Never
restart the active controller during delivery to adopt server changes.
