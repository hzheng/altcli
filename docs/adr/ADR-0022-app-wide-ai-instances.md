# ADR-0022: App-wide AI instances and background jobs

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
exclusions from activity evidence. Global AI is human-operated and its native
input may create the existing server-wide barrier. Its effectful-tool
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
