# ADR-0019: Terminal input and evidence-bound checkpoints

Date: 2026-09-22. Status: implementation proposal from the approved terminal-input plan; validation limits are recorded in [VALIDATION](../../VALIDATION.md).

## Decision

A running modern Plan, Implementation or standalone assignment may receive an explicit human update, literal answer, Enter, or separately confirmed Escape. The current holder alone is eligible. The composer remains editable when delivery is blocked. The original assignment's follow-up policy stays frozen; an update adds no commit, review, branch or integration authority. Legacy staging keeps its existing contract.

Input is a separate durable interaction, never a new CommandRecord or assignment. Its request ID, run, command, registration, exact acknowledged native session/turn and hold revision must match. Before terminal bytes, an immediate SQLite transaction reserves the input and a hold covering the entire run/index. Exact duplicates return the existing receipt; conflicting duplicates fail. A preflight refusal sends nothing. Any failure after transport starts is uncertain and is never replayed. Restart retains ownership and invalidates live recovery evidence.

The hold is distinct from human pause. It blocks peer dispatch, no-successor release and automatic Plan approval. An exact original completion must still carry its valid publication or captured Plan result and source-specific settled/background evidence. The controller records that result once and saves the disposition it would otherwise apply. Only **Review input and continue**, with fresh confirmation of all writers and empty prompts, may apply that disposition once.

Neither equal prompt text nor a reservation identifies a later native prompt. Existing Codex same-turn steering retains only its original verified binding. An uncorrelated/new turn during an unfinished assignment faults the run; a later completion cannot repair that missing authority. Claude's ordinary prompt-submission hooks are not a universal dialog-answer acknowledgment. Enter and Escape are transport receipts, not semantic success.

## Transitions

| Event/state | Result and permitted next action |
| --- | --- |
| Valid update/answer/key to current acknowledged holder | Reserve whole-run hold, then type; no new assignment or marker |
| Stale target/revision, nonholder, unknown binding or concurrent input | Refuse before bytes |
| Preflight refusal | Record rejection; remove only this reservation's hold, preserving earlier input or concurrent faults |
| Transport begins then fails, or host restarts | Durable uncertainty; inspect and deliberately take over, never retry |
| Original valid completion under an input hold | Capture original result/disposition; stay paused and retain ownership |
| Original completion has missing/invalid result, unknown background work, interruption or unrelated native work | Fault; no resumable input checkpoint |
| Review input and continue at unchanged validated checkpoint | Apply saved complete/automatic/manual/Plan disposition once, preserving budget and approval policy |
| Unrelated native work after an already validated waiting checkpoint | Pause; separately observe exact external start/completion and all writers |
| Restore checkpoint after that external work settles without changed content, identities or evidence | Return to waiting, send nothing, preserve counters; next progression requires an explicit action |
| Missing external start/finish, conflicting evidence, new instance, changed files/result/Plan, restart or old paused run without checkpoint | Refuse restore; retain ownership for deliberate takeover |
| Duplicate checkpoint confirmation | Return prior decision; never repeat a transition |

A checkpoint records its capture time and includes the exact finished command, saved result and pending disposition/policy, checkout fingerprint/branch, eligible checkout agents, CLI registrations and process baselines. Restoration revalidates files, original result/Plan artifacts, current inventory, native settlement and background evidence. External starts must be newer than the checkpoint; delayed older evidence cannot authorize restoration. Native observations invalidate stale confirmations before asynchronous checks. It does not revive an unfinished assignment or reset the automatic budget. Unknown/unidentified checkout panes prevent capture. Reconciliation remains observational plus human confirmation, not OS isolation or proof against hidden external writers.

## Squash advice

The Projects integration preview may ask an eligible, settled agent for read-only ordered batch endpoints and messages, rationale and dependencies. The prompt names exact source/target revisions and the prior batch baseline. This is an ordinary standalone instruction with existing readiness and ownership checks. Output stays literal agent text. Humans copy the proposed endpoint/message and obtain a new preview and confirmation for each batch. No advice grants integration authority; stale, conflicting and uncertain operations retain existing refusal behavior.

## Deferred

Reliable native input acknowledgments, semantic dialog recognition, automatic permissions, queued-turn reassignment, autonomous app mutations, N-agent rollout and unattended recovery are not introduced. Installed-version observations must be recorded separately from fake lifecycle and harmless tmux tests; unsupported/unverified providers require manual inspection and fail-closed recovery.
