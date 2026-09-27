'use client';
import { useEffect, useRef, useState } from 'react';
import { HttpError } from '../client/api';
import type { ManualSession, TerminalTarget } from '../contracts/terminals';
import type { FrozenWriter, NativeTerminalHandle } from './NativeTerminal';
import { IconButton } from './Hint';

export interface KeyboardOption { key: string; label: string; inView: boolean }
/** Who holds the one server-wide keyboard, as the server last reported it. `key` identifies the holder: an option key for this
 * browser's terminal here, otherwise the manual-input record, so a changed holder is never mistaken for the one confirmed. */
export interface KeyboardOwner { kind: 'this-browser' | 'this-browser-elsewhere' | 'other-browser' | 'unresolved'; key: string; label: string }
/** The server-reported holder; `here` names this browser's writer when it is one of the mounted terminals here. */
export function keyboardOwnerOf(sessions: ManualSession[] | undefined, clientInstanceId: string, here: (target: TerminalTarget) => { key: string; label: string } | undefined, describe?: (target: TerminalTarget) => string | undefined): KeyboardOwner | null {
  const all = sessions ?? []; const live = all.find((m) => m.live);
  if (live) {
    const label = describe?.(live.target);
    if (live.clientInstanceId !== clientInstanceId) return { kind: 'other-browser', key: `${live.id}:${live.generation}`, label: label ? `${label} (another browser)` : 'another browser' };
    const mine = here(live.target);
    return mine ? { kind: 'this-browser', ...mine } : { kind: 'this-browser-elsewhere', key: `${live.id}:${live.generation}`, label: label ? `${label} (another terminal in this browser)` : 'another terminal in this browser' };
  }
  return all.length ? { kind: 'unresolved', key: all.map((m) => `${m.id}:${m.revision}`).join(','), label: 'an unresolved manual-input record' } : null;
}
type Pending = { id: number; key: string; sent: boolean };
type Asking = { kind: 'acquire'; key: string; owner: KeyboardOwner | null; viewEpoch: number } | { kind: 'settled' };

/** One decision coordinator for local claim buttons and Control access's release actions. The status icon never grants authority.
 * All targets share pending intent, transfer, cancellation and uncertainty handling; no effect requests the keyboard. */
