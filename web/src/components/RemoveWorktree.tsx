'use client';
import { useState } from 'react';
import type { Project, ProjectWorktree, WorktreeRemoval, WorktreeRemovalPreview } from '../contracts/projects';
import { api, HttpError } from '../client/api';

/** Deletion always requires a fresh server preview and explicit confirmation. */
export function RemoveWorktree({ project, tree, token, disabled, onChanged }: {
  project: Project; tree: ProjectWorktree; token: string; disabled: boolean; onChanged: (notice: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<WorktreeRemovalPreview | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const held = [...project.creations, ...(project.removals ?? [])].some((op) => ['applying', 'uncertain'].includes(op.status));
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  const name = tree.branch ?? tree.path.split('/').filter(Boolean).pop() ?? tree.path;
  async function inspect() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api<WorktreeRemovalPreview>(token, 'projects/worktrees/removal/preview', { body: { projectId: project.id, worktreeId: tree.id } })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Removal check failed.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!preview || !current || busy || held || unknown || disabled) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeRemoval>(token, 'projects/worktrees/removal', { body: { ...preview, confirm: true } });
      await onChanged(result.message); setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Removal response is unknown. Recheck Projects; do not resend.');
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUnknown(true); setError('Removal response is unknown. Inspect its result before doing anything else; do not resend.'); }
    } finally { setBusy(false); }
  }
  async function inspectUnknown() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeRemoval>(token, 'projects/worktrees/removal/reconcile', { body: { requestId: preview.requestId } });
      await onChanged(result.message);
      if (result.status === 'removed' || result.status === 'failed') { setUnknown(false); setPreview(null); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. Nothing was retried.'); }
    finally { setBusy(false); }
  }
  return <div className="create-worktree">
    {!preview && <button type="button" className="quiet" disabled={disabled || busy || held || unknown} onClick={() => void inspect()}>Check removal of {name}</button>}
    {preview && <div className="notice" role="region" aria-label={`Remove ${name}`}>
      <p>{preview.integratedBy === 'squash' ? 'Squash integration verified' : 'Merged ancestry verified'} in <span className="mono">{preview.targetRef.replace('refs/heads/', '')}</span> at <span className="mono">{preview.integratedCommit.slice(0, 12)}</span>.</p>
      <p>Remove directory <span className="mono">{preview.worktree.root}</span> at <span className="mono">{preview.head.slice(0, 12)}</span>? The branch, commits and run history will be kept. This cannot be undone in the app.</p>
      <p>Any ignored files in this directory, including local environment files, dependencies and build output, will also be deleted. Save anything you want to keep before confirming.</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" disabled={disabled || busy || held || unknown || !current} onClick={() => void remove()}>Confirm removal</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this removal response</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}
export function RemovalResults({ project, token, onChanged }: { project: Project; token: string; onChanged: (notice: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function inspect(requestId: string) {
    setBusy(true); setError('');
    try { const result = await api<WorktreeRemoval>(token, 'projects/worktrees/removal/reconcile', { body: { requestId } }); await onChanged(result.message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed.'); }
    finally { setBusy(false); }
  }
  return <>{(project.removals ?? []).filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => <div className="notice" key={op.input.requestId}>
    <strong>Worktree removal {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.worktree.root}</p>
    <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void inspect(op.input.requestId)}>Inspect removal result</button>
  </div>)}{error && <p className="notice error" role="alert">{error}</p>}</>;
}
