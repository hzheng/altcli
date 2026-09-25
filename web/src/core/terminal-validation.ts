import type { KeyboardInput, ManualReconcile, NativeInput, TerminalOpen, TerminalTarget } from '../contracts/terminals.ts';
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
  const b = terminalFields(value, ['target', 'cols', 'rows', 'clientInstanceId']);
  const t = terminalFields(b.target, ['agentId', 'registrationId', 'launchId']);
  let target: TerminalTarget;
  if (Object.keys(t).length === 1 && t.launchId !== undefined) target = { launchId: requestId(t.launchId) };
  else if (Object.keys(t).length === 2 && t.launchId === undefined) target = { agentId: terminalText(t.agentId), registrationId: requestId(t.registrationId) };
  else throw new AppError('TERMINAL_INPUT', 'Choose one exact terminal target.');
  return { target, ...terminalSize(b), clientInstanceId: requestId(b.clientInstanceId) };
}
export function parseKeyboard(value: unknown): KeyboardInput {
  const b = terminalFields(value, ['requestId', 'action', 'expectedGeneration', 'transfer', 'confirmReady']);
  if (!['acquire', 'release', 'releaseSettled'].includes(String(b.action)) || (b.transfer !== undefined && typeof b.transfer !== 'boolean') || (b.confirmReady !== undefined && typeof b.confirmReady !== 'boolean')) throw new AppError('TERMINAL_INPUT', 'Invalid keyboard decision.');
  if (b.action !== 'release' && b.confirmReady !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the server-wide keyboard operation.');
  return { requestId: requestId(b.requestId), action: b.action as KeyboardInput['action'], expectedGeneration: requestId(b.expectedGeneration),
    ...(b.transfer === undefined ? {} : { transfer: b.transfer as boolean }), ...(b.confirmReady === undefined ? {} : { confirmReady: b.confirmReady as boolean }) };
}
export function parseNativeInput(value: unknown): NativeInput {
  const b = terminalFields(value, ['generation', 'seq', 'encoding', 'data']);
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
