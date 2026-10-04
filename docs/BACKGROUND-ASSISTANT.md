# Agents tab, attention and the Background assistant

## Scope and status

Implemented locally on October 2, 2026, from the endorsed Plan of run `aec693b1` (revision 3) recorded in the
[ADR-0022 amendment](adr/ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant):

- a central **Agents** tab with three kinds of agents, each with its own profiles;
- **attention**: deterministic, durable records of runs, Plan checkpoints and launches that need you, with no model involved;
- shared read contracts for Helper and Background jobs: output schemas, explicit principals and new attention and launch reads;
- a strict assessment validator, one recorded private tmux runner, explicit enablement and bounded Claude investigation jobs;
- owner-confirmed or explicitly delegated app actions and host commands, with a durable **Log** (schema 24).

The runtime is implemented locally. Background is disabled by default; saving profiles and browsing never starts it. The installed
Claude Code 2.1.288 probe, and on October 3, 2026 the 2.1.289 probe, passed using synthetic issue evidence, scoped MCP reads, validated
structured output and verified process-group exit. The same real-tmux pipeline also passed with the installed provider; its restart and cancellation cases use a fixture provider. Neither is physical-device or production-data acceptance.

## The Agents tab

The top bar is **Console · Projects · Agents · Settings**. Agents holds three kinds:

| Kind | Sections |
| --- | --- |
| Workspace agents | **Inventory**: the selected checkout's agents, with status and **Show … in Console**. **Profiles**: the agent launch profiles that were in Settings → Console preferences |
| Helper | **Chat**, **Session**, **Profiles** (formerly Settings), **Evidence** and **Guide**. `/global-ai` opens Agents → Helper → Chat |
| Background assistant | **Attention** (the default), **Activity**, **Log**, **Profiles** and **Settings** |

Settings → Console preferences links to each kind's profiles. Viewing a list or switching kinds changes nothing; names, membership and
launches stay in Projects and instructions stay in Console. Each kind keeps its section in page memory, which Lock clears.

Profiles have a purpose: `agent`, `helper` or `background`. Each list shows only its own purpose, and only an agent profile can launch a
worktree agent. A Background assistant profile is a direct `claude` executable with only `--model` and `--effort`. Codex is not yet a
verified Background adapter, and the host refuses any other argument rather than dropping it. Saving a Background profile launches,
enables and sends nothing.

## Attention

The host derives attention from its own records: never from terminal output, captures or a model.

| Item | Raised when | Stays quiet |
| --- | --- | --- |
| Run | An owned run is paused with a typed cause: uncertain delivery, an interrupted turn, a completion gate, terminal input to review, a backend restart, or another recorded pause | Your own Pause, and routine waits such as a manual Next turn |
| Plan | An owned Plan waits at its checkpoint for approval, a disagreement decision, branch consent or manual continuation | An agreed Plan whose authorized automatic transition the controller performs |
| Launch | A recorded workspace launch or cleanup, or a Helper start, is uncertain | Starting, exited and failed launches, which their own cards show |

Each underlying issue (`run:<id>`, `launch:<id>`, `helper:<id>`) has at most one open item. A material change revises the item in place
instead of sending another notice. When the issue ends, the item resolves with a disposition read from the current record, which never
claims task success or that an agent stopped. A later recurrence opens a new item. An unreadable record keeps its item open and marks it
stale; absence never resolves it.

**How changes are detected.** Run, checkpoint, launch and Helper writes record a semantic fingerprint and a monotonic version in the same
SQLite transaction, so a rolled-back transition leaves nothing behind. After the commit, a coalesced wake-up reconciles. A pass when the
controller starts and a 15-second sweep repair anything a write path missed, reading only recorded state: no tmux, Git, terminal or model.
An unchanged source writes nothing, however often it is read. Typed pause causes (`pauseCause: user | restart`) distinguish your own Pause
and a restart; no reason text is classified.

**Delivery.** Every page heading shows **Attention · N**, the count of open items not yet marked seen. It opens Agents → Background
assistant → Attention. Each item shows the recorded facts first, then **Open …**, which only navigates to Control access, the launch card
or Helper's Session, and **Mark seen**. Mark seen records the exact revision for every browser and changes no run, approval, hold or
reservation. A newer revision is unseen again. Recently resolved items stay listed with their disposition.

