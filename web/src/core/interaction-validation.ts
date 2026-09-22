import type { CheckpointInput, InteractionInput } from '../contracts/interactions.ts';
import { AppError } from './errors.ts';
import { agentId, object, promptText, requestId } from './validation.ts';

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError('INVALID_REVISION', 'A current interaction revision is required.');
  return value as number;
}
function nativeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(value)) throw new AppError('INVALID_ID', 'The exact native turn binding is required.');
  return value;
}
export function parseInteraction(value: unknown): InteractionInput {
  const b = object(value);
  if (Object.keys(b).some((k) => !['requestId','runId','commandId','agentId','registrationId','sessionId','sourceTurnId','expectedRevision','confirmPresent','purpose','text','key','confirmInterrupt'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown interaction field.');
  if (b.confirmPresent !== true) throw new AppError('PRESENCE_REQUIRED', 'Inspect this terminal before sending input.');
  if (!['detail','answer','key'].includes(String(b.purpose))) throw new AppError('INVALID_PURPOSE', 'Unknown input purpose.');
  const result: InteractionInput = { requestId: requestId(b.requestId), runId: requestId(b.runId), commandId: requestId(b.commandId), agentId: agentId(b.agentId), registrationId: requestId(b.registrationId), sessionId: nativeId(b.sessionId), sourceTurnId: nativeId(b.sourceTurnId), expectedRevision: revision(b.expectedRevision), confirmPresent: true, purpose: b.purpose as InteractionInput['purpose'] };
  if (b.purpose === 'key') {
    if (b.confirmInterrupt !== undefined && b.confirmInterrupt !== true) throw new AppError('INTERRUPT_CONFIRMATION', 'Interrupt confirmation must be true when supplied.');
    if (b.text !== undefined || !['Enter','Escape'].includes(String(b.key))) throw new AppError('INVALID_KEY', 'Choose Enter or Escape.');
    if (b.key === 'Escape' && b.confirmInterrupt !== true) throw new AppError('INTERRUPT_CONFIRMATION', 'Escape may interrupt the agent. Confirm it explicitly.');
    result.key = b.key as 'Enter' | 'Escape';
    if (b.confirmInterrupt === true) result.confirmInterrupt = true;
  } else {
    if (b.key !== undefined || b.confirmInterrupt !== undefined) throw new AppError('INVALID_KEY', 'Text input cannot include a key.');
    result.text = promptText(b.text);
    if (/\[codercrew-command:/i.test(result.text)) throw new AppError('INVALID_TEXT', 'An update cannot contain a controller command marker.');
  }
  return result;
}
export function parseCheckpoint(value: unknown): CheckpointInput {
  const b = object(value);
  if (Object.keys(b).some((k) => !['requestId','runId','commandId','expectedRevision','action','confirmReady'].includes(k))) throw new AppError('UNKNOWN_FIELD', 'Unknown checkpoint field.');
  if (b.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Inspect every terminal and all checkout writers.');
  if (!['review_input','restore'].includes(String(b.action))) throw new AppError('INVALID_ACTION', 'Unknown checkpoint action.');
  return { requestId: requestId(b.requestId), runId: requestId(b.runId), commandId: requestId(b.commandId), expectedRevision: revision(b.expectedRevision), action: b.action as CheckpointInput['action'], confirmReady: true };
}
