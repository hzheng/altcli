'use client';
import { useState } from 'react';
import type { ManualReconcile, ManualSession } from '../contracts/terminals';

export function ManualInputRecovery({ manual, disabled, decide }: {
  manual: ManualSession; disabled: boolean; decide: (input: ManualReconcile) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [inspected, setInspected] = useState(false);
  const identity = () => ({ requestId: crypto.randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision });
  return <section className="notice" aria-label="Manual input reconciliation">
    <p>{manual.reason}</p>
    <p className="fine">{manual.bytes} input bytes recorded · {manual.runs.length} affected runs. Inspect every pane before confirming. Workflow checkpoint review remains separate.</p>
    {!manual.live && <>
      <button type="button" disabled={disabled} onClick={() => void decide({ ...identity(), confirmReady: true })}>I inspected every pane; record settled</button>
      <details><summary>Record a human inspection decision…</summary>
        <p>Use this after inspecting the host when settled checks cannot resolve changed or missing panes, unknown activity, or changed checkpoints. This releases the server-wide barrier. Affected runs keep their holds and still need Review input and continue or takeover.</p>
        <label>Inspection note<input value={note} maxLength={1000} disabled={disabled} onChange={e => setNote(e.target.value)} /></label>
        <label className="readiness"><input type="checkbox" checked={inspected} disabled={disabled} onChange={e => setInspected(e.target.checked)} />I inspected the host and acknowledge possible prior and background effects.</label>
        <button type="button" disabled={disabled || !inspected || !note.trim()} onClick={() => void decide({ ...identity(), confirmInspected: true, note })}>Record inspection and release server barrier</button>
      </details>
    </>}
  </section>;
}
