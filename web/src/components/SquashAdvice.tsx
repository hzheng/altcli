'use client';
import { useState } from 'react';
import type { WorktreeIntegrationPreview } from '../contracts/projects';
import type { WorkflowState } from '../contracts/workflow';
import type { CommandRecord } from '../contracts/api';
import { api, HttpError } from '../client/api';

/** Suggestions are ordinary read-only agent work. Every integration still needs its own fresh preview and confirmation. */
export function SquashAdvice({ token, preview, disabled }: { token: string; preview: WorktreeIntegrationPreview; disabled: boolean }) {
  const [state, setState] = useState<WorkflowState | null>(null); const [target, setTarget] = useState('');
  const [preference, setPreference] = useState(''); const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [unknown, setUnknown] = useState(false);
  const candidates = state?.sessions.filter((s) => state.groups.some((g) => g.members.includes(s.id) && g.members.length <= 2) &&
    !state.runs.some((r) => r.repository === s.repository && ['running','waiting','paused'].includes(r.status)) &&
    state.instances.some((i) => i.agentId === s.id && i.status === 'current') && state.activities?.some((a) => a.agentId === s.id && ['ready','idle'].includes(a.state))) ?? [];
  async function choose() {
    setBusy(true); setMessage(''); setReady(false);
    try { setState(await api<WorkflowState>(token, 'state')); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to inspect agents.'); }
    finally { setBusy(false); }
  }
  async function ask() {
    const session = candidates.find((s) => s.id === target); const group = state?.groups.find((g) => g.members.includes(target));
    if (!session || !group || !ready || disabled || busy || unknown) return;
    setBusy(true); setReady(false);
    const text = `Read-only advice: suggest ordered squash batches with inclusive endpoint SHAs, commit messages, rationale and dependency/conflict concerns. Do not modify files, commit, merge, switch branches, or invoke app mutations. Source checkout: ${JSON.stringify(preview.worktree.root)}. Source HEAD: ${preview.head}. Integration checkout: ${JSON.stringify(preview.target.root)}. Target HEAD: ${preview.targetHead}. Batch baseline: ${preview.mergeBase}. Previous verified squash: ${preview.previousCommit ?? 'none'}. Proposed final endpoint: ${preview.through}. Grouping preference: ${JSON.stringify(preference)}. Inspect these exact revisions. The human will separately preview and confirm each batch in AltCLI.`;
    try {
      const result = await api<CommandRecord>(token, 'instructions', { body: { requestId: crypto.randomUUID(), groupId: group.id, groupRevision: group.revision,
        registrations: Object.fromEntries(group.members.map((id) => [id, state!.sessions.find((s) => s.id === id)!.registrationId])), agentId: session.id,
        policy: group.members.length === 1 ? 'solo' : 'peer', confirmReady: true, text } });
      setMessage(`${result.status}: ${result.error ?? `Read the suggestions in ${session.label}’s Console. Copy an endpoint and message, then preview each batch again.`}`);
      setState(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Advice response unknown.');
      if (!(error instanceof HttpError) || error.status >= 500) setUnknown(true);
    } finally { setBusy(false); }
  }
  return <details className="pane-disclosure"><summary>Ask an agent to suggest batches</summary>
    <p className="fine">Read-only suggestions; each batch still needs your preview and confirmation. The selected checkout must be settled and unowned.</p>
    <button disabled={disabled || busy || unknown} onClick={() => void choose()}>Choose a settled agent</button>
    {state && <><label>Agent<select value={target} onChange={(e) => { setTarget(e.target.value); setReady(false); }}><option value="">Choose…</option>{candidates.map((s) => <option key={s.id} value={s.id}>{s.label} · {s.repository}</option>)}</select></label>
      {!candidates.length && <p>No eligible settled agents. Finish owned work and recheck.</p>}
      <label>Grouping preference<input value={preference} maxLength={300} onChange={(e) => { setPreference(e.target.value); setReady(false); }} /></label>
      <label><input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> I checked every writer in the selected agent’s checkout; prompts are empty and no background work remains.</label>
      <button disabled={disabled || busy || unknown || !ready || !target} onClick={() => void ask()}>Ask for read-only batch suggestions</button></>}
    {message && <p role="status">{message}</p>}
  </details>;
}
