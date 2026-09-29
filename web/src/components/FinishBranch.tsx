'use client';
import { useEffect, useId, useState } from 'react';
import { FINISH_HOLDING } from '../contracts/projects';
import type { FinishOutcome, FinishPreview, Project, ProjectWorktree, TaskFinish, WorktreeDiscardPreview, WorktreeRemovalPreview } from '../contracts/projects';
import type { WorkspaceDiscovery } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { focusNotice } from '../client/notices';
import { useTildify } from '../client/home';
import { StatusIcon } from './Hint';

const short = (sha: string | null) => sha ? sha.slice(0, 12) : 'unknown';
const refName = (ref: string | null) => ref ? ref.replace('refs/heads/', '') : 'main';
const ACTIVITY = { working: ['⚙️', 'Working'], unknown: ['❔', 'Activity unknown'], ready: ['✅', 'Ready'], idle: ['💤', 'Idle'], interrupted: ['⏸️', 'Interrupted'] } as const;
const OUTCOMES: { value: FinishOutcome; label: string }[] = [
  { value: 'close', label: 'Close the app sessions only; keep the worktree and branch' },
  { value: 'remove', label: 'Close the sessions, then remove the worktree (the branch is kept)' },
  { value: 'discard', label: 'Close the sessions, then discard: delete the worktree and its branch' },
];

/** Finish branch: close the tmux sessions AltCLI launched for this task worktree without typing in a terminal, then optionally remove
 * or discard it through the existing confirmed operations. Each step shows fresh evidence and needs its own confirmation; nothing
 * is merged, retried or run automatically. */
