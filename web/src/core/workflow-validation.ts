import { AppError } from './errors.ts';
import { object, parseCommand, parseEvent, requestId, agentId } from './validation.ts';
import type { ActivityReset, HookEvent, RunAction, StartInput, WorkspaceReset } from '../contracts/workflow.ts';

export function parseStart(value: unknown): StartInput {
  const { pairId, autoContinue, turnLimit, ...command } = object(value);
  if (autoContinue !== undefined && typeof autoContinue !== 'boolean') throw new AppError('INVALID_BODY', 'autoContinue must be a boolean.');
  if (turnLimit !== undefined && (!Number.isInteger(turnLimit) || (turnLimit as number) < 1 || (turnLimit as number) > 200)) throw new AppError('INVALID_BODY', 'turnLimit must be an integer from 1 to 200.');
  return { ...parseCommand(command), ...(pairId !== undefined ? { pairId: agentId(pairId) } : {}),
    ...(autoContinue !== undefined ? { autoContinue } : {}), ...(turnLimit !== undefined ? { turnLimit: turnLimit as number } : {}) };
}
export function parseHook(value: unknown): HookEvent {
  const { commandId, sourceTurnId, identity, backgroundState, backgroundSummary, completionSequence, reporterPid, cliPid, startedAt, event, ...rest } = object(value);
  if (!['session_started', 'turn_started', 'turn_complete', 'turn_interrupted', 'outcome'].includes(String(event))) throw new AppError('INVALID_EVENT', 'Unknown lifecycle event.');
  if (event === 'session_started' && (commandId !== undefined || sourceTurnId !== undefined)) throw new AppError('INVALID_EVENT', 'Session startup cannot certify a command or turn.');
  const legacy = parseEvent({ ...rest, event: event === 'session_started' || event === 'turn_started' || event === 'turn_interrupted' ? 'turn_complete' : event });
  if (event === 'turn_interrupted' && (legacy.source !== 'codex' || !sourceTurnId || !identity || !cliPid || !startedAt || !legacy.sessionId || legacy.settled === true || legacy.outcome)) throw new AppError('INVALID_EVENT', 'Interruption requires exact Codex turn evidence and cannot certify completion.');
  if (sourceTurnId !== undefined && (typeof sourceTurnId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(sourceTurnId))) throw new AppError('INVALID_EVENT', 'Invalid source turn identity.');
  if (backgroundState !== undefined && !['clear', 'active', 'unknown'].includes(String(backgroundState))) throw new AppError('INVALID_EVENT', 'Invalid background state.');
  if (completionSequence !== undefined && (event !== 'turn_complete' || legacy.source !== 'claude' || !Number.isSafeInteger(completionSequence) || (completionSequence as number) < 1)) throw new AppError('INVALID_EVENT', 'Invalid completion sequence.');
  if (backgroundSummary !== undefined) {
    const summary = object(backgroundSummary);
    if (Object.keys(summary).sort().join(',') !== 'crons,taskTypes,tasks' ||
      [summary.tasks, summary.crons].some(n => n !== null && (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100000)) ||
      !Array.isArray(summary.taskTypes) || summary.taskTypes.length > 5 || new Set(summary.taskTypes).size !== summary.taskTypes.length ||
      summary.taskTypes.some(t => !['local_bash', 'local_agent', 'remote_agent', 'in_process_teammate', 'unknown'].includes(t))) throw new AppError('INVALID_EVENT', 'Invalid background summary.');
  }
  if (reporterPid !== undefined && (typeof reporterPid !== 'string' || !/^\d{1,10}$/.test(reporterPid))) throw new AppError('INVALID_EVENT', 'Invalid reporter process id.');
  if (cliPid !== undefined && (typeof cliPid !== 'string' || !/^\d{1,10}$/.test(cliPid))) throw new AppError('INVALID_EVENT', 'Invalid CLI process id.');
  if (startedAt !== undefined && (typeof startedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(startedAt) || !Number.isFinite(Date.parse(startedAt)))) throw new AppError('INVALID_EVENT', 'Invalid activity start time.');
  let pane;
  if (identity !== undefined) {
    const fields = object(identity);
    if (Object.keys(fields).sort().join(',') !== 'paneId,panePid,serverPid,serverStarted,socketPath') throw new AppError('INVALID_EVENT', 'Invalid pane identity fields.');
    for (const key of ['panePid', 'serverPid', 'serverStarted']) if (typeof fields[key] !== 'string' || !/^\d+$/.test(fields[key])) throw new AppError('INVALID_EVENT', 'Invalid process identity.');
    if (fields.paneId !== legacy.paneId || fields.socketPath !== legacy.socketPath) throw new AppError('INVALID_EVENT', 'Pane identity does not match the event envelope.');
    pane = fields as unknown as NonNullable<HookEvent['identity']>;
  }
  return { ...legacy, event: event as HookEvent['event'],
    ...(commandId !== undefined ? { commandId: requestId(commandId) } : {}),
    ...(sourceTurnId !== undefined ? { sourceTurnId: sourceTurnId as string } : {}),
    ...(pane ? { identity: pane } : {}), ...(backgroundState !== undefined ? { backgroundState: backgroundState as HookEvent['backgroundState'] } : {}),
    ...(backgroundSummary !== undefined ? { backgroundSummary: backgroundSummary as HookEvent['backgroundSummary'] } : {}),
    ...(completionSequence !== undefined ? { completionSequence: completionSequence as number } : {}),
    ...(reporterPid !== undefined ? { reporterPid: reporterPid as string } : {}), ...(cliPid !== undefined ? { cliPid: cliPid as string } : {}), ...(startedAt !== undefined ? { startedAt: startedAt as string } : {}) };
}
export function parseRunAction(value: unknown): RunAction {
  const body = object(value);
  if (Object.keys(body).some((k) => !['runId', 'action', 'confirmReady', 'expectedCommandId', 'expectedRevision'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown field.');
  if (!['pause','takeover','continue','recheck'].includes(String(body.action))) throw new AppError('INVALID_ACTION', 'Unknown run action.');
  if (body.action !== 'pause' && body.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Inspect every participant and stop all writers before changing ownership.');
  return { runId: requestId(body.runId), action: body.action as RunAction['action'], ...(body.confirmReady === true ? { confirmReady: true } : {}),
    ...(['continue', 'recheck'].includes(String(body.action)) ? { expectedCommandId: requestId(body.expectedCommandId) } : {}),
    ...(body.action === 'recheck' ? { expectedRevision: requestId(body.expectedRevision) } : {}) };
}
export function parseWorkspaceReset(value: unknown): WorkspaceReset {
  const body = object(value);
  if (Object.keys(body).some((k) => !['repository', 'confirmReady'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown field.');
  if (typeof body.repository !== 'string' || !body.repository.startsWith('/')) throw new AppError('INVALID_REPOSITORY', 'Repository must be an absolute path.');
  if (body.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Confirm that this workspace has no run in progress before forgetting its agents and groups.');
  return { repository: body.repository, confirmReady: true };
}
export function parseActivityReset(value: unknown): ActivityReset {
  const body = object(value);
  if (Object.keys(body).some((k) => !['agentId', 'registrationId', 'expectedUpdatedAt', 'confirmReady'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown field.');
  if (body.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Inspect the terminal and confirm an empty prompt with no background writers.');
  if (body.expectedUpdatedAt !== null && (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))) throw new AppError('INVALID_BODY', 'Expected activity timestamp is required.');
  return { agentId: agentId(body.agentId), registrationId: requestId(body.registrationId), expectedUpdatedAt: body.expectedUpdatedAt as string | null, confirmReady: true };
}
