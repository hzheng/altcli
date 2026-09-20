# Local setup

Use Node 24, tmux and Git 2.36 or newer on the same awake host as Codex and
Claude Code; project discovery reads `git worktree list --porcelain -z`, which
older Git rejects. Run one backend per store, as the user who owns the tmux
socket. Keep this clone available: installed hooks and skills point into it.

## Install and start

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

Restart the coding CLIs to load the hooks and skills. For the first checks, set
`CODERCREW_ENABLE_INPUT=false` in `web/.env.local`, then start the console:

```bash
cd web && npm run dev
```

Codex needs both the native `UserPromptSubmit` entry in `~/.codex/hooks.json`
(or `$CODEX_HOME/hooks.json`) and the `notify` command in `config.toml`.
Both CLIs also install SessionStart for startup/resume, so fresh sessions can
report Ready before their first prompt. Trust the additional Codex SessionStart
hook through `/hooks`. Ready is a session observation, not task completion.
Codex also installs Interrupt with its native three-second timeout limit. It
reports the exact cancelled turn as Interrupted and pauses its relay; it never
certifies completion or background-process quiescence. Trust this hook through
`/hooks` after upgrading, along with the other CoderCrew hooks.
Metadata-only hook delivery diagnostics live beside turn bindings as `*.status`
files under `~/.local/share/codercrew/hook-turns/`; they contain no prompt,
response, token or raw error text.
Native hooks must be enabled (`features.hooks`, enabled by default in Codex
0.155.1). To update only hook installation, run `node scripts/install-hooks.mjs`
while the CLIs are idle, then restart Codex and use `/hooks` to review and trust
the CoderCrew UserPromptSubmit, SessionStart and Interrupt hooks before the next command. Codex skips new or
changed native hooks until trusted; see [hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
A turn that
started without this native binding cannot be completed by searching notification
history; reconcile any old owned run through Pause / take over.

Open http://127.0.0.1:8787 and enter the token from `web/.env.local`. Verify pane
captures before setting `CODERCREW_ENABLE_INPUT=true` and restarting the backend.
After configuration or server-code changes, settle active deliveries before
restarting; hot reload retains the running controller.

## Select a project, worktree and group

Start a coding CLI in tmux inside your repository. CoderCrew discovers its local
project through Git's shared metadata directory and lists all its worktrees,
including those without agents. Linked worktrees in other folders stay in the
same project; separate clones stay separate even with identical origin URLs.
Projects used by an explicit name/membership edit, Start or creation are remembered
after restart. Merely browsing is read-only and retains discoveries only for the
current backend process. Prepare dependencies and agent sessions yourself;
CoderCrew does not clone repositories, move agents or configure environments.

In **Projects**, select a project, then click a worktree card to open its console.
If agents occupy several subdirectories, choose the task group directory first.
Selection is shown by its border/background, not a separate Selected button.
Every eligible agent has a checkbox; all are included initially. One selected
agent is a solo group, two a pair, and three or more a larger group. Checkbox
changes save immediately. Larger groups can be selected, but Plan/Implementation
execution currently supports only one or two members and displays that limit.
There is no Register, Create group or Use group step. The **Name** column defaults
to the agent label; edit it inline and press Enter or leave the field to save,
or Escape to cancel. Names do not change tmux sessions or historical runs.
Discovery and opening a card are read-only; exact instance bindings are checked
internally and persisted only on an explicit edit or Start.
All selected members must share the same canonical
current directory and Git worktree/index. Separate subdirectories appear as
task groups under one worktree and share its execution lock. Separate linked
worktrees can run independent tasks concurrently; shared databases, ports and
other environment resources remain your responsibility.

### Create a task worktree

Choose **Create task worktree**, select a starting checkout, and enter a new
branch name. **Preview worktree** displays the exact committed baseline and
destination, defaulting to `~/.codercrew/<repo-name>/<branch-name>`. Branch slashes
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
may leave empty parent directories. Worktree removal is not exposed by this UI.

Dirty or unavailable workspaces remain readable, but Plan and Implementation
starts are disabled until the index and nonignored worktree are clean. The console
lists staged, unstaged and untracked files. Commit intended changes on your task
branch, then **Recheck** and confirm readiness again. Creating a branch alone does
not clean the checkout. To review that work after committing, choose a **Review
baseline** and use **Relay [peer]**; to leave it uncommitted, use the optional
staging fallback. Keep unrelated changes separate or create another clean task
worktree.
CoderCrew never automatically stages, commits, combines, stashes or discards them.

Before Start, check all agents
sharing the checkout, including unselected agents: prompts must be empty, with no
permission dialogs or background writers. Confirm readiness explicitly. Selecting
a workspace never starts or redirects a run. Renaming and saved
membership changes are blocked while a run owns the checkout.

## 1 · Plan

Prepare a narrow `.codercrew/plans/` ignore rule. Outputs must be ignored and
untracked; a broad `.codercrew/` rule is refused. Inspect existing ignored content
before narrowing such a rule so private files are not exposed. CoderCrew never
edits ignore rules or force-adds planning documents.

Choose **1 · Plan**, enter the shared brief, and choose the implementation roles.
The same workspace group participates in both phases. The collapsible **Collaboration
settings** panel holds the tracked relay log, **Automatic collaboration**, the automatic turn budget,
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
integration branch (`CODERCREW_INTEGRATION_BRANCHES`, default `main,master`, plus
the local `origin/HEAD`) only a new task branch or task worktree is offered, and
the server refuses anything else; detached HEAD requires a new named branch. Branch
creation occurs at a settled boundary, with clean entry or captured initial changes, separately from Plan approval.
Integrate accepted results yourself, preferably by squash merge or pull request.
CoderCrew never switches to an existing branch, stages, commits, stashes or resets
your work.

The assigned agent uses `commit-handoff` to publish one commit per completed turn,
including an entry in the tracked, nonignored `RELAY-LOG.jsonl`. **Send** performs
one standalone instruction without an automatic commit, branch change, or relay.
**Commit [agent]** snapshots all current staged, unstaged and nonignored untracked
changes as they stand, then stops. It does not finish pending requests; text is
optional handoff context. **Relay [peer]** reviews every commit after the selected
**Review baseline**: the earliest candidate (default) is the recipient's last
handoff commit on this branch from the relay log, or the task baseline when they
have none; the latest is the last commit only; **Another commit…** previews a typed
baseline before sending. On a dirty checkout, the button becomes **Commit current
changes & relay [peer]**: the selected worker snapshots the current changes,
and the controller sends the selected baseline through the new snapshot for review
after validating its commit and settled completion. The baseline selector remains
available; current HEAD selects only the current changes. No instruction text is
required for this action; readiness and active-run gates still apply. Clean
checkout review requires project changes in the selected range.
Send and Commit name the selected worker; Relay names the receiving
peer or designated reviewer.
The collapsible **Collaboration settings** panel holds the tracked relay log and
the agreement for subsequent turns: automatic collaboration, the turn budget, and
whether a reviewer objection pauses for you (by default it is routed straight
back to the author). Otherwise use **Next turn**.
A completed chain still needs final task-level verification.

## Pause and recovery

Unknown completion, background work or changed agent identity pauses the run.
Inspect the agents and use **Pause / take over** before manual intervention.
Pause prevents further scheduling but does not interrupt workers or retract input;
explicit takeover releases ownership after inspection. Never send a replacement
command just because an HTTP response failed.

A backend restart pauses owned runs without replay. Closing or locking a browser
does not pause them. Resolve outstanding work before starting another run.

## Optional staging fallback

The supervised two-agent staging flow is off by default. To use it, set
`CODERCREW_ENABLE_LEGACY_RELAY=true`, restart after active deliveries settle, and
select **Staging fallback**. Its `relay` instruction rule and staging contract are
documented in [SKILLS.md](SKILLS.md#mapping-relay-to-the-skill). This option does
not change Plan or committed Implementation.

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
