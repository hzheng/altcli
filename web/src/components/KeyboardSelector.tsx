'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { HttpError } from '../client/api';
import type { ManualSession, TerminalTarget } from '../contracts/terminals';
import type { FrozenWriter, NativeTerminalHandle } from './NativeTerminal';
import { StatusIcon } from './Hint';

export interface KeyboardOption { key: string; label: string; inView: boolean }
/** Who holds the one server-wide keyboard, as the server last reported it. `key` identifies the holder: an option key for this
 * browser's terminal here, otherwise the manual-input record, so a changed holder is never mistaken for the one confirmed. */
export interface KeyboardOwner { kind: 'this-browser' | 'this-browser-elsewhere' | 'other-browser' | 'unresolved'; key: string; label: string }
/** The server-reported holder; `here` names this browser's writer when it is one of the selector's own terminals. */
export function keyboardOwnerOf(sessions: ManualSession[] | undefined, clientInstanceId: string, here: (target: TerminalTarget) => { key: string; label: string } | undefined): KeyboardOwner | null {
  const all = sessions ?? []; const live = all.find((m) => m.live);
  if (live) {
    if (live.clientInstanceId !== clientInstanceId) return { kind: 'other-browser', key: `${live.id}:${live.generation}`, label: 'another browser' };
    const mine = here(live.target);
    return mine ? { kind: 'this-browser', ...mine } : { kind: 'this-browser-elsewhere', key: `${live.id}:${live.generation}`, label: 'another terminal in this browser' };
  }
  return all.length ? { kind: 'unresolved', key: all.map((m) => `${m.id}:${m.revision}`).join(','), label: 'an unresolved manual-input record' } : null;
}
const OWNER_STATUS = {
  'this-browser-elsewhere': ['↔️', 'Keyboard in another terminal', 'This browser types in a terminal that is not listed here. Choosing a pane here moves the keyboard to it.'],
  'other-browser': ['🔒', 'Keyboard held in another browser', 'Another browser holds the keyboard for this tmux server. Choosing a pane here transfers it; check with that browser’s user first.'],
  unresolved: ['⚠️', 'Manual input unresolved', 'Earlier manual input is not reconciled. Review it in the manual input notice; choosing a pane here recovers the keyboard but not that review.'],
} as const;
type Pending = { id: number; key: string; sent: boolean };
type Asking = { kind: 'acquire'; key: string; owner: KeyboardOwner | null; viewEpoch: number } | { kind: 'settled' };

/** The one keyboard for this tmux server, chosen in one place. A choice asks for confirmation and then uses the broker's serialized
 * acquire/transfer on that pane's terminal. It never grants from an effect, never releases one pane before acquiring another, and a
 * cancelled, superseded or outdated intent sends nothing. The checked selection is always what the server reports. */
