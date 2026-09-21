'use client';
import { useId, useState } from 'react';
import type { Project, ProjectWorktree, WorktreeDiscard, WorktreeDiscardPreview, WorktreeIntegration, WorktreeIntegrationPreview, WorktreeRemoval, WorktreeRemovalPreview } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { MAX_MESSAGE_JSON_BYTES, messageJsonBytes } from '../core/squash-message';

interface ActionProps { project: Project; tree: ProjectWorktree; token: string; disabled: boolean; disabledReason?: string; onChanged: (notice: string) => Promise<void> }
/** Deletion actions disable only for hard blocks (read-only host, a request in flight, unreadable state); a known soft blocker is shown as a hint
 * and the click still runs the server preview, whose exact refusal (pane inside, dirty files, not integrated) is then displayed. */
interface DeletionProps extends ActionProps { hint?: string }
const nameFor = (tree: ProjectWorktree) => tree.branch ?? tree.path.split('/').filter(Boolean).pop() ?? tree.path;
/** Any applying or uncertain operation on the project holds every lifecycle action until it is inspected. */
const isHeld = (project: Project) => [...project.creations, ...(project.removals ?? []), ...(project.integrations ?? []), ...(project.discards ?? [])].some((op) => ['applying', 'uncertain'].includes(op.status));
const short = (sha: string) => sha.slice(0, 12);
const refName = (ref: string) => ref.replace('refs/heads/', '');

/** The three confirmed end-of-task operations on a linked worktree, each with its own server preview and confirmation. */
export function WorktreeActions(props: ActionProps & { deletionReason?: string; deletionHint?: string }) {
  return <div className="worktree-actions">
    <IntegrateWorktree {...props} />
    <RemoveWorktree {...props} disabled={!!props.deletionReason} disabledReason={props.deletionReason} hint={props.deletionHint} />
    <DiscardWorktree {...props} disabled={!!props.deletionReason} disabledReason={props.deletionReason} hint={props.deletionHint} />
  </div>;
}
const holdReason = (disabled: boolean, disabledReason: string | undefined, held: boolean, unknown: boolean, busy: boolean, what: string) =>
  disabled ? disabledReason || `${what} is unavailable. Recheck the worktree.`
    : held ? 'A worktree operation is applying or uncertain. Inspect its result below first.'
    : unknown ? `The last ${what.toLowerCase()} response is unknown. Inspect its result before continuing.`
    : busy ? 'Checking or applying this operation. Wait for it to finish.' : '';

