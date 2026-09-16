# ADR-0006: No root manifest; web owns npm tasks; root scripts are repository operations

**Date:** September 15, 2026  
**Status:** Selected for the scaffold  
**Amends:** ADR-0002's "root forwarding `package.json`"

## Context

ADR-0002 added a root `package.json` whose only content was scripts forwarding
into `web/`. It declared no dependencies and owned no code. The reference project
(TimedGoal) has neither a root manifest nor root launchers: every task is
`cd web && npm run <task>`, with `pre*` hooks and `web/scripts/` for tooling.

Two things in CoderCrew are genuinely not web-package concerns: `scripts/setup.mjs`
writes `web/.env.local`, and `scripts/install-skills.mjs` links the root `skills/`
directory into `~/.claude/skills` and `~/.codex/skills`.

## Decision

- `web/package.json` is the source of truth for every JavaScript task: `dev`,
  `build`, `start`, `typecheck`, `test:smoke`, `test`, `e2e`, and the aggregate
  `check` (smoke, typecheck, unit, build) and `check:e2e` (plus browser tests).
- Root `scripts/` holds repository operations invoked with plain `node`:
  `node scripts/setup.mjs`, `node scripts/install-skills.mjs [--check]`. No shell
  wrapper forwards a single npm task; the documented form is `cd web && npm run …`.
- One thin root gate, `./scripts/check.sh [--e2e]`, exists because it combines two
  owners: the skill-link check and the web gate. CI runs exactly that plus the
  Playwright install and `npm run e2e`.
- No root `package.json`. Reintroduce a root manifest only when the root gains a
  real dependency-management or workspace role, for example a second JavaScript
  package such as a shared protocol library.

## Consequences

Commands run from `web/` or by path from the root, matching TimedGoal. `npm run`
inside `web/` remains the discoverable task menu. `.nvmrc` stays at the root for
`nvm use` before `cd web`.