export function FinishBranch({ project, tree, token, disabled, disabledReason, noticeId, onChanged, viewEpoch }: {
  project: Project; tree: ProjectWorktree; token: string; disabled: boolean; disabledReason?: string; onChanged: (notice: string) => Promise<void>; viewEpoch?: number;
  /** ID of the shared notice explaining why Finish branch cannot proceed; WorktreeActions shows it once. */
  noticeId?: string;
}) {
  const [preview, setPreview] = useState<FinishPreview | null>(null), [outcome, setOutcome] = useState<FinishOutcome>('close'), [stopActive, setStopActive] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [lost, setLost] = useState<string | null>(null), [note, setNote] = useState(''), [inspected, setInspected] = useState(false);
  const [gitPreview, setGitPreview] = useState<WorktreeRemovalPreview | WorktreeDiscardPreview | null>(null), [typed, setTyped] = useState('');
  const controlId = useId(); const name = tree.branch ?? tree.path; const tilde = useTildify();
  // Confirmations attest to what was on screen; a view change revokes them (previews stay for re-checking).
  useEffect(() => { setStopActive(false); setTyped(''); setInspected(false); }, [viewEpoch]);
  const op = (project.finishes ?? []).filter((f) => f.preview.worktreeId === tree.id).at(-1);
  const holding = op && FINISH_HOLDING.includes(op.status) ? op : undefined;
  async function act<T>(work: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(true); setError('');
    try { return await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : fallback); return undefined; } finally { setBusy(false); }
  }
  const check = () => {
    const blocker = busy ? 'Checking or applying this operation. Wait for it to finish.'
      : lost ? 'The Finish branch response was lost. Inspect its record before doing anything else; do not resend.'
      : holding ? `Finish branch is ${holding.status.replace('_', ' ')}. ${holding.message} Inspect or complete it below.`
      : disabled ? disabledReason || 'These actions are unavailable. Recheck the worktree.' : '';
    if (blocker) { setError(focusNotice(blocker, noticeId) ? '' : blocker); return; }
    return act(async () => { setPreview(null); setGitPreview(null); setStopActive(false); setOutcome('close');
      setPreview(await api<FinishPreview>(token, 'projects/worktrees/finish/preview', { body: { projectId: project.id, worktreeId: tree.id } })); }, 'Finish branch check failed.');
  };
  async function confirm() {
    if (!preview) return;
    setBusy(true); setError('');
    try {
      const result = await api<TaskFinish>(token, 'projects/worktrees/finish', { body: { requestId: preview.requestId, digest: preview.digest, outcome, stopActive, confirm: true } });
      setPreview(null); await onChanged(result.message);
    } catch (caught) {
      // A lost response may have closed sessions: never resend it; inspect the recorded operation instead.
      if (!(caught instanceof HttpError) || caught.status >= 500) { setLost(preview.requestId); setError('The Finish branch response was lost. Inspect its record before doing anything else; do not resend.'); }
      else setError(caught instanceof Error ? caught.message : 'Finish branch failed.');
    } finally { setBusy(false); }
  }
  const reconcile = (action: 'inspect' | 'decide' | 'abandon') => holding && act(async () => {
    const result = await api<TaskFinish>(token, 'projects/worktrees/finish/reconcile', { body: { requestId: holding.requestId, revision: holding.revision, action, ...(action === 'decide' ? { note } : {}) } });
    setNote(''); setInspected(false); setGitPreview(null); await onChanged(result.message);
  }, 'Inspection failed. Nothing was retried.');
  const kind = holding?.input.outcome === 'discard' ? 'discard' : 'removal';
  const previewGit = () => holding && act(async () => { setTyped('');
    setGitPreview(await api<WorktreeRemovalPreview | WorktreeDiscardPreview>(token, `projects/worktrees/${kind}/preview`, { body: { projectId: project.id, worktreeId: tree.id } })); }, 'Check failed.');
  const continueGit = () => holding && gitPreview && act(async () => {
    const child = kind === 'discard' ? { discard: { ...gitPreview, confirmBranch: typed, confirm: true } } : { removal: { ...gitPreview, confirm: true } };
    const result = await api<TaskFinish>(token, 'projects/worktrees/finish/continue', { body: { requestId: holding.requestId, revision: holding.revision, ...child } });
    setGitPreview(null); await onChanged(result.message);
  }, 'The Git step failed.');
  /** Reads the server's record of a request whose response was lost; it never resends it. */
  const inspectLost = () => act(async () => {
    const discovery = await api<WorkspaceDiscovery>(token, 'workspaces');
    const found = discovery.projects?.some((p) => p.finishes?.some((f) => f.requestId === lost));
    setLost(null); setPreview(null);
    await onChanged(found ? 'The Finish branch request was recorded; its result is shown on the worktree.' : 'No record of that Finish branch request was found, so nothing was closed. Preview again if you still want to finish.');
  }, 'Inspection failed. Nothing was resent.');
  const closable = preview?.sessions.filter((s) => s.closable) ?? [];
  const removeReason = preview && !(preview.git.integration === 'integrated' && preview.git.dirty === false) ? 'Needs proven integration and a clean worktree.' : '';
  const reason = !preview ? '' : preview.blockers[0] || (outcome === 'remove' ? removeReason : '')
    || (preview.active && !stopActive ? 'Some sessions may have unfinished work or background processes: confirm stopping them anyway.' : '')
    || (outcome === 'close' && !closable.length ? 'There are no app-launched sessions to close.' : '');
  return <div className="create-worktree finish-branch">
    <button type="button" className="quiet" aria-label={`Finish ${name}`} aria-describedby={disabled ? noticeId : undefined} onClick={() => void check()}>Finish branch</button>
    {preview && <div className="notice" role="region" aria-label={`Finish ${name}`}>
      <p><strong>Finish {preview.branch}</strong>: close the tmux sessions AltCLI launched for <span className="mono">{tilde(preview.worktree.root)}</span>. Sessions you opened yourself are never closed.</p>
      {preview.sessions.length ? <ul className="finish-sessions" aria-label="App-launched sessions">{preview.sessions.map((s) => <li key={s.sessionId}>
        <strong>{s.sessionName}</strong> <span className="muted">{s.sessionId}{s.clients ? ` · ${s.clients} attached` : ''}</span>{!s.closable && <span className="warning-text"> · not closed: {s.reason}</span>}
        <ul>{s.panes.map((p) => { const tasks = p.processes.filter((q) => q.pid !== p.root?.pid && !q.infrastructure);
          return <li key={p.paneId}>{p.activity && <StatusIcon icon={ACTIVITY[p.activity][0]} label={ACTIVITY[p.activity][1]} help={`${p.agent ?? 'This pane'}: ${ACTIVITY[p.activity][1].toLowerCase()}.`} />} {p.agent ?? p.command} <span className="mono muted">{p.paneId}{p.dead ? ' · exited' : ''}</span>
            {tasks.length > 0 && <span className="warning-text"> · running {tasks.slice(0, 4).map((q) => `${q.command} ${q.pid}`).join(', ')}{tasks.length > 4 ? ` and ${tasks.length - 4} more` : ''}</span>}</li>; })}</ul></li>)}</ul>
        : <p>No app-launched sessions are open in this worktree.</p>}
      {preview.others.length > 0 && <p className="fine">Also in this worktree, not closed by AltCLI: {preview.others.map((o) => `${o.command} (${o.location})`).join(', ')}. Removal and discard need them closed or moved; do that yourself.</p>}
      <p>Branch <span className="mono">{preview.git.branch}</span> at <span className="mono">{short(preview.git.head)}</span>{preview.git.targetRef && <> · {preview.git.ahead ?? '?'} ahead, {preview.git.behind ?? '?'} behind <span className="mono">{refName(preview.git.targetRef)}</span> at <span className="mono">{short(preview.git.targetHead)}</span></>}
        {' · '}{preview.git.dirty === null ? 'uncommitted changes unknown' : preview.git.dirty ? `${preview.git.changeCount} uncommitted change${preview.git.changeCount === 1 ? '' : 's'}` : 'clean'}.</p>
      <p>{preview.git.integration === 'integrated' ? <>Integration proven: {preview.git.integratedBy === 'squash' ? 'squash commit' : 'merged ancestry at'} <span className="mono">{short(preview.git.integratedCommit)}</span>.</>
        : <span className="warning-text">Integration {preview.git.integration === 'not_proven' ? 'not proven' : 'could not be inspected'}.</span>} {preview.git.note}</p>
      {preview.run && <p className="fine">A {preview.run.status} run owns this worktree. It keeps ownership: after the sessions close, take it over in Console once you have checked its writers stopped; removal and discard wait for that.</p>}
      {preview.blockers.map((b) => <p key={b} className="warning-text" role="alert">{b}</p>)}
      <fieldset className="finish-outcome"><legend>Then</legend>{OUTCOMES.map((o) => <label key={o.value} className="readiness"><input type="radio" name={`${controlId}-outcome`} checked={outcome === o.value}
        disabled={busy || (o.value === 'remove' && !!removeReason)} onChange={() => setOutcome(o.value)} />{o.label}{o.value === 'remove' && removeReason && <span className="muted"> ({removeReason})</span>}</label>)}</fieldset>
      {outcome === 'discard' && <p className="warning-text">Discard deletes the directory, including ignored files, and the branch. You confirm the exact branch name after the sessions close.</p>}
      {preview.active && <label className="readiness"><input type="checkbox" checked={stopActive} disabled={busy} onChange={(e) => setStopActive(e.target.checked)} />Stop these sessions anyway. Work in progress and anything not saved in them is lost, and background processes they started may keep running.</label>}
      {reason && <p className="fine" role="status">{reason}</p>}
      <button type="button" disabled={busy || !!reason} onClick={() => void confirm()}>{closable.length ? `Close ${closable.length} session${closable.length === 1 ? '' : 's'}` : 'Continue without closing sessions'}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {holding && <div className="notice" role="region" aria-label={`Finishing ${name}`}>
      <p><strong>Finish branch · {holding.status.replace('_', ' ')}</strong></p><p>{holding.message}</p>
      {holding.sessions.some((s) => s.status !== 'closed' || s.evidence !== 'clear') && <ul aria-label="Session results">{holding.sessions.map((s) => <li key={s.sessionId}>{s.sessionName}: {s.status}
        {s.evidence === 'survivors' && ` · still running: ${s.survivors.map((p) => `${p.command} ${p.pid}`).join(', ')}`}{s.evidence === 'unknown' && ' · process evidence unavailable'}</li>)}</ul>}
      {['uncertain', 'attention', 'git_uncertain'].includes(holding.status) && <button type="button" disabled={busy} onClick={() => void reconcile('inspect')}>Inspect again</button>}
      {['uncertain', 'attention'].includes(holding.status) && <details><summary>Record an inspection decision…</summary>
        <p>Use this after checking the host yourself when inspection cannot settle it (for example a background process you decided to leave running). It records your note; it does not certify that everything stopped.</p>
        <label>Inspection note<input value={note} maxLength={1000} disabled={busy} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="readiness"><input type="checkbox" checked={inspected} disabled={busy} onChange={(e) => setInspected(e.target.checked)} />I inspected the host and accept any remaining effects.</label>
        <button type="button" disabled={busy || !inspected || !note.trim()} onClick={() => void reconcile('decide')}>Record decision and continue</button></details>}
      {holding.status === 'awaiting_git' && !gitPreview && <div className="pane-buttons"><button type="button" disabled={busy} onClick={() => void previewGit()}>Continue: check {kind === 'discard' ? 'discard' : 'removal'}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void reconcile('abandon')}>Stop here (keep the worktree)</button></div>}
      {holding.status === 'awaiting_git' && gitPreview && (kind === 'discard' ? <div className="notice error" role="region" aria-label={`Confirm discard of ${name}`}>
        <p>Delete <span className="mono">{tilde(gitPreview.worktree.root)}</span>, including ignored files, and the branch <span className="mono">{gitPreview.branch}</span> at <span className="mono">{short(gitPreview.head)}</span>. Lost: {(gitPreview as WorktreeDiscardPreview).unmergedCommits} commit{(gitPreview as WorktreeDiscardPreview).unmergedCommits === 1 ? '' : 's'} not in <span className="mono">{refName(gitPreview.targetRef)}</span>{(gitPreview as WorktreeDiscardPreview).dirty ? ` and ${(gitPreview as WorktreeDiscardPreview).changeCount} uncommitted changes` : ''}. The journal is archived first. This cannot be undone in the app.</p>
        <label>Type the branch name to confirm<input aria-label="Branch name to discard" value={typed} disabled={busy} placeholder={gitPreview.branch} onChange={(e) => setTyped(e.target.value)} /></label>
        <button type="button" disabled={busy || typed !== gitPreview.branch} onClick={() => void continueGit()}>Confirm discard</button><button type="button" className="quiet" disabled={busy} onClick={() => setGitPreview(null)}>Cancel</button></div>
        : <div className="notice" role="region" aria-label={`Confirm removal of ${name}`}>
        <p>{(gitPreview as WorktreeRemovalPreview).integratedBy === 'squash' ? 'Squash integration verified' : 'Merged ancestry verified'} in <span className="mono">{refName(gitPreview.targetRef)}</span>. Remove <span className="mono">{tilde(gitPreview.worktree.root)}</span>, including ignored files; the branch, commits and run history are kept.</p>
        <button type="button" disabled={busy} onClick={() => void continueGit()}>Confirm removal</button><button type="button" className="quiet" disabled={busy} onClick={() => setGitPreview(null)}>Cancel</button></div>)}
    </div>}
    {lost && <button type="button" disabled={busy} onClick={() => void inspectLost()}>Inspect the Finish branch record</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}
