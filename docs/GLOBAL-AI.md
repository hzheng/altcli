# Global AI: app-aware reads (A1)

## Scope and status

A1 adds a user-operated, app-wide Codex terminal and a read-only MCP interface to
AltCLI's existing host. It is not the Background assistant, a new reviewer, a
second controller, or delegated execution. The source and regression fixtures are
present; installed Codex, macOS/Linux deployment and physical iPhone acceptance
must be recorded separately. See ADR-0022/0023 for the broader direction.

## Use

Restart the host with the normal `cd web && npm run dev` or production `npm run
start` command. Server changes must not replace a live dispatcher through hot
reload. The custom host supplies its actual loopback port to the MCP bridge;
plain `next start` does not provide the native terminal gateway.

Open **Global AI** from the Console link. It opens a separate tab to preserve the
workspace's drafts. Unlock using the existing owner token; this page keeps it in
memory only and never passes it to the model. Select an enabled direct Codex launch
profile from Settings. A1 permits `--model`/`-m`, `--no-daemon`, `--no-alt-screen`,
and `-c model_reasoning_effort=...`. Other profiles/arguments are refused explicitly,
not silently stripped. Create a dedicated profile when the normal coding profile
uses wrappers, resume, workspace-changing or approval-bypass options.

Choose the workspace roots whose app records may enter this conversation. An
empty scope still permits documentation help. Preview the exact program, arguments,
private directory and scope, then confirm. No session or model request starts from
viewing the page. Model selection is configured in the profile; actual model and
remaining subscription quota are not inferred.

A1 reuses the user's Codex home/sign-in. It adds a read-only sandbox request and an
`altcli_read` stdio MCP configuration for this launch, without editing user config.
No API-key fallback, global clipboard access or owner-token environment is added.
The launcher preserves the existing conservative environment policy. Authentication,
provider permissions, subscriptions and required runtime options need verification
for the installed CLI. The CLI's inherited configuration and other integrations
remain the owner's responsibility: **read-only AltCLI tools are not an OS sandbox**.

Use the native terminal for `/mcp`, login/trust/model prompts and questions. The
terminal is bound to the app launch rather than coding-agent discovery, so a
startup program is usable before it resembles a ready project coder. Login and
external browser flows can still need an external step. Ask:

- "Which shared runs need my attention?"
- "Why is run <ID> blocked, and what should I do next?"
- "Explain Commit versus Relay in this installed version."

The agent receives orientation in its private AGENTS.md. Tools return current
recorded facts, explicit unknowns, observation time, content-derived revision and
document line/hash references. The **Evidence** panel lets the owner inspect the
same read model. It is not another prompt composer. Existing Console controls
remain responsible for checking and executing any recommended action.

## Native input and recovery

Global AI uses the existing terminal broker and its accepted multiwriter contract.
Several owner clients can type, including into this session. No exclusive keyboard
policy is reintroduced. Its ordinary native input shares the current server-wide
manual barrier. Display stops this connection's typing; Console → Control access
handles reconciliation and saved checkpoints. Read-only MCP queries never clear
that barrier, certify idle activity or resume work.

Launch facts are recorded before process effects. A lost/uncertain launch is not
retried. **Inspect recorded instance** refreshes evidence. A known placeholder or
started pane can be opened in the browser. If no exact identity was captured, the
app does not adopt a coincidentally named session: exceptional host inspection may
still be necessary. This increment does not fix startup access for every existing
project launch; its Git-free app-instance path is specifically A1.

**Revoke app tools** immediately invalidates the read capability, without stopping
Codex. **Refresh original app access** explicitly reauthorizes the same scope after
expiry or a host restart, only while the observed instance still matches. The stdio
bridge rereads its private descriptor on each request, so no prompt or CLI restart
is needed merely to renew access. A revocation racing renewal wins.

**Retire app access** revokes tools and frees the app-instance slot. It does not kill
tmux, erase the provider conversation, prove no background work exists, or settle
manual input. Exit the CLI in its terminal first when appropriate. Retired records
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
| `get_capabilities` | Runtime feature flags, read contract and allowlisted installed document IDs |
| `list_workspaces` | Only explicitly shared roots, with observed directory/branch/agent metadata |
| `list_runs` | Bounded recent/active run summaries within scope |
| `get_run` | Current recorded reason, execution/activity, manual hold, checkpoint, plan and publication; no authorization |
| `get_recent_events` | Bounded command/execution metadata, not prompts or terminal transcripts |
| `search_docs` | Bounded literal matches with document hashes and line references |
| `read_doc` | Up to 120 lines from a known operating document; no arbitrary paths or URLs |

The owner-facing API retains the normal bearer/Origin checks. The bridge instead
uses a random, eight-hour read capability stored in a private 0600 descriptor under
0700 app storage. Only its path, never its token, appears in launch arguments. The
server keeps the active capability in memory; restart invalidates it. It is checked
before request parsing and after awaited reads. Four tool reads may be in flight;
requests and results are bounded. Redirects and non-loopback destinations are refused.

The selected roots cannot be expanded by model JSON, navigation in Console, or a
field claiming to be the owner. Sharing a different scope requires a new explicitly
confirmed app conversation in A1. Narrowing or retirement cannot retract data already
seen by the CLI/provider. Documentation can include labelled future/historical
sections; runtime capabilities and current state take precedence. Incomplete or
unavailable evidence remains visible instead of being interpreted as approval.

No mutation tools, arbitrary shell tool, terminal-transcript tool, image attachment
scope, background queue, notification service or approval policy is added in A1.
The owner can still operate the CLI natively under its normal permissions. A tool
allowlist does not prevent a same-user process from accessing files outside it.

## Storage, rollout and tests

`global_ai_instances` is optional metadata in the existing Store connection. It
contains launch facts and scope, not owner/provider credentials, new workflow
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
checks scope, provenance, private descriptors, MCP framing/HTTP, idempotency,
revocation and restart with injected services. The integration fixture uses real
SQLite and the existing ControlPlane. The private-tmux fixture uses a harmless
program named codex, not a provider; it never touches the user's tmux server.
Existing failing baseline fixtures are not weakened or relabelled by this feature.
The web gate runs the new checks and TypeScript early so unrelated historical
workflow failures do not hide A1 validation.

Installed acceptance: record the actual Codex/auth/model/config versions; verify
`/mcp`, an answer grounded in a deliberately blocked disposable run, scope refusal,
startup prompts, multiple browsers, host restart plus explicit access renewal, and
physical iPhone input. Mock/native fixture success is not this provider/device
acceptance. Revoking or retiring A1 does not stop workspace agents or erase history.

## Primary integration references

- Codex MCP configuration: https://developers.openai.com/codex/mcp/
- Codex CLI arguments: https://developers.openai.com/codex/cli/reference/
- MCP stdio transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

These document the integration mechanisms, not successful execution on a particular
installed host or an unconditional subscription/billing entitlement.
