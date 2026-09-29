'use client';
import { useState } from 'react';
import { api } from '../client/api';
import type { ManualSession, ManualWriter, TerminalTarget } from '../contracts/terminals';
import type { FrozenWriter, NativeTerminalHandle } from './NativeTerminal';

export interface KeyboardOption { key: string; label: string; inView: boolean }
export interface KeyboardOwner { kind: 'this-browser' | 'this-browser-elsewhere' | 'other-browser' | 'unresolved'; key: string; label: string }
/** An aggregate display summary, never an exclusive keyboard owner or an admission decision. */
export function keyboardOwnerOf(sessions: ManualSession[] | undefined, clientInstanceId: string, here: (target: TerminalTarget) => { key: string; label: string } | undefined, describe?: (target: TerminalTarget) => string | undefined): KeyboardOwner | null {
  const all = sessions ?? [], writers = all.flatMap(m => m.writers.filter(w => w.live));
  if (!writers.length) return all.length ? { kind: 'unresolved', key: all.map(m => m.id + ':' + m.revision).join(','), label: 'unresolved manual input' } : null;
  return { kind: writers.every(w => w.clientInstanceId === clientInstanceId) ? 'this-browser' : 'other-browser',
    key: writers.map(w => w.connectionId + ':' + w.generation).join(','),
    label: writers.map(w => (here(w.target)?.label ?? describe?.(w.target) ?? 'terminal') + (w.clientInstanceId === clientInstanceId ? '' : ' (another browser/tab)')).join(', ') };
}

/** Freeze every local queue before asking the server to stop the exact displayed set.
 * After a request is sent, an error never thaws a grant that may already have ended. */
export async function stopTerminalWriters(token: string, manual: ManualSession, writers: ManualWriter[], handle: (writer: ManualWriter) => NativeTerminalHandle | undefined, confirmReady = false, handoffRequestId?: string): Promise<ManualSession> {
  const frozen: { terminal: NativeTerminalHandle; state: FrozenWriter }[] = [];
  let sent = false;
  try {
    for (const writer of writers) {
      const terminal = handle(writer);
      if (!terminal?.matches(writer)) throw Error('A selected terminal is no longer writable in this page. Inspect its input.');
      const state = terminal.freeze(!confirmReady);
      if (!state) throw Error('A selected writer changed. Nothing was stopped.');
      frozen.push({ terminal, state });
    }
    sent = true;
    const result = await api<ManualSession>(token, 'terminals/stop', { body: { requestId: crypto.randomUUID(), expectedBootId: manual.bootId,
      manualSessionId: manual.id, expectedRevision: manual.revision,
      writers: writers.map(w => ({ connectionId: w.connectionId, generation: w.generation, revision: w.revision })),
      ...(confirmReady ? { confirmReady: true } : {}), ...(handoffRequestId ? { handoffRequestId } : {}) } });
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

/** Explicit stop/recovery only. Typing in NativeTerminal owns initial admission. */
export function useKeyboardControls({ sessions, clientInstanceId, token, options, handle, disabled, refresh, describe, onShow }: {
  sessions: ManualSession[]; clientInstanceId: string; token: string;
  options: KeyboardOption[]; handle: (key: string) => NativeTerminalHandle | undefined;
  disabled: boolean; refresh: () => Promise<void>; describe: (target: TerminalTarget) => string;
  onShow?: (key: string) => void;
}) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const localHandle = (writer: ManualWriter) => options.map(o => handle(o.key)).find(h => h?.matches(writer));
  const live = sessions.flatMap(m => m.writers.filter(w => w.live).map(writer => ({ manual: m, writer })));
  const mine = live.filter(({ writer }) => writer.clientInstanceId === clientInstanceId);
  async function stop(manual: ManualSession, writers: ManualWriter[]) {
    setPending(true); setMessage('');
    try { const result = await stopTerminalWriters(token, manual, writers, localHandle); setMessage(result.reason); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Typing could not be stopped. Inspect manual input.'); }
    finally { setPending(false); await refresh(); }
  }
  const recovery = <div className="keyboard-release">
    <p className="fine">{live.length ? `${live.length} active input connection${live.length === 1 ? '' : 's'}. Automation is held across this server.` : 'No active input connections. Type directly in a terminal to begin.'}</p>
    {live.map(({ manual, writer }) => <div className="pane-buttons" key={writer.connectionId}>
      <span>{describe(writer.target)} · {writer.clientInstanceId === clientInstanceId ? 'this browser' : 'another browser/tab'}</span>
      {writer.clientInstanceId === clientInstanceId && <button type="button" className="quiet" disabled={disabled || pending || !localHandle(writer)} onClick={() => void stop(manual, [writer])}>Stop typing here</button>}
      {writer.clientInstanceId !== clientInstanceId && <span className="fine">Stop this connection in its own browser.</span>}
      {(() => { const target = writer.target, option = 'agentId' in target ? options.find(o => o.key === target.agentId) : undefined;
        return option && !option.inView && onShow && <button type="button" className="quiet" onClick={() => onShow(option.key)}>Show {option.label}</button>; })()}
    </div>)}
    {mine.length > 1 && <button type="button" className="quiet" disabled={disabled || pending || mine.some(x => !localHandle(x.writer)) || new Set(mine.map(x => x.manual.id)).size !== 1}
      onClick={() => void stop(mine[0]!.manual, mine.map(x => x.writer))}>Stop typing in this browser</button>}
    {sessions.filter(m => m.recoveryRequired).map(m => <p className="fine" key={m.id}>Input needs inspection: {m.reason}</p>)}
    {message && <p className="fine" aria-live="polite">{message}</p>}
  </div>;
  return { recovery };
}
