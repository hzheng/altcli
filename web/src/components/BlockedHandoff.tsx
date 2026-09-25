'use client';
import { useState } from 'react';
import type { BlockedHandoff as Handoff } from '../contracts/workflow';

export function BlockedHandoff({ handoff, disabled, onRecheck }: { handoff: Handoff; disabled: boolean; onRecheck: () => void }) {
  const [ready, setReady] = useState(false);
  const summary = handoff.backgroundSummary;
  return <section className="notice" aria-label="Blocked handoff">
    <h3>Handoff pending</h3>
    <p>{handoff.publishedSha ? <>Published result observed at <code>{handoff.publishedSha.slice(0, 12)}</code>. It has not been accepted for relay.</> : 'No validated publication has been observed.'}</p>
    {handoff.publicationError && <p>Publication check: {handoff.publicationError}</p>}
    <p>Completion gate: {handoff.gate}</p>
    <p>Background state: {handoff.backgroundState}{summary && <> · Tasks: {summary.tasks ?? 'unknown'} · Scheduled wakeups: {summary.crons ?? 'unknown'}{summary.taskTypes.length > 0 && <> · Types: {summary.taskTypes.join(', ')}</>}</>}</p>
    <p className="fine">Recheck validates this turn’s completion, current workers, result and checkout. Missing clear evidence keeps the run paused. The original command is never resent.</p>
    <label className="readiness"><input type="checkbox" checked={ready} disabled={disabled} onChange={e => setReady(e.target.checked)} />I inspected every checkout writer; prompts are empty, with no queued input or background work.</label>
    <button disabled={disabled || !ready} onClick={() => { setReady(false); onRecheck(); }}>Recheck and relay</button>
  </section>;
}
