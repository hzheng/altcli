# ADR-0021: Explicit repository entry and agent session launch

Status: accepted direction; implementation proposal. Setup enables its flag; a missing flag means off.

An explicit absolute repository path adds metadata through canonical Git common
directory identity. No scan, clone, dummy tmux server or Git mutation is implied.
Users prepare environments. AltCLI may explicitly launch versioned executable +
argv profiles in a main or linked checkout, after a captured preview and human
confirmation. This amends the agent-placement boundary in ADR-0012/ADR-0013;
existing branch/worktree and end-of-task consents remain separate.

Launch has durable per-checkout reservations shared with Start, keyboard input
and setup. Configure an inert placeholder's safe lifetime and exact full-UUID
marker before executing an arbitrary program once. Verify literal arguments,
absolute executable and the actual child environment, including old tmux state.
Never source shell configuration implicitly, store controller credentials in a
profile, retry an uncertain spawn, adopt a reused name or delete successful
siblings. Observed startup is not readiness. Uncertainty survives restart until
inspection or a recorded human decision; history is retained.

tmux retains execution argv in pane metadata. Launch therefore omits API keys,
OAuth tokens and proxy environment variables, including values inherited by an
existing tmux server. Use CLI credential stores; profiles requiring credential
or proxy environment variables are unsupported. Only nonsecret host settings
and configuration paths enter the launch argv.

September 25 update: a launched session is named from its profile and branch
(`<profile>-<branch>`), numbered `-2`, `-3`… when that name is live on the server or held by an
unsettled launch anywhere on the host; confirmation refuses a previewed name taken since, rather
than renaming it. Launch identity remains the session ID and full-UUID marker, never the name.
Live launched sessions are closed through the separately confirmed Finish branch of
[ADR-0013](ADR-0013-confirmed-branch-setup.md#confirmed-closing-of-launched-sessions); its history
is kept. Repository entry can also browse host directories read-only and adds the checkout Git
reports, refusing when the browsed directory, repository or branch changed since it was shown.
Launch cards provide status and recovery actions. Terminal views are in Console
when the checkout is selected; Projects does not embed a second terminal view.

September 26 extension, explicitly requested by the owner: each launch card offers
**Clean up…** for a dead or missing app-launched session, independently of finishing
the branch. A read-only preview binds the recorded server/session/pane identity and
full launch marker. Confirmation acknowledges possible surviving background work.
For a retained dead session, only the original single pane/window, unshared and
still dead, can be removed; tmux rechecks these conditions in its command queue.
A missing original session only retires its card. Names are never removal targets,
and a replacement session is never stopped by cleanup. Expanded/shared
sessions require the broader Finish branch preview or manual host inspection.

The cleanup decision and checkout reservation persist before any removal. Unknown
results retain ownership across restart; **Refresh launch status** checks absence without retrying.
Verified absence retires the card, console entry and terminal target without a
workspace reset. Saved registrations remain historical; surviving agents keep
their names and group selection. Launch and acknowledgement history is retained.
Existing run/delivery/setup owners and keyboard records
targeting that pane block cleanup. A keyboard on another pane may remain active;
its manual-input barrier, snapshots and workflow checkpoints are preserved. This
does not certify that background work stopped or that the task completed. SQLite
v16 prevents older backends from reconciling away an unresolved cleanup.

September 27 update: cleanup also offers **Close agent** for a running session,
with explicit acknowledgement of interrupted work. The final tmux check binds the
original pane PID. Group membership does not gate closing; existing identity,
ownership, background-work and no-retry safeguards still apply.

## Proposed launch completion work

Proposed future direction, not implemented: offer browser access to an exact
verified launch before it qualifies as a coding agent. The existing launch-ID
terminal target is only a starting point: unresolved launch reservations currently
block keyboard admission. A future scoped startup interaction must retain that
reservation, block unrelated automation and preserve truthful needs-attention
state. Session names alone cannot authorize access; login, trust and model prompts
must not be converted into fake readiness or automatic approvals.

Optional named host environment profiles and Create & launch remain proposals.
Environment design needs allowlists, secret references, redacted previews and
configuration-bound consent, not blanket inheritance or credentials in argv.
Creation and each launch need separate durable outcomes: never launch into a
guessed path after uncertain creation, retry an uncertain batch or delete
successful siblings. These proposals do not change today's explicit launch
consent or credential/proxy omissions. See
[open choices](../OPEN-DECISIONS.md#proposed-app-wide-assistance-and-completion-choices)
and the [roadmap](../../ROADMAP.md#proposed-app-wide-assistance-and-completion-work).

See [the protocol](../TERMINAL-PROTOCOL.md) for API, environment and recovery rules.
Remote/provider/mobile acceptance remains separate from fake and private-fixture
validation. Setup enables the feature flags; a missing flag means off.