| Interface | Content |
| --- | --- |
| `GET /api/v1/state` | `attention`: open and unseen counts, the newest 20 open items, 10 recent resolutions and whether more exist |
| `GET /api/v1/attention?status=open\|resolved&cursor=` | Every item, newest first, 50 per page |

The feed and every page carry `revision`, a digest of the open set that changes whenever an item opens, resolves, changes or is
marked seen in any browser. **Show all** reads every page and shows that copy only while its pages agree with each other and with
the feed's current revision. It reads them again after any change, so a resolved item, an old revision or a stale Mark seen never
stays on screen.
| `POST /api/v1/attention` | `{ "action": "mark-seen", "itemId", "revision" }` for the item's current revision |

All open items are kept; resolved history keeps the newest 200 within seven days. Attention starts with the controller singleton, on the
first request or hook event after the backend starts, and then runs without any browser. Item text is rendered as text, never HTML.

## Read contracts shared with Helper

Every read tool declares an `outputSchema`, and the host checks each reply against it before it leaves the host; a mismatch is refused
(`TOOL_CONTRACT`) rather than returned. MCP's `structuredContent` and its serialized text carry the same reply. New tools:

| Tool | Result |
| --- | --- |
| `list_attention` | Open attention items for every project (Helper only) |
| `get_attention_item` | One item with its revision, facets and destination |
| `get_launch` | One recorded workspace launch or Helper start: status, phase, message and identity facts |

Reads take an explicit principal set by the transport, never by model input. Helper keeps its owner-approved host-wide reads. A Background
job reads only its admitted item and that item's run or launch: no host-wide listing, and a `get_run` without
plan text, objection text or the publication summary and checks. `get_capabilities` reports contract `global-ai-read-v2` and
`backgroundAssistant: { attention: true, runtime: "available", enabled: <current enablement> }`.

## Assessment validation

A Background job's answer is validated by the host independently of any CLI-side schema:

- exact fields, with the item ID and revision echoed exactly;
- bounded plain text, rejecting control and bidirectional-override characters;
- one to six citations of host-minted evidence IDs actually served to that attempt;
- a destination allowed for the item's kind.

One bad citation rejects the whole answer. A valid assessment proves its citations' provenance, not its interpretation, and the assessment itself cannot
approve, resolve, certify readiness or act. Effects use the separate action admission contract below.

## Storage, upgrade and recovery

