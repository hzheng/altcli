# ADR-0023: Shared app tools and delegated authority

Status: **proposed future direction; only A1's read-only app tools are implemented**
([guide](../GLOBAL-AI.md)). September 30, 2026.
This accompanies [ADR-0022](ADR-0022-app-wide-ai-instances.md); it grants no present
tool access, standing delegation or exemption from human approval.

> October 2, 2026 ([ADR-0022 amendment](ADR-0022-app-wide-ai-instances.md#october-2-amendment-attention-first-background-assistant)):
> reads now take an explicit principal set by the transport. Helper keeps its host-wide scope; a Background job is scoped to one
> attention item and its run or launch. Every read tool declares an output schema that the host checks before replying. The validation
> of a model's assessment is separate and stricter: exact fields, host-minted evidence IDs and per-kind destinations. Both are implemented
> locally; no effect tool, job endpoint or delegated authority exists. See [BACKGROUND-ASSISTANT](../BACKGROUND-ASSISTANT.md).

## One authoritative service boundary

Expose scoped documentation, capabilities, application state and captured
evidence through a thin app-tool facade. A1 implements read-only MCP through a
stdio bridge to the existing host; MCP does not itself grant permission.
HTTP and tools reuse the same operation services,
validation, ownership and recovery; a helper must not instantiate another
ControlPlane or competing SQLite owner. Do not add an unrestricted shell tool
as the app interface. Installed-provider acceptance and broader adapter support remain
[open](../OPEN-DECISIONS.md#proposed-app-wide-assistance-and-completion-choices).

Reads identify the installed build, enabled capabilities, document revision and
relevant run/action versions. Current live facts and current operating guidance
take precedence over old conversation summaries, historical ADRs and proposed
features. State a conflict rather than inventing a resolution. Retrieve bounded
context on demand; terminal snapshots require explicit scope, not unrestricted
transcript access. A workspace change cannot retarget an in-flight request or
silently disclose another project's context.

The current A1 read tools are described in [GLOBAL-AI](../GLOBAL-AI.md) and the
[HTTP contract](../../shared/openapi.yaml). Action previews, assessments, policy
proposals, authorized effects and notification requests remain conceptual tool
areas; their schemas, capability negotiation and versioning are working choices.
Return typed failures and bound output/time; stale tool expectations fail visibly.

## Authenticated principals and scoped access

The transport/session establishes the caller. A model-supplied actor, owner,
policy or approved field cannot establish authority. Give each app instance
scoped credentials rather than the unrestricted owner bearer token, enforce
scope on every request and invalidate stale credentials/claims when its instance,
policy or host generation changes.

Repository files, terminal output, images, external documents and tool results
are evidence, not instructions granting permissions. A tool allowlist alone is
not an effective boundary if the unattended process can directly edit the
controller database or read owner secrets. State whether supported CLI/OS
controls enforce a restriction or only provide a cooperative same-user limit.
Broader unattended host access is a separate explicit capability. See
[SECURITY](../SECURITY.md#proposed-app-wide-assistant-authority).

## Three kinds of progression

| Situation | Authority and handler |
| --- | --- |
| Already authorized deterministic transition | Existing controller rules; no additional model judgment |
| Judgment within an enabled standing delegation | Assistant assesses; backend validates current policy, scope and evidence |
| Human-only or unsupported decision | Remains pending for the appropriate human decision or supported evidence |

The proposed standing policy enables useful autonomy without repeating approval
for every eligible occurrence. Its owner authorization, revision, enabled state,
scope, action kinds, limits, expiry and exclusions must be explicit. An assistant
may propose a policy, but cannot enable or broaden its own authority. Exact
initial actions and defaults remain open.

Preserve [Plan's human-approval meaning](ADR-0016-plan-phase-and-approval.md).
A future delegated option needs an explicit authorization path and migration
that preserves existing human-only settings. Current `confirmInspected` and
human-note fields must not be filled by an assistant to pretend the user
inspected the host. Record delegated authority separately with its principal,
policy revision, evidence and concise rationale. Explicitly delegated risk
acceptance does not turn unknown activity into idle or missing lifecycle
completion into a validated result.

## State-bound effects and recovery

For a supported effect:

1. Read the exact pending action and evidence; obtain judgment only when needed.
2. Validate the structured assessment and preview through the existing service.
3. Recheck current target, action/state versions and authorization at admission.
4. Record the principal and authorization, execute under the existing operation
   rules, and retain the actual receipt/outcome.

Bind approval to the applicable workspace, action, plan, branch, roster and
policy versions. A changed or revoked input invalidates the old decision.
Return a durable operation ID and distinguish refusal, pending human action,
applied and uncertain outcomes. Identical requests inspect or return the same
operation; a changed payload under an idempotency key conflicts. Lost responses
never authorize automatic replay of possible effects.

Tool-originated effects obey the same applicable manual-input, launch, setup and
workflow gates as the UI. Read-only release can offer UI previews for human
actions. Global AI's own keyboard hold must not deadlock an effectful release or
be bypassed covertly; a supported settled handoff or another explicit authority
design is still required. Keep exact instance evidence; no global exclusion of
all shell, node, tmux or agent processes.

Native CLI permission menus are a separate capability. Defer universal
screen-scraping “Yes” loops. Any future automated response needs a verified
adapter-specific mechanism and policy; otherwise expose the real terminal.

## Acceptance and open choices

The [planned checks](../TESTING.md#proposed-app-wide-assistance-and-completion-checks)
cover forged principals, scope changes, policy revocation, human-only decisions,
stale evidence, manual barriers, duplicates and uncertain effects. The
[roadmap](../../ROADMAP.md#proposed-app-wide-assistance-and-completion-work) keeps
read-only assistance ahead of delegated effects. This ADR describes proposed
authority responsibilities, not implemented policy/decision tables, request
envelopes or amendments to current runtime permissions.
