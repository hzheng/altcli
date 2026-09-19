# The review-handoff skill

**Current contract:** the skill below remains the operating staging protocol at `46f228b`. Its deprecation direction is recorded in [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode); no new skill is installed by this documentation-only change.

`skills/review-handoff/SKILL.md` is the single canonical skill. This PR does not edit
its content. ADR-0010 had already added the final RELAY-OUTCOME line before the
hardening review; the original baseline and staging rules remain intact.

```bash
node scripts/install-skills.mjs
node scripts/install-skills.mjs --check
```

The installer links skills into the CLI user directories and refuses to replace a
real directory. It needs only this clone. Links point into this worktree, so edits
or branch switches can change the live skill. Do not alter the skill or global
instructions during a relay without an explicit workflow-change request.

## Mapping relay to the skill

Add this rule deliberately to the global Claude and Codex instruction files:

> When the user's entire message is `relay`, or begins with `relay:`, use the
> `review-handoff` skill. Context after the colon does not change its baseline or
> staging rules. A `[codercrew-command:<UUID>]` suffix is correlation metadata,
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

## Separate future skill contracts

Do not combine incompatible instructions behind a guessed mode. [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) defines ignored planning documents: assigned draft or unified plan only, no staging/commits, exact-version completion, cooperative draft withholding, and an independent approval checkpoint. Native plan mode is adapter-specific; never broaden edit permissions merely to save a draft.

[ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) defines a separate commit-relay skill: clean entry, exact assigned revisions, one direct handoff commit with one appended tracked log entry, permitted project changes, and no unpublished leftovers. The agent/authorized helper commits; the server validates read-only. A review-only or objection turn changes only the log. Work is a proposal, not self-approval; optional self-review is visibly non-independent.

[ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) supplies phase/group roles and action permissions. Group terminology does not rename the legacy skill or change CLI start/Stop pairing. All concrete skill names, parsers, helper APIs, and adapter integrations remain implementation work, with open choices in [OPEN-DECISIONS](OPEN-DECISIONS.md).

The planned [branch-setup exception](adr/ADR-0013-confirmed-branch-setup.md) requires explicit scoped consent at a settled boundary; it is not staging authority, a planning-turn operation, or blanket permission to switch existing branches. Ordinary code review still does not authorize Git mutation.
