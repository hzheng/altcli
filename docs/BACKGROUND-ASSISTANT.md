# Agents tab, attention and the Background assistant

## Scope and status

Implemented locally on October 2, 2026, from the endorsed Plan of run `aec693b1` (revision 3) recorded in the
[ADR-0022 amendment](adr/ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant):

- a central **Agents** tab with three kinds of agents, each with its own profiles;
- **attention**: deterministic, durable records of runs, Plan checkpoints and launches that need you, with no model involved;
- shared read contracts for Helper and a future Background job: output schemas, explicit principals and new attention and launch reads;
- a strict validator for future Background assessments.

**Not implemented:** the Background runtime itself, meaning its recorded instance, jobs, enablement, AI explanations and the
installed-provider probe. Nothing in this version starts a Background process or sends data to a model provider. Fixture, unit and
browser checks are not installed-host acceptance.

## The Agents tab

The top bar is **Console · Projects · Agents · Settings**. Agents holds three kinds:

| Kind | Sections |
| --- | --- |
| Workspace agents | **Inventory**: the selected checkout's agents, with status and **Show … in Console**. **Profiles**: the agent launch profiles that were in Settings → Console preferences |
| Helper | **Chat**, **Session**, **Profiles** (formerly Settings), **Evidence** and **Guide**. `/global-ai` opens Agents → Helper → Chat |
| Background assistant | **Attention** (the default), **Activity**, **Profiles** and **Settings** |

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
job, once the runtime exists, reads only its admitted item and that item's run or launch: no host-wide listing, and a `get_run` without
plan text, objection text or the publication summary and checks. `get_capabilities` reports contract `global-ai-read-v2` and
`backgroundAssistant: { attention: true, runtime: "unavailable", enabled: false }`.

## Assessment validation

A future Background job's answer will be validated by the host independently of any CLI-side schema:

- exact fields, with the item ID and revision echoed exactly;
- bounded plain text, rejecting control and bidirectional-override characters;
- one to six citations of host-minted evidence IDs actually served to that attempt;
- a destination allowed for the item's kind.

One bad citation rejects the whole answer. A valid assessment proves its citations' provenance, not its interpretation, and it cannot
approve, resolve, certify readiness or act.

## Storage, upgrade and recovery

Store schema 22 adds `attention_sources` and `attention_items` and the run field `pauseCause`. The upgrade from schema 20 or 21 only adds
data, so it needs no settled store, and it keeps a private `altcli-schema-<n>-<time>.sqlite3` backup first. Pre-registry stores still meet
the [ADR-0024](adr/ADR-0024-registered-repositories-and-managed-workspaces.md#upgrade) gate. Older versions refuse a schema-22 store, so
rollback restores that backup with its matching version while nothing is in flight.

Upgrading restarts the backend: stop the old one while no delivery is active. The usual recovery then pauses owned runs (with
`pauseCause: restart`) and marks interrupted deliveries and starting launches uncertain. It keeps their owners and replays nothing, and
attention raises an item for each.

## Tests

| Command (from `web/`) | Covers |
| --- | --- |
| `node --experimental-strip-types --test scripts/attention.test.ts` (part of `npm run test:workflow`) | Real SQLite and workflow fixtures: typed pauses, revisions, A → B → A versions, rollback, sweep repair, stale records, paging, Mark seen, launches, Helper starts, the schema-21 upgrade and the assessment validator |
| `npm run test:global-ai` | Output-schema conformance, job scope, the minimized job view, MCP structured replies and Background profile validation |
| `npx playwright test e2e/agents.spec.ts` | A real paused run in Attention, Mark seen and navigation-only Open, launch and Helper destinations, paging, and the three kinds and their profiles |

## Not yet implemented

The Plan's P4 remains. It covers a recorded Background instance in tmux on Helper's endpoint resolver, its runner, explicit enablement, and
bounded read-only jobs. Its v1 limits are:

- a 20 s settle and one job at a time;
- 10 starts an hour, at least 30 s apart, and a 120 s deadline;
- 12 tool calls and one automatic attempt per issue version;
- a stop after three consecutive failures.

It also covers explicit Inspect and Resume after a restart, and a disposable Claude Code probe before any adapter is enabled. Later
increments remain separate: setup-operation attention, toasts or OS push, external notifications and delegated handling.
