# Collaboration documentation migration map

Date: September 19, 2026

This is a navigation and provenance record, not another standalone design specification. The maintained ADRs and guides contain the actual decisions, rationale, detailed rules, examples, rollout, open choices, and acceptance scenarios. Future edits belong in those documents.

## Controlling input and baseline

The supplied revised `Collaboration-Design.md`, based on V4, is the controlling input. Its exact bytes are identified by SHA-256 `d8430089eeddc5d2836b6985004a8f039e65fc48e0ff6c0a30a49bc45afe9f10`. The repository base for this documentation change is `46f228b16658cd120515e717558d1def2e6e6a57`.

The input contains 26 numbered sections, 50 decision records (D01-D50), and 115 tabulated acceptance scenarios, plus explicit solo acceptance prose. All have maintained destinations below. No copy of the monolithic source is needed to use the new documents.

The inspected base tree does not contain a tracked `Collaboration-Design.md`; therefore this PR does not pretend to delete a repository file that is absent. It integrates the uploaded draft without adding that monolith. Once this documentation change is merged, the user's external/local draft can be dropped. Earlier filenames remain provenance labels, not required linked dependencies.

## Maintained document responsibilities

The [architecture index](../Architecture_Decision.md) retains all 50 decision IDs, their full statements, and their status labels, and links ADR-0012 through ADR-0018. The [workflow guide](WORKFLOWS.md) owns vocabulary, the end-to-end flow, and UI semantics. [ROADMAP](../ROADMAP.md#migration-and-implementation-sequence) owns sequencing, [TESTING](TESTING.md#acceptance-scenarios) owns the acceptance catalog, [SECURITY](SECURITY.md#validation-and-permissions) owns validation/permission rules, and [OPEN-DECISIONS](OPEN-DECISIONS.md) owns unresolved choices. [SOURCES](SOURCES.md) preserves baseline comparison, evidence scope, source precedence, and superseded alternatives.

Existing setup instructions, current behavior, runtime skill, and historical ADRs are not rewritten to claim the future design already shipped. README, SETUP, SKILLS, and AGENTS point to the maintained future direction while preserving the current operating contract. No source code, schema, dependency, installed hook configuration, or executable skill changes are part of this PR.

## Source-section destinations

| Source section | Maintained home |
| --- | --- |
| 1. Scope and decision status | [Architecture_Decision.md](../Architecture_Decision.md#scope-and-decision-status) |
| 2. Product purpose, retained architecture, and comparison with the reference implementation | [SOURCES.md](SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation) |
| 3. Separate workspaces, groups, phases, policies, and handoffs | [WORKFLOWS.md](WORKFLOWS.md#separate-workspaces-groups-phases-policies-and-handoffs) |
| 4. Optional Plan phase in one shared workspace | [ADR-0016-plan-phase-and-approval.md](adr/ADR-0016-plan-phase-and-approval.md#optional-plan-phase-in-one-shared-workspace) |
| 5. Plan approval, phase transition, and final-plan retention | [ADR-0016-plan-phase-and-approval.md](adr/ADR-0016-plan-phase-and-approval.md#plan-approval-phase-transition-and-final-plan-retention) |
| 6. Deprecate the uncommitted relay mode | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#deprecate-the-uncommitted-relay-mode) |
| 7. Commit-based handoff contract | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#commit-based-handoff-contract) |
| 8. One tracked append-only relay log | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#one-tracked-append-only-relay-log) |
| 9. What the log records and what Git supplies | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#what-the-log-records-and-what-git-supplies) |
| 10. Revision identity and review scope | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#revision-identity-and-review-scope) |
| 11. Review decisions and derived change status | [ADR-0014-commit-relay-and-deprecation.md](adr/ADR-0014-commit-relay-and-deprecation.md#review-decisions-and-derived-change-status) |
| 12. Unify execution and separate collaboration policies | [ADR-0015-collaboration-policies-and-solo.md](adr/ADR-0015-collaboration-policies-and-solo.md#unify-execution-and-separate-collaboration-policies) |
| 13. Peer relay behavior | [ADR-0015-collaboration-policies-and-solo.md](adr/ADR-0015-collaboration-policies-and-solo.md#peer-relay-behavior) |
| 14. Worker and reviewer behavior | [ADR-0015-collaboration-policies-and-solo.md](adr/ADR-0015-collaboration-policies-and-solo.md#worker-and-reviewer-behavior) |
| 15. Workspace-first UI, groups, phases, and actions | [WORKFLOWS.md](WORKFLOWS.md#workspace-first-ui-groups-phases-and-actions) |
| 16. Role changes and phase boundaries | [ADR-0015-collaboration-policies-and-solo.md](adr/ADR-0015-collaboration-policies-and-solo.md#role-changes-and-phase-boundaries) |
| 17. Server-owned orchestration and invariants | [ADR-0017-phase-orchestration-and-evidence.md](adr/ADR-0017-phase-orchestration-and-evidence.md#server-owned-orchestration-and-invariants) |
| 18. Publication, hooks, and completion evidence | [ADR-0017-phase-orchestration-and-evidence.md](adr/ADR-0017-phase-orchestration-and-evidence.md#publication-hooks-and-completion-evidence) |
| 19. User-prepared workspaces, branch consent, and remote operation | [ADR-0012: workspace/discovery](adr/ADR-0012-workspace-discovery-and-groups.md), [ADR-0013: branch consent](adr/ADR-0013-confirmed-branch-setup.md), [ADR-0018: remote operation](adr/ADR-0018-remote-publication-and-history.md) |
| 20. Validation and permissions | [SECURITY.md](SECURITY.md#validation-and-permissions) |
| 21. Manual handoffs, pauses, and recovery | [ADR-0017-phase-orchestration-and-evidence.md](adr/ADR-0017-phase-orchestration-and-evidence.md#manual-handoffs-pauses-and-recovery) |
| 22. History, integration, and operating costs | [ADR-0018-remote-publication-and-history.md](adr/ADR-0018-remote-publication-and-history.md#history-integration-and-operating-costs) |
| 23. Migration and implementation sequence | [ROADMAP.md](../ROADMAP.md#migration-and-implementation-sequence) |
| 24. Acceptance scenarios | [TESTING.md](TESTING.md#acceptance-scenarios) |
| 25. Open choices and intentionally deferred work | [OPEN-DECISIONS.md](OPEN-DECISIONS.md#open-choices-and-intentionally-deferred-work) |
| 26. Sources, superseded alternatives, and interpretation | [SOURCES.md](SOURCES.md#sources-superseded-alternatives-and-interpretation) |

The executive summary, complete end-to-end flow, and final design principle are retained in [WORKFLOWS](WORKFLOWS.md). Source provenance and history are in [SOURCES](SOURCES.md#collaboration-documentation-migration); the original table of contents is replaced by this document map and the ADR index.

## Decision ownership

The full decision text and original status remain in the [decision ledger](../Architecture_Decision.md#decision-ledger). These are primary maintenance owners; related guides provide examples and acceptance details.

| Decision ID | Primary owner |
| --- | --- |
| D01 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D02 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D03 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D04 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D05 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D06 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D07 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D08 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D09 | [ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) |
| D10 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D11 | [ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) |
| D12 | [ADR-0018](adr/ADR-0018-remote-publication-and-history.md) |
| D13 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D14 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D15 | [ADR-0018](adr/ADR-0018-remote-publication-and-history.md) |
| D16 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D17 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D18 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D19 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D20 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D21 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D22 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D23 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D24 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D25 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D26 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D27 | [ROADMAP.md](../ROADMAP.md) |
| D28 | [ROADMAP.md](../ROADMAP.md) |
| D29 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D30 | [ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) |
| D31 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D32 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D33 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D34 | [ADR-0016](adr/ADR-0016-plan-phase-and-approval.md) |
| D35 | [SOURCES.md](SOURCES.md) |
| D36 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |
| D37 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D38 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D39 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D40 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D41 | [ADR-0015](adr/ADR-0015-collaboration-policies-and-solo.md) |
| D42 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D43 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D44 | [ADR-0017](adr/ADR-0017-phase-orchestration-and-evidence.md) |
| D45 | [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md) |
| D46 | [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md) |
| D47 | [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md) |
| D48 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D49 | [ADR-0012](adr/ADR-0012-workspace-discovery-and-groups.md) |
| D50 | [ADR-0014](adr/ADR-0014-commit-relay-and-deprecation.md) |

## Editorial changes made during redistribution

- Numbered references to sections in the retired draft become links to their maintained destinations; prior filenames identify provenance only.
- ADR-0013 now records the requested narrow branch-setup exception. Places asking for a future ADR now link that record while still stating implementation and host acceptance are pending.
- Current runtime behavior and historical test records remain separate from target design and acceptance requirements. The pinned source comparison does not become an installed-host guarantee.
- The original Git exclusion alternative is described as a repository-local exclude entry, rather than assuming every worktree has a physical `.git/` directory. This does not authorize the controller to edit exclusions or configuration.
- Runtime logs/databases remain uncommitted. The future tracked implementation relay log is explicitly distinguished from that existing runtime-data prohibition.
- The planning acceptance rows that name `PLAN-OUTCOME` are interpreted under their final-line transport. The source also permits an equivalent correlated helper; its required evidence is not removed and both transports are not made mandatory.
- Recommendations and open choices remain unresolved, including automatic peer-objection policy, concrete parsers/helper APIs, exact safe lifecycle evidence, provider capability validation, numerical planning budgets, retention, and remote-worker control.
- Historical `pair` references and vendor event pairing retain their meaning. New product design uses **group**, with explicit migration preserving identities and old runs. Solo is not a duplicated participant; larger planning groups remain a separate rollout gate.

These changes relocate and clarify presentation; they do not silently introduce a new product direction or resolve open policies. The source's setup/role-change language must continue to be interpreted with the pinned per-command session correlation in ADR-0011; the detailed future participant-replacement policy remains open.

## Coverage and validation scope

The documentation check verifies the 26-section destination map, exactly one D01-D50 ledger, preservation of all 115 source acceptance-table rows plus solo prose, Markdown fence balance, relative links/anchors, and a Markdown-only changed-file set. Uploaded content is compared by Git blob hash with the locally checked bytes.

Application tests and live CLI/device acceptance are separate from document validation. No new runtime behavior, passing future test suite, Gemini adapter, or unattended safety is certified by this migration. Existing historical ADRs and executable review skill remain unchanged; see [TESTING](TESTING.md) and [VALIDATION](../VALIDATION.md) for their respective requirement/evidence roles.
