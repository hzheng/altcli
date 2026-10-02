'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ManualSession, ManualWriter, TerminalTarget } from '../contracts/terminals';
import { api, HttpError } from '../client/api';
import { stopTerminalWriters } from './KeyboardSelector';
import type { NativeTerminalHandle } from './NativeTerminal';

/** Recorded as the human decision on manual input when an action's acknowledgement overrides it. */
export const OVERRIDE_NOTE = 'Acknowledged the listed consequences at an action and chose to proceed.';

/** Everything an acknowledgement next to an action clears before that action runs, with the identities its requests are checked against. */
export interface Holds {
  /** A request with an uncertain result; clearing it only removes the local warning, nothing is resent. */
  request: string | null;
  runs: { id: string; commandId: string; status: string; label: string }[];
  delivery: string | null;
  manual: ManualSession[];
}
/** An action's view of the holds: what proceeding does and risks, the identity an acknowledgement is bound to, and the steps that
 * clear exactly those holds. Null when nothing holds it. */
export interface Override { lines: string[]; key: string; clear: () => Promise<void> }
/** The structural identity of a set of holds: every request, run and command, delivery, and manual record with its writers. A change
 * here revokes an acknowledgement even when the listed consequences read the same. */
export function holdKey(h: Holds): string {
  return JSON.stringify([h.request, h.runs.map((r) => [r.id, r.commandId, r.status]), h.delivery,
    h.manual.map((m) => [m.id, m.bootId, m.revision, m.writers.map((w) => [w.connectionId, w.clientInstanceId, w.generation, w.revision, w.live])])]);
}
/** What a consent key includes for an override: its identity and its wording. */
export const overrideKey = (override: Override | null | undefined) => override ? [override.key, override.lines] : null;

/** One line per hold, in the order clearHolds performs the steps. */
export function holdConsequences(h: Holds, describe: (target: TerminalTarget) => string, clientInstanceId: string): string[] {
  const lines: string[] = [];
  if (h.request) lines.push(`The warning for uncertain request ${h.request.slice(0, 8)} is cleared. It may already have reached a terminal; nothing is resent.`);
  for (const run of h.runs) lines.push(`The controller’s ${run.status} run for ${run.label} ends. Its agents are not interrupted and may still be working.`);
  if (h.delivery) lines.push('The older uncertain delivery hold is released. Partly typed input may remain in a terminal; nothing is replayed.');
  const writers = h.manual.flatMap(m => m.writers.filter(w => w.live));
  if (writers.length) lines.push(`Typing stops in ${writers.map(w => `${describe(w.target)} (${w.clientInstanceId === clientInstanceId ? 'this browser' : 'another browser or tab'})`).join(', ')}. Keys not yet sent are dropped; those terminals switch to Display.`);
  if (h.manual.length) {
    const bytes = h.manual.reduce((n, m) => n + m.bytes, 0), paused = h.manual.reduce((n, m) => n + m.runs.length, 0);
    lines.push(`Manual terminal input (${bytes} byte${bytes === 1 ? '' : 's'}${h.manual.some(m => m.recoveryRequired) ? ', some of it uncertain' : ''}) is recorded as accepted. It may have run commands or left background work AltCLI cannot see. The listed manual-input holds lift${paused ? `; ${paused} run${paused === 1 ? '' : 's'} it paused stay paused for checkpoint review` : ''}.`);
  }
  return lines;
}

/** Performs the acknowledged steps in order, each its own checked request. The first refusal or unknown response stops the rest and the
 * error says what already happened. Nothing is retried, replayed or marked successful. */
export async function clearHolds(token: string, h: Holds, handle: (writer: ManualWriter) => NativeTerminalHandle | undefined, clearRequest: () => void): Promise<void> {
  const done: string[] = [];
  try {
    if (h.request) { clearRequest(); done.push('cleared the uncertain-request warning'); }
    for (const run of h.runs) {
      await api(token, 'runs', { body: { runId: run.id, action: 'takeover', confirmReady: true, expectedCommandId: run.commandId } });
      done.push(`ended the controller’s run for ${run.label}`);
    }
    if (h.delivery) { await api(token, 'control/release', { body: { expectedCommandId: h.delivery, confirmReady: true } }); done.push('released the older delivery hold'); }
    // Every writer stops before any record is reconciled: overlapping live writers prevent reconciliation.
    const stopped: ManualSession[] = [];
    for (const manual of h.manual) {
      const live = manual.writers.filter(w => w.live);
      stopped.push(live.length ? await stopTerminalWriters(token, manual, live, handle, true) : manual);
      if (live.length) done.push(`stopped ${live.length} typing connection${live.length === 1 ? '' : 's'}`);
    }
    for (const manual of stopped) {
      await api(token, 'terminals/reconcile', { body: { requestId: crypto.randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision, confirmInspected: true, note: OVERRIDE_NOTE } });
      done.push('recorded your decision on manual input');
    }
  } catch (error) {
    const unknown = !(error instanceof HttpError) || error.status >= 500;
    throw Error(`${unknown ? 'The last step’s result is unknown' : 'Stopped'}: ${error instanceof Error ? error.message : 'a step failed.'} ${done.length ? `Already done: ${done.join('; ')}.` : 'Nothing was changed.'} The action was not started and nothing was retried; check the current state before trying again.`);
  }
}

