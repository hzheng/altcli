'use client';
import { useEffect, useId, useState } from 'react';
import type { Project, ProjectWorktree, WorktreeDiscard, WorktreeDiscardPreview, WorktreeIntegration, WorktreeIntegrationPreview, WorktreeRemoval, WorktreeRemovalPreview, WorktreeRename, WorktreeRenamePreview, WorktreeUpdate, WorktreeUpdatePreview } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { MAX_MESSAGE_JSON_BYTES, messageJsonBytes } from '../core/squash-message';
import { SquashAdvice } from './SquashAdvice';
import { FinishBranch } from './FinishBranch';
import { FINISH_HOLDING } from '../contracts/projects';

interface ActionProps { project: Project; tree: ProjectWorktree; token: string; disabled: boolean; disabledReason?: string; onChanged: (notice: string) => Promise<void>;
  /** Increases whenever the view changes; hiding a confirmation revokes it. */
  viewEpoch?: number;
  /** ID of the shared blocker or hint that WorktreeActions shows once for this action. */
  noticeId?: string }
const nameFor = (tree: ProjectWorktree) => tree.branch ?? tree.path.split('/').filter(Boolean).pop() ?? tree.path;
/** Any applying or uncertain operation on the project holds every lifecycle action until it is inspected. */
const isHeld = (project: Project) => [...project.creations, ...(project.removals ?? []), ...(project.integrations ?? []), ...(project.discards ?? []), ...(project.updates ?? []), ...(project.renames ?? [])].some((op) => ['applying', 'uncertain'].includes(op.status))
  || (project.finishes ?? []).some((op) => FINISH_HOLDING.includes(op.status));
const short = (sha: string) => sha.slice(0, 12);
const refName = (ref: string) => ref.replace('refs/heads/', '');

/** The confirmed end-of-task operations on a linked worktree, each with its own server preview and confirmation. Finish branch
 * closes the sessions AltCLI launched there, then hands over to removal or discard.
 * Deletion actions disable only for hard blocks (read-only host, a request in flight, unreadable state); a known soft blocker is shown as a hint
 * and the click still runs the server preview, whose exact refusal (pane inside, dirty files, not integrated) is then displayed.
 * Blockers and hints shared by several actions are shown once below them; each action refers to its notice by ID. */
export function WorktreeActions(props: ActionProps & { deletionReason?: string; deletionHint?: string }) {
  const baseId = useId(); const held = isHeld(props.project);
  const heldReason = held ? 'A worktree operation is applying, uncertain or waiting (Finish branch). Inspect or complete it first.' : '';
  const squashBlock = props.disabled ? props.disabledReason || 'These actions are unavailable. Recheck the worktree.' : heldReason;
  const deletionBlock = props.deletionReason || heldReason; const hint = deletionBlock ? '' : props.deletionHint ?? '';
  const notices = [...new Set([squashBlock, deletionBlock, hint].filter(Boolean))];
  const idOf = (text: string) => text ? `${baseId}-${notices.indexOf(text)}` : undefined;
  return <div className="worktree-actions">
    <IntegrateWorktree {...props} noticeId={idOf(squashBlock)} />
    <UpdateWorktree {...props} noticeId={idOf(squashBlock)} />
    <RenameBranch {...props} noticeId={idOf(squashBlock)} />
    <FinishBranch {...props} disabled={!!props.deletionReason} noticeId={idOf(props.deletionReason ?? '')} />
    <RemoveWorktree {...props} disabled={!!props.deletionReason} noticeId={idOf(deletionBlock || hint)} />
    <DiscardWorktree {...props} disabled={!!props.deletionReason} noticeId={idOf(deletionBlock || hint)} />
    {notices.map((text, index) => <div key={text}><p className="fine" id={`${baseId}-${index}`} role="status">{text}</p></div>)}
  </div>;
}
/** Reasons that concern only one action; shared blockers are explained by its notice. */
const localReason = (unknown: boolean, busy: boolean, what: string) =>
  unknown ? `The last ${what.toLowerCase()} response is unknown. Inspect its result before continuing.`
    : busy ? 'Checking or applying this operation. Wait for it to finish.' : '';