export function useKeyboardControls({ options, handle, owner, affected, disabled, viewEpoch, refresh, onShow }: {
  options: KeyboardOption[]; handle: (key: string) => NativeTerminalHandle | undefined; owner: KeyboardOwner | null;
  affected: string[]; disabled: boolean; viewEpoch: number; refresh: () => Promise<void>; onShow?: (key: string) => void;
}) {
  const [asking, setAsking] = useState<Asking | null>(null), [pending, setPending] = useState<Pending | null>(null), [message, setMessage] = useState('');
  const intent = useRef(0);
  const [messageFor, setMessageFor] = useState<string | null>(null);
  const ownerKey = owner ? `${owner.kind}:${owner.key}` : '';
  const latest = useRef({ ownerKey, viewEpoch, disabled, keys: [] as string[] });
  latest.current = { ownerKey, viewEpoch, disabled, keys: options.map((o) => o.key) };
  // Unmounting invalidates an unsent intent. Lock also clears available targets and disables decisions.
  useEffect(() => () => { intent.current++; }, []);
  // A view or owner change revokes an open confirmation: it attested to what was on screen.
  useEffect(() => { setAsking(null); }, [viewEpoch, ownerKey]);
  const mine = owner?.kind === 'this-browser' ? owner.key : null;
  const labelOf = (key: string) => options.find((o) => o.key === key)?.label ?? key;
  const off = disabled || !!pending;
  const settle = (id: number) => setPending((p) => p?.id === id ? null : p);
  /** After a decision the server made, stay pending until the reported owner changes (bounded): polls can overlap the refresh, and
   * a choice made while the old writer still shows would be ignored or misdirected. */
  async function settleAfter(id: number, before: string, decided: boolean) {
    await refresh();
    for (const deadline = Date.now() + 3000; decided && latest.current.ownerKey === before && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 100));
    settle(id);
  }
  function claim(key: string) {
    if (off || key === mine) return;
    setMessage(''); setMessageFor(key);
    intent.current++; setAsking({ kind: 'acquire', key, owner, viewEpoch });
  }
  async function acquire(ask: Extract<Asking, { kind: 'acquire' }>) {
    const id = ++intent.current; const askedOwner = ask.owner ? `${ask.owner.kind}:${ask.owner.key}` : '';
    setAsking(null); setPending({ id, key: ask.key, sent: false }); setMessage('');
    const current = () => id === intent.current && latest.current.ownerKey === askedOwner && latest.current.viewEpoch === ask.viewEpoch && latest.current.keys.includes(ask.key) && !latest.current.disabled;
    let frozen: { key: string; writer: FrozenWriter } | null = null; let sent = false, decided = false;
    try {
      const target = handle(ask.key);
      if (!target) throw Error(`${labelOf(ask.key)} has no terminal here. Nothing was requested.`);
      await target.connect();
      if (!current()) { setMessage('Keyboard request cancelled before it was sent: the view, the pane or the keyboard owner changed. Nothing was requested.'); return; }
      // Stop typing in this browser's current pane first; nothing typed there moves to the new pane.
      if (ask.owner?.kind === 'this-browser') { const old = handle(ask.owner.key)?.freeze(); if (old) frozen = { key: ask.owner.key, writer: old }; }
      sent = true; setPending({ id, key: ask.key, sent: true });
      const result = await target.keyboard('acquire', !!ask.owner); decided = result.writer;
      setMessage(result.writer ? `Keyboard moved to ${labelOf(ask.key)}.` : result.reason);
    } catch (error) {
      // Only a definite refusal leaves the old writer as it was; a lost response may have moved authority.
      const definite = !sent || (error instanceof HttpError && error.status < 500);
      if (frozen && definite) handle(frozen.key)?.thaw(frozen.writer);
      const text = error instanceof Error ? error.message : 'Keyboard request failed.';
      setMessage(definite ? text : `${text} The keyboard decision may have happened; the keyboard status shows what the server reports. Inspect before typing.`);
    } finally { await settleAfter(id, askedOwner, decided); }
  }
  async function release(settled: boolean) {
    const key = mine; setAsking(null); setMessage(''); setMessageFor('release');
    if (!key) return;
    const target = handle(key);
    if (!target) { setMessage(`${labelOf(key)} has no terminal here. Nothing was released.`); return; }
    const id = ++intent.current, before = latest.current.ownerKey; let decided = false; setPending({ id, key: 'none', sent: true });
    try { const result = await target.keyboard(settled ? 'releaseSettled' : 'release', false); decided = !result.writer; setMessage(result.reason); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Keyboard release is uncertain. Inspect before typing.'); }
    finally { await settleAfter(id, before, decided); }
  }
  const shown = mine ? options.find((o) => o.key === mine) : undefined;
  /** The terminal's ⌨️ tool: it only asks, and the confirmation below the tool row sends the request. Hidden while this pane types. */
  function claimButton(key: string) {
    if (mine === key) return null;
    return <IconButton icon="⌨️" label="Claim keyboard" disabled={off} aria-busy={pending?.key === key} onClick={() => claim(key)}
      help="Type in this pane: asks for confirmation first, then holds AltCLI dispatch, setup and launch until you release it in Control access." />;
  }
  function claimControl(key: string) {
    const ask = asking?.kind === 'acquire' && asking.key === key ? asking : null;
    return <div className="keyboard-claim">
      {pending?.key === key && !pending.sent && <button type="button" className="quiet" onClick={() => { intent.current++; settle(pending.id); setMessage('Keyboard request cancelled. Nothing was requested.'); }}>Cancel keyboard request</button>}
      {ask && <div className="notice" role="region" aria-label="Confirm keyboard">
        <p>{!ask.owner ? `Take the one keyboard for this tmux server and type in ${labelOf(key)}.`
          : ask.owner.kind === 'this-browser' ? `Move the keyboard from ${ask.owner.label} to ${labelOf(key)}. Nothing typed in ${ask.owner.label} moves with it, and its manual input still needs reconciliation.`
          : ask.owner.kind === 'unresolved' ? `Recover the keyboard for ${labelOf(key)}. Earlier manual input is unresolved and still needs reconciliation.`
          : `Transfer the keyboard from ${ask.owner.label} to ${labelOf(key)}. Check with its user first. Typing there stops, and its manual input still needs reconciliation.`}
          {' '}Dispatch, setup and launch are held until manual input is reconciled. Terminal input can run commands and tmux shortcuts on this host.</p>
        {affected.length > 0 && <ul aria-label="Affected runs">{affected.map((run) => <li key={run}>{run}</li>)}</ul>}
        <button type="button" disabled={off} onClick={() => void acquire(ask)}>Confirm keyboard</button><button type="button" onClick={() => setAsking(null)}>Cancel</button>
      </div>}
      {messageFor === key && message && <p className="fine" aria-live="polite">{message}</p>}
    </div>;
  }
  const recovery = <div className="keyboard-release">
    <div className="pane-buttons">
      {shown && !shown.inView && onShow && <button type="button" className="quiet" onClick={() => onShow(shown.key)}>Show {shown.label}</button>}
      {mine && <>
        <button type="button" className="quiet" disabled={off} onClick={() => void release(false)}>Release keyboard</button>
        <button type="button" className="quiet" disabled={off} onClick={() => { intent.current++; setMessage(''); setMessageFor('release'); setAsking({ kind: 'settled' }); }}>Release and record settled…</button>
      </>}
    </div>
    {!mine && <p className="fine">{owner && owner.kind !== 'unresolved' ? `Keyboard: ${owner.label}.` : 'Nobody holds the keyboard.'} Claim it at the terminal where you want to type.</p>}
    {asking?.kind === 'settled' && <div className="notice" role="region" aria-label="Confirm settled release">
      <p>Confirm every pane is settled, with empty prompts and no background writers. Each held run still needs checkpoint review.</p>
      <button type="button" disabled={off} onClick={() => void release(true)}>Confirm settled release</button><button type="button" onClick={() => setAsking(null)}>Cancel</button>
    </div>}
    {messageFor === 'release' && message && <p className="fine" aria-live="polite">{message}</p>}
  </div>;
  return { claimButton, claimControl, recovery };
}
