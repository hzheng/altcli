import type { GroupInput, GroupSelection, ImplementationStart, PolicyChange, ReviewPreviewInput, StandaloneStart } from '../contracts/implementation.ts';
import { AppError } from './errors.ts';
import { agentId, object, promptText, requestId, singleLine } from './validation.ts';

const invalid = (message: string): never => { throw new AppError('INVALID_IMPLEMENTATION', message); };
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) return invalid('Expected a full Git object ID. Recheck the workspace.');
  return value;
}
export function logPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some((p) => p === '.' || p === '..' || p.toLowerCase() === '.git')) return invalid('The log must be a relative file path outside .git, without traversal.');
  return value;
}
export function parseGroup(value: unknown): GroupInput {
  const body = object(value);
  if (Object.keys(body).some((k) => !['name', 'members'].includes(k))) return invalid('Unknown group field.');
  const name = singleLine(body.name);
  if (name.length > 40) return invalid('Group names are limited to 40 characters.');
  if (!Array.isArray(body.members) || body.members.length < 1) return invalid('Choose distinct agents.');
  const members = body.members.map(agentId);
  if (new Set(members).size !== members.length) return invalid('Choose distinct agents.');
  return { name, members };
}
export function parseGroupSelection(value: unknown): GroupSelection {
  const body = object(value);
  if (Object.keys(body).some((key) => !['members', 'expectedRevision', 'registrations'].includes(key))) return invalid('Unknown group selection field.');
  if (!Array.isArray(body.members)) return invalid('Choose distinct agents.');
  const members = body.members.map(agentId);
  if (new Set(members).size !== members.length) return invalid('Choose distinct agents.');
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return invalid('Confirm the current group revision.');
  const registrations = Object.fromEntries(Object.entries(object(body.registrations)).map(([id, generation]) => [agentId(id), requestId(generation)]));
  if (Object.keys(registrations).length !== members.length || members.some((id) => !registrations[id])) return invalid('Confirm each selected registration.');
  return { members, registrations, expectedRevision: Number(body.expectedRevision) };
}
export function parseImplementation(value: unknown): ImplementationStart {
  const b = object(value);
  if (Object.keys(b).some((k) => !['requestId','groupId','groupRevision','registrations','agentId','kind','text','handoff','policy','workerId','autoContinue','turnLimit','pauseOnObjection','logPath','branch','reviewBase','confirmReady'].includes(k))) return invalid('Unknown implementation field.');
  if (!Number.isInteger(b.groupRevision) || Number(b.groupRevision) < 1) return invalid('Confirm the current group revision.');
  const registrations = object(b.registrations);
  if (Object.keys(registrations).length < 1 || Object.keys(registrations).length > 2) return invalid('Confirm the exact selected registrations.');
  const instances = Object.fromEntries(Object.entries(registrations).map(([id, generation]) => [agentId(id), requestId(generation)]));
  if (!['solo','peer','worker_reviewer'].includes(String(b.policy)) || !['work','commit','review'].includes(String(b.kind))) return invalid('Choose a supported implementation policy and action.');
  if (typeof b.handoff !== 'boolean' || typeof b.autoContinue !== 'boolean' || b.confirmReady !== true) return invalid('Confirm readiness of all selected and other agents sharing this checkout.');
  if (b.pauseOnObjection !== undefined && typeof b.pauseOnObjection !== 'boolean') return invalid('Choose whether a reviewer objection pauses for you or routes to the author.');
  if (!Number.isInteger(b.turnLimit) || Number(b.turnLimit) < 1 || Number(b.turnLimit) > 200) return invalid('Automatic turn limit must be 1–200.');
  const branch = object(b.branch);
  if (Object.keys(branch).some((k) => !['branch','head','newBranch','taskBase'].includes(k)) || (branch.branch !== null && (typeof branch.branch !== 'string' || !branch.branch))) return invalid('Choose a branch against the displayed checkout and commit.');
  if (branch.taskBase !== undefined && branch.newBranch !== undefined) return invalid('A new branch begins at the confirmed commit; a task baseline applies only to an existing branch.');
  if (branch.newBranch !== undefined && (typeof branch.newBranch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,150}$/.test(branch.newBranch))) return invalid('Invalid new branch name.');
  const text = b.text === undefined || b.text === '' ? undefined : promptText(b.text);
  if (b.kind === 'commit' && b.autoContinue && !b.handoff) return invalid('Commit without relay cannot enable automatic continuation.');
  if (b.kind === 'commit' && !b.handoff && b.reviewBase !== undefined) return invalid('A review baseline requires relay.');
  if (b.kind === 'work' && !text) return invalid('Work needs an instruction.');
  if (b.kind === 'review' && b.reviewBase === undefined) return invalid('An existing-candidate review needs an explicit baseline.');
  return { requestId: requestId(b.requestId), groupId: agentId(b.groupId), groupRevision: Number(b.groupRevision), registrations: instances, agentId: agentId(b.agentId), kind: b.kind as ImplementationStart['kind'],
    ...(text ? { text } : {}), handoff: b.handoff, policy: b.policy as ImplementationStart['policy'], ...(b.workerId !== undefined ? { workerId: agentId(b.workerId) } : {}),
    autoContinue: b.autoContinue, turnLimit: Number(b.turnLimit), ...(b.pauseOnObjection !== undefined ? { pauseOnObjection: b.pauseOnObjection } : {}), ...(b.logPath !== undefined ? { logPath: logPath(b.logPath) } : {}),
    branch: { branch: branch.branch as string | null, head: sha(branch.head), ...(branch.newBranch !== undefined ? { newBranch: branch.newBranch as string } : {}), ...(branch.taskBase !== undefined ? { taskBase: sha(branch.taskBase) } : {}) },
    ...(b.reviewBase !== undefined ? { reviewBase: sha(b.reviewBase) } : {}), confirmReady: true };
}
export function parseStandalone(value: unknown): StandaloneStart {
  const b = object(value);
  if (Object.keys(b).some((k) => !['requestId','groupId','groupRevision','registrations','agentId','text','policy','workerId','confirmReady'].includes(k))) return invalid('Unknown standalone instruction field.');
  if (!Number.isSafeInteger(b.groupRevision) || Number(b.groupRevision) < 1) return invalid('Confirm the current group revision.');
  const registrations = Object.fromEntries(Object.entries(object(b.registrations)).map(([id, generation]) => [agentId(id), requestId(generation)]));
  if (Object.keys(registrations).length < 1 || Object.keys(registrations).length > 2) return invalid('Confirm the exact selected registrations.');
  if (!['solo','peer','worker_reviewer'].includes(String(b.policy)) || b.confirmReady !== true) return invalid('Confirm the policy and readiness of every agent sharing this checkout.');
  return { requestId: requestId(b.requestId), groupId: agentId(b.groupId), groupRevision: Number(b.groupRevision), registrations,
    agentId: agentId(b.agentId), text: promptText(b.text), policy: b.policy as StandaloneStart['policy'],
    ...(b.workerId !== undefined ? { workerId: agentId(b.workerId) } : {}), confirmReady: true };
}
export function parsePolicyChange(value: unknown): PolicyChange {
  const body = object(value);
  if (Object.keys(body).some((key) => !['runId','expectedCommandId','expectedRevision','policy','workerId','autoContinue','pauseOnObjection'].includes(key))) return invalid('Unknown policy field.');
  if (body.pauseOnObjection !== undefined && typeof body.pauseOnObjection !== 'boolean') return invalid('Choose whether a reviewer objection pauses for you or routes to the author.');
  if (!['peer','worker_reviewer'].includes(String(body.policy)) || typeof body.autoContinue !== 'boolean' || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return invalid('Invalid collaboration policy revision.');
  return { runId: requestId(body.runId), expectedCommandId: requestId(body.expectedCommandId), expectedRevision: Number(body.expectedRevision),
    policy: body.policy as PolicyChange['policy'], ...(body.workerId !== undefined ? { workerId: agentId(body.workerId) } : {}), autoContinue: body.autoContinue,
    ...(body.pauseOnObjection !== undefined ? { pauseOnObjection: body.pauseOnObjection } : {}) };
}

export function parseReviewPreview(value: unknown): ReviewPreviewInput {
  const b = object(value);
  if (Object.keys(b).some((key) => !['groupId', 'head', 'logPath', 'base', 'recipient', 'taskBase', 'commitPending'].includes(key))) return invalid('Unknown review preview field.');
  if (b.commitPending !== undefined && typeof b.commitPending !== 'boolean') return invalid('commitPending must be a boolean.');
  if (b.base === undefined ? b.recipient === undefined || b.taskBase === undefined : b.recipient !== undefined || b.taskBase !== undefined) return invalid('Preview either an explicit baseline, or the recipient and task baseline that derive one.');
  return { groupId: agentId(b.groupId), head: sha(b.head), ...(b.logPath !== undefined ? { logPath: logPath(b.logPath) } : {}), ...(b.commitPending !== undefined ? { commitPending: b.commitPending } : {}),
    ...(b.base !== undefined ? { base: sha(b.base) } : { recipient: agentId(b.recipient), taskBase: sha(b.taskBase) }) };
}