const describedBy = (...ids: (string | false | undefined)[]) => ids.filter(Boolean).join(' ') || undefined;

/** One squash commit on the integration branch, made in the checkout that has it checked out. The task worktree is untouched. */
export function IntegrateWorktree({ project, tree, token, disabled, noticeId, onChanged }: ActionProps) {
  const [preview, setPreview] = useState<WorktreeIntegrationPreview | null>(null); const [message, setMessage] = useState('');
  const [choosing, setChoosing] = useState(false); const [through, setThrough] = useState('');
  const [commits, setCommits] = useState<WorktreeIntegrationPreview['commits']>([]); const controlId = useId();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const held = isHeld(project); const name = nameFor(tree);
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  // The same budget the server enforces: the JSON-encoded message, so escapes count and the confirmation always fits.
  const messageBytes = messageJsonBytes(message); const messageValid = !!message.trim() && messageBytes <= MAX_MESSAGE_JSON_BYTES;
  const blocked = disabled || held;
  const blockedReason = unknown ? 'The last squash response is unknown. Inspect its result before continuing.'
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
    {!choosing && <button type="button" className="quiet" aria-label={`Squash ${name} into main`} aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!blockedReason} onClick={() => void inspect()}>Squash into main</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {choosing && <div className="notice">
      <label>Squash through commit<input aria-label="Squash through commit" placeholder="Leave empty for HEAD, or paste a SHA" list={`${controlId}-commits`} value={through} disabled={busy || unknown}
        onChange={(event) => { setThrough(event.target.value); setPreview(null); setError(''); }} /></label>
      <datalist id={`${controlId}-commits`}>{commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.subject}</option>)}</datalist>
      <p className="fine">Leave empty for all remaining commits. A SHA includes that commit and stops this batch there. Each batch creates one commit on main; later batches resume after the last integrated commit.</p>
      <button type="button" disabled={blocked || !!blockedReason} onClick={() => void inspect()}>Preview batch</button>
      {!preview && <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>}
    </div>}
    {preview && <div className="notice" role="region" aria-label={`Squash ${name}`}>
      <p>Squash {preview.commitCount} commit{preview.commitCount === 1 ? '' : 's'} from <span className="mono">{preview.branch}</span> (<span className="mono">{preview.mergeBase.slice(0, 7)}..{preview.through.slice(0, 7)}</span>) into <span className="mono">{refName(preview.targetRef)}</span> at <span className="mono">{short(preview.targetHead)}</span>, in <span className="mono">{preview.target.root}</span>. Merged without conflicts; the new commit's tree will be <span className="mono">{short(preview.tree)}</span>.</p>
      <p>{preview.previousCommit ? `Continues after squash ${short(preview.previousCommit)}. ` : ''}{preview.through !== preview.head ? 'Later task commits will remain for another batch.' : 'This batch reaches the current task HEAD.'}</p>
      <p className="mono commands">{preview.commands.join('\n')}</p>
      {preview.dirty && <p>The task worktree has uncommitted changes; they are not part of this squash.</p>}
      <p>Agents in <span className="mono">{preview.target.root}</span> must be idle: the merge changes its files and index. The task branch and worktree stay as they are; use Check removal afterwards. This cannot be undone in the app.</p>
      <SquashAdvice key={preview.consent} token={token} preview={preview} disabled={blocked || !!reason || busy || unknown} />
      <label>Commit message<textarea aria-label="Squash commit message" value={message} disabled={busy || unknown} rows={6} onChange={(e) => setMessage(e.target.value)} /></label>
      <p className="fine" aria-live="polite">{messageBytes.toLocaleString()} of {MAX_MESSAGE_JSON_BYTES.toLocaleString()} bytes (JSON-encoded, as sent){messageBytes > MAX_MESSAGE_JSON_BYTES ? ' — shorten the message to confirm.' : ''}</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!reason} onClick={() => void integrate()}>Confirm squash</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this squash result</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Update from main: move the task branch onto main in place, so the directory, its ignored environment and the agents are reused.
 * A fully integrated branch moves to main's tip; later commits are replayed on top. The old tip is kept under refs/altcli/preserved. */