export function KeyboardSelector({ options, handle, owner, affected, disabled, viewEpoch, refresh, onShow }: {
  options: KeyboardOption[]; handle: (key: string) => NativeTerminalHandle | undefined; owner: KeyboardOwner | null;
  affected: string[]; disabled: boolean; viewEpoch: number; refresh: () => Promise<void>; onShow?: (key: string) => void;
}) {
  const name = useId();
  const [asking, setAsking] = useState<Asking | null>(null), [pending, setPending] = useState<Pending | null>(null), [message, setMessage] = useState('');
  const intent = useRef(0);
  const ownerKey = owner ? `${owner.kind}:${owner.key}` : '';
  const latest = useRef({ ownerKey, viewEpoch, keys: [] as string[] });
  latest.current = { ownerKey, viewEpoch, keys: options.map((o) => o.key) };
  // Unmounting (Lock, leaving the section) invalidates any intent that has not been sent.
  useEffect(() => () => { intent.current++; }, []);
  // A view or owner change revokes an open confirmation: it attested to what was on screen.
  useEffect(() => { setAsking(null); }, [viewEpoch, ownerKey]);
  const mine = owner?.kind === 'this-browser' ? owner.key : null;
  const checked = mine ?? (owner ? null : 'none');
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
  function choose(key: string) {
    setMessage('');
    if (off) return;
    if (key === 'none') {
      if (mine) void release(false);
      else if (owner) setMessage(`${owner.label} holds the keyboard; choosing Nobody here cannot release it.`);
      return;
    }
    if (key === mine) return;
    intent.current++; setAsking({ kind: 'acquire', key, owner, viewEpoch });
  }
  async function acquire(ask: Extract<Asking, { kind: 'acquire' }>) {
    const id = ++intent.current; const askedOwner = ask.owner ? `${ask.owner.kind}:${ask.owner.key}` : '';
    setAsking(null); setPending({ id, key: ask.key, sent: false }); setMessage('');
    const current = () => id === intent.current && latest.current.ownerKey === askedOwner && latest.current.viewEpoch === ask.viewEpoch && latest.current.keys.includes(ask.key);
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
      setMessage(definite ? text : `${text} The keyboard decision may have happened; this selector shows what the server reports. Inspect before typing.`);
    } finally { await settleAfter(id, askedOwner, decided); }
  }
  async function release(settled: boolean) {
    const key = mine; setAsking(null); setMessage('');
    if (!key) return;
    const target = handle(key);
    if (!target) { setMessage(`${labelOf(key)} has no terminal here. Nothing was released.`); return; }
    const id = ++intent.current, before = latest.current.ownerKey; let decided = false; setPending({ id, key: 'none', sent: true });
    try { const result = await target.keyboard(settled ? 'releaseSettled' : 'release', false); decided = !result.writer; setMessage(result.reason); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Keyboard release is uncertain. Inspect before typing.'); }
    finally { await settleAfter(id, before, decided); }
  }
  const status = owner && owner.kind !== 'this-browser' ? OWNER_STATUS[owner.kind] : null;
  const shown = mine ? options.find((o) => o.key === mine) : undefined;
  return <div className="keyboard-block">
    <div className="keyboard-selector">
      <span className="target-caption">Keyboard</span>
      <span role="radiogroup" aria-label="Keyboard input" className="kb-radios">
        <label><input type="radio" name={name} value="none" checked={checked === 'none'} disabled={off || (!!owner && !mine)} onChange={() => choose('none')} />Nobody (observe only)</label>
        {options.map((o) => <label key={o.key}><input type="radio" name={name} value={o.key} checked={checked === o.key} disabled={off} onChange={() => choose(o.key)} />{o.label}
          {pending?.key === o.key && <span className="muted"> · pending…</span>}</label>)}
      </span>
      <select className="kb-select" aria-label="Keyboard input" value={checked ?? ''} disabled={off} onChange={(e) => choose(e.target.value)}>
        {checked === null && <option value="" disabled>{status?.[1] ?? 'Held elsewhere'}</option>}
        <option value="none" disabled={!!owner && !mine}>Nobody (observe only)</option>
        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {status && <span className="kb-owner"><StatusIcon icon={status[0]} label={status[1]} help={status[2]} /><span>{status[1]}</span></span>}
      {shown && !shown.inView && onShow && <button type="button" className="quiet" onClick={() => onShow(shown.key)}>Show {shown.label}</button>}
      {mine && <button type="button" className="quiet" disabled={off} onClick={() => { intent.current++; setMessage(''); setAsking({ kind: 'settled' }); }}>Release and record settled…</button>}
      {pending && !pending.sent && <button type="button" className="quiet" onClick={() => { intent.current++; settle(pending.id); setMessage('Keyboard request cancelled. Nothing was requested.'); }}>Cancel keyboard request</button>}
    </div>
    {asking?.kind === 'acquire' && <div className="notice" role="region" aria-label="Confirm keyboard">
      <p>{!asking.owner ? `Take the one keyboard for this tmux server and type in ${labelOf(asking.key)}.`
        : asking.owner.kind === 'this-browser' ? `Move the keyboard from ${asking.owner.label} to ${labelOf(asking.key)}. Nothing typed in ${asking.owner.label} moves with it, and its manual input still needs reconciliation.`
        : asking.owner.kind === 'unresolved' ? `Recover the keyboard for ${labelOf(asking.key)}. Earlier manual input is unresolved and still needs reconciliation.`
        : `Transfer the keyboard from ${asking.owner.label} to ${labelOf(asking.key)}. Typing there stops, and its manual input still needs reconciliation.`}
        {' '}Dispatch, setup and launch are held until manual input is reconciled. Terminal input can run commands and tmux shortcuts on this host.</p>
      {affected.length > 0 && <ul aria-label="Affected runs">{affected.map((run) => <li key={run}>{run}</li>)}</ul>}
      <button type="button" disabled={disabled} onClick={() => void acquire(asking)}>Confirm keyboard</button><button type="button" onClick={() => setAsking(null)}>Cancel</button></div>}
    {asking?.kind === 'settled' && <div className="notice" role="region" aria-label="Confirm settled release">
      <p>Confirm every pane is settled, with empty prompts and no background writers. Each held run still needs checkpoint review.</p>
      <button type="button" disabled={disabled} onClick={() => void release(true)}>Confirm settled release</button><button type="button" onClick={() => setAsking(null)}>Cancel</button></div>}
    {message && <p className="fine" role="status">{message}</p>}
  </div>;
}
