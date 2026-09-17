import { AppError } from './errors.ts';
import { object, parseCommand, parseEvent, requestId, agentId } from './validation.ts';
import type { HookEvent, RunAction, StartInput } from '../contracts/workflow.ts';

export function parseStart(value: unknown): StartInput {
  const { pairId, autoContinue, ...command } = object(value);
  if (autoContinue !== undefined && typeof autoContinue !== 'boolean') throw new AppError('INVALID_BODY', 'autoContinue must be a boolean.');
  return { ...parseCommand(command), ...(pairId !== undefined ? { pairId: agentId(pairId) } : {}),
    ...(autoContinue !== undefined ? { autoContinue } : {}) };
}
export function parseHook(value: unknown): HookEvent {
  const { commandId, sourceTurnId, identity, backgroundState, event, ...rest } = object(value);
  if (!['turn_started', 'turn_complete', 'outcome'].includes(String(event))) throw new AppError('INVALID_EVENT', 'Unknown lifecycle event.');
  const legacy = parseEvent({ ...rest, event: event === 'turn_started' ? 'turn_complete' : event });
  if (sourceTurnId !== undefined && (typeof sourceTurnId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(sourceTurnId))) throw new AppError('INVALID_EVENT', 'Invalid source turn identity.');
  if (backgroundState !== undefined && !['clear', 'active', 'unknown'].includes(String(backgroundState))) throw new AppError('INVALID_EVENT', 'Invalid background state.');
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
    ...(pane ? { identity: pane } : {}), ...(backgroundState !== undefined ? { backgroundState: backgroundState as HookEvent['backgroundState'] } : {}) };
}
export function parseRunAction(value: unknown): RunAction {
  const body = object(value);
  if (Object.keys(body).some((k) => !['runId', 'action', 'confirmReady'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown field.');
  if (body.action !== 'pause' && body.action !== 'takeover') throw new AppError('INVALID_ACTION', 'Unknown run action.');
  if (body.action === 'takeover' && body.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Inspect every participant and stop all writers before releasing ownership.');
  return { runId: requestId(body.runId), action: body.action, ...(body.confirmReady === true ? { confirmReady: true } : {}) };
}