Store schema 22 added `attention_sources`, `attention_items` and the run field `pauseCause`. Schema 23 adds Background settings, attempts, semantic-version admission records, settle timestamps and rolling-hour accounting. Schema 24 adds action permissions, proposals and an append-only audit, and identifies delegated decisions separately. These upgrades only add
data, so it needs no settled store, and it keeps a private `altcli-schema-<n>-<time>.sqlite3` backup first. Pre-registry stores still meet
the [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md#upgrade) gate. Older versions refuse a schema-24 store, so
rollback restores that backup with its matching version while nothing is in flight.

Upgrading restarts the backend: stop the old one while no delivery is active. The usual recovery then pauses owned runs (with
`pauseCause: restart`) and marks interrupted deliveries and starting launches uncertain. It keeps their owners and replays nothing, and
attention raises an item for each.

## Tests

| Command (from `web/`) | Covers |
| --- | --- |
| `node --experimental-strip-types --test scripts/attention.test.ts` (part of `npm run test:workflow`) | Real SQLite and workflow fixtures: typed pauses, revisions, A → B → A versions, rollback, sweep repair, stale records, paging, Mark seen, launches, Helper starts, the schema-21 upgrade and the assessment validator |
| `npm run test:global-ai` | Shared read contracts plus durable Background scheduling, capability separation, limits, stale answers, native process boundaries and real-tmux restart recovery with a fixture provider |
| `npm run probe:background` | Opt-in installed Claude probe with synthetic evidence; consumes the configured login’s provider allowance |
| `ALTCLI_BACKGROUND_REAL=1 node --experimental-strip-types --test scripts/background.integration.test.ts` | Opt-in complete host → recorded tmux runner → installed Claude → scoped MCP → validated assessment path, using synthetic evidence |
| `npx playwright test e2e/agents.spec.ts` | A real paused run in Attention, Mark seen and navigation-only Open, launch and Helper destinations, paging, and the three kinds and their profiles |

## Enablement, jobs and controls

Create a named Claude profile in **Agents → Background assistant → Profiles**, then use **Settings → Preview enablement**. The preview
binds the exact profile revision, resolved executable, environment and provider version. Confirm the scoped data disclosure and shared
provider allowance. The first eligible issue starts one recorded private tmux session, separate from Helper, on the configured endpoint.
It stays outside Git and has no browser terminal or workspace-input exemption. **Activity** shows recent jobs; current explanations appear
beneath the corresponding **Attention** item with likely cause, next steps, uncertainty and citations.

The host, not the browser, admits work. A trusted runner receives one persisted claim and starts a fresh Claude invocation. A lost delivery
is never replayed. The runner's private transport capability is separate from the model's issue-scoped MCP capability; neither is the owner
token. Prompts use stdin, tools use private descriptors, and results use bounded structured stdout. The host independently checks the result
and served evidence. An answer applies only to the same item ID, material revision, semantic source version and enablement.

| Limit | Value |
| --- | --- |
| Active work / settle | One job; same semantic version for 20 seconds |
| Admission | 10 starts per rolling hour; at least 30 seconds apart; one automatic attempt per version |
| Deadline / tools | 120 seconds; 12 scoped tool calls |
| Evidence / result / native output | 64 KiB / 8 KiB / 1 MiB |
| Pending work / failure circuit | 100 coalesced oldest eligible issues; pause after 3 consecutive failures |
| History | Latest 200 settled attempts, plus unresolved work and each current referenced assessment; Activity displays the latest 20 and Attention carries up to 200 current explanations |

**Pause** stops admission and lets the current job finish. **Disable** revokes result eligibility and tools and requests bounded cancellation.
Neither clears unknown execution. **Inspect** checks the exact recorded session and any private completion receipt; **Resume** is an explicit
revalidation after inspection or pause. **Retry diagnosis** is explicit and obeys the same rate limits. **Stop Background** confirms the exact
session and refuses extra panes or unresolved attempts. A changed profile requires stopping the old instance and previewing a new one.
Closing or locking a browser leaves enabled work running. Host shutdown/restart revokes capabilities, keeps unfinished work uncertain, and
requires Inspect and Resume. It never creates a replacement session automatically.

The adapter accepts the verified Claude Code releases **2.1.288** and **2.1.289**. Preview reports the detected and supported versions
when a CLI update is not yet supported; other versions require a native capability probe before enablement.
It disables built-in tools, inherited settings and hooks, skills, automatic memory,
connectors and the bundled instruction/authoring plugins; only the scoped MCP server and structured-output tool are accepted at initialization.
It removes owner and tmux correlation variables from the child environment. Unexpected tools, plugins or hook events fail the invocation.
This is a cooperative same-user CLI boundary, not an OS sandbox. Managed policy can prevent it from operating; it does not bypass that policy.
The adapter follows the official [CLI](https://code.claude.com/docs/en/cli-reference),
[structured-output](https://code.claude.com/docs/en/headless) and [plugin](https://code.claude.com/docs/en/plugins/mods/overview) contracts.
A result becomes usable only after native exit and an empty invocation process group. Timeout, lost receipts or surviving work keep ownership.

`GET /api/v1/background` returns settings, current explanations and recent attempts. Owner-authorized POST controls share that route;
`/background/runner` and `/background/tools` accept their distinct loopback capabilities only.

External notifications, setup-operation attention and Codex Background support remain separate increments. An assessment grants no authority; the action contract below separately controls effects.

## Confirmed actions, standing permissions and Log

The owner’s October 2 clarification accepts effects in addition to diagnosis
([ADR-0023 amendment](adr/ADR-0023-app-tools-and-delegated-authority.md#october-2-amendment-confirmed-background-actions)).
Background may request app operations or host commands, including file edits. Native Claude tools remain disabled: every request uses
`request_action` and is written to SQLite before execution. `get_action_permissions` describes the contract; `get_actions` reads outcomes
for the admitted issue. The installed OpenAPI contract is available through bounded documentation reads.

All three permissions default to **Ask every time** in **Agents → Background assistant → Settings**:

| Permission | What allowing it authorizes |
| --- | --- |
| App actions | Future requests to the existing owner API, including previews, agent launch/input and worktree operations, through the same validators and operation gates |
| Host commands and file changes | Future executable/argument requests as the host user, including explicit shell programs, file changes and network use |
| Readiness and risk decisions | In combination with App actions, explicit delegation of decisions normally acknowledged by a person, including Plan approval and reconciliation; this never supplies native idle/completion evidence |

Saving requires explicit acknowledgement and a current permission revision. It never approves an existing proposal. The model has no
permission-setting tool; the app-action path rejects Background’s own endpoints, private capabilities and lifecycle hooks. An action is
bound to its exact payload, instance, enablement, issue revision, semantic source version, permission revision and a 30-minute expiry.
Changed or revoked inputs cannot authorize it. App-specific preview digests, branch/roster versions and manual-input checks still apply.
Plan keeps its original human-only setting: a separately delegated approval freezes `authority: background` with the action ID and policy
revision. Delegated inspection records are separate from human inspection. Neither type changes unknown process evidence into idle.

**Log** shows requests needing a decision before the history. Inspect the exact command or app body, check the acknowledgement, then
**Approve and run** or **Deny action**. Permitted future requests may run with the browser closed. Only one effect runs at a time;
other allowed requests wait for its settlement and are revalidated before admission. There are at most four proposals per investigation
and 100 pending proposals. Duplicate request keys and equivalent payloads return their original record instead of replaying a possible
effect. A completed action after its investigation ended may trigger a fresh investigation, within the existing job rates and budgets.
That follow-up grants no further effects by itself.

Host commands use argument arrays, stdin, a 120-second bound, an 8 KiB captured-output bound and process-group cancellation. They do not
inherit the app token or tmux/hook environment. This is full same-user host access, **not an OS sandbox or a path confinement mechanism**.
A program can access other directories, launch programs or perform network operations. The audit records requested commands and results,
not every filesystem write or system call inside a program; it cannot resist deliberate same-user modification of its own database.
A command exit or app HTTP receipt does not prove that all effects or a workflow task completed.
While manual terminal input holds any worktree, a host command is refused before it starts. Like any refusal before launch, it is recorded
as failed and does not hold the action slot.

The database retains action payloads, rationale, principal, authorization source and revision, timestamps, native PID, bounded/redacted
results, refusals and unknown outcomes. It also logs tool requests/results, job starts/finishes, lifecycle controls and permission changes.
History pages contain 50 entries and have stable cursors; audit history is not automatically pruned. Credential literals are refused in
proposals and recognized credentials are redacted in results. No model reasoning trace is requested or recorded.

Disable cancels the active command or app delivery; earlier effects may remain. Restart changes in-flight actions to **uncertain**,
never retries them, and retains their slot. **Record inspection** requires an owner note and refuses a still-running recorded command
process group. It releases only the Background action slot; original app operations and their holds remain authoritative. Stop Background
refuses unresolved effects as well as unresolved model jobs.

`GET /api/v1/background/actions?before=<entry-id>` reads Log and unresolved requests. Owner POST on the same route saves permissions or
approves, denies and reconciles an exact proposal. App execution uses one-use, exact-request grants alongside the ordinary owner HTTP
authentication; the model never receives that credential. Claims, decisions and audit events share the existing SQLite owner.

Action tests include a real temporary-file write, cancellation and surviving process groups; real owner HTTP, grant replay/forgery,
source/policy revocation, queued work, restart, paging, and delegated Plan authority. Browser tests exercise Log confirmation and concurrent
permission changes on desktop and iPhone Chromium viewports. `npm run probe:background:actions` is an opt-in installed-Claude probe:
Claude Code 2.1.288 / Haiku, and on October 3, 2026 2.1.289 / Haiku, each proposed one synthetic file write; it remained pending until the fixture owner confirmed, then executed once
and produced SQLite audit records. This is synthetic local acceptance, not production-data or physical-device acceptance.
