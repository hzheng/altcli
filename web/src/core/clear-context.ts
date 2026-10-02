import type { AgentType, ClearContextInput } from '../contracts/api.ts';
import { AppError } from './errors.ts';
import { agentId, object, requestId } from './validation.ts';

/** Native conversation commands must be sent alone, without a workflow correlation suffix. */
export function clearContextCommand(type: AgentType): string | null {
  return type === 'claude' || type === 'codex' ? '/clear' : null;
}
export function parseClearContext(value: unknown): ClearContextInput {
  const b = object(value);
  if (Object.keys(b).some(k => !['requestId', 'agentId', 'registrationId', 'expectedActivityUpdatedAt', 'confirmReady'].includes(k))) throw new AppError('INVALID_BODY', 'Unexpected clear-context field.');
  if (b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'Inspect the empty prompt and confirm clearing this conversation.');
  if (b.expectedActivityUpdatedAt !== null && (typeof b.expectedActivityUpdatedAt !== 'string' || b.expectedActivityUpdatedAt.length > 40 || !Number.isFinite(Date.parse(b.expectedActivityUpdatedAt)))) throw new AppError('INVALID_ACTIVITY', 'Include the displayed activity timestamp, or null when unknown.');
  return { requestId: requestId(b.requestId), agentId: agentId(b.agentId), registrationId: requestId(b.registrationId), expectedActivityUpdatedAt: b.expectedActivityUpdatedAt as string | null, confirmReady: true };
}
