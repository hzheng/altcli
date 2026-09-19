# ADR-0018: Optional remote publication and deliberate history retention

Date: September 19, 2026

Status: Accepted design direction; implementation and host acceptance pending.
Items explicitly labeled working specification, recommendation, or open choice retain that status.
This documentation-only change does not enable the described features.

Relationship: Future publication extensions to ADR-0011; no remote worker implementation is claimed.

## Context

A Git remote exchanges committed implementation artifacts; a PR is an optional review and integration surface. Planning drafts, execution control, and environment state require separate handling.

## Decision

### Local versus remote scope

Remote human control through the web console does not move agents or require Git synchronization. The current local group contract requires all selected instances to operate in the same canonical directory/worktree/index. Future remote-worker groups will need explicit host-aware membership and code/publication identity instead of local directory equality. That is an extension, not an automatic exception to local validation.

### Shared Git remote for multiple hosts

```text
Worker host A: local checkout and coding CLI
        ↓ push completed handoff
Designated shared Git remote / task branch
        ↓ fetch exact published revision
Worker host B: separate local checkout and coding CLI
```

Local commit creation and remote publication are different states; the next host cannot consume a commit that has not reached the configured destination. Use one designated shared remote for ordering and discovery; GitHub is an option, not a requirement. Git exchanges committed artifacts only; multi-host worker control, registration, environments, and secrets are a deferred transport.

Index equality becomes mode-specific: the deprecated staging protocol requires the same mutable worktree/index. Local planning/implementation reservations can still use a canonical local workspace/index key to exclude competing runs. For remote commit relay, global ownership is tied to task/history/publication identity, while local execution locks include host identity. Do not compare absolute index paths across hosts or interpret identical paths on different hosts as the same workspace.

A PR supplies hosted discussion, review, CI, and integration; it does not transport commits. Local relay needs no remote and no PR; cross-machine relay needs shared publication and still no PR; formal hosted review adds one PR per task. GitHub credentials are not a prerequisite for the first useful local commit relay.

Ignored plan documents are not a remote mechanism: a remote human can view them through the controller, but N planners distributed across hosts need explicit controller-managed draft transfer, identity, and barrier handling, and a remote implementation worker receives the frozen final-plan text with its task or through a deliberately selected tracked implementation-start record. Same-host planning is the first scope.

### History, integration, and operating costs

Every completed turn retains who participated, what revision it evaluated, what it concluded, and why: the committed log in Implementation, the controller-held revision and result history in Plan. Give the next agent the relevant entry, unresolved findings, brief, and exact code range rather than the whole growing log. The expected gain is less handoff ambiguity and coordination chatter, not a proportional cut in model tokens.

Intermediate commits are task history; whether they all reach the main branch is an integration choice. Squash merge versus preserving task commits, and whether the relay log is retained, archived, or omitted at integration, are decided deliberately; the log is never deleted mid-run, and deleting a squashed branch does not preserve every reference.

Do not assume Git metadata is the dominant operating cost. Likely costs include full CI on every small handoff, multiple working directories with their environments, remote authentication and publication failures, and maintaining two handoff modes or every configuration combination. The testing direction is focused checks during turns and a full acceptance gate on the final candidate, with results always naming the revision they tested. Parallel drafts can reduce wall-clock time when resources permit, but do not eliminate the inference cost of N proposals and may face shared rate limits. Keep N+1 working plan documents, not per-turn files. Each plan edit can require N-1 further endorsements, so avoid low-value formatting/wording churn and expose budget usage. Preserve final text and authority even after temporary drafts are discarded. More agents is an optional choice, not a promise of a better plan.

## Consequences and acceptance

The constraints and unresolved choices above are part of this decision, not implied runtime guarantees. Implementation must pass the applicable [acceptance scenarios](../TESTING.md#acceptance-scenarios). Sequence delivery through [ROADMAP](../../ROADMAP.md#migration-and-implementation-sequence); preserve unresolved choices in [OPEN-DECISIONS](../OPEN-DECISIONS.md).
