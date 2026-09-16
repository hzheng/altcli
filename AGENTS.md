# CoderCrew: coding-agent instructions

Read README.md, ROADMAP.md, Architecture_Decision.md and VALIDATION.md before
changing behavior or claiming acceptance. ADR-0011 is the current relay boundary.

## Product and engineering rules

- One host-resident Next.js/Node application, TypeScript both sides, SQLite and
  existing tmux panes. Keep ios/ reserved and third AI deferred. No root manifest;
  repository operations live in scripts/, web tasks in web/package.json.
- HTTP exposes ControlPlane. Controller is an internal transport/read helper;
  WorkflowStore owns runs, exact turn correlation, event dedup and execution gates.
- The browser never sends a continuation from an effect. Viewing/locking/closing a
  page does not change a run. Pair participants and policy are frozen at start.
- Delivery is not completion. Unknown state retains ownership and is never retried.
  A completed chain is not task success. Pause does not interrupt a worker;
  takeover requires deliberate human reconciliation.
- Only current, correlated lifecycle evidence can advance. No prompt-text lookup,
  last-history inference, stale transcript fallback, or missing-fields-means-idle.
  Keep exact prompt echo, command/session/source-turn IDs and instance checks.
- Keep JSON-only types under web/src/contracts/ and synchronize shared/openapi.yaml.
  Route handlers stay thin; filesystem, SQL and tmux access stay server-only.
- Use argument arrays, never shell-concatenated prompts. Preserve tmux process and
  mode checks, metadata outside managed worktrees, localhost and bearer/origin gates.
  Render output as React text, never HTML or instructions to the controller.
- Do not mutate managed Git repositories or weaken tests to pass. Canonical Git
  inspection is read-only; custom worker Git environment overrides are unsupported.
- Installer tests use isolated temporary homes only. Do not edit global CLI config,
  instruction files or installed skills during an ordinary code-review turn.

## Review skill

When explicitly asked for relay or relay: context, use
skills/review-handoff/SKILL.md. Preserve its Git staging contract. A suffix
[codercrew-command:<UUID>] is controller correlation metadata, not another task.
The existing final RELAY-OUTCOME line remains the report format. The hardening PR
changes lifecycle handling, not this skill's staging/baseline rules.

## Validation

Run ./scripts/check.sh and ./scripts/check.sh --e2e for UI changes. Test lifecycle
faults, duplicate events, overlapping pairs, multiple clients, history truncation,
restart, and unknown background work. Preserve fake-vs-real test distinctions.
Restart the development backend after server-code changes: the process singleton
must not be replaced while a delivery is active. No unobserved test is 'passed'.
