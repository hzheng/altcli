'use client';
import { useState } from 'react';
import type { RelayRun } from '../contracts/workflow';
import type { WorkspaceGit } from '../contracts/implementation';
import { api } from '../client/api';

export function PlanningProgress({ token, run, disabled, refresh, onMessage, onStop, git }: {
  token: string; run: RelayRun; disabled: boolean; refresh: () => Promise<void>; onMessage: (text: string) => void; onStop: () => void;
  /** The workspace's current Git reading, used only while it still matches the planning baseline. */
  git?: WorkspaceGit;
}) {
  const plan = run.planning!; const current = plan.current;
  const [confirmed, setConfirmed] = useState(''); const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(''); const [planner, setPlanner] = useState(plan.required[0]!);
  const [override, setOverride] = useState(''); const [branchChoice, setBranchChoice] = useState(''); const [branchName, setBranchName] = useState(''); const [baseline, setBaseline] = useState<string | null>(null);
  // The same integration-branch policy as at Start: no continuing on an integration branch, and an existing task branch keeps a confirmed baseline.
  const live = git && git.branch === plan.request.baseline.branch && git.head === plan.request.baseline.head ? git : undefined;
  const integration = live?.integration ?? false;
  const needsBaseline = branchChoice === 'stay' && !!live && !integration && live.taskBase !== live.head;
  const taskBase = baseline ?? live?.taskBase ?? '';
  const agreed = !!current && current.briefRevision === plan.briefRevision && !Object.keys(plan.objections).length && plan.required.every((id) => plan.endorsements[id] === current.revision);
  const settled = run.status === 'waiting' && !run.implementation && !!current;
  const key = JSON.stringify([run.currentCommandId, run.status, current?.hash, current?.revision, plan.briefRevision, plan.policyRevision, changes, planner, override, branchChoice, branchName, taskBase]);
  const ready = confirmed === key;
  const needsBranch = !plan.request.implementation.branch;
  const branchValid = !needsBranch || (branchChoice === 'stay' && !!plan.request.baseline.branch && !integration && (!needsBaseline || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(taskBase.trim()))) || (branchChoice === 'new' && !!branchName.trim());
  const label = (id: string) => plan.participants.find((p) => p.id === id)?.label ?? id;
  async function decide(action: 'approve' | 'changes') {
    if (!settled || disabled || busy || !ready || !current) return;
    setBusy(true); setConfirmed('');
    try {
      await api(token, 'planning/decision', { body: { runId: run.id, expectedCommandId: run.currentCommandId, expectedRevision: current.revision, expectedHash: current.hash,
        expectedBriefRevision: plan.briefRevision, expectedPolicyRevision: plan.policyRevision, action, confirmReady: true,
        ...(action === 'changes' ? { text: changes.trim(), agentId: planner } : { ...(!agreed ? { overrideReason: override.trim() } : {}),
          ...(needsBranch ? { branch: { ...plan.request.baseline, ...(branchChoice === 'new' ? { newBranch: branchName.trim() } : needsBaseline ? { taskBase: taskBase.trim() } : {}) } } : {}) }) } });
      onMessage(action === 'changes' ? 'Requested changes are a new shared brief revision. Earlier endorsements no longer authorize Implementation.' : 'The exact plan was authorized. Inspect the server-owned Implementation status.');
      setChanges('');
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Plan action failed. Inspect the run before retrying.'); }
    finally { await refresh(); setBusy(false); }
  }
  return <section className="planning-progress" aria-label="Plan progress">
    <div className="section-heading"><h3>{run.implementation ? 'Frozen Plan → Implementation' : `Plan · ${plan.step}`}</h3><span className="badge">{plan.required.length === 1 ? 'SOLO PLAN' : `${Object.values(plan.drafts).filter((d) => d.status === 'finalized').length}/${plan.required.length} DRAFTS`}</span></div>
    <p className="fine">Brief v{plan.briefRevision} · roster v{plan.group.revision} · epoch {plan.epoch}. {plan.request.requireApproval ? 'Human approval required.' : 'Approval checkpoint waived by Start authorization.'} {plan.required.length === 1 && 'Solo readiness is not independent consensus.'}</p>
    <ul>{plan.required.map((id) => <li key={id}>{label(id)} · {plan.drafts[id]!.status} · {current && plan.endorsements[id] === current.revision ? `endorses v${current.revision}` : 'no current endorsement'}{plan.drafts[id]!.briefRevision !== plan.briefRevision ? ' · initial draft belongs to an earlier brief' : ''}
      {plan.objections[id] && <p className="notice">{plan.objections[id]}</p>}</li>)}</ul>
    <details><summary>Captured initial drafts</summary><p className="fine">Do not share peer drafts with an unfinished planner. Independence is cooperative, not filesystem isolation.</p>
      {plan.required.map((id) => <article key={id}><h4>{label(id)}</h4><p className="mono fine">{plan.drafts[id]!.path}</p><pre className="plan-document">{plan.drafts[id]!.document?.text ?? 'No finalized draft yet.'}</pre></article>)}</details>
    {current && <><h3>{agreed ? plan.required.length === 1 ? 'Plan ready (solo)' : 'Plan agreed' : 'Plan under review'} · v{current.revision}</h3>
      <p className="mono fine">SHA-256 {current.hash}</p><pre className="plan-document" aria-label="Captured shared plan">{current.text}</pre>
      <details><summary>Version-specific endorsement history</summary><ul>{plan.endorsementHistory.map((entry, i) => <li key={i}>{label(entry.agentId)} · plan v{entry.revision}, brief v{entry.briefRevision}{entry.revision === current.revision && entry.briefRevision === plan.briefRevision ? ' · current' : ' · historical'}</li>)}</ul></details></>}
    <p>Implementation: {plan.implementationParticipants.map((p) => p.label).join(' ⇄ ')} · {plan.request.implementation.policy} · {plan.request.implementation.branch?.newBranch ?? plan.request.implementation.branch?.branch ?? 'branch consent still required'}</p>
    {plan.frozen && <p className="notice">Frozen v{plan.frozen.plan.revision} · authorized by {plan.frozen.authority === 'human' ? 'human approval' : 'the prior automatic policy'} at {new Date(plan.frozen.authorizedAt).toLocaleString()}.{plan.frozen.overrideReason && ` Explicit override: ${plan.frozen.overrideReason}`}</p>}
    {settled && <>
      {needsBranch && <div className="register-grid"><label>Implementation branch consent<select aria-label="Implementation branch consent" value={branchChoice} disabled={disabled || busy} onChange={(e) => setBranchChoice(e.target.value)}>
        <option value="">Choose…</option>{plan.request.baseline.branch && !integration && <option value="stay">Continue on {plan.request.baseline.branch}</option>}<option value="new">Create a new branch after approval</option></select>
        {integration && <small>{plan.request.baseline.branch} is an integration branch: implementation needs a new task branch created from it.</small>}</label>
        {branchChoice === 'new' && <label>New implementation branch<input aria-label="New implementation branch" value={branchName} disabled={disabled || busy} onChange={(e) => setBranchName(e.target.value)} /></label>}
        {needsBaseline && <label>Task baseline commit<input aria-label="Task baseline commit" value={taskBase} disabled={disabled || busy} placeholder="Full commit ID where this task began" onChange={(e) => setBaseline(e.target.value)} /><small>{live?.taskBase ? 'Inferred from the nearest integration branch; confirm or correct it.' : 'Not inferable from the integration branches; enter it.'}</small></label>}</div>}
      {!agreed && <label>Override reason — missing endorsements or objections<input aria-label="Plan override reason" maxLength={1900} value={override} disabled={disabled || busy} onChange={(e) => setOverride(e.target.value)} /><small>This overrides plan judgment, never active writers or safety checks.</small></label>}
      <details><summary>Request changes to the plan</summary>
        <label>Planner for changes<select aria-label="Planner for changes" value={planner} disabled={disabled || busy} onChange={(e) => setPlanner(e.target.value)}>{plan.required.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
        <label>Requested changes<textarea aria-label="Requested plan changes" rows={3} maxLength={1900} value={changes} disabled={disabled || busy} onChange={(e) => setChanges(e.target.value)} /></label>
      </details>
      <label className="readiness"><input type="checkbox" aria-label="Ready for plan decision" checked={ready} disabled={disabled || busy} onChange={(e) => setConfirmed(e.target.checked ? key : '')} />I reviewed this exact captured version and checked every planner and other checkout writer is settled. The branch choice is separately authorized.</label>
      <div className="register-actions"><button className="primary" disabled={disabled || busy || !ready || !branchValid || (!agreed && !override.trim())} onClick={() => void decide('approve')}>{!agreed ? 'Override & implement' : plan.request.requireApproval ? 'Approve & implement' : 'Continue to Implementation'}</button>
        <button disabled={disabled || busy || !ready || !changes.trim()} onClick={() => void decide('changes')}>Request changes</button><button disabled={disabled || busy} onClick={onStop}>Stop planning</button></div>
    </>}
  </section>;
}
