# Reference sources and provenance

**Historical starter provenance:** the September 14 notes below are retained as historical observations, not a new claim about today's tools or validation. The collaboration migration record follows, pinned to the submitted source and `46f228b`.

Inspected September 14, 2026. Source observations and AltCLI design choices are
separated below. Repository access was read-only; no GitHub files were changed.

## User-provided sources

- The uploaded `SKILL.md`, kept unchanged at `skills/review-handoff/SKILL.md`
  and symlinked into the CLIs' skill directories by `node scripts/install-skills.mjs`.
  In particular: accepted incoming work is staged; the current reviewer's
  improvements remain unstaged; the four outcomes are preserved.
- The uploaded `ROADMAP.md` and `ADR-0001-tmux-web-controller.md`. Exact originals
  are archived under `docs/history/2026-09-13/`. Their original date is retained.
- The conversation's September 14 decisions: AltCLI as project name,
  TypeScript frontend and backend, web-first development, native iOS reserved,
  and a ZIP starter delivery.

## Official technical references

- [Next route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route): HTTP route handlers and Web Request/Response APIs.
- [Next runtime configuration](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config): Node runtime boundary.
- [tmux manual](https://man.openbsd.org/tmux.1): persistent sessions, exact pane IDs, metadata formats, capture-pane, send-keys, hex input, and command parsing.
- [Codex skills](https://developers.openai.com/codex/skills/): repository `.agents/skills` discovery.
- [Claude Code skills](https://code.claude.com/docs/en/skills): project `.claude/skills` discovery.
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve): private service exposure and Serve configuration.

Dependency versions are not asserted to be the latest available packages. The
packaging runtime could not resolve npm's registry;
no registry download, dependency audit, lockfile resolution, or full web build was
completed. Consult `VALIDATION.md` for the actual checks.

## Collaboration documentation migration

The controlling input was the reviewed V4 revision of the standalone collaboration design, SHA-256 `d8430089eeddc5d2836b6985004a8f039e65fc48e0ff6c0a30a49bc45afe9f10`. Its 26 sections, 50 decision records, and 115 tabulated acceptance scenarios are redistributed into maintained documents; see [DESIGN-MIGRATION](DESIGN-MIGRATION.md). That draft is not part of this repository; the maintained documents are authoritative.

The submitted review's source baseline is preserved. This migration checked the branch identity and relevant current documentation/workflow source; it did not repeat a full repository audit, installed-agent run, or external documentation review. The future design is not the current runtime, and old CI is not evidence for new features.

## Product purpose, retained architecture, and comparison with the reference implementation

AltCLI is an external control center for coding agents, not another coding agent. Its immediate value is centralized reading, instructions, coordinated planning/review, and portable human supervision.

Retain the supplied architecture: registered coding CLIs operate in tmux; one host-resident Next.js App Router application with TypeScript on both sides, React, Tailwind, SQLite through `better-sqlite3`, Vitest, and Playwright; dependencies in `web/package.json`; repository operations in root `scripts/`; no root manifest just for forwarding commands. Terminal access and coordination remain server-side. The initial iPhone interface is the responsive console over private Tailscale access. Native iOS, richer terminal interaction, and an AI supervisor remain deferred.

Codex, Claude Code, and Gemini CLI are examples of adapter kinds, not fixed agent identities. Multiple instances of the same CLI may be registered. Support for a Gemini model through some other runtime uses that runtime's adapter. Adding a third planning participant does not require a third supervisory AI or a replacement web stack.

The scope remains **plans first, not competing implementations**. A group of N separately assigned draft writers uses one existing, user-prepared clean workspace; their documents live in AltCLI's data directory. Initial selection is capped at one or two members; larger planning rosters remain a planned capability. Only distinct initial draft assignments may execute concurrently; the unified plan and implementation remain single-writer. AltCLI discovers and validates agent placement; it does not create task worktrees, relocate CLI sessions, or provision their environments.

### Evidence boundary for the comparison

The supplied document compares this design with the hardening implementation of ADR-0011, ROADMAP, and REVIEW-RESOLUTION. **Pinned reference baseline:** commit `46f228b16658cd120515e717558d1def2e6e6a57` (`46f228b`, `main`, September 18, 2026). The relay review of this revision verified the following against that commit's source, so the rows below describe shipped behavior, not assumptions: a run freezes participants, an explicit pair, `autoContinue`, and `turnLimit` (default 20) at start; one `currentCommandId` per run, with any other completion recorded as late or unknown; worktree ownership keyed by the canonical index path; command marker, exact prompt echo, source-turn acknowledgment, session pinned within a command, event dedup, and a single dispatcher claim; the hook reads the final `RELAY-OUTCOME` line from the CLI's own record of the last message with exactly four outcome values; Send & relay is gated by the read-only worktree digest; an actionable `strong_objection` is sent to the author as a correction instruction when continuation is on; `accept_and_improve` with continuation off leaves the run `paused` with ownership retained; restart pauses without replay; and the server issues no Git mutation. Installed-CLI host acceptance is still pending per VALIDATION.md; pinning the source does not certify live behavior. [S1](SOURCES.md#source-1)

The two statements about Codex evidence are both true at that commit and describe two layers, not two revisions: the Codex `notify` payload carries no background-work fields, so the hook reports `unknown`; the server then compensates for Codex participants only, recording the processes under the pane before delivery and treating a newly associated process that survives completion as active work. Unreadable evidence stays unknown and pauses. Whether that observational evidence is acceptable for unattended operation remains the host-acceptance question, not a documentation ambiguity.

### Why commit relay improves on the referenced uncommitted relay

| Concern | Referenced uncommitted design | Proposed commit relay |
| --- | --- | --- |
| Review target | Mutable index/worktree comparison; path-level staging cannot preserve arbitrary conceptual hunk ownership. | Exact review endpoints assigned by the controller. |
| Report validation | Outcome comes from an agent report; the source identifies Git-delta validation as a gap. | Validate entry, permitted project diff, parent, clean entry, and leftovers. This validates consistency, not the correctness of the reviewer. |
| Objection versus no change | Both can leave identical Git state; a result message supplies the distinction. | A log-only objection is a durable handoff artifact. |
| Roles | The referenced workflow allows both peers to improve. | Review-only edits are a detectable role violation in the published diff. |
| History | Outcome records plus a mutable index; no immutable code snapshot for every turn. | Per-turn commits and a log that can travel with code. |
| Hosts | Shared mutable index/worktree. | Identified commits exchanged through a remote; separate local indexes are permitted. |
| Restart | Recover ledger and reconcile mutable work. | Recover ledger and rediscover published artifacts; ambiguous execution is still not replayed. |
| Agent contract | Stage accepted incoming changes, leave own improvements unstaged. | Follow entry schema and commit discipline without adopting unrelated user work. |
| Lifecycle evidence | Correlated CLI events and the accepted background-work policy. | Still separate from the artifact. A commit is not proof that writers stopped; the adapter/evidence policy remains necessary. |
| New server work | No new result mechanism in the frozen path. | Read-only publication validation, phase policy, and recovery, plus workspace-first discovery. The only new Git-write authority is explicitly confirmed creation/check-out of a new branch at a settled setup boundary; it does not authorize controller commits or worktree management. |

**Verdict, as a design recommendation:** commit relay is stronger for artifact identity, review history, publication validation, and future remote workers. Its additional skill and validation work are worthwhile. It does not by itself solve missed lifecycle signals, background work, or semantic correctness. The supplied deprecation decision is retained with acceptance criteria, not treated as permission to break the existing workflow.

### Why Plan is added, and why sequential dispatch comes first

Plan is additive. It captures alternative approaches, explicit assumptions, peer refinement, and an optional human gate before project changes. Its value is not confined to exactly two vendors.

Preserve the supplied protocol delivery order: commit relay before local Plan, sequential draft dispatch before concurrent drafts. Add workspace/group onboarding as a small entry-layer increment, not a replacement protocol. **Use arrays/maps of N assignments from the start.** Two independent limits remain: initial user-selectable membership is one or two; draft execution begins at concurrency=1. Later enablement of 3+ planning and higher concurrency is tested separately. Neither requires reintroducing a product concept limited to exactly two participants.

Concurrency also requires correct output checks, complete-roster barriers, cancellation, budget accounting, and restart handling. It is not merely sending two prompts sooner. Actual elapsed-time savings depend on provider limits and shared resources; do not promise that more planners produce proportionally faster or better results.

## Sources, superseded alternatives, and interpretation

### Source precedence and scope of this edit

<a id="source-1"></a>

**[S1](SOURCES.md#source-1) The user-supplied standalone collaboration design (V4 lineage).** Retained background source for the 26-section organization, Plan/Implementation distinction, single-workspace planning, deprecation contract, clean-entry/leftover checks, implementation-first recommendation, and acceptance/migration framing. Its assertions about shipped code were verified against commit `46f228b` during the relay review of this revision ([Product purpose, retained architecture, and comparison with the reference implementation](SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation)); installed-CLI host acceptance remains separate.

<a id="source-2"></a>

**[S2](SOURCES.md#source-2) Supplied `review-handoff` skill and earlier conversation.** The legacy index/worktree contract stages accepted incoming work and leaves reviewer improvements unstaged; it remains separate. The new document does not modify that skill or authorize staging during an ordinary code review.

<a id="source-5"></a>

**[S5](SOURCES.md#source-5) The V3 revision of that design.** The direct editable base for V4. Its N-shaped planning roster, N+1 documents, full-roster barrier, exact-version agreement, concurrent-output validation correction, Gemini/provider adapters, single-commit lineage rule, and detailed lifecycle/result separation are preserved. V4 extends them with explicit solo behavior and an initial two-member selection cap, rather than deleting future N-agent support.

<a id="source-6"></a>

**[S6](SOURCES.md#source-6) Latest workspace and group discussion.** This is the controlling source for V4 changes: the user prepares worktrees and places agents in the same directory; the app discovers Git workspaces from tmux and groups eligible sessions by cwd; one agent can work solo, two are selected automatically, and three or more require an explicit selection of two until larger groups are enabled; users may create a customizable branch after consent or explicitly remain on main; product terminology changes from pair to group.

In the submitted V4, S6 changes S5 explicitly through the decision ledger, permission model, UI, migration plan, and acceptance scenarios. Other unresolved S5 choices remain unresolved. Those contents now have maintained homes in the ADRs and guides; this redistribution is not a new code implementation.

### Previously recorded external context

V3 recorded a limited September 18, 2026 check of these official pages:

<a id="source-3"></a>

- **[S3](SOURCES.md#source-3) Gemini CLI, Plan Mode:** `https://geminicli.com/docs/cli/plan-mode/`
<a id="source-4"></a>

- **[S4](SOURCES.md#source-4) Gemini CLI, Hooks reference:** `https://geminicli.com/docs/hooks/reference/`

Their integration discussion is retained as context from V3, **not newly fetched or reverified in V4**. It does not establish the user's installed-version behavior, safe background-writer guarantees, or a functioning AltCLI Gemini adapter. This consolidation claims no new external research, application test, CI run, or broad audit; its only new audit evidence is the targeted pinned-source verification in [Product purpose, retained architecture, and comparison with the reference implementation](SOURCES.md#product-purpose-retained-architecture-and-comparison-with-the-reference-implementation).

### Retained review judgments

1. Clean entry, explicit lineage, leftovers, correlated guidance, deprecation criteria, and staged rollout remain valuable constraints.
2. A larger planning group changes agreement, not just array length: the complete current-version required roster is the proposed default, not the last two approvals.
3. Parallel validation permits authorized active drafts to change, while protecting project content and finalized/unassigned files. Snapshots alone do not attribute every write or enforce secrecy.
4. Provider adapters normalize actual evidence instead of requiring Gemini to invent Claude fields. A model name is not execution identity or readiness.
5. Inherited implementation claims need a pinned baseline. V4 reconciles the two Codex evidence descriptions at the source level for `46f228b`; installed-host acceptance remains open.
6. One direct single-parent handoff commit remains the first commit-relay lineage contract. Hidden intermediate commits require a future extension.

### Superseded alternatives and explicit V4 amendments

| Earlier suggestion or broad rule | Current interpretation |
| --- | --- |
| Users must add each pane and create a named pair before working. | Workspace-first discovery and automatic initial group suggestions; exact registration still exists underneath Start. |
| Pair is the product's participant abstraction. | **Group** is the term throughout the current design. A group contains distinct instances, and a run freezes its membership revision. |
| A group is always exactly two members. | Solo has one; two-member peer/fixed-role implementation is supported; 3+ planning is a retained later capability. |
| One agent should be represented twice so it can pair with itself. | One ID once, with explicit solo and optional non-independent self-review semantics; no implicit self-relay loop. |
| Every pane in a directory is a coding agent. | Eligible adapter-backed instances count; shells, servers, and unknown runtimes do not silently become selected members. |
| Refreshing workspace discovery may adjust the running group. | Inventory may change; run membership, roles, and successors stay fixed until explicit boundary-controlled changes. |
| N-agent design means all 3+ discovered agents can start immediately. | Initial selection cap is one or two. N-capable storage and tests are preserved; larger planning groups require explicit enablement. |
| All selected members need only share a repository name or root prefix. | Initial local contract requires the same canonical cwd and actual worktree/index. Different cwd cards sharing an index cannot run conflicting tasks. |
| AltCLI should automatically provision task worktrees and move sessions. | Superseded. The user prepares environments and cwd; the app validates and gives Recheck diagnostics. No provisioning or automatic cleanup. |
| Controller Git access is absolutely read-only with no exceptions. | Publication validation stays read-only. A narrowly consented new-branch create-and-checkout at a settled boundary is the sole V4 setup exception, now recorded by [ADR-0013](adr/ADR-0013-confirmed-branch-setup.md); runtime implementation remains pending. |
| Finding any branch other than main is enough. | Inspect the actual checked-out branch of this workspace. Other branches do not select the task branch. |
| A task must always leave main. | Dedicated task branch recommended; explicit continuation on main/the configured primary branch is allowed with all other checks intact. |
| Waiving plan approval permits the app to create a branch automatically. | Branch consent is independent. Missing consent waits; no switch beneath active planners. |
| Independent planning requires separate code branches/worktrees and a merge. | Plan writes isolated named drafts in one existing workspace, then refines a unified document. |
| Planning drafts must be tracked/committed or use force-add staging. | Drafts live in AltCLI's data directory, outside the checkout; no Git mutation during Plan. |
| Every nonassigned draft must be unchanged at every completion. | During concurrency, other active owners may update their own assigned drafts; frozen/idle/unassigned artifacts remain protected. |
| The author and next reviewer always establish plan agreement. | Only if they cover the whole required group for the current revision. Solo is plan-ready, not independent consensus. |
| More planning agents require a third supervisor. | They are ordinary participants with provider adapters; no supervisor is required. |
| Every planner automatically becomes an implementation writer. | Implementation group and roles are explicitly selected; extras remain unscheduled and settled. |
| All runtimes expose the same hook fields. | Adapter-specific evidence under shared invariants; unknown is not filled with invented data. |
| Every turn in every phase creates a commit. | Only completed commit-mode Implementation turns; Plan uses captured documents/results. |
| File existence, unchanged content, or a native plan-ready prompt authorizes implementation. | Valid identified results, version-specific readiness/agreement, settled activity, Plan gate, branch consent, and workspace checks are required. |
| Human plan approval is always mandatory. | Optional per run, independent of automatic collaboration; default-on remains the recommendation. |
| Human override can clear unknown active writers or grant arbitrary permissions. | Override concerns plan judgment; unsafe execution and permission requirements still need explicit reconciliation. |
| Working drafts can be discarded without preserving the final plan. | Preserve full frozen text and authority first; data-directory documents do not travel with Git. |
| One current command describes all execution. | Bounded assignment set during enabled parallel drafts; one current editor afterward. |
| The deprecated staging path should gain every new capability. | Freeze its verified behavior; only discovery/terminology/compatibility wrapping changes without altering the staging contract. |
| A PR is needed for cross-machine Git exchange. | Shared publication transports commits; PR remains optional. Local same-directory group rules apply until remote-worker support is explicitly built. |
| Commit existence alone proves all activity finished. | Artifact/result and safe lifecycle evidence remain distinct. |

All schema names, exact APIs, defaults labeled recommendations, and deferred policies remain working choices. The document does not claim workspace discovery, branch setup, solo mode, N-agent dispatch, phase UI, or the commit/log protocol are already implemented or host-tested. Earlier green CI is not evidence for this future implementation.
