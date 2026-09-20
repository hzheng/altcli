import type { PlanDecision, PlannedImplementation, PlanStart } from '../contracts/planning.ts';
import { AppError } from './errors.ts';
import { agentId, object, promptText, requestId } from './validation.ts';
import { parseImplementation, sha } from './implementation-validation.ts';

const fail = (message: string): never => { throw new AppError('INVALID_PLAN', message); };
export function parsePlan(value: unknown): PlanStart {
  const b = object(value);
  if (Object.keys(b).some((k) => !['requestId','groupId','groupRevision','registrations','text','baseline','autoContinue','requireApproval','turnLimit','pauseOnObjection','implementation','confirmReady'].includes(k))) fail('Unknown planning field.');
  const baseline = object(b.baseline);
  if (Object.keys(baseline).sort().join(',') !== 'branch,head' || (baseline.branch !== null && (typeof baseline.branch !== 'string' || !baseline.branch))) fail('Confirm the displayed planning branch and baseline.');
  if (typeof b.requireApproval !== 'boolean' || typeof b.autoContinue !== 'boolean' || b.confirmReady !== true) fail('Confirm the independent planning, approval and automation choices.');
  if (b.pauseOnObjection !== undefined && typeof b.pauseOnObjection !== 'boolean') fail('Choose whether a reviewer objection pauses for you or routes to the author.');
  const raw = object(b.implementation);
  if (raw.branch === undefined) fail('Choose a future branch or explicitly defer branch consent with null.');
  if (Object.keys(raw).some((k) => !['groupId','groupRevision','registrations','agentId','handoff','policy','workerId','logPath','branch'].includes(k))) fail('Unknown post-plan implementation setting.');
  const parsed = parseImplementation({ ...raw, branch: raw.branch ?? baseline, requestId: b.requestId, text: b.text, kind: 'work', autoContinue: false, turnLimit: b.turnLimit, confirmReady: true });
  const { requestId: id, text, kind: _kind, autoContinue: _auto, turnLimit, confirmReady: _confirm, reviewBase: _base, ...settings } = parsed;
  // Reuse the exact group-generation validation used by direct implementation, without inheriting its permissions.
  const roster = parseImplementation({ ...parsed, groupId: b.groupId, groupRevision: b.groupRevision, registrations: b.registrations });
  return { requestId: id, groupId: roster.groupId, groupRevision: roster.groupRevision, registrations: roster.registrations, text: text!,
    baseline: { branch: baseline.branch as string | null, head: sha(baseline.head) }, autoContinue: b.autoContinue as boolean, requireApproval: b.requireApproval as boolean,
    turnLimit, ...(b.pauseOnObjection !== undefined ? { pauseOnObjection: b.pauseOnObjection as boolean } : {}), implementation: { ...settings, branch: raw.branch === null ? null : settings.branch } as PlannedImplementation, confirmReady: true };
}
export function parsePlanDecision(value: unknown): PlanDecision {
  const b = object(value);
  if (Object.keys(b).some((k) => !['runId','expectedCommandId','expectedRevision','expectedHash','expectedBriefRevision','expectedPolicyRevision','action','text','agentId','overrideReason','branch','confirmReady'].includes(k))) fail('Unknown plan decision field.');
  if (!['approve','changes'].includes(String(b.action)) || b.confirmReady !== true) fail('Choose a plan action and confirm all writers are settled.');
  for (const key of ['expectedRevision','expectedBriefRevision','expectedPolicyRevision']) if (!Number.isInteger(b[key]) || Number(b[key]) < 1) fail('Confirm the exact displayed plan and policy revisions.');
  if (typeof b.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.expectedHash)) fail('Confirm the captured plan hash.');
  let branch;
  if (b.branch !== undefined) {
    const c = object(b.branch);
    if (Object.keys(c).some((k) => !['branch','head','newBranch','taskBase'].includes(k)) || (c.branch !== null && (typeof c.branch !== 'string' || !c.branch)) || (c.newBranch !== undefined && (typeof c.newBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,150}$/.test(c.newBranch))) || (c.taskBase !== undefined && c.newBranch !== undefined)) fail('Invalid branch consent.');
    branch = { branch: c.branch as string | null, head: sha(c.head), ...(c.newBranch !== undefined ? { newBranch: c.newBranch as string } : {}), ...(c.taskBase !== undefined ? { taskBase: sha(c.taskBase) } : {}) };
  }
  if (b.action === 'changes' && (!b.text || !b.agentId)) fail('Name the planner and the requested changes.');
  return { runId: requestId(b.runId), expectedCommandId: requestId(b.expectedCommandId), expectedRevision: Number(b.expectedRevision), expectedHash: b.expectedHash as string,
    expectedBriefRevision: Number(b.expectedBriefRevision), expectedPolicyRevision: Number(b.expectedPolicyRevision), action: b.action as PlanDecision['action'], confirmReady: true,
    ...(b.text !== undefined ? { text: promptText(b.text) } : {}), ...(b.agentId !== undefined ? { agentId: agentId(b.agentId) } : {}),
    ...(b.overrideReason !== undefined ? { overrideReason: promptText(b.overrideReason) } : {}), ...(branch ? { branch } : {}) };
}
