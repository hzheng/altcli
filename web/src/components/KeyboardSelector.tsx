'use client';
import { api } from '../client/api';
import type { ManualSession, ManualWriter, TerminalTarget } from '../contracts/terminals';
import type { FrozenWriter, NativeTerminalHandle } from './NativeTerminal';

export interface KeyboardOwner { kind: 'this-browser' | 'this-browser-elsewhere' | 'other-browser' | 'unresolved'; key: string; label: string }
/** An aggregate display summary, never an exclusive keyboard owner or an admission decision. */
export function keyboardOwnerOf(sessions: ManualSession[] | undefined, clientInstanceId: string, here: (target: TerminalTarget) => { key: string; label: string } | undefined, describe?: (target: TerminalTarget) => string | undefined): KeyboardOwner | null {
  const all = sessions ?? [], writers = all.flatMap(m => m.writers.filter(w => w.live));
  if (!writers.length) return all.length ? { kind: 'unresolved', key: all.map(m => m.id + ':' + m.revision).join(','), label: 'unresolved manual input' } : null;
  return { kind: writers.every(w => w.clientInstanceId === clientInstanceId) ? 'this-browser' : 'other-browser',
    key: writers.map(w => w.connectionId + ':' + w.generation).join(','),
    label: writers.map(w => (here(w.target)?.label ?? describe?.(w.target) ?? 'terminal') + (w.clientInstanceId === clientInstanceId ? '' : ' (another browser/tab)')).join(', ') };
}

/** Freeze every local queue before asking the server to stop the exact displayed set. With `remote`, writers without a terminal in
 * this page (another browser or tab) are stopped too; that page sees the stop and switches to Display.
 * After a request is sent, an error never thaws a grant that may already have ended. */
export async function stopTerminalWriters(token: string, manual: ManualSession, writers: ManualWriter[], handle: (writer: ManualWriter) => NativeTerminalHandle | undefined, remote = false): Promise<ManualSession> {
  const frozen: { terminal: NativeTerminalHandle; state: FrozenWriter }[] = [];
  let sent = false;
  try {
    for (const writer of writers) {
      const terminal = handle(writer);
      if (!terminal?.matches(writer)) { if (remote) continue; throw Error('A selected terminal is no longer writable in this page. Inspect its input.'); }
      const state = terminal.freeze(true);
      if (!state) throw Error('A selected writer changed. Nothing was stopped.');
      frozen.push({ terminal, state });
    }
    sent = true;
    const result = await api<ManualSession>(token, 'terminals/stop', { body: { requestId: crypto.randomUUID(), expectedBootId: manual.bootId,
      manualSessionId: manual.id, expectedRevision: manual.revision,
      writers: writers.map(w => ({ connectionId: w.connectionId, generation: w.generation, revision: w.revision })) } });
    if (result.id !== manual.id || result.bootId !== manual.bootId || !Array.isArray(result.writers) || writers.some(w =>
      !result.writers.some(stopped => stopped.connectionId === w.connectionId && stopped.generation === w.generation && !stopped.live)))
      throw Error('The stop receipt does not match the selected writers. Inspect manual input.');
    for (const item of frozen) item.terminal.stopped(item.state);
    return result;
  } catch (error) {
    for (const item of frozen) {
      if (!sent) item.terminal.thaw(item.state);
      else item.terminal.abandon('The stop decision failed or is uncertain. Inspect manual input before continuing.');
    }
    throw error;
  }
}