/** One squash commit on the integration branch, made in the checkout that has it checked out. The task worktree is untouched. */
export function IntegrateWorktree({ project, tree, token, disabled, disabledReason, onChanged }: ActionProps) {
  const [preview, setPreview] = useState<WorktreeIntegrationPreview | null>(null); const [message, setMessage] = useState('');
  const [choosing, setChoosing] = useState(false); const [through, setThrough] = useState('');
  const [commits, setCommits] = useState<WorktreeIntegrationPreview['commits']>([]); const controlId = useId();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const held = isHeld(project); const name = nameFor(tree);
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  // The same budget the server enforces: the JSON-encoded message, so escapes count and the confirmation always fits.
  const messageBytes = messageJsonBytes(message); const messageValid = !!message.trim() && messageBytes <= MAX_MESSAGE_JSON_BYTES;
  const blockedReason = disabled ? disabledReason || 'Squash is unavailable. Recheck the worktree.'
    : held ? 'A worktree operation is applying or uncertain. Inspect its result below before squashing.'
    : unknown ? 'The last squash response is unknown. Inspect its result before continuing.'
    : busy ? 'Checking or applying this squash. Wait for it to finish.' : '';
  const reason = blockedReason || (preview && !current ? 'The worktree changed. Preview this batch again.'
    : preview && !messageValid ? 'Enter a nonempty commit message within the size limit.' : '');
  const cancel = () => { setPreview(null); setChoosing(false); setThrough(''); setCommits([]); setError(''); };
  async function inspect() {
    setChoosing(true); setBusy(true); setError(''); setPreview(null);
    try { const shown = await api<WorktreeIntegrationPreview>(token, 'projects/worktrees/integration/preview', { body: { projectId: project.id, worktreeId: tree.id, ...(through.trim() ? { through: through.trim() } : {}) } }); setPreview(shown); setMessage(shown.message); setCommits(shown.commits); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Squash check failed.'); }
    finally { setBusy(false); }
  }
  async function integrate() {
    if (!preview || !current || busy || held || unknown || disabled || !messageValid) return;
    setBusy(true); setError('');
    try {
      // Compact consent: the digest stands for the previewed operation, so the request stays small however many commits were listed.
      const result = await api<WorktreeIntegration>(token, 'projects/worktrees/integration', { body: { projectId: project.id, worktreeId: tree.id, through: preview.through, requestId: preview.requestId, consent: preview.consent, message, confirm: true } });
      await onChanged(result.message); cancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Squash response is unknown. Inspect the integration checkout; do not resend.');
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUnknown(true); setError('Squash response is unknown. Inspect its result before doing anything else; do not resend.'); }
    } finally { setBusy(false); }
  }
  async function inspectUnknown() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeIntegration>(token, 'projects/worktrees/integration/reconcile', { body: { requestId: preview.requestId } });
      await onChanged(result.message);
      if (result.status === 'integrated' || result.status === 'failed') { setUnknown(false); cancel(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. Nothing was retried.'); }
    finally { setBusy(false); }
  }
  return <div className="create-worktree">
    {!choosing && <button type="button" className="quiet" aria-label={`Squash ${name} into main`} aria-describedby={reason ? `${controlId}-reason` : undefined} disabled={!!blockedReason} onClick={() => void inspect()}>Squash into main</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {choosing && <div className="notice">
      <label>Squash through commit<input aria-label="Squash through commit" placeholder="Leave empty for HEAD, or paste a SHA" list={`${controlId}-commits`} value={through} disabled={busy || unknown}
        onChange={(event) => { setThrough(event.target.value); setPreview(null); setError(''); }} /></label>
      <datalist id={`${controlId}-commits`}>{commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.subject}</option>)}</datalist>
      <p className="fine">Leave empty for all remaining commits. A SHA includes that commit and stops this batch there. Each batch creates one commit on main; later batches resume after the last integrated commit.</p>
      <button type="button" disabled={!!blockedReason} onClick={() => void inspect()}>Preview batch</button>
      {!preview && <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>}
    </div>}
    {preview && <div className="notice" role="region" aria-label={`Squash ${name}`}>
      <p>Squash {preview.commitCount} commit{preview.commitCount === 1 ? '' : 's'} from <span className="mono">{preview.branch}</span> (<span className="mono">{preview.mergeBase.slice(0, 7)}..{preview.through.slice(0, 7)}</span>) into <span className="mono">{refName(preview.targetRef)}</span> at <span className="mono">{short(preview.targetHead)}</span>, in <span className="mono">{preview.target.root}</span>. Merged without conflicts; the new commit's tree will be <span className="mono">{short(preview.tree)}</span>.</p>
      <p>{preview.previousCommit ? `Continues after squash ${short(preview.previousCommit)}. ` : ''}{preview.through !== preview.head ? 'Later task commits will remain for another batch.' : 'This batch reaches the current task HEAD.'}</p>
      <p className="mono commands">{preview.commands.join('\n')}</p>
      {preview.dirty && <p>The task worktree has uncommitted changes; they are not part of this squash.</p>}
      <p>Agents in <span className="mono">{preview.target.root}</span> must be idle: the merge changes its files and index. The task branch and worktree stay as they are; use Check removal afterwards. This cannot be undone in the app.</p>
      <label>Commit message<textarea aria-label="Squash commit message" value={message} disabled={busy || unknown} rows={6} onChange={(e) => setMessage(e.target.value)} /></label>
      <p className="fine" aria-live="polite">{messageBytes.toLocaleString()} of {MAX_MESSAGE_JSON_BYTES.toLocaleString()} bytes (JSON-encoded, as sent){messageBytes > MAX_MESSAGE_JSON_BYTES ? ' — shorten the message to confirm.' : ''}</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" aria-describedby={reason ? `${controlId}-reason` : undefined} disabled={!!reason} onClick={() => void integrate()}>Confirm squash</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this squash result</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Deletion always requires a fresh server preview and explicit confirmation. */
export function RemoveWorktree({ project, tree, token, disabled, disabledReason, hint, onChanged }: DeletionProps) {
  const [preview, setPreview] = useState<WorktreeRemovalPreview | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false); const controlId = useId();
  const held = isHeld(project); const name = nameFor(tree);
  const blockedReason = holdReason(disabled, disabledReason, held, unknown, busy, 'Removal');
  const reason = blockedReason || (!preview && hint) || '';
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
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
    {!preview && <button type="button" className="quiet" aria-label={`Check removal of ${name}`} aria-describedby={reason ? `${controlId}-reason` : undefined} disabled={!!blockedReason} onClick={() => void inspect()}>Check removal</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {preview && <div className="notice" role="region" aria-label={`Remove ${name}`}>
      <p>{preview.integratedBy === 'squash' ? 'Squash integration verified' : 'Merged ancestry verified'} in <span className="mono">{refName(preview.targetRef)}</span> at <span className="mono">{short(preview.integratedCommit)}</span>.</p>
      <p>Remove directory <span className="mono">{preview.worktree.root}</span> at <span className="mono">{short(preview.head)}</span>? The branch, commits and run history will be kept. This cannot be undone in the app.</p>
      <p>Any ignored files in this directory, including local environment files, dependencies and build output, will also be deleted. Save anything you want to keep before confirming.</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" disabled={disabled || busy || held || unknown || !current} onClick={() => void remove()}>Confirm removal</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this removal response</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Forced deletion of the worktree and its branch without integration evidence: the branch name must be typed to confirm. */
export function DiscardWorktree({ project, tree, token, disabled, disabledReason, hint, onChanged }: DeletionProps) {
  const [preview, setPreview] = useState<WorktreeDiscardPreview | null>(null); const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const controlId = useId();
  const held = isHeld(project); const name = nameFor(tree);
  const blockedReason = holdReason(disabled, disabledReason, held, unknown, busy, 'Discard');
  const reason = blockedReason || (!preview && hint) || '';
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  async function inspect() {
    setBusy(true); setError(''); setPreview(null); setTyped('');
    try { setPreview(await api<WorktreeDiscardPreview>(token, 'projects/worktrees/discard/preview', { body: { projectId: project.id, worktreeId: tree.id } })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Discard check failed.'); }
    finally { setBusy(false); }
  }
  async function discard() {
    if (!preview || !current || busy || held || unknown || disabled || typed !== preview.branch) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeDiscard>(token, 'projects/worktrees/discard', { body: { ...preview, confirmBranch: typed, confirm: true } });
      await onChanged(result.message); setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Discard response is unknown. Recheck Projects; do not resend.');
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUnknown(true); setError('Discard response is unknown. Inspect its result before doing anything else; do not resend.'); }
    } finally { setBusy(false); }
  }
  async function inspectUnknown() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeDiscard>(token, 'projects/worktrees/discard/reconcile', { body: { requestId: preview.requestId } });
      await onChanged(result.message);
      if (result.status === 'discarded' || result.status === 'failed') { setUnknown(false); setPreview(null); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. Nothing was retried.'); }
    finally { setBusy(false); }
  }
  return <div className="create-worktree">
    {!preview && <button type="button" className="quiet danger" aria-label={`Discard ${name}`} aria-describedby={reason ? `${controlId}-reason` : undefined} disabled={!!blockedReason} onClick={() => void inspect()}>Discard…</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {preview && <div className="notice error" role="region" aria-label={`Discard ${name}`}>
      <p><strong>Discard {preview.branch}?</strong> This deletes the directory <span className="mono">{preview.worktree.root}</span>, including ignored files, and deletes the branch <span className="mono">{preview.branch}</span> at <span className="mono">{short(preview.head)}</span>. It does not check that anything was integrated.</p>
      <p>Lost: {preview.unmergedCommits} commit{preview.unmergedCommits === 1 ? '' : 's'} not in <span className="mono">{refName(preview.targetRef)}</span>{preview.dirty ? ` and ${preview.changeCount} uncommitted change${preview.changeCount === 1 ? '' : 's'}` : ''}. The handoff journal is archived first and run history is kept. This cannot be undone in the app.</p>
      <label>Type the branch name to confirm<input aria-label="Branch name to discard" value={typed} disabled={busy || unknown} placeholder={preview.branch} onChange={(e) => setTyped(e.target.value)} /></label>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" disabled={disabled || busy || held || unknown || !current || typed !== preview.branch} onClick={() => void discard()}>Confirm discard</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this discard response</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Applying or uncertain lifecycle operations stay visible with read-only inspection until they reach a recorded result. */
export function LifecycleResults({ project, token, onChanged }: { project: Project; token: string; onChanged: (notice: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function inspect(path: string, requestId: string) {
    setBusy(true); setError('');
    try { const result = await api<{ message: string }>(token, path, { body: { requestId } }); await onChanged(result.message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed.'); }
    finally { setBusy(false); }
  }
  const pending = <T extends { status: string }>(ops: T[] | undefined) => (ops ?? []).filter((op) => ['applying', 'uncertain'].includes(op.status));
  return <>
    {pending(project.removals).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree removal {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void inspect('projects/worktrees/removal/reconcile', op.input.requestId)}>Inspect removal result</button>
    </div>)}
    {pending(project.integrations).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Squash integration {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.branch} → {op.input.target.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void inspect('projects/worktrees/integration/reconcile', op.input.requestId)}>Inspect squash result</button>
    </div>)}
    {pending(project.discards).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree discard {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void inspect('projects/worktrees/discard/reconcile', op.input.requestId)}>Inspect discard result</button>
    </div>)}
    {error && <p className="notice error" role="alert">{error}</p>}
  </>;
}
