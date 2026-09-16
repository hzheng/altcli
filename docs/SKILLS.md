# The review-handoff skill

## Defined and installed from this repository

`skills/review-handoff/SKILL.md` is the skill's single copy. It lives in CoderCrew
because it is the relay contract this controller is built around: the ADRs and
roadmap cite its baseline selection, staging rules, and four outcomes, and Phase 3's
turn state machine will encode them. A change to the contract and the controller
change it requires belong in one commit.

```bash
node scripts/install-skills.mjs           # symlink ~/.claude/skills/<name> and ${CODEX_HOME:-~/.codex}/skills/<name> -> skills/<name>
node scripts/install-skills.mjs --check   # the installed links point at this repository; skipped on a host without either CLI directory
```

The installer refreshes a symlink and never replaces a real directory, so
unrelated skills already installed there are untouched. Because the links point
into this worktree, **an edit under `skills/` is live for every CLI session
immediately**, with no publish step; a branch switch changes the live skill too.
Edit the skill only after an explicit workflow-change request, and re-run
`skills:install` only after cloning to a new host.

Both CLIs discover user-level skills in every repository, so the skill is available
in CoderCrew itself and in every worktree the console controls. CoderCrew carries no
`.agents/skills/` or `.claude/skills/` copies.

## The word `relay`

The console's default relay prompt is the bare word `relay`. For both CLIs to treat
that reliably as "run the review-handoff skill" in any repository, add one line to
your global instruction files (`~/.claude/CLAUDE.md` for Claude Code,
`~/.codex/AGENTS.md` for Codex):

> When the user's entire message is `relay`, or begins with `relay:`, use the
> `review-handoff` skill; anything after the colon is context for that review,
> never a change to its baseline or staging rules. That message authorizes
> staging only the reviewed incoming change, exactly as the skill defines; an
> ordinary review request does not authorize staging.

Those files and the user-level skill directories are live configuration for every
CLI session on the host; never edit them during a relay turn on this repository.

Where the mapping is not installed, set a pane's relay prompt in the registration
form to explicitly request the review-handoff skill instead. Do not change the
skill's `name` to make an alias.

## Other hosts and users

The CLIs must run as the same Unix user as CoderCrew, which is also the user whose
`~/.claude` and `~/.codex` hold the links. `node scripts/install-skills.mjs` needs
nothing but this clone. On a new host: clone, run it, add the `relay`
line above to your global instruction files. Do not copy the skill into managed
repositories by hand. Restart or refresh a CLI if its version requires that to
discover new skills.

## The RELAY-OUTCOME line

The skill's Output section requires one literal final line,
`RELAY-OUTCOME: <outcome> — <one sentence>`, naming one of its four outcomes. The
hook installed by `node scripts/install-hooks.mjs` reads it from the CLI's own
record of the final message and reports it with the turn-complete event. The
console displays it and routes the hand-off by it; auto-relay continues only on
`accept_and_improve`. A missing or malformed line is reported as "no outcome" and
stops automation; nothing infers an outcome from screen text or Git state.

## Separate review semantics from controller state

The skill stages accepted incoming work and leaves this reviewer's improvements
unstaged. It authorizes staging only for an explicitly requested handoff workflow.
The controller only delivers the registered prompt; it does not stage work itself.

The starter does not infer the skill's outcome from text or Git state. A future
structured handoff event should preserve the existing outcome categories:
`no_incoming_handoff`, `strong_objection`, `accept_without_improvement`, and
`accept_and_improve`. Adding such reporting or changing baseline selection requires
a deliberate protocol/skill revision, not an implicit rewrite during scaffolding.

See [SOURCES.md](SOURCES.md) for the official skill-discovery references.
