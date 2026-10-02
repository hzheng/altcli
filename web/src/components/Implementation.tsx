'use client';
import { useState } from 'react';
import type { CollaborationPolicy } from '../contracts/implementation';
import type { RelayRun } from '../contracts/workflow';
import { api } from '../client/api';

/** The recorded publication and saved successor are separate: receiving a result does not mean the next agent was dispatched. */
export function HandoffProgress({ run }: { run: RelayRun }) {
  const publication = run.implementation?.latestPublication;
  const next = ['paused', 'waiting'].includes(run.status) ? run.implementation?.next : null;
  const label = (id: string) => run.participants.find(p => p.id === id)?.label ?? id;
  const inputHeld = run.interaction?.active && !run.interaction.fault && run.interaction.disposition;
  return <>
    {publication && <details className="notice" aria-label="Published handoff result">
      <summary>Latest validated result from {label(publication.entry.agentId)} · turn {publication.entry.turn} · {publication.sha === publication.entry.parent ? 'report only, no commit' : `commit ${publication.sha.slice(0, 12)}`}</summary>
      <p className="command-text">{publication.entry.summary}</p>
      <p className="fine">Checks reported by the agent: {publication.entry.checks.join('; ') || 'none reported'}</p>
    </details>}
    {next && <div className="notice" role="status" aria-label="Queued handoff">
      <p><strong>Queued: {next.action === 'work' ? 'work' : 'review'} by {label(next.agentId)}.</strong> This turn has not been sent.</p>
      {inputHeld && <>
        <p>{run.interaction?.origin === 'keyboard' ? 'Manual terminal input covering this worktree holds automatic handoffs. Stopping typing does not resume this run.' : 'Terminal input holds this run until you review its validated checkpoint.'}</p>
        <p>Use <strong>Review input and continue</strong> below once the input checkpoint is ready.{run.interaction?.disposition === 'waiting' && ' Then use Next turn to send the saved handoff.'} <strong>Take control</strong> ends this run and cancels its queued handoff.</p>
      </>}
    </div>}
  </>;
}

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