export function UpdateWorktree({ project, tree, token, disabled, noticeId, onChanged }: ActionProps) {
  const [preview, setPreview] = useState<WorktreeUpdatePreview | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const controlId = useId(); const held = isHeld(project); const name = nameFor(tree);
  const blocked = disabled || held; const blockedReason = localReason(unknown, busy, 'Update');
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  const reason = blockedReason || (preview && !current ? 'The worktree changed. Preview the update again.' : '');
  async function inspect() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api<WorktreeUpdatePreview>(token, 'projects/worktrees/update/preview', { body: { projectId: project.id, worktreeId: tree.id } })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Update check failed.'); }
    finally { setBusy(false); }
  }
  async function update() {
    if (!preview || !current || busy || held || unknown || disabled) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeUpdate>(token, 'projects/worktrees/update', { body: { projectId: project.id, worktreeId: tree.id, requestId: preview.requestId, consent: preview.consent, confirm: true } });
      await onChanged(result.message); setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Update response is unknown. Inspect its result; do not resend.');
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUnknown(true); setError('Update response is unknown. Inspect its result before doing anything else; do not resend.'); }
    } finally { setBusy(false); }
  }
  async function inspectUnknown() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeUpdate>(token, 'projects/worktrees/update/reconcile', { body: { requestId: preview.requestId } });
      await onChanged(result.message);
      if (result.status === 'updated' || result.status === 'failed') { setUnknown(false); setPreview(null); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. Nothing was retried.'); }
    finally { setBusy(false); }
  }
  const target = preview ? refName(preview.targetRef) : 'main';
  return <div className="create-worktree">
    {!preview && <button type="button" className="quiet" aria-label={`Update ${name} from main`} aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!blockedReason} onClick={() => void inspect()}>Update from main</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {preview && <div className="notice" role="region" aria-label={`Update ${name}`}>
      <p>{preview.replay.length
        ? <>Replay {preview.replay.length} commit{preview.replay.length === 1 ? '' : 's'} of <span className="mono">{preview.branch}</span> onto <span className="mono">{target}</span> at <span className="mono">{short(preview.targetHead)}</span>, without conflicts.</>
        : <>Move <span className="mono">{preview.branch}</span> to <span className="mono">{target}</span> at <span className="mono">{short(preview.targetHead)}</span>.</>}{' '}
        {preview.boundaryBy === 'ancestry' ? `${target} already contains every task commit.`
          : preview.boundaryBy === 'squash' ? `${target} already contains the task commits through ${short(preview.boundary)} as a squash.`
          : `Nothing on this branch is in ${target} yet, so every task commit is replayed.`}</p>
      {!!preview.replay.length && <ol className="fine">{preview.replay.slice(0, 20).map((step) => <li key={step.sha}><span className="mono">{step.sha.slice(0, 7)}</span> {step.subject}</li>)}</ol>}
      {preview.replay.length > 20 && <p className="fine">…and {preview.replay.length - 20} more.</p>}
      <p>{preview.fastForward ? 'History is kept: the branch fast-forwards.' : <>This rewrites the branch; its current tip <span className="mono">{short(preview.head)}</span> is kept under <span className="mono">refs/altcli/preserved</span> and the journal keeps every handoff patch.</>}</p>
      <p>The directory, ignored files such as dependencies and local configuration, and the agents stay. Agents here must be idle: tracked files change under them, and they need fresh instructions for the new baseline. Nothing is pushed.</p>
      <p className="mono commands">{preview.commands.join('\n')}</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!reason} onClick={() => void update()}>Confirm update</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this update result</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Rename the task branch in place: files, the directory, agents and tmux session names are unchanged. */
