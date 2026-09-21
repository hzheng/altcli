# Claude Code project guidance

@AGENTS.md

The `review-handoff` skill is defined in `skills/review-handoff/SKILL.md` and
installed by `node scripts/install-skills.mjs`, which symlinks it into `~/.claude/skills`
and `~/.codex/skills` from the main checkout only; an edit there is live for every
CLI session immediately, while an edit in a linked worktree is live once integrated.
Edit the skill only on an explicit workflow-change request. Never edit user-level
instruction files or skill directories during a relay turn on this repository.
