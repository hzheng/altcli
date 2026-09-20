'use client';
import { useEffect, useState } from 'react';
import type { Project, WorktreeCreation, WorktreePreview } from '../contracts/projects';
import { api, HttpError } from '../client/api';

/** Explicit setup only; no effects create worktrees, bind agents, or start runs. */
export function CreateWorktree({ project, token, disabled, onChanged }: {
  project: Project; token: string; disabled: boolean; onChanged: (notice: string) => Promise<void>;
}) {
  const sources = project.worktrees.filter((w) => w.identity && w.head && !w.error);
  const [open, setOpen] = useState(false); const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [branch, setBranch] = useState(''); const [preview, setPreview] = useState<WorktreePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState<string | null>(null);
  const source = project.worktrees.find((w) => w.id === sourceId);
  const sourceKey = JSON.stringify([source?.identity, source?.head, source?.branch, source?.error]);
  useEffect(() => { setPreview(null); setConfirmed(false); }, [sourceKey]);
  const currentPreview = preview && preview.sourceWorktreeId === sourceId && preview.branch === branch && source?.head === preview.sourceHead && source.branch === preview.sourceBranch;
  const held = project.creations.some((op) => ['applying', 'uncertain'].includes(op.status));
  const blocked = disabled || busy || held || !!uncertain;
  const invalidate = () => { setPreview(null); setConfirmed(false); setError(''); };
  async function inspect() {
    setBusy(true); invalidate();
    try { setPreview(await api<WorktreePreview>(token, 'projects/worktrees/preview', { body: { projectId: project.id, sourceWorktreeId: sourceId, branch } })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not preview creation.'); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!preview || !currentPreview || !confirmed || blocked) return;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const operation = await api<WorktreeCreation>(token, 'projects/worktrees', { body: { ...preview, confirm: true } });
      await onChanged(operation.message);
      if (operation.status === 'ready') { setOpen(false); setBranch(''); setPreview(null); }
      else { setError(operation.message); if (operation.status === 'applying' || operation.status === 'uncertain') setUncertain(preview.requestId); }
    } catch (caught) {
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUncertain(preview.requestId); setError('Creation response is unknown. Recheck its result before doing anything else; do not resend.'); }
      else setError(caught.message);
    } finally { setBusy(false); }
  }
  async function reconcile(requestId: string) {
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeCreation>(token, 'projects/worktrees/reconcile', { body: { requestId } });
      await onChanged(result.message);
      if (result.status === 'ready' || result.status === 'failed') { setUncertain(null); setPreview(null); setConfirmed(false); }
      else setError(result.message);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. No creation was retried.'); }
    finally { setBusy(false); }
  }
  const unresolved = project.creations.filter((op) => ['applying', 'uncertain'].includes(op.status));
  return <div className="create-worktree">
    {!open && <button type="button" className="quiet" disabled={blocked || !sources.length} onClick={() => setOpen(true)}>Create task worktree</button>}
    {open && <form className="worktree-form" aria-label="Create task worktree" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
      <h3>Create task worktree</h3>
      <label>Starting checkout<select aria-label="Starting checkout" value={sourceId} disabled={blocked} onChange={(event) => { setSourceId(event.target.value); invalidate(); }}>
        {sources.map((w) => <option key={w.id} value={w.id}>{w.branch ?? 'detached HEAD'} · {w.path}</option>)}
      </select></label>
      <label>New task branch<input aria-label="New task branch" value={branch} maxLength={150} required disabled={blocked} placeholder="feature/login-fix" onChange={(event) => { setBranch(event.target.value); invalidate(); }} /></label>
      <p className="fine">Creates a clean linked worktree from a committed baseline. Staged, unstaged, untracked and ignored source files are not copied. Agents and environments are not moved or installed.</p>
      <div className="row-tools"><button disabled={blocked || !source || !branch}>Preview worktree</button><button type="button" className="quiet" disabled={busy} onClick={() => { setOpen(false); invalidate(); }}>Cancel</button></div>
      {preview && <div className="notice worktree-preview">
        <p>Branch <span className="mono">{preview.branch}</span><br />Starting commit <span className="mono">{preview.sourceHead}</span><br />Destination <span className="mono">{preview.path}</span></p>
        {!currentPreview && <p>The starting checkout changed. Preview again before confirming.</p>}
        <label className="readiness"><input type="checkbox" aria-label="Confirm worktree creation" checked={confirmed && !!currentPreview} disabled={blocked || !currentPreview} onChange={(event) => setConfirmed(event.target.checked)} />I confirm this new branch, starting commit and destination. No existing checkout will be switched.</label>
        <button type="button" className="primary" disabled={blocked || !currentPreview || !confirmed} onClick={() => void create()}>Create confirmed worktree</button>
      </div>}
    </form>}
    {unresolved.map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree creation {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.path}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void reconcile(op.input.requestId)}>Inspect creation result</button>
    </div>)}
    {uncertain && !unresolved.some((op) => op.input.requestId === uncertain) && <div className="notice">Creation {uncertain} needs inspection.
      <button type="button" disabled={busy} onClick={() => void reconcile(uncertain)}>Inspect creation result</button></div>}
    {error && <p role="alert" className="notice error">{error}</p>}
  </div>;
}