export function RenameBranch({ project, tree, token, disabled, noticeId, onChanged, viewEpoch }: ActionProps) {
  const [editing, setEditing] = useState(false); const [newBranch, setNewBranch] = useState('');
  const [preview, setPreview] = useState<WorktreeRenamePreview | null>(null);
  // A preview is consent for what was on screen: hiding the view clears it; the typed name stays.
  useEffect(() => { setPreview(null); }, [viewEpoch]);
  // The request sent for confirmation is kept apart from that revocable preview: an unknown result is inspected by its ID.
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const controlId = useId(); const held = isHeld(project); const name = nameFor(tree);
  const blocked = disabled || held; const blockedReason = localReason(unknown, busy, 'Rename');
  const current = preview?.head === tree.head && preview?.branch === tree.branch && preview?.worktree.root === tree.path;
  const reason = blockedReason || (preview && !current ? 'The worktree changed. Preview the rename again.' : '');
  const cancel = () => { setEditing(false); setNewBranch(''); setPreview(null); setError(''); setPending(null); };
  async function inspect() {
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api<WorktreeRenamePreview>(token, 'projects/worktrees/rename/preview', { body: { projectId: project.id, worktreeId: tree.id, newBranch: newBranch.trim() } })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Rename check failed.'); }
    finally { setBusy(false); }
  }
  async function rename() {
    if (!preview || !current || busy || held || unknown || disabled) return;
    setBusy(true); setError(''); setPending(preview.requestId);
    try {
      const result = await api<WorktreeRename>(token, 'projects/worktrees/rename', { body: { ...preview, confirm: true } });
      await onChanged(result.message); cancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rename response is unknown. Inspect its result; do not resend.');
      if (!(caught instanceof HttpError) || caught.status >= 500) { setUnknown(true); setError('Rename response is unknown. Inspect its result before doing anything else; do not resend.'); }
      else setPending(null); // the server answered: nothing is pending
    } finally { setBusy(false); }
  }
  async function inspectUnknown() {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<WorktreeRename>(token, 'projects/worktrees/rename/reconcile', { body: { requestId: pending } });
      await onChanged(result.message);
      if (result.status === 'renamed' || result.status === 'failed') { setUnknown(false); cancel(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed. Nothing was retried.'); }
    finally { setBusy(false); }
  }
  return <div className="create-worktree">
    {!editing && <button type="button" className="quiet" aria-label={`Rename branch ${name}`} aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!blockedReason} onClick={() => { setEditing(true); setNewBranch(tree.branch ?? ''); }}>Rename…</button>}
    {reason && <p className="fine" id={`${controlId}-reason`} role="status">{reason}</p>}
    {editing && <div className="notice">
      <label>New branch name<input aria-label="New branch name" value={newBranch} maxLength={150} disabled={busy || unknown} onChange={(event) => { setNewBranch(event.target.value); setPreview(null); setError(''); }} /></label>
      <button type="button" disabled={blocked || !!blockedReason || !newBranch.trim() || newBranch.trim() === tree.branch} onClick={() => void inspect()}>Preview rename</button>
      {!preview && <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>}
    </div>}
    {preview && <div className="notice" role="region" aria-label={`Rename ${name}`}>
      <p>Rename <span className="mono">{preview.branch}</span> to <span className="mono">{preview.newBranch}</span> at <span className="mono">{short(preview.head)}</span>.</p>
      <p>The directory <span className="mono">{preview.worktree.root}</span>, its files{preview.dirty ? ' (including your uncommitted changes, which stay exactly as they are)' : ''}, the agents and tmux session names stay the same.{preview.checkpoints ? ` ${preview.checkpoints} recorded squash batch${preview.checkpoints === 1 ? ' carries' : 'es carry'} over to the new name.` : ''} Nothing is pushed.</p>
      <p className="mono commands">{preview.commands.join('\n')}</p>
      {!current && <p>The worktree changed. Cancel and check again.</p>}
      <button type="button" aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={blocked || !!reason} onClick={() => void rename()}>Confirm rename</button>
      <button type="button" className="quiet" disabled={busy || unknown} onClick={cancel}>Cancel</button>
    </div>}
    {unknown && <button type="button" disabled={busy} onClick={() => void inspectUnknown()}>Inspect this rename result</button>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </div>;
}

/** Deletion always requires a fresh server preview and explicit confirmation. */
export function RemoveWorktree({ project, tree, token, disabled, noticeId, onChanged }: ActionProps) {
  const [preview, setPreview] = useState<WorktreeRemovalPreview | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false); const controlId = useId();
  const held = isHeld(project); const name = nameFor(tree);
  const reason = localReason(unknown, busy, 'Removal');
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
    {!preview && <button type="button" className="quiet" aria-label={`Check removal of ${name}`} aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={disabled || held || !!reason} onClick={() => void inspect()}>Check removal</button>}
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
export function DiscardWorktree({ project, tree, token, disabled, noticeId, onChanged, viewEpoch }: ActionProps) {
  const [preview, setPreview] = useState<WorktreeDiscardPreview | null>(null); const [typed, setTyped] = useState('');
  // The typed branch name is the confirmation: hiding the view clears it, while the preview stays for re-checking.
  useEffect(() => { setTyped(''); }, [viewEpoch]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [unknown, setUnknown] = useState(false);
  const controlId = useId();
  const held = isHeld(project); const name = nameFor(tree);
  const reason = localReason(unknown, busy, 'Discard');
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
    {!preview && <button type="button" className="quiet danger" aria-label={`Discard ${name}`} aria-describedby={describedBy(noticeId, reason && `${controlId}-reason`)} disabled={disabled || held || !!reason} onClick={() => void inspect()}>Discard…</button>}
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

/** Applying or uncertain lifecycle operations stay visible with read-only inspection until they reach a recorded result. A discard whose
 * inspection found only the branch left, at the confirmed head, also offers the confirmed finish of that same consent. */
export function LifecycleResults({ project, token, onChanged }: { project: Project; token: string; onChanged: (notice: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function send(path: string, body: { requestId: string; confirm?: true }) {
    setBusy(true); setError('');
    try { const result = await api<{ message: string }>(token, path, { body }); await onChanged(result.message); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Inspection failed.'); }
    finally { setBusy(false); }
  }
  const pending = <T extends { status: string }>(ops: T[] | undefined) => (ops ?? []).filter((op) => ['applying', 'uncertain'].includes(op.status));
  return <>
    {/* A Git step can remove the worktree before its finish is settled. Keep recovery reachable without its card. */}
    {(project.finishes ?? []).filter((op) => FINISH_HOLDING.includes(op.status) && !project.worktrees.some((tree) => tree.id === op.preview.worktreeId)).map((op) =>
      <FinishBranch key={op.requestId} project={project} token={token} disabled onChanged={onChanged}
        tree={{ id: op.preview.worktreeId, path: op.preview.worktree.root, identity: op.preview.worktree, branch: op.preview.branch,
          head: op.preview.git.head, main: false, error: null }} />)}
    {pending(project.removals).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree removal {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void send('projects/worktrees/removal/reconcile', { requestId: op.input.requestId })}>Inspect removal result</button>
    </div>)}
    {pending(project.integrations).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Squash integration {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.branch} → {op.input.target.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void send('projects/worktrees/integration/reconcile', { requestId: op.input.requestId })}>Inspect squash result</button>
    </div>)}
    {pending(project.updates).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree update {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.branch} → {refName(op.input.targetRef)} in {op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void send('projects/worktrees/update/reconcile', { requestId: op.input.requestId })}>Inspect update result</button>
    </div>)}
    {pending(project.renames).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Branch rename {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.branch} → {op.input.newBranch} in {op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void send('projects/worktrees/rename/reconcile', { requestId: op.input.requestId })}>Inspect rename result</button>
    </div>)}
    {pending(project.discards).map((op) => <div className="notice" key={op.input.requestId}>
      <strong>Worktree discard {op.status}</strong><p>{op.message}</p><p className="mono">{op.input.worktree.root}</p>
      <button type="button" disabled={busy || op.status === 'applying'} onClick={() => void send('projects/worktrees/discard/reconcile', { requestId: op.input.requestId })}>Inspect discard result</button>
      {op.status === 'uncertain' && op.branchRemains && <button type="button" className="danger" disabled={busy} onClick={() => void send('projects/worktrees/discard/finish', { requestId: op.input.requestId, confirm: true })}>Delete branch {op.input.branch} and finish discard</button>}
    </div>)}
    {error && <p className="notice error" role="alert">{error}</p>}
  </>;
}
