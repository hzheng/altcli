# The review-handoff skill

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
