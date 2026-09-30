import type { KeyboardBatch, KeyboardInput, KeyboardSettlement, ManualReconcile, NativeImageInput, NativeInput, TerminalOpen, TerminalTarget } from '../contracts/terminals.ts';
import { TERMINAL_LIMITS } from '../contracts/terminals.ts';
import { AppError } from './errors.ts';
import { object, requestId } from './validation.ts';
export function terminalFields(value: unknown, allowed: string[]): Record<string, unknown> {
  const body = object(value);
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new AppError('TERMINAL_INPUT', 'Unexpected terminal field.');
  return body;
}
export function terminalText(value: unknown, limit = 200): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new AppError('TERMINAL_INPUT', 'Invalid terminal identifier.');
  return value;
}
export function terminalNumber(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new AppError('TERMINAL_INPUT', 'Invalid terminal number.');
  return Number(value);
}
export function terminalSize(value: unknown): { cols: number; rows: number } {
  const b = object(value);
  return { cols: Math.max(20, Math.min(500, terminalNumber(b.cols, 1, 10000))), rows: Math.max(5, Math.min(200, terminalNumber(b.rows, 1, 10000))) };
}
export function parseTerminalOpen(value: unknown): TerminalOpen {
  const b = terminalFields(value, ['protocol', 'target', 'cols', 'rows', 'clientInstanceId']);
  if (b.protocol !== 2) throw new AppError('TERMINAL_VERSION', 'Reload this browser to use the current terminal protocol.', 409);
  const t = terminalFields(b.target, ['agentId', 'registrationId', 'launchId']);
  let target: TerminalTarget;
  if (Object.keys(t).length === 1 && t.launchId !== undefined) target = { launchId: requestId(t.launchId) };
  else if (Object.keys(t).length === 2 && t.launchId === undefined) target = { agentId: terminalText(t.agentId), registrationId: requestId(t.registrationId) };
  else throw new AppError('TERMINAL_INPUT', 'Choose one exact terminal target.');
  return { protocol: 2, target, ...terminalSize(b), clientInstanceId: requestId(b.clientInstanceId) };
}
export function parseKeyboard(value: unknown): KeyboardInput {
  const b = terminalFields(value, ['requestId', 'action', 'expectedGeneration', 'expectedBootId', 'confirmReady', 'expectedRevision', 'handoffRequestId']);
  if (!['acquire', 'release', 'releaseSettled'].includes(String(b.action)) || (b.confirmReady !== undefined && typeof b.confirmReady !== 'boolean')) throw new AppError('TERMINAL_INPUT', 'Invalid keyboard decision.');
  if (b.action === 'releaseSettled' && b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm that manual input is settled.');
  if (b.expectedRevision !== undefined && b.action !== 'releaseSettled') throw new AppError('TERMINAL_INPUT', 'A keyboard revision applies only to a settled release.');
  if (b.handoffRequestId !== undefined && (b.action !== 'releaseSettled' || b.expectedRevision === undefined)) throw new AppError('TERMINAL_INPUT', 'A handoff requires a checked settled release.');
  return { requestId: requestId(b.requestId), action: b.action as KeyboardInput['action'], expectedGeneration: requestId(b.expectedGeneration), expectedBootId: requestId(b.expectedBootId),
    ...(b.expectedRevision === undefined ? {} : { expectedRevision: terminalNumber(b.expectedRevision, 1, Number.MAX_SAFE_INTEGER) }),
    ...(b.handoffRequestId === undefined ? {} : { handoffRequestId: requestId(b.handoffRequestId) }),
    ...(b.confirmReady === undefined ? {} : { confirmReady: b.confirmReady as boolean }) };
}
export function parseKeyboardBatch(value: unknown): KeyboardBatch {
  const b = terminalFields(value, ['requestId', 'expectedBootId', 'manualSessionId', 'expectedRevision', 'writers', 'confirmReady', 'handoffRequestId']);
  if (!Array.isArray(b.writers) || !b.writers.length || b.writers.length > TERMINAL_LIMITS.hostConnections) throw new AppError('TERMINAL_INPUT', 'Choose the exact writers to stop.');
  const writers = b.writers.map(value => { const w = terminalFields(value, ['connectionId', 'generation', 'revision']);
    return { connectionId: requestId(w.connectionId), generation: requestId(w.generation), revision: terminalNumber(w.revision, 1, Number.MAX_SAFE_INTEGER) }; });
  if (new Set(writers.map(w => w.connectionId)).size !== writers.length) throw new AppError('TERMINAL_INPUT', 'Duplicate writer.');
  if (b.confirmReady !== undefined && b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm settlement or stop without settlement.');
  if (b.handoffRequestId !== undefined && b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'A handoff requires confirmed settlement.');
  return { requestId: requestId(b.requestId), expectedBootId: requestId(b.expectedBootId), manualSessionId: requestId(b.manualSessionId),
    expectedRevision: terminalNumber(b.expectedRevision, 1, Number.MAX_SAFE_INTEGER), writers,
    ...(b.confirmReady === true ? { confirmReady: true } : {}), ...(b.handoffRequestId === undefined ? {} : { handoffRequestId: requestId(b.handoffRequestId) }) };
}
export function parseKeyboardSettlement(value: unknown): KeyboardSettlement {
  const b = terminalFields(value, ['manualSessionId', 'revision']);
  return { manualSessionId: requestId(b.manualSessionId), revision: terminalNumber(b.revision, 1, Number.MAX_SAFE_INTEGER) };
}
export function parseNativeInput(value: unknown): NativeInput | NativeImageInput {
  const b = terminalFields(value, ['generation', 'seq', 'encoding', 'data', 'image']);
  if (b.image !== undefined) {
    if (b.encoding !== undefined || b.data !== undefined) throw new AppError('TERMINAL_INPUT', 'An image insertion carries no terminal bytes.');
    const i = terminalFields(b.image, ['attachmentId', 'bootId', 'paneId', 'sessionId']);
    return { generation: requestId(b.generation), seq: terminalNumber(b.seq, 1, Number.MAX_SAFE_INTEGER),
      image: { attachmentId: requestId(i.attachmentId), bootId: requestId(i.bootId), paneId: terminalText(i.paneId, 32), sessionId: terminalText(i.sessionId, 64) } };
  }
  if (!['utf8', 'binary'].includes(String(b.encoding)) || typeof b.data !== 'string' || b.data.length > TERMINAL_LIMITS.inputFrame * 2) throw new AppError('TERMINAL_INPUT', 'Invalid terminal input frame.');
  return { generation: requestId(b.generation), seq: terminalNumber(b.seq, 1, Number.MAX_SAFE_INTEGER), encoding: b.encoding as NativeInput['encoding'], data: b.data };
}
export function parseManualReconcile(value: unknown): ManualReconcile {
  const b = terminalFields(value, ['requestId', 'manualSessionId', 'expectedRevision', 'confirmReady', 'confirmInspected', 'note']);
  const identity = { requestId: requestId(b.requestId), manualSessionId: requestId(b.manualSessionId), expectedRevision: terminalNumber(b.expectedRevision, 1, Number.MAX_SAFE_INTEGER) };
  if (b.confirmInspected !== undefined || b.note !== undefined) {
    if (b.confirmInspected !== true || b.confirmReady !== undefined) throw new AppError('CONFIRM_REQUIRED', 'Confirm one inspection decision, acknowledging possible prior and background effects.');
    const note = terminalText(b.note, 1000);
    if (!note.trim()) throw new AppError('TERMINAL_INPUT', 'Record what you inspected.');
    return { ...identity, confirmInspected: true, note };
  }
  if (b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'Inspect the terminal and confirm it is settled.');
  return { ...identity, confirmReady: true };
}
