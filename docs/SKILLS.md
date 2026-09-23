# Phase-specific handoff skills

`skills/commit-handoff/SKILL.md` is the separate committed implementation contract.
The controller prompt names its exact repository path and a per-command assignment
file under the external data directory. No global alias or skill installation is
required for this path. Optional installed links are still checked if present.
The assignment includes the exact branch, parent, accepted baseline, review range,
action, registration, policy revision, original task, outstanding findings, the
external `resultPath`, and the optional tracked `logPath`.
It authorizes one scoped local publication; the controller never commits it.

Every turn writes one schema-1 JSON object to `resultPath`, outside the checkout;
AltCLI records it in its handoff journal. The object copies every `identity`
field in the assignment and adds `model`, `decision`, `reason`, `needsHuman`,
`summary`, and `checks`. Work has null decision/reason; reviews report
accept/object. A turn commits only when it changed project content; objection and
review-only turns change no project files and publish no commit. When `logPath` is
set (an explicit project preference), the same object is also appended as one line
to that tracked file inside the handoff commit, so every turn commits. `needsHuman`
explicitly stops automatic remediation for out-of-scope questions. See the skill
for limits.

The `review-handoff` skill below is used only by the staging fallback, enabled with
`ALTCLI_ENABLE_LEGACY_RELAY=true`.

`skills/review-handoff/SKILL.md` defines that flow's baseline, staging rules and
final `RELAY-OUTCOME` line. Its contract remains unchanged.

Install dependencies, hooks and all skill links together from the repository root:

```bash
node scripts/setup.mjs
```

The skill installer links into the CLI user directories and refuses to replace a
real directory. Links point into this worktree, so edits
or branch switches can change the live skill. Do not alter the skill or global
instructions during a relay without an explicit workflow-change request.

## Mapping relay to the skill

Add this rule deliberately to the global Claude and Codex instruction files:

> When the user's entire message is `relay`, or begins with `relay:`, use the
> `review-handoff` skill. Context after the colon does not change its baseline or
> staging rules. A `[altcli-command:<UUID>]` suffix is correlation metadata,
> not another task. Stage only the reviewed incoming change exactly as the skill
> defines; an ordinary review request does not authorize staging.

The usual files are `~/.claude/CLAUDE.md` and `${CODEX_HOME:-~/.codex}/AGENTS.md`.
The controller sends `relay:` plus optional context and its unique command marker.
Where no alias rule is installed, use an explicit skill request as the registered
relay prompt instead. Do not rename the skill to create an alias.

## Outcome and lifecycle are separate

The final nonempty response line must be
`RELAY-OUTCOME: <outcome> - <one sentence>`, with one of the four existing outcomes:
`no_incoming_handoff`, `strong_objection`, `accept_without_improvement`, or
`accept_and_improve`. The skill also permits its existing dash format. The hook
reads the current final message, never terminal screen text or a stale transcript.
For `strong_objection`, the sentence is a required standalone, actionable reason;
when the run permits continuation, the server sends that reason to the author as
a normal correction instruction and returns changed work to relay review.

The server additionally requires exact command, prompt, worker/session and turn
correlation, plus clear background-work evidence, before advancing. An outcome
line alone is not proof that work finished safely or that its Git delta is valid.
The skill stages accepted incoming changes and leaves its own improvements
unstaged. The controller performs read-only Git identity checks, never staging,
commit, reset or cleanup operations.

See [SETUP.md](SETUP.md) for installing lifecycle hooks and
[ADR-0011](adr/ADR-0011-server-owned-relay-runs.md) for execution ownership.

## Planning handoff

`skills/plan-handoff/SKILL.md` is loaded from its exact repository path, separately
from the committed and staging protocols. Its immutable assignment is stored under
the external data directory. The assigned planner writes only its draft or shared
plan under `<data directory>/plans/<run-ID>/` and the exact `<commandId>.result.json`
beside its assignment; nothing is written into the checkout.
`PlanResult` defines the strict schema: copied identity, outcome, output SHA-256,
model, summary and optional blocking reason. This is a local file-result protocol,
not an HTTP token passed to an agent or a screen/outcome parser.

Publish the result **before** the correlated lifecycle completion. The controller
captures bounded, stable UTF-8 bytes only with unchanged code/branch/index,
protected peer artifacts, matching identity/hash and clear activity evidence.
Duplicate events are consumed once; a missing/invalid/late result remains paused
and is never polled into success. Only draft/synthesis/revision turns report
`complete`; review reports `accept` or `object`; `blocked` never advances.
Existing lifecycle hooks stay unchanged. The controller does not invoke a native
plan mode or infer permissions from provider names; output restrictions and draft
withholding are cooperative and still require installed-host acceptance.

Do not combine incompatible instructions behind a guessed mode. [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) defines planning documents kept in AltCLI's data directory: assigned draft or unified plan only, no staging/commits, exact-version completion, cooperative draft withholding, and an independent approval checkpoint. Native plan mode is adapter-specific; never broaden edit permissions merely to save a draft.

[ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) defines a separate commit-relay skill: captured unfinished input for initial work, clean entry for reviews and later turns, exact assigned revisions, one published result recorded in the handoff journal, at most one direct handoff commit with permitted project changes (optionally mirroring the entry into a tracked log), and no unpublished leftovers. The agent/authorized helper commits; the server validates read-only. A review-only or objection turn changes no project content and, without a tracked log, commits nothing. Work is a proposal, not self-approval; optional self-review is visibly non-independent.

[ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) supplies phase/group roles and action permissions. Each phase has its own skill contract while sharing CLI lifecycle checks. Native plan-mode and additional adapter integrations remain future work, with open choices in [OPEN-DECISIONS](OPEN-DECISIONS.md).

The implemented local [branch-setup exception](adr/ADR-0013-confirmed-branch-setup.md) requires explicit scoped consent at a settled boundary; it is not staging authority, a planning-turn operation, or blanket permission to switch existing branches. Ordinary code review still does not authorize Git mutation.
