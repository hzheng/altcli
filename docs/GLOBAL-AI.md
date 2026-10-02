# Helper: app-aware reads (A1)

The UI calls this feature **Helper**, a Console tab whose **Chat** section holds the
conversation. Internal routes and identifiers keep the Global AI name used by
ADR-0022/0023.

## Scope and status

A1 adds a user-operated, app-wide Codex or Claude Code terminal and a read-only MCP
interface to AltCLI's existing host. It is not the Background assistant, a new
reviewer, a second controller, or delegated execution. The source and regression
fixtures are present; installed Codex and Claude Code, macOS/Linux deployment and
physical iPhone acceptance must be recorded separately. See ADR-0022/0023 for the
broader direction.

## Use

Restart the host with the normal `cd web && npm run dev` or production `npm run
start` command. Server changes must not replace a live dispatcher through hot
reload. The custom host supplies its actual loopback port to the MCP bridge;
plain `next start` does not provide the native terminal gateway.

Set it up first in Console → **Helper → Settings**; Chat's start flow links there, as
does Settings → Console preferences under its launch profiles. Each Helper profile has
a name, a CLI (Codex or Claude Code), a model and a reasoning effort (blank keeps the
CLI's configured default), so different CLIs, models and efforts can sit side by side.
Saving creates or updates an ordinary launch profile, shown literally as
`codex --no-daemon -m <model> -c model_reasoning_effort=<effort>` or
`claude --model <model> --effort <effort>`, and launches nothing. **New profile** adds
another; the first is named `Helper` by default. Choosing the other CLI starts from its
defaults; until saved, the profile keeps its CLI and values. Helper profiles are kept
apart from agent profiles: each launch profile records its purpose, set when it is
created. Settings → Console preferences → Launch profiles and worktree **Launch
agents** list only agent profiles, and the host refuses a Helper profile for an agent
launch; Helper lists and starts only Helper profiles, and the host accepts a Helper
profile only with arguments Helper can launch. A profile saved before purposes existed
is an agent profile, except the one the earlier single-profile Settings → Helper saved:
named `Helper` or `Global AI`, with arguments Helper can launch. Deleting asks first and
stops no running conversation. Chat preselects the profile named
`Helper`, or one saved under the earlier label `Global AI`, otherwise the first; saving
never renames a profile. That section also
names any missing host requirement: the tmux adapter, input, native terminals and
agent launch. AltCLI does not list or verify the models a sign-in offers; the CLI
reports an unavailable model in its terminal. A running conversation keeps the
settings it was launched with: after a change, the Chat section names the difference
and offers **Restart with saved settings**, or type `/model` in its terminal to switch
that conversation's model in place.

Open the **Helper** tab in Console, before **Settings**, or go to `/global-ai`, which
opens Console there. Helper has five sections: **Chat** (where it opens: the
conversation's terminal once one exists, otherwise the start flow), **Session** (status,
restart, app access and retirement), **Settings** (the launch profiles above), **Evidence**
(the read model) and **Guide** (the
general explanation of the console); a section chosen earlier on the page is kept.
Helper uses Console's unlocked token and **Lock**, and the
token is never passed to the model. Switching tabs keeps every tab's drafts and the
Helper terminal. Outside Guide, the heading shows only the connection status: Control
access and the input status stay on the other tabs, since this terminal holds nothing. Chat's list holds only
enabled Helper profiles, which A1 accepts only as direct launches: Codex with `--model`/`-m`, `--no-daemon`, `--no-alt-screen`, and
`-c model_reasoning_effort=...`; Claude Code with `--model` and `--effort`. Preview validates the chosen profile again, and other
arguments are refused explicitly, not silently stripped.

Global AI reads AltCLI's records for every project on this host, including projects
added after it starts; there is no per-workspace selection. Preview the exact program,
arguments and private directory, then confirm, which also approves sending those
records to the model provider. No session or model request starts from viewing the
page. Model selection is configured in the profile; actual model and
remaining subscription quota are not inferred.

A1 reuses the CLI's existing home and sign-in. It adds a read-only posture and an
`altcli_read` stdio MCP configuration for this launch, without editing user config.
No API-key fallback, global clipboard access or owner-token environment is added.
The launcher preserves the existing conservative environment policy. Authentication,
provider permissions, subscriptions and required runtime options need verification
for the installed CLI. The CLI's inherited configuration and other integrations
remain the owner's responsibility: **read-only AltCLI tools are not an OS sandbox**.

### What read-only means for each CLI

Helper's app tools are read-only. Native CLI commands follow the CLI's permission
policy, including existing approvals. Helper adds these arguments after the profile's:

| | Codex | Claude Code |
| --- | --- | --- |
| Arguments | `--cd <directory> --sandbox read-only` and `-c mcp_servers.altcli_read.*` | `--permission-mode manual --strict-mcp-config --mcp-config <altcli_read> --allowedTools mcp__altcli_read`; tmux starts it in the directory |
| Writes | The OS sandbox blocks writes by its commands and edits; Codex can ask the owner to approve an exception under its configured approval policy | Manual mode prompts for file edits and shell commands unless already allowed; built-in read-only commands can run without prompting. This is Claude Code's own check, not an OS sandbox; permitted commands run with the owner's rights |
| AltCLI reads | Through `altcli_read` | Allowed without asking. No other MCP server loads, including claude.ai connectors |
| Inherited configuration | The user's Codex config, other MCP servers and hooks | The user's Claude settings: their allow rules, "don't ask again" answers, hooks and plugins still apply |
| Orientation | `AGENTS.md` | `CLAUDE.md` |

Claude Code asks whether to trust each new Helper directory; answer in its terminal.
Claude Code 2.1.287 also accepts a trusted parent outside Git, so trusting
`<data directory>/global-ai` once (run `claude` there and accept) stops the question
on restarts. Approving an action in Helper creates no manual-input hold for either CLI.

Use the native terminal for `/mcp`, login/trust/model prompts and questions. The
terminal is bound to the app launch rather than coding-agent discovery, so a
startup program is usable before it resembles a ready project coder. Login and
external browser flows can still need an external step. Ask:

- "Which runs need my attention?"
- "Why is run <ID> blocked, and what should I do next?"
- "Explain Commit versus Relay in this installed version."

The agent receives orientation in its private AGENTS.md or CLAUDE.md. Tools return current
recorded facts, explicit unknowns, observation time, content-derived revision and
document line/hash references. The **Evidence** section lets the owner inspect the
same read model. It is not another prompt composer. Existing Console controls
remain responsible for checking and executing any recommended action.

## Native input and recovery

The Global AI terminal is always writable: input starts as soon as it connects, and
there is no Display/Terminal switch. It is the one terminal outside all worktree and global
manual-input barriers ([ADR-0020](adr/ADR-0020-native-terminals.md)). Typing there
creates no manual-input record, holds no dispatch, setup or launch, touches no run
checkpoint and needs no reconciliation. That is safe because no project, run or
automated delivery uses its private tmux session; the broker exempts only an
unretired Global AI instance's own terminal, and every agent terminal keeps the
barrier. Helper's native display uses a read-only tmux client, while each input
frame goes directly to its original pane as literal bytes. Tmux prefixes therefore
reach the CLI too; they cannot switch Helper input into a workspace session.
Helper remains writable during another terminal's hold or an automated delivery.
Several owner clients can type into it. Read-only MCP queries never clear
another terminal's hold, certify idle activity or resume work.

Launch facts are recorded before process effects. A lost/uncertain launch is not
retried. **Inspect recorded instance** refreshes evidence. A known placeholder or
started pane can be opened in the browser. If no exact identity was captured, the
app does not adopt a coincidentally named session: exceptional host inspection may
still be necessary. This increment does not fix startup access for every existing
project launch; its Git-free app-instance path is specifically A1.

**Revoke app tools** immediately invalidates the read capability, without stopping
the CLI. **Refresh app access** explicitly reauthorizes read access after expiry or
a host restart, only while the observed instance still matches. The stdio
bridge rereads its private descriptor on each request, so no prompt or CLI restart
is needed merely to renew access. A revocation racing renewal wins.

**Retire app access** revokes tools and frees the app-instance slot. It does not kill
tmux, erase the provider conversation or prove no background work exists, and AltCLI
no longer opens a retired instance's terminal.

Session's **Restart with** chooses a profile: this conversation's, as saved now, or
another one. **Restart** previews it, then after one confirmation of the exact command
stops the current CLI by ending its tmux session, retires it and starts a new
conversation with that profile. The changed-settings notice's **Restart with saved
settings** does the same with this conversation's profile. Only the exact, marked Global AI session that inspection
verifies is stopped; extra panes or windows refuse the stop, and the host's input
and launch switches still apply. If inspection or the stop cannot be verified,
the instance remains unretired with tools revoked for inspection; a lost stop
response does not prove the process is still running. The CLI keeps its own session history, but the new
conversation does not continue the old one. Exit the CLI in its terminal first when appropriate. Retired records
remain historical; a new conversation receives a new UUID. Old input is never
replayed into it. Old app panes stay excluded from automatic project grouping while
their raw process evidence remains visible to normal manual-input checks.

## Tools and authority

The stdio bridge supports MCP initialize, ping, tools/list and tools/call. It proxies
only to this host's loopback read endpoint. It neither opens SQLite nor launches a
controller. Supported protocol versions are 2025-06-18 and 2025-11-25; this is not a
claim that every provider has been validated with both.

| Tool | Result |
| --- | --- |
| `get_capabilities` | Runtime feature flags, read contract and the IDs of the documents built into this version |
| `list_workspaces` | Observed workspaces on this host, with directory/branch/agent metadata |
| `list_runs` | Bounded recent/active run summaries across this host's projects |
| `get_run` | Current recorded reason, execution/activity, manual hold, checkpoint, plan and publication; no authorization |
| `get_recent_events` | Bounded command/execution metadata, not prompts or terminal transcripts |
| `search_docs` | Bounded literal matches with document hashes and line references |
| `read_doc` | Up to 120 lines from a built-in operating document; no arbitrary paths or URLs |

The documents are packed when the app is built: `scripts/build-kb.mjs` copies the
allowlisted `README.md`, `docs/WORKFLOWS.md`, `docs/TERMINAL-PROTOCOL.md`,
`docs/SETUP.md` and `docs/GLOBAL-AI.md` into the generated server module
`web/src/server/global-ai/kb.generated.ts` before `npm run dev`, `build`,
`typecheck`, `test:global-ai` and `e2e`. Any build or bundle therefore carries the
documents that match its code, and the host never reads a checkout at runtime. A
symlinked or oversized (over 256 KiB) document fails the build. Edit the source
documents, not the generated module, which is not tracked.

The owner-facing API retains the normal bearer/Origin checks. The bridge instead
uses a random, eight-hour read capability stored in a private 0600 descriptor under
0700 app storage. Only its path, never its token, appears in launch arguments. The
server keeps the active capability in memory; restart invalidates it. It is checked
before request parsing and after awaited reads. Four tool reads may be in flight;
requests and results are bounded. Redirects and non-loopback destinations are refused.

Model JSON cannot add arguments, a scope or a field claiming to be the owner, and an
unknown run ID is refused. Revocation or retirement cannot retract data already
seen by the CLI/provider. Documentation can include labelled future/historical
sections; runtime capabilities and current state take precedence. Incomplete or
unavailable evidence remains visible instead of being interpreted as approval.

No mutation tools, arbitrary shell tool, terminal-transcript tool, image attachment
scope, background queue, notification service or approval policy is added in A1.
The owner can still operate the CLI natively under its normal permissions. A tool
allowlist does not prevent a same-user process from accessing files outside it.

## Storage, rollout and tests

`global_ai_instances` is optional metadata in the existing Store connection. It
contains launch facts, not owner/provider credentials, new workflow
ownership or delegated authority. Existing schema-19 hosts ignore it; they cannot
serve the new in-memory read capability. Do not run two hosts against one database.
The private `<data directory>/global-ai/<UUID>` directory contains orientation and
the bridge descriptor. No fake project or Git branch/worktree is created.

Run from `web/`:

```sh
npm run test:global-ai
npm run typecheck
npm run test:native
npm run e2e
npm run build
```

The dependency-free `node --experimental-strip-types --test scripts/global-ai.test.ts`
checks provenance, the packed documents, private descriptors, MCP framing/HTTP,
idempotency, revocation and restart with injected services. The integration fixture uses real
SQLite and the existing ControlPlane. The private-tmux fixtures use harmless
programs named codex and claude, not providers; they never touch the user's tmux
server. The claude fixture checks that the exact arguments, including the JSON MCP
configuration, reach the program and that its orientation is `CLAUDE.md`.
Existing failing baseline fixtures are not weakened or relabelled by this feature.
The web gate runs the new checks and TypeScript early so unrelated historical
workflow failures do not hide A1 validation.

Installed acceptance: record the actual Codex or Claude Code/auth/model/config versions; verify
`/mcp`, an answer grounded in a deliberately blocked disposable run, an answer citing
a built-in document, startup prompts, multiple browsers, host restart plus explicit access renewal, and
physical iPhone input. Mock/native fixture success is not this provider/device
acceptance. Revoking or retiring A1 does not stop workspace agents or erase history.

Recorded for Claude Code 2.1.287 on macOS (October 1, 2026), with a fixture read
endpoint, not an AltCLI host: a one-shot `claude -p` run with Helper's arguments
connected only `altcli_read`, called a read tool without asking, and held both a
Write and a Bash call for approval; started interactively in a new directory, it
first asked for trust. A Helper conversation launched from AltCLI with Claude Code
has not been recorded.

## Primary integration references

- Codex MCP configuration: https://developers.openai.com/codex/mcp/
- Codex CLI arguments: https://developers.openai.com/codex/cli/reference/
- Claude Code CLI arguments: https://code.claude.com/docs/en/cli-reference
- Claude Code MCP configuration: https://code.claude.com/docs/en/mcp
- Claude Code permission modes and rules: https://code.claude.com/docs/en/permissions
- MCP stdio transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

These document the integration mechanisms, not successful execution on a particular
installed host or an unconditional subscription/billing entitlement.