/** The one place an action lists what proceeding does and risks. Its checkbox is the action's readiness and the acknowledgement of
 * every listed consequence together; blockers no acknowledgement can clear are listed with them. */
export function Acknowledgement({ label, checked, disabled, onChange, children, lines, blockers = [] }: {
  label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; children: ReactNode; lines: string[]; blockers?: string[];
}) {
  return <div className="acknowledgement" role="group" aria-label={`${label} acknowledgement`}>
    <label className="readiness"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>
    {!!lines.length && <><p className="fine"><strong>Checking this also accepts:</strong></p><ul className="consequences" aria-label="Consequences of proceeding">{lines.map((line) => <li key={line}>{line}</li>)}</ul></>}
    {!!blockers.length && <><p className="fine"><strong>Still blocked; no acknowledgement can clear this:</strong></p><ul className="consequences" aria-label="Remaining blockers">{blockers.map((line) => <li key={line}>{line}</li>)}</ul></>}
  </div>;
}

/** An acknowledged override as actions consume it: `ok` once nothing holds them or the holds are acknowledged; `prepare` clears them. */
export interface Proceed { ok: boolean; prepare: () => Promise<void> }
export const OVERRIDE_REASON = 'Something holds this action. Check “Proceed anyway” above to accept the listed consequences, or resolve them first.';
/** Clears acknowledged holds before one request. Reports and returns false when they are not acknowledged, a step fails, or
 * `unchanged` says the confirmation on screen was revoked while they were cleared, so that failure is never mistaken for the
 * action's own (possibly unknown) result. */
export async function prepared(proceed: Proceed | undefined, setError: (message: string) => void, unchanged?: () => boolean): Promise<boolean> {
  if (!proceed) return true;
  if (!proceed.ok) { setError(OVERRIDE_REASON); return false; }
  try { await proceed.prepare(); } catch (error) { setError(error instanceof Error ? error.message : 'The holds could not be cleared. Nothing was started.'); return false; }
  if (unchanged && !unchanged()) { setError('The holds were cleared, but the view changed and revoked this confirmation. Nothing was started; confirm again.'); return false; }
  return true;
}
/** The latest value, readable after an await. */
export function useLatest<T>(value: T) { const ref = useRef(value); ref.current = value; return ref; }
/** False once the component has unmounted (Lock, another workspace or tab): a continuation after an await must not act for it.
 * A render-time revision cannot show this, since an unmounted component never renders again. */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

/** For confirmations that have no readiness check of their own (worktree operations, launches): an acknowledgement shown only while
 * something holds the actions. `prepare` clears the holds before a request. */
export function useOverride(override: Override | null | undefined, action: string): Proceed & { node: ReactNode } {
  const [checked, setChecked] = useState(false);
  const key = JSON.stringify(overrideKey(override));
  const [seen, setSeen] = useState(key);
  // A changed set of holds needs a fresh acknowledgement, even when its consequences read the same.
  if (seen !== key) { setSeen(key); setChecked(false); }
  const needed = !!override?.lines.length;
  return {
    ok: !needed || checked,
    node: needed ? <Acknowledgement label={`Proceed with ${action} anyway`} checked={checked} disabled={false} onChange={setChecked} lines={override!.lines}>
      <strong>Proceed anyway.</strong> I accept the consequences listed below and want {action} to go ahead.</Acknowledgement> : null,
    async prepare() { if (needed) { setChecked(false); await override!.clear(); } },
  };
}

/** Taking control next to the input of a controller-owned checkout: one acknowledgement of everything it ends or accepts, then the
 * same steps as Take control in Control access. Afterwards the checkout's own Send actions return. */
export function TakeControlHere({ override, disabled, open, submit, onMessage, onDone }: {
  override: Override; disabled: boolean; open: boolean;
  submit: (work: () => Promise<void>) => Promise<void>; onMessage: (message: string) => void; onDone: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const key = JSON.stringify(overrideKey(override)); const [seen, setSeen] = useState(key);
  if (seen !== key) { setSeen(key); setChecked(false); }
  return <details className="pane-disclosure take-control-here" open={open || undefined}><summary>Take control here</summary>
    <Acknowledgement label="Take control here" checked={checked} disabled={disabled} onChange={setChecked} lines={override.lines}>
      <strong>Take control of this checkout.</strong> I inspected the terminals and accept the consequences below; afterwards I send instructions myself.</Acknowledgement>
    <div className="pane-buttons"><button type="button" disabled={disabled || !checked} onClick={() => void submit(async () => {
      setChecked(false);
      try { await override.clear(); onMessage('You have control. Nothing was interrupted, replayed or marked successful.'); }
      catch (error) { onMessage(error instanceof Error ? error.message : 'Taking control failed.'); }
      finally { await onDone(); }
    })}>Take control</button></div>
  </details>;
}
