import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Group } from '../contracts/implementation.ts';
import type { CapturedPlanResult, PlanAction, PlanningRun, PlanStart } from '../contracts/planning.ts';
import type { ManagedSession } from '../contracts/workflow.ts';

/** N-shaped state; the API's separate rollout guard limits selected groups to two. `plans` is the canonical plan-document
 * directory in AltCLI's data directory, so planning never writes into the checkout. */
export function newPlanning(input: PlanStart, group: Group, participants: ManagedSession[], implementationParticipants: ManagedSession[], cwd: string, plans: string): PlanningRun {
  const directory = join(plans, input.requestId);
  return { phase: 'plan', group: { ...group, cwd }, participants, implementationParticipants, cwd, worktree: participants[0]!.worktree!,
    epoch: 1, brief: input.text, briefRevision: 1, policyRevision: 1, directory, planPath: join(directory, 'plan.md'), required: [...group.members],
    drafts: Object.fromEntries(group.members.map((id, index) => [id, { agentId: id, commandId: index === 0 ? input.requestId : randomUUID(), path: join(directory, `draft-${id}.md`), status: 'queued', document: null, briefRevision: 1 }])),
    step: 'drafts', current: null, endorsements: {}, endorsementHistory: [], objections: {}, next: { agentId: group.members[0]!, action: 'draft' }, frozen: null, request: input };
}
export function planAgreed(plan: PlanningRun): boolean {
  return !!plan.current && plan.current.briefRevision === plan.briefRevision && Object.keys(plan.objections).length === 0 && plan.required.every((id) => plan.endorsements[id] === plan.current!.revision);
}
/** Called only inside the workflow's correlated completion transaction. */
export function consumePlan(plan: PlanningRun, captured: CapturedPlanResult): void {
  const { result, document } = captured; const { agentId, action, commandId, outputPath } = result.identity;
  plan.next = null;
  if (result.outcome === 'blocked') return;
  if (action === 'draft') {
    Object.assign(plan.drafts[agentId]!, { status: 'finalized', document });
    const pending = plan.required.find((id) => plan.drafts[id]!.status !== 'finalized');
    if (pending) { plan.next = { agentId: pending, action: 'draft' }; return; }
    if (plan.required.length > 1) { plan.step = 'synthesis'; plan.next = { agentId: plan.required[0]!, action: 'synthesize' }; return; }
    // Solo promotes the captured draft in storage; no extra model call or controller project write.
  }
  if (result.outcome === 'object') {
    plan.objections[agentId] = result.reason!; delete plan.endorsements[agentId]; plan.step = 'checkpoint'; return;
  }
  if (!plan.current || plan.current.hash !== document!.hash || plan.current.briefRevision !== plan.briefRevision) {
    plan.current = { ...document!, path: outputPath, revision: (plan.current?.revision ?? 0) + 1, briefRevision: plan.briefRevision, author: agentId, commandId };
    plan.endorsements = {};
  } else if (outputPath === plan.planPath) plan.current.path = outputPath;
  plan.endorsements[agentId] = plan.current.revision;
  plan.endorsementHistory.push({ agentId, revision: plan.current.revision, briefRevision: plan.briefRevision });
  delete plan.objections[agentId];
  const next = plan.required.find((id) => plan.endorsements[id] !== plan.current!.revision);
  plan.step = next ? 'refinement' : 'checkpoint';
  if (next) plan.next = { agentId: next, action: 'review' as PlanAction };
}
