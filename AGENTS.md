# CoderCrew: coding-agent instructions

**Documentation authority:** [ADR-0012 through ADR-0018](Architecture_Decision.md#accepted-collaboration-direction-not-yet-implemented) and the linked guides now own the accepted collaboration design; there is no separate design draft to consult. These are target decisions, not claims that new runtime features or skills exist; [OPEN-DECISIONS](docs/OPEN-DECISIONS.md) remains unresolved.

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

Project tests, builds, lint and type checks are already authorized, including npm,
Node test scripts and scripts/check.sh; do not ask for conversational confirmation.
Reuse applicable saved command approvals. Prefer direct commands; avoid changing
environment wrappers or log redirections that turn an approved test into a new
approval request. CLI-enforced permission rules still apply.

Run ./scripts/check.sh and ./scripts/check.sh --e2e for UI changes. Test lifecycle
faults, duplicate events, overlapping pairs, multiple clients, history truncation,
restart, and unknown background work. Preserve fake-vs-real test distinctions.
Restart the development backend after server-code changes: the process singleton
must not be replaced while a delivery is active. No unobserved test is 'passed'.

## Implementing the next collaboration increments

Follow [ROADMAP](ROADMAP.md#migration-and-implementation-sequence), [WORKFLOWS](docs/WORKFLOWS.md), and the applicable ADR. Preserve the legacy skill and verified staging behavior. Use **group** for the new product/API design while preserving historical pair IDs through an explicit migration; do not rename vendor event pairing or invalidate active runs incidentally.

Projects are identified by canonical Git common directory; worktrees and their standard indexes remain independent execution boundaries. Discovery is read-only; Start binds exact eligible instances. Users prepare environments and agent directories. ADR-0013 permits two scoped, confirmed setup operations: creation/check-out of a new branch at a settled boundary (clean entry or captured unfinished input for the first work turn), and creation of a new task branch with a linked worktree at an exact committed baseline. Task worktrees default to ~/.codercrew/<repo-name>/<branch-name>; no existing checkout is switched and dirty source files are not copied. The default branch and configured integration branches are starting points only, never implementation branches; an existing task branch keeps a confirmed baseline, and integration is a separate explicit step (squash recommended). ADR-0013 separately permits three confirmed end-of-task operations on a linked task worktree: one previewed squash commit into the integration branch made in that branch's own clean, unowned checkout under normal hook policy; non-force removal of a clean, unused worktree after verified normal or squash integration, retaining branch/history; and forced discard of the worktree plus branch deletion after the typed branch name, with the journal archived first. Each keeps durable uncertainty ownership. This does not authorize an ordinary agent review to mutate Git, or allow controller staging, handoff commits, automatic removal or discard, environment bootstrap, cleanup, or history rewriting. Uncertain creation retains its durable setup owner until explicit inspection; never retry or roll it back automatically.

Planning uses ignored documents and captured results; implementation uses the selected handoff contract. Do not silently turn proposed schemas, provider capabilities, N-agent rollout, automatic peer-objection routing, or other open choices into accepted behavior. Update the canonical ADR/guide instead of reintroducing a monolithic design draft. All acceptance claims must name what actually ran.
