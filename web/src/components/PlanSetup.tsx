'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommandRecord } from '../contracts/api';
import type { Group, WorkspaceGit } from '../contracts/implementation';
import type { WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { useRemembered } from '../client/memory';
import { isSha, type RunSettings } from './RunSettings';
import { Acknowledgement, overrideKey, type Override } from './Holds';
import { imagesBlocker, imagesKey } from '../client/attachments';
import { AttachImageButton, AttachmentTray, IMAGE_LIMIT_NOTE, pasteImages, useImageTray } from './AttachmentTray';

/** The last gate before Start Plan; its check is beside the button. */
const NOT_READY = 'Check Ready for planning above. Changing the brief, a setting or the checkout clears an earlier confirmation.';

/** Group-level Plan start: one shared brief for every planner. Starting a Plan is never a per-pane coding send. */
export function PlanSetup(p: {
  token: string; state: WorkflowState; group?: Group; git?: WorkspaceGit; workspaceError: string; agentsKey: string; settings: RunSettings;
  /** The displayed pane's agent, used as the default first implementer. */
  displayed?: string;
  blockedReason: string; busy: boolean; submit: (work: () => Promise<void>) => Promise<void>;
  consent: string; setConsent: (update: (current: string) => string) => void; runMark: string; recheck: number; draftKey: string;
  refresh: () => Promise<void>; onRecheck: () => Promise<void>; onMessage: (message: string) => void; onUncertain: (id: string) => void;
  /** An accepted start: the console shows the terminals. */
  onSent: () => void;
  /** What starting overrides (controller runs, delivery holds, manual input), listed in the readiness check and cleared at start. */
  override: Override | null;
  onOpenAccess: () => void;
  /** Increases on every view change; a start that is still clearing holds is cancelled by it. */
  viewEpoch: number;
}) {
  const { settings: s, group, git } = p;
  const members = group?.members ?? [];
  const [text, setText] = useRemembered(`${p.draftKey}:brief`, '');
  // Images that belong to the shared brief: every planner and the approved implementation receive the same ones.
  const images = useImageTray(p.token, group?.repository ?? '', `${p.draftKey}:brief-images`);
  const [imageNotice, setImageNotice] = useState('');
  const attachImages = (files: File[]) => { setImageNotice(images.add(files).join(' ')); };
  // A refused start is shown beside its button; the console-wide message sits elsewhere.
  const [startError, setStartError] = useState('');
  useEffect(() => { setStartError(''); }, [p.recheck]);
  const target = s.selectedPolicy === 'worker_reviewer' ? s.workerId : members.includes(s.actor) ? s.actor : members.includes(p.displayed ?? '') ? p.displayed! : members[0];
  const registrations = Object.fromEntries(members.map((id) => [id, p.state.sessions.find((session) => session.id === id)?.registrationId ?? '']));
  const instances = members.map((id) => p.state.instances.find((instance) => instance.agentId === id)?.status);
  const key = JSON.stringify(['plan', group?.id, group?.revision, registrations, instances, p.agentsKey, target, git ?? null, p.workspaceError, s.consent, p.runMark, p.recheck, text, imagesKey(images.items), overrideKey(p.override)]);
  // What a click authorizes except the holds it clears (runs and manual input): any change while they are cleared cancels the start.
  const intent = JSON.stringify([group?.id, group?.revision, registrations, instances, p.agentsKey, target, git ?? null, p.workspaceError, s.consent, p.recheck, p.state.activities, p.token, p.viewEpoch, text, imagesKey(images.items)]);
  const intentRef = useRef({ key: intent, revision: 0 });
  if (intentRef.current.key !== intent) intentRef.current = { key: intent, revision: intentRef.current.revision + 1 };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The consent key includes the brief, so typing after ticking Ready unticks it; returning to old values never revives it.
  const consented = useRef(key);
  useEffect(() => { if (consented.current !== key) { const previous = consented.current; consented.current = key; p.setConsent((current) => current === previous ? '' : current); } }, [key]);
  const ready = p.consent === key;
  const branchInvalid = (s.branchChoice === 'stay' && (!git?.branch || git.integration)) || (s.branchChoice === 'new' && !s.branchName.trim());
  // Shared images reach every planner and implementation member: each must be a CLI whose image reading was verified.
  const unsupportedAgents = images.items.length ? members.map((id) => p.state.sessions.find((session) => session.id === id)).filter((session) => session?.agentType !== 'claude' && session?.agentType !== 'codex') : [];
  const unsupported = unsupportedAgents.length ? `Images are verified only for Claude Code and Codex. Remove the images to plan with ${unsupportedAgents.map((session) => session?.label ?? 'this agent').join(', ')}.` : '';
  const disabled = !!p.blockedReason || p.busy || !!p.workspaceError || !group || members.length < 1 || members.length > 2 || !git || !git.clean || branchInvalid
    || (s.needsBaseline && !isSha(s.taskBase.trim())) || !s.limitValid || !!imagesBlocker(images.items) || !!unsupported;
  // Start Plan would otherwise grey out silently: the consent key includes the brief, so typing after ticking Ready unticks it.
  const reason = p.blockedReason || (p.busy ? 'Wait for the current request or Recheck to finish.'
    : p.workspaceError || !git ? 'Recheck the workspace Git state before planning.'
    : !git.clean ? 'Plan needs a clean checkout. Commit or separate the changes listed above, then Recheck.'
    : branchInvalid ? 'Choose the implementation branch and enter its name, or leave the choice for the plan checkpoint.'
    : s.needsBaseline && !isSha(s.taskBase.trim()) ? 'Enter the full task baseline commit.'
    : !s.limitValid ? 'Set the maximum automatic turns to a whole number from 1 to 200.'
    : !text.trim() ? images.items.length ? 'Enter the shared task brief to go with the images.' : 'Enter the shared task brief.'
    : imagesBlocker(images.items) || unsupported
    || (!ready ? NOT_READY : ''));
  const reasonId = useId(); const briefId = useId();
  async function start() {
    if (disabled || !ready || !text.trim() || !group || !git || !target) return;
    p.setConsent(() => ''); setStartError(''); const requestId = crypto.randomUUID(); const intentRevision = intentRef.current.revision;
    // The request is built from the confirmed brief, images and settings before any hold is cleared.
    const brief = text; const sentImages = images.items; const body = { requestId, groupId: group.id, groupRevision: group.revision, registrations,
      ...(sentImages.length ? { attachments: sentImages.map((item) => item.receipt!.id) } : {}),
      text: text.trim(), baseline: { branch: git.branch, head: git.head }, autoContinue: s.automatic, requireApproval: s.requireApproval, turnLimit: s.limit, pauseOnObjection: s.pauseOnObjection, confirmReady: true,
      implementation: { groupId: group.id, groupRevision: group.revision, registrations, agentId: target, policy: s.selectedPolicy,
        ...(s.selectedPolicy === 'worker_reviewer' ? { workerId: s.workerId } : {}), handoff: !s.solo, ...(s.logPath ? { logPath: s.logPath } : {}), branch: s.branchChoice ? s.branch() : null } };
    await p.submit(async () => {
      let dispatched = false;
      try {
        // The check accepted every listed hold; each is cleared first. A failed step, or any change to the brief, settings or view
        // meanwhile, starts nothing.
        if (p.override) {
          await p.override.clear();
          if (!mounted.current || intentRef.current.revision !== intentRevision) throw Error('The holds were cleared, but the brief, settings or displayed state changed. Inspect and confirm readiness again; nothing was started.');
        }
        dispatched = true;
        const record = await api<CommandRecord>(p.token, 'planning', { body });
        if (record.status === 'rejected') setStartError(`REJECTED: ${record.error ?? 'The server refused this start.'}`);
        else { p.onMessage(`${record.status.toUpperCase()}: ${record.error ?? 'Plan started. The server owns this run.'}`); setText((current) => current === brief ? '' : current); images.clearExact(sentImages.map((item) => item.key)); p.onSent(); }
      } catch (error) {
        setStartError(error instanceof Error ? error.message : 'Phase start failed.');
        if (dispatched && (!(error instanceof HttpError) || error.status >= 500)) p.onUncertain(requestId);
      } finally { await Promise.all([p.refresh(), p.onRecheck()]); }
    });
  }
  return <section className="composer implementation command-zone" aria-label="Plan setup">
    <div className="section-heading"><h2>Plan</h2><span className="badge">PLAN DOCUMENTS · NO CODE EDITS</span></div>
    <p className="muted">Each planner drafts independently, one at a time. Then refine one shared plan. Coding starts only after the separate approval and branch gates.</p>
    {!p.blockedReason && git && !git.clean && <section className="notice workspace-changes" aria-label="Uncommitted changes">
      <h3>Plan needs a clean checkout</h3>
      <p>Resolve conflicts, then commit the intended changes on your task branch. Creating a branch alone does not make the checkout clean.</p>
      <ul aria-label="Blocking files">{git.changes.map((change) => <li key={change.path}>
        <span>{change.status === '??' ? 'Untracked' : ['DD','AU','UD','UA','DU','AA','UU'].includes(change.status) ? 'Unmerged' : [change.status[0] !== ' ' && 'Staged', change.status[1] !== ' ' && 'Unstaged'].filter(Boolean).join(' + ')}</span>
        <code>{change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}</code>
      </li>)}</ul>
      {git.changeCount > git.changes.length && <p>Showing {git.changes.length} of {git.changeCount} changed paths. Inspect the full list locally with <code>git status</code>.</p>}
      <p>Plain Send can continue without a handoff commit. Commit snapshots the current changes without finishing pending requests. Then choose a Review baseline and use Relay in Implementation to request peer review.</p>
      <p>Keep unrelated work separate, or prepare another clean worktree yourself. Staged and unstaged changes may be different tasks; AltCLI will not combine, stage, commit, stash or discard them.</p>
      {p.git?.stageRelay?.eligible && p.state.legacyEnabled && members.length === 2 && <p>To keep changes uncommitted on <span className="mono">{p.git.branch}</span>, use <strong>Stage relay</strong> in Implementation for supervised two-agent review.</p>}
    </section>}
    {!group ? <p>Select at least one agent in Projects to start.</p> : members.length > 2 ? <p className="notice" role="status">Your group has {members.length} agents. Plan and Implementation currently execute with one or two agents; larger-group execution is not enabled yet. Your selection is saved. Choose one or two members to start a run.</p> : <>
      <p className="fine">Plan documents are kept in AltCLI’s data directory, not in this checkout. No branch is created during Plan. Output permissions are cooperative and validated, not native CLI sandbox isolation.</p>
      <label htmlFor={briefId}>Shared task brief</label><textarea id={briefId} rows={3} value={text} disabled={p.busy} maxLength={1900} onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { pasteImages(e, attachImages); }} />
      <div className="attach-row"><AttachImageButton label="Attach image to brief" className="quiet" disabled={p.busy} onFiles={attachImages} />
        <small>Every planner and the approved implementation receive the brief’s images. {IMAGE_LIMIT_NOTE} Request changes stays text-only; a different image set needs a new Plan.</small></div>
      <AttachmentTray label="Images for the shared brief" tray={images} onMessage={setImageNotice} />
      {imageNotice && <p className="fine" role="status">{imageNotice}</p>}
      <div role="group" aria-label="Readiness for Plan">
        <Acknowledgement label="Ready for planning" checked={ready} disabled={disabled} onChange={(checked) => p.setConsent(() => checked ? key : '')} lines={p.override?.lines ?? []}>
          I checked every selected and unselected agent sharing this checkout: all are settled, prompts are empty, and no background writers remain. I authorize document-only planning and the displayed post-plan settings; any branch choice applies only after Plan finishes.</Acknowledgement>
        <p className="fine"><strong>Start Plan</strong> for {members.length} {members.length === 1 ? 'planner' : 'planners'}: document-only planning of the shared brief.{p.override && <> <button type="button" className="quiet inline-link" aria-controls="control-access" onClick={p.onOpenAccess}>Why? Control access</button></>}</p>
      </div>
      <div className="register-actions"><button type="button" className="primary" title={`${reason ? `${reason} ` : ''}Start document-only planning.`} aria-describedby={reason ? reasonId : undefined} disabled={disabled || !ready || !text.trim()} onClick={() => void start()}>Start Plan</button></div>
      {startError && <p className="notice error" role="alert">{startError}</p>}
      {reason && <p className="fine" role="status" id={reasonId}>{reason}</p>}
      <p className="fine">Opening this phase or changing a setting does not send work. Initial peer drafts stay out of assignments until the complete-roster barrier.</p>
    </>}
  </section>;
}
