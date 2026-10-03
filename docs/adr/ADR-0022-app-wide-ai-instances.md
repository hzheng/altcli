# ADR-0022: App-wide AI instances and background jobs

> October 2, 2026: the [attention-first amendment](#october-2-amendment-attention-first-background-assistant) records the endorsed
> design for the first Background increment. Deterministic attention, the Agents tab, profiles and read contracts are implemented locally;
> the Background runtime is not.

> October 1, 2026: [ADR-0024](ADR-0024-registered-repositories-and-managed-workspaces.md) resolves the app-owned socket choice: Helper and the future Background assistant run as recorded app-wide instances on AltCLI's dedicated tmux endpoint (not yet implemented), which is not isolation.

Status: **proposed future direction; only the Global AI A1 read increment is
implemented** ([guide](../GLOBAL-AI.md)), without installed-provider acceptance.
September 30, 2026.
This records a selectively integrated [design source](../SOURCES.md#september-30-next-step-design-source),
not permission to launch assistants or change the current controller contract.

## Purpose and roles

Provide app-wide help and useful background assessment while preserving native
terminals and deterministic collaboration. Neither role is a mandatory reviewer
or a replacement for the controller; neither enables larger workflow groups.

| Role | Initiator and purpose | Conversation and visibility |
| --- | --- | --- |
| Workspace agent (existing) | Human or controller assigns project planning, work or review | Existing workspace Console |
| Global AI (proposed) | Human asks app questions or discusses the host's projects (A1 reads all of them) | Dedicated app-wide native terminal, available without a dummy project |
| Background assistant (proposed) | Enabled policies select useful events for bounded jobs | Separate instance with compact status and inspectable activity |

Keep the app roles' instance IDs, tmux sessions, conversations, context scopes and
app credentials separate. Background jobs never type into the Global AI prompt.
Sharing approved preferences, summaries or images is explicit and scoped; a
conversation does not silently create a standing policy. App-wide image scope is
a later extension, not reuse of arbitrary workspace-private attachments.

Reuse versioned profiles, exact launch records, native terminal rendering and
the existing host services where suitable. A launch profile, runtime adapter,
requested model, observed model, instance role and delegation policy are distinct
facts. Model options depend on verified adapter capabilities; an unobserved model
is unknown, not the last requested label. Do not prescribe a permanent model list.

## Lifecycle and identified work

Recommend lazy startup after explicit enablement, with one bounded background job
at a time per instance initially. Settings and status should expose the selected
profile, permitted scope, blocked login/quota/startup, current work and pause/stop.
These are proposed product concepts, not existing settings or a fixed state enum.
Startup interaction depends on the scoped access proposed in
[ADR-0021](ADR-0021-project-entry-and-agent-launch.md#proposed-launch-completion-work).

Jobs carry identified triggers, scope, input revisions, claim/attempt identity,
allowed tools, deadlines and budgets. Prefer structured results validated by the
backend; neither schema validity nor an idle-looking terminal proves correctness
or completion. Keep concise evidence, uncertainties and rationale rather than
private reasoning traces. Native lifecycle evidence and operation receipts remain
separate. A surviving tmux runner is not another scheduler or database owner.

Filter and deduplicate events before invoking a model. Unchanged polls, heartbeats
and each terminal byte do not create jobs. Causation and rate/depth limits prevent
explain-notify-explain loops. Already authorized deterministic progression stays
with the controller, without another model approval gate.

Pause stops admission of new jobs; it does not undo an in-flight effect. Stop
accounts for jobs and possible effects before terminating the app-owned instance.
Closing a browser does not cancel enabled background work; Lock revokes browser
access, while stopping that work is separate. Direct human manipulation of an
executing background job invalidates its provenance or requires reconciliation.

On host restart, revoke old credentials and claims, inspect operation receipts,
and deliberately rebind exact surviving instances. Do not blindly spawn a second
runner or replay a possibly executed action. Read-only reasoning may have a new
attempt under policy; uncertain effects require inspection. Exact scoped
conversation IDs, rather than an ambiguous “resume last,” preserve context.

## Identity and application ownership

Record app roles explicitly, bound to exact launch/server/session/pane/process
identities and generations. Do not infer them from a name, cwd or executable.
App-wide instances should use an app-owned directory and stay out of automatic
project-group membership unless deliberately assigned through a supported path.
Infrastructure status cannot hide project writes or exempt them from ownership.

The background agent should use [app tools](ADR-0023-app-tools-and-delegated-authority.md),
not a human keyboard grant to perform app actions. Avoid broad process-name
exclusions from activity evidence. Global AI is human-operated, and its own
terminal is outside the manual-input barrier: no project, run or automated
delivery uses its private session and directory, and its input goes only to its
own pane, so typing there creates no manual-input record and holds no automation
([GLOBAL-AI](../GLOBAL-AI.md#native-input-and-recovery)). Its effectful-tool
self-interference and an optional auxiliary socket remain
[open choices](../OPEN-DECISIONS.md#proposed-app-wide-assistance-and-completion-choices);
neither a role nor a socket establishes OS isolation or bypasses another writer.

## Notifications, budgets and useful degradation

Recommend deterministic in-app notification storage/delivery with deduplication
and receipts. Use the model for interpretation, grouping and concise content;
important baseline alerts must still work when it is unavailable. External
destinations require explicit configuration and privacy choices. Notification
text cannot approve an action or alter a run.

Prefer event batching, current-document retrieval and bounded context over model
polling. Expose job/tool/time limits and measured usage when available; do not
invent remaining quota. Prefer existing CLI authentication only where the
verified provider/adapter permits that mode. Separate sessions may consume the
same allowance. Do not silently switch authentication, billing or model profile,
or copy provider credentials into prompts, tools or the browser.

Disabling assistance stops new jobs and revokes its authority while preserving
uncertain operations, workspace agents and history. Existing terminals, docs,
deterministic progression and recovery remain usable without a model response.

## Delivery and unresolved mechanisms

The recommended sequence is Global AI reads, background read-only jobs,
deterministic notifications, then explicitly delegated effects. See the
[roadmap](../../ROADMAP.md#proposed-app-wide-assistance-and-completion-work) and
[prospective acceptance catalog](../TESTING.md#proposed-app-wide-assistance-and-completion-checks).
Runtime adapters, process/conversation lifecycle, budgets, retention and socket
choice remain open. Conceptual instance, job, notification, documentation and
scoped-preference records describe responsibilities, not new tables or APIs.
Future migrations must preserve existing history and refuse older runtimes that
would ignore new effectful authority.

## October 2 amendment: attention-first Background assistant

Status: accepted through an endorsed two-planner Plan (run `aec693b1`, brief revision 1, plan revision 3); the transition into
Implementation was authorized by that run's automatic policy. **Implemented locally:** deterministic attention, the Agents tab,
role profiles, shared read contracts and the assessment validator. **Not implemented:** the Background runtime and its provider
probe. [BACKGROUND-ASSISTANT](../BACKGROUND-ASSISTANT.md) describes the current behavior.

The first increment diagnoses and notifies; it does not confirm, approve, resume, retry or answer prompts. It has two layers that fail
independently:

| Layer | Decision |
| --- | --- |
| Attention | Always on and model-free. Owned runs that cannot progress, Plan checkpoints that need the human, and uncertain launches or Helper starts become one durable item per issue key. A real change revises the item in place, the issue's end resolves it, and a recurrence opens a new item. Source fingerprints and monotonic versions are written in the same transaction as the source change. A boot pass and a 15-second sweep repair any missed path, and unchanged sources write nothing. Typed pause causes (`user`, `restart`) replace any reading of reason text. Delivery is the in-app list and a heading count; toasts, OS push and external channels are deferred |
| Background diagnosis | After explicit enablement, a settled item version admits one bounded, read-only job. The host validates its answer independently of any CLI schema and attaches it only by compare-and-set to the exact item revision, source version, attempt and enablement. A late answer is recorded as stale. Model failure never affects attention |

Runtime decisions for the pending increment:

- **Instance and endpoint.** One recorded Background instance in tmux, on the same endpoint resolver as Helper: the configured endpoint
  until [ADR-0024](ADR-0024-registered-repositories-and-managed-workspaces.md)'s I4 lands, then the dedicated endpoint. Existing
  instances stay bound to their recorded endpoint, and I4's transition and gate include them.
- **Runner and principals.** The host owns scheduling and storage; a runner in the instance only carries jobs. Job reads use a separate
  capability scoped to one item and its run or launch.
- **Restart.** After a restart, new attempts need an explicit Inspect and Resume.
- **First adapter.** Claude Code is the first candidate, enabled only after a disposable probe verifies structured output and the
  removal of built-in tools. Codex follows only after passing the same probe.
- **v1 limits.** One active job, a 20 s settle, 10 starts an hour at least 30 s apart, a 120 s deadline, 12 tool calls, one automatic
  attempt per item version, and a stop after three consecutive failures.

Store schema 22 adds the attention tables and Background profiles. The change only adds data, so it needs no settlement; it keeps a
private backup, and older versions refuse the store. Standalone setup-operation attention and delegated handling under an owner policy
remain later increments, with no authority granted here.
