'use client';
import { useState } from 'react';
import type { CollaborationPolicy } from '../contracts/implementation';
import type { RelayRun } from '../contracts/workflow';
import { api } from '../client/api';

export function RunPolicy({ token, run, disabled, onChanged, onMessage }: { token: string; run: RelayRun; disabled: boolean; onChanged: () => Promise<void>; onMessage: (text: string) => void }) {
  const impl = run.implementation!;
  const [policy, setPolicy] = useState(impl.policy); const [worker, setWorker] = useState(impl.workerId ?? run.participants[0]!.id);
  const [automatic, setAutomatic] = useState(run.autoContinue); const [pauseOnObjection, setPauseOnObjection] = useState(run.pauseOnObjection === true); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api(token, 'implementation/policy', { body: { runId: run.id, expectedCommandId: run.currentCommandId, expectedRevision: impl.revision,
      policy, ...(policy === 'worker_reviewer' ? { workerId: worker } : {}), autoContinue: automatic, pauseOnObjection } }); onMessage('Policy saved. The next turn still needs your readiness confirmation.'); }
    catch (error) { onMessage(error instanceof Error ? error.message : 'Could not change policy.'); }
    finally { await onChanged(); setBusy(false); }
  }
  return <details><summary>Change collaboration at this boundary</summary>
    <label>Next-turn policy<select aria-label="Next-turn policy" value={policy} disabled={disabled || busy} onChange={(e) => setPolicy(e.target.value as CollaborationPolicy)}><option value="peer">Peer relay</option><option value="worker_reviewer">Worker + reviewer</option></select></label>
    {policy === 'worker_reviewer' && <label>Worker<select aria-label="Next-turn worker" value={worker} disabled={disabled || busy} onChange={(e) => setWorker(e.target.value)}>{run.participants.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
    <label className="readiness"><input type="checkbox" checked={automatic} disabled={disabled || busy} onChange={(e) => setAutomatic(e.target.checked)} />Automatic collaboration after the next turn</label>
    <label className="readiness"><input type="checkbox" checked={pauseOnObjection} disabled={disabled || busy} onChange={(e) => setPauseOnObjection(e.target.checked)} />Pause on a reviewer objection</label>
    <button disabled={disabled || busy} onClick={() => void save()}>Save next-turn policy</button>
  </details>;
}
