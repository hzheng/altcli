'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommandRecord } from '../contracts/api';
import type { Group, WorkspaceGit } from '../contracts/implementation';
import type { WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { useRemembered } from '../client/memory';
import { isSha, type RunSettings } from './RunSettings';

/** Group-level Plan start: one shared brief for every planner. Starting a Plan is never a per-pane coding send. */
export function PlanSetup(p: {
  token: string; state: WorkflowState; group?: Group; git?: WorkspaceGit; workspaceError: string; agentsKey: string; settings: RunSettings;
  /** The displayed pane's agent, used as the default first implementer. */
  displayed?: string;
  blockedReason: string; busy: boolean; submit: (work: () => Promise<void>) => Promise<void>;
  consent: string; setConsent: (update: (current: string) => string) => void; runMark: string; recheck: number; draftKey: string;
  refresh: () => Promise<void>; onRecheck: () => Promise<void>; onMessage: (message: string) => void; onUncertain: (id: string) => void;
}) {
  const { settings: s, group, git } = p;
  const members = group?.members ?? [];
  const [text, setText] = useRemembered(`${p.draftKey}:brief`, '');
  // A refused start is shown beside its button; the console-wide message sits elsewhere.
  const [startError, setStartError] = useState('');
  useEffect(() => { setStartError(''); }, [p.recheck]);
  const target = s.selectedPolicy === 'worker_reviewer' ? s.workerId : members.includes(s.actor) ? s.actor : members.includes(p.displayed ?? '') ? p.displayed! : members[0];
  const registrations = Object.fromEntries(members.map((id) => [id, p.state.sessions.find((session) => session.id === id)?.registrationId ?? '']));
  const instances = members.map((id) => p.state.instances.find((instance) => instance.agentId === id)?.status);
  const key = JSON.stringify(['plan', group?.id, group?.revision, registrations, instances, p.agentsKey, target, git ?? null, p.workspaceError, s.consent, p.runMark, p.recheck, text]);
  // The consent key includes the brief, so typing after ticking Ready unticks it; returning to old values never revives it.
  const consented = useRef(key);
  useEffect(() => { if (consented.current !== key) { const previous = consented.current; consented.current = key; p.setConsent((current) => current === previous ? '' : current); } }, [key]);
  const ready = p.consent === key;
  const branchInvalid = (s.branchChoice === 'stay' && (!git?.branch || git.integration)) || (s.branchChoice === 'new' && !s.branchName.trim());
  const disabled = !!p.blockedReason || p.busy || !!p.workspaceError || !group || members.length < 1 || members.length > 2 || !git || !git.clean || branchInvalid
    || (s.needsBaseline && !isSha(s.taskBase.trim())) || !s.limitValid;
  // Start Plan would otherwise grey out silently: the consent key includes the brief, so typing after ticking Ready unticks it.
  const reason = p.blockedReason || (p.busy ? 'Wait for the current request or Recheck to finish.'
    : p.workspaceError || !git ? 'Recheck the workspace Git state before planning.'
    : !git.clean ? 'Plan needs a clean checkout. Commit or separate the changes listed above, then Recheck.'
    : branchInvalid ? 'Choose the implementation branch and enter its name, or leave the choice for the plan checkpoint.'
    : s.needsBaseline && !isSha(s.taskBase.trim()) ? 'Enter the full task baseline commit.'
    : !s.limitValid ? 'Set the maximum automatic turns to a whole number from 1 to 200.'
    : !text.trim() ? 'Enter the shared task brief.'
    : !ready ? 'Confirm Ready for planning. Changing the brief, a setting or the checkout clears an earlier confirmation.' : '');
  const reasonId = useId(); const briefId = useId();
  async function start() {
    if (disabled || !ready || !text.trim() || !group || !git || !target) return;
    p.setConsent(() => ''); setStartError(''); const requestId = crypto.randomUUID();
    await p.submit(async () => {
      try {
        const record = await api<CommandRecord>(p.token, 'planning', { body: { requestId, groupId: group.id, groupRevision: group.revision, registrations,
          text: text.trim(), baseline: { branch: git.branch, head: git.head }, autoContinue: s.automatic, requireApproval: s.requireApproval, turnLimit: s.limit, pauseOnObjection: s.pauseOnObjection, confirmReady: true,
          implementation: { groupId: group.id, groupRevision: group.revision, registrations, agentId: target, policy: s.selectedPolicy,
            ...(s.selectedPolicy === 'worker_reviewer' ? { workerId: s.workerId } : {}), handoff: !s.solo, ...(s.logPath ? { logPath: s.logPath } : {}), branch: s.branchChoice ? s.branch() : null } } });
        if (record.status === 'rejected') setStartError(`REJECTED: ${record.error ?? 'The server refused this start.'}`);
        else { p.onMessage(`${record.status.toUpperCase()}: ${record.error ?? 'Plan started. The server owns this run.'}`); setText(''); }
      } catch (error) {
        setStartError(error instanceof Error ? error.message : 'Phase start failed.');
        if (!(error instanceof HttpError) || error.status >= 500) p.onUncertain(requestId);
      } finally { await Promise.all([p.refresh(), p.onRecheck()]); }
    });
  }
  return <section className="composer implementation" aria-label="Plan setup">
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
      <p>Keep unrelated work separate, or prepare another clean worktree yourself. Staged and unstaged changes may be different tasks; CoderCrew will not combine, stage, commit, stash or discard them.</p>
      {p.state.legacyEnabled && members.length === 2 && <p>To keep changes uncommitted, use the <strong>Staging fallback</strong> preference in Settings for supervised two-agent review.</p>}
    </section>}
    {!group ? <p>Select at least one agent in Projects to start.</p> : members.length > 2 ? <p className="notice" role="status">Your group has {members.length} agents. Plan and Implementation currently execute with one or two agents; larger-group execution is not enabled yet. Your selection is saved. Choose one or two members to start a run.</p> : <>
      <p className="fine">Plan documents are kept in CoderCrew’s data directory, not in this checkout. No branch is created during Plan. Output permissions are cooperative and validated, not native CLI sandbox isolation.</p>
      <label htmlFor={briefId}>Shared task brief</label><textarea id={briefId} rows={3} value={text} disabled={!!p.blockedReason || p.busy} maxLength={1900} onChange={(e) => setText(e.target.value)} />
      <label className="readiness"><input type="checkbox" aria-label="Ready for planning" checked={ready} disabled={disabled} onChange={(e) => p.setConsent(() => e.target.checked ? key : '')} />
        I checked every selected and unselected agent sharing this checkout: all are settled, prompts are empty, and no background writers remain. I authorize document-only planning and the displayed post-plan settings; any branch choice applies only after Plan finishes.</label>
      <div className="register-actions"><button type="button" className="primary" title={`${reason ? `${reason} ` : ''}Start document-only planning.`} aria-describedby={reason ? reasonId : undefined} disabled={disabled || !ready || !text.trim()} onClick={() => void start()}>Start Plan</button></div>
      {startError && <p className="notice error" role="alert">{startError}</p>}
      {reason && <p className="fine" role="status" id={reasonId}>{reason}</p>}
      <p className="fine">Opening this phase or changing a setting does not send work. Initial peer drafts stay out of assignments until the complete-roster barrier.</p>
    </>}
  </section>;
}
