import { createHash } from 'node:crypto';
import type { AttentionDestination, AttentionKind, AttentionSubject, PlanNeed, RunBlocker } from '../../contracts/attention.ts';
import type { GlobalAIInstance } from '../../contracts/global-ai.ts';
import type { Checkpoint } from '../../contracts/interactions.ts';
import type { LaunchInstance } from '../../contracts/launches.ts';
import type { Execution, RelayRun } from '../../contracts/workflow.ts';
import { planAgreed } from '../planning-state.ts';

/** A source's current issue. Pure functions of recorded state: no terminal text, model or live observation is consulted. */
export interface Derived {
  key: string; kind: AttentionKind; facets: string[]; subject: AttentionSubject;
  title: string; detail: string; destination: AttentionDestination;
  /** Digest of the fields that define the condition. Observation times and updatedAt-only saves never change it. */
  fingerprint: string;
}
export const runKey = (id: string): string => `run:${id}`;
export const launchKey = (id: string): string => `launch:${id}`;
export const helperKey = (id: string): string => `helper:${id}`;

/** Recorded text flattened and bounded for display. It is evidence, never a classifier. */
export function flatten(text: string | null | undefined, limit = 600): string {
  const flat = (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const BLOCKERS: Record<RunBlocker, string> = {
  delivery_uncertain: 'Delivery uncertain', interrupted: 'Turn interrupted', completion_gate: 'Completion evidence holds the handoff',
  input_review: 'Terminal input needs review', restart: 'Backend restarted', paused: 'Paused run needs inspection',
};
const NEEDS: Record<PlanNeed, string> = {
  approval: 'Plan ready for your approval', disagreement: 'Plan disagreement needs your decision',
  branch: 'Plan agreed; choose its implementation branch', continuation: 'Plan agreed; continue to Implementation yourself',
};
type Phase = Extract<AttentionSubject, { type: 'run' }>['phase'];
const PHASES: Record<Phase, string> = { implementation: 'Implementation', plan: 'Plan', standalone: 'Send', stage: 'Stage relay', legacy: 'Pre-upgrade relay' };
const phaseOf = (run: RelayRun): Phase => run.implementation ? 'implementation' : run.planning ? 'plan' : run.standalone ? 'standalone' : run.stage ? 'stage' : 'legacy';

/** An owned run that cannot progress without the human, or a Plan checkpoint awaiting the human's decision. A routine manual wait,
 * the owner's own Pause and an authorized automatic transition are not alerts. */
export function runAttention(run: RelayRun, execution: Execution | undefined, checkpoint: Checkpoint | undefined): Derived | null {
  const current = execution?.commandId === run.currentCommandId ? execution : undefined;
  const subject: AttentionSubject = { type: 'run', runId: run.id, repository: run.repository, phase: phaseOf(run),
    participants: run.participants.map((p) => p.label), commandId: run.currentCommandId };
  const destination: AttentionDestination = { surface: 'control-access', repository: run.repository, runId: run.id };
  const point = checkpoint?.commandId === run.currentCommandId ? { revision: checkpoint.revision, fault: checkpoint.fault } : null;
  if (run.status === 'paused') {
    const facets: RunBlocker[] = [];
    if (current?.status === 'uncertain') facets.push('delivery_uncertain');
    if (current?.status === 'interrupted') facets.push('interrupted');
    if (run.blockedHandoff) facets.push('completion_gate');
    if (run.interaction?.active) facets.push('input_review');
    if (run.pauseCause === 'restart') facets.push('restart');
    if (!facets.length) {
      if (run.pauseCause === 'user') return null;
      facets.push('paused');
    }
    const h = run.blockedHandoff, hold = run.interaction;
    const condition = { kind: 'run', facets, commandId: run.currentCommandId, execution: current?.status ?? null, checkpoint: point, pauseCause: run.pauseCause ?? null,
      handoff: h ? { revision: h.revision, gate: h.gate, background: h.backgroundState, publicationError: h.publicationError } : null,
      hold: hold ? { active: hold.active, fault: hold.fault, disposition: hold.disposition ?? null, revision: hold.revision } : null,
      // A generic pause has no typed equivalent, so its normalized recorded reason defines it; typed facets never depend on prose.
      reason: facets[0] === 'paused' ? flatten(run.reason) : null };
    return { key: runKey(run.id), kind: 'run', facets, subject, title: `${BLOCKERS[facets[0]!]} · ${PHASES[phaseOf(run)]}`,
      detail: flatten(run.reason), destination, fingerprint: digest(condition) };
  }
  const plan = run.planning;
  if (run.status === 'waiting' && plan && !run.implementation && plan.step === 'checkpoint' && !plan.next) {
    const need: PlanNeed | null = !planAgreed(plan) ? 'disagreement' : plan.request.requireApproval ? 'approval'
      : !plan.request.implementation.branch ? 'branch' : !run.autoContinue ? 'continuation' : null;
    if (!need) return null;
    const condition = { kind: 'plan', need, commandId: run.currentCommandId, epoch: plan.epoch, briefRevision: plan.briefRevision,
      policyRevision: plan.policyRevision, roster: plan.required, revision: plan.current?.revision ?? null, hash: plan.current?.hash ?? null,
      endorsements: plan.endorsements, objections: Object.keys(plan.objections).sort(), checkpoint: point };
    return { key: runKey(run.id), kind: 'plan', facets: [need], subject, title: NEEDS[need], detail: flatten(run.reason), destination, fingerprint: digest(condition) };
  }
  return null;
}
/** A recorded workspace launch or cleanup whose outcome is uncertain. Missing pane evidence never settles it; only inspection does. */
export function launchAttention(item: LaunchInstance): Derived | null {
  if (item.closed || item.status !== 'uncertain') return null;
  const facet = item.cleanup && item.cleanup.status !== 'done' ? 'cleanup_uncertain' : 'start_uncertain';
  return { key: launchKey(item.id), kind: 'launch', facets: [facet],
    subject: { type: 'launch', launchId: item.id, projectId: item.projectId, worktreeId: item.worktreeId, repository: item.worktree.root,
      sessionName: item.sessionName, profileLabel: item.profile.label },
    title: `${facet === 'cleanup_uncertain' ? 'Cleanup needs inspection' : 'Launch needs inspection'} · ${item.sessionName}`, detail: flatten(item.message),
    destination: { surface: 'launch', projectId: item.projectId, worktreeId: item.worktreeId, repository: item.worktree.root, launchId: item.id },
    fingerprint: digest({ kind: 'launch', facet, status: item.status, phase: item.phase, cleanup: item.cleanup?.status ?? null, message: flatten(item.message) }) };
}
/** An app-instance (Helper) start whose outcome is uncertain. */
export function helperAttention(instance: GlobalAIInstance): Derived | null {
  if (instance.status !== 'uncertain') return null;
  return { key: helperKey(instance.id), kind: 'launch', facets: ['start_uncertain'],
    subject: { type: 'helper', instanceId: instance.id, sessionName: instance.sessionName, profileLabel: instance.profile.label },
    title: 'Helper start needs inspection', detail: flatten(instance.message), destination: { surface: 'helper-session', instanceId: instance.id },
    fingerprint: digest({ kind: 'helper', status: instance.status, phase: instance.phase, message: flatten(instance.message) }) };
}
/** Why a resolved item no longer needs attention, read from the current record. Describes controller state, not task success. */
export function runResolution(run: RelayRun): string {
  if (run.status === 'completed') return 'The run completed. Final task-level verification remains yours.';
  if (run.status === 'stopped') return 'Control returned to you. Taking control neither stops an agent nor proves its work settled.';
  if (run.status === 'running') return 'The controller is progressing this run again.';
  if (run.status === 'waiting') return 'The run now waits for a routine manual step in Control access.';
  return 'Paused by you. It stays in Control access.';
}
export const launchResolution = (item: LaunchInstance): string =>
  item.closed ? 'The launch was closed.' : `Inspection recorded this launch as ${item.status}.`;
export const helperResolution = (instance: GlobalAIInstance): string => `The Helper start is now recorded as ${instance.status}.`;
