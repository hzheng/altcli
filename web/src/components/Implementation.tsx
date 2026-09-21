'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommandRecord } from '../contracts/api';
import type { CollaborationPolicy, Group, ReviewPreview } from '../contracts/implementation';
import type { RelayRun, WorkflowState, Workspace } from '../contracts/workflow';
import { api, HttpError } from '../client/api';

export function Implementation({ token, state, group, workspace, workspaceError, selectedAgent, blocked, blockedReason = '', refresh, onRecheck, onMessage, onUncertain, phase = 'implementation' }: {
  token: string; state: WorkflowState; group?: Group; workspace?: Workspace; selectedAgent?: string; blocked: boolean;
  workspaceError: string; refresh: () => Promise<void>; onRecheck: () => Promise<void>; onMessage: (message: string) => void; onUncertain: (id: string) => void;
  phase?: 'plan' | 'implementation'; blockedReason?: string;
}) {
  const planning = phase === 'plan';
  const implementationGroup = group;
  const [requireApproval, setRequireApproval] = useState(true); const [actor, setActor] = useState('');
  const [policy, setPolicy] = useState<CollaborationPolicy>('peer');
  const [worker, setWorker] = useState(''); const [text, setText] = useState('');
  const [automatic, setAutomatic] = useState(true); const [limit, setLimit] = useState(20); const [pauseOnObjection, setPauseOnObjection] = useState(false);
  const [trackLog, setTrackLog] = useState(false); const [log, setLog] = useState('RELAY-LOG.jsonl'); const [reviewBase, setReviewBase] = useState('');
  // The journal lives in CoderCrew; mirroring it into a tracked file is an explicit project preference, off by default.
  const logPath = trackLog && log.trim() ? log.trim() : undefined;
  const [choice, setChoice] = useState<string | null>(null); const [branchName, setBranchName] = useState(''); const [baseline, setBaseline] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(''); const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [baselineChoice, setBaselineChoice] = useState(''); // '' = earliest candidate, a SHA, or 'other' for a typed baseline
  const [lastPreview, setLastPreview] = useState<{ key: string; data?: ReviewPreview; error?: string }>();
  const [explicitPreview, setExplicitPreview] = useState<{ key: string; data?: ReviewPreview; error?: string }>();
  // Loading belongs to one request at a time: only the newest preview may show or clear it, whether it finishes or is cancelled.
  const previewRequests = useRef(0); const [previewing, setPreviewing] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const members = implementationGroup?.members ?? [];
  const solo = members.length === 1;
  const selectedPolicy = solo ? 'solo' : policy;
  const workerId = members.includes(worker) ? worker : members[0];
  const target = selectedPolicy === 'worker_reviewer' ? workerId : planning && members.includes(actor) ? actor : members.includes(selectedAgent ?? '') ? selectedAgent! : members[0];
  const reviewer = members.find((id) => id !== target);
  const nameOf = (id?: string) => state.sessions.find((session) => session.id === id)?.label ?? 'agent';
  const targetName = nameOf(target); const reviewerName = nameOf(reviewer);
  const git = workspace?.git;
  const snapshotRelay = git?.clean === false;
  // Reads committed objects for an exact base..HEAD; the server validates the range rather than the client estimating it.
  async function previewBase(base: string, signal?: AbortSignal) {
    if (!group || !git || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return;
    const key = JSON.stringify([previewKey, base]); const request = ++previewRequests.current; setPreviewing(request); setConfirmed('');
    try { const data = await api<ReviewPreview>(token, 'implementation/preview', { body: { groupId: group.id, head: git.head, ...(logPath ? { logPath } : {}), base, commitPending: snapshotRelay }, signal }); if (!signal?.aborted) setExplicitPreview({ key, data }); }
    catch (error) { if (!signal?.aborted) setExplicitPreview({ key, error: error instanceof Error ? error.message : 'Could not preview this range.' }); }
    finally { setPreviewing((current) => current === request ? 0 : current); }
  }
  const registrations = Object.fromEntries(members.map((id) => [id, state.sessions.find((s) => s.id === id)?.registrationId ?? '']));
  const plannerRegistrations = Object.fromEntries((group?.members ?? []).map((id) => [id, state.sessions.find((s) => s.id === id)?.registrationId ?? '']));
  // An integration branch is a starting point only: the picker never offers to continue on it, and the server refuses it too.
  const branchChoice = choice ?? (git?.branch && !git.integration ? 'stay' : '');
  // Staying on an existing task branch keeps its permanent baseline; when it cannot be inferred, the user confirms it.
  const needsBaseline = branchChoice === 'stay' && !!git && !git.integration && git.taskBase !== git.head;
  const taskBase = baseline ?? git?.taskBase ?? '';
  // A new branch begins at the displayed head; an existing task branch reviews back to its confirmed baseline.
  const reviewTaskBase = branchChoice === 'new' ? git?.head ?? '' : taskBase.trim();
  const previewKey = JSON.stringify([group?.id, git?.head, logPath ?? null, reviewer, reviewTaskBase, previewRevision, snapshotRelay]);
  const last = lastPreview?.key === previewKey ? lastPreview : undefined;
  // Candidate baselines come from the server's first-parent chain, earliest (everything new to the recipient) to latest (the last commit only).
  const candidates = last?.data?.candidates ?? [];
  const chosen = baselineChoice === 'other' ? 'other' : candidates.some((candidate) => candidate.sha === baselineChoice) ? baselineChoice : candidates[0]?.sha ?? (last?.error ? 'other' : '');
  const chosenIndex = candidates.findIndex((candidate) => candidate.sha === chosen);
  const earliestLabel = last?.data?.since === 'recipient' ? `all since ${reviewerName}'s last commit` : 'all since the task baseline';
  const markerOf = (index: number) => [index === 0 ? `earliest: ${earliestLabel}` : '', index === candidates.length - 1 ? snapshotRelay ? 'latest: current changes only' : 'latest: last commit only' : ''].filter(Boolean).join(' · ');
  // Any baseline other than the earliest is previewed as its own exact range; the typed one only on request.
  const explicitBase = chosen === 'other' ? reviewBase.trim() : chosenIndex > 0 ? chosen : '';
  const recent = explicitPreview?.key === JSON.stringify([previewKey, explicitBase]) ? explicitPreview : undefined;
  const selectedRange: ReviewPreview | undefined = chosenIndex === 0 ? last?.data : recent?.data;
  useEffect(() => {
    if (planning || solo || !git || chosen === 'other' || chosenIndex <= 0 || recent) return;
    const abort = new AbortController(); void previewBase(chosen, abort.signal); return () => abort.abort();
  }, [planning, solo, git?.clean, chosen, chosenIndex, previewKey, !!recent]); // previewBase reads the same keys as previewKey
  // This effect only reads committed objects. Sending always requires an explicit button click.
  useEffect(() => {
    if (planning || solo || !group || !git || !reviewer || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reviewTaskBase)) return;
    const abort = new AbortController();
    void api<ReviewPreview>(token, 'implementation/preview', { body: { groupId: group.id, head: git.head, ...(logPath ? { logPath } : {}), recipient: reviewer, taskBase: reviewTaskBase, commitPending: snapshotRelay }, signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setLastPreview({ key: previewKey, data }); })
      .catch((error) => { if (!abort.signal.aborted) setLastPreview({ key: previewKey, error: error instanceof Error ? error.message : 'Could not read the commits to review.' }); });
    return () => abort.abort();
  }, [token, planning, solo, group?.id, git?.head, git?.clean, logPath, reviewer, reviewTaskBase, previewKey]);
  const key = JSON.stringify([phase, group?.id, group?.revision, plannerRegistrations, implementationGroup?.id, implementationGroup?.revision, registrations, members.map((id) => state.instances.find((i) => i.agentId === id)?.status), workspace?.agents, target, git, workspaceError, branchChoice, branchName, taskBase, selectedPolicy, workerId, automatic, requireApproval, limit, pauseOnObjection, logPath ?? null, reviewBase, chosen, recent?.data, last?.data, planning ? text : null]);
  // Once the displayed checkout/settings change, returning to old values must not revive consent.
  useEffect(() => { setConfirmed(''); }, [key]);
  const ready = confirmed === key;
  const sendDisabled = blocked || busy || checking || !!workspaceError || !group || members.length < 1 || members.length > 2 || !git;
  const disabled = blocked || busy || checking || !!workspaceError || !group || members.length < 1 || members.length > 2 || !git || (planning && !git.clean) || (!planning && !branchChoice) || (branchChoice === 'stay' && (!git.branch || git.integration)) || (needsBaseline && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(taskBase.trim())) || (branchChoice === 'new' && !branchName.trim()) || !Number.isInteger(limit) || limit < 1 || limit > 200;
  const reviewBlockedReason = blockedReason || (blocked ? 'A run or workspace readiness check blocks new work. See the Console status above.'
    : busy || checking ? 'Wait for the current request or Recheck to finish.'
    : workspaceError || !git ? 'Recheck the workspace Git state before reviewing.'
    : !branchChoice || (branchChoice === 'new' && !branchName.trim()) ? 'Choose the implementation branch and enter its name before reviewing.'
    : needsBaseline && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(taskBase.trim()) ? 'Enter the full task baseline commit before reviewing.'
    : !Number.isInteger(limit) || limit < 1 || limit > 200 ? 'Set the maximum automatic turns to a whole number from 1 to 200.'
    : !ready ? 'Confirm Ready for implementation after checking the review range and all agents.' : null);
  // Start Plan greys out silently otherwise: the consent key includes the brief, so typing after ticking Ready unticks it.
  const planBlockedReason = !planning ? '' : blockedReason || (blocked ? 'A run or workspace readiness check blocks new work. See the Console status above.'
    : busy || checking ? 'Wait for the current request or Recheck to finish.'
    : workspaceError || !git ? 'Recheck the workspace Git state before planning.'
    : !git.clean ? 'Plan needs a clean checkout. Commit or separate the changes listed above, then Recheck.'
    : (branchChoice === 'stay' && (!git.branch || git.integration)) || (branchChoice === 'new' && !branchName.trim()) ? 'Choose the implementation branch and enter its name, or leave the choice for the plan checkpoint.'
    : needsBaseline && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(taskBase.trim()) ? 'Enter the full task baseline commit.'
    : !Number.isInteger(limit) || limit < 1 || limit > 200 ? 'Set the maximum automatic turns to a whole number from 1 to 200.'
    : !text.trim() ? 'Enter the shared task brief.'
    : !ready ? 'Confirm Ready for planning. Changing the brief, a setting or the checkout clears an earlier confirmation.' : '');
  const planReasonId = useId();
  async function start(kind: 'work' | 'commit' | 'review', handoff: boolean, review?: ReviewPreview) {
    const standalone = !planning && kind === 'work' && !handoff;
    if ((standalone ? sendDisabled : disabled || (kind === 'review' && !git?.clean)) || !ready || !group || !implementationGroup || !git || !target) return;
    if ((kind === 'review' || (kind === 'commit' && handoff)) && (!review || review.head !== git.head || !reviewer)) return;
    setBusy(true); setConfirmed(''); const requestId = crypto.randomUUID();
    try {
      const branch = { branch: git.branch, head: git.head, ...(branchChoice === 'new' ? { newBranch: branchName.trim() } : needsBaseline ? { taskBase: taskBase.trim() } : {}) };
      const record = standalone ? await api<CommandRecord>(token, 'instructions', { body: { requestId, groupId: group.id, groupRevision: group.revision, registrations, agentId: target, text: text.trim(), policy: selectedPolicy, ...(selectedPolicy === 'worker_reviewer' ? { workerId } : {}), confirmReady: true } }) : planning ? await api<CommandRecord>(token, 'planning', { body: { requestId, groupId: group.id, groupRevision: group.revision, registrations: plannerRegistrations,
        text: text.trim(), baseline: { branch: git.branch, head: git.head }, autoContinue: automatic, requireApproval, turnLimit: limit, pauseOnObjection, confirmReady: true,
        implementation: { groupId: implementationGroup.id, groupRevision: implementationGroup.revision, registrations, agentId: target, policy: selectedPolicy,
          ...(selectedPolicy === 'worker_reviewer' ? { workerId } : {}), handoff: !solo, ...(logPath ? { logPath } : {}), branch: branchChoice ? branch : null } } })
        : await api<CommandRecord>(token, 'implementation', { body: { requestId, groupId: group.id, groupRevision: group.revision, registrations,
        agentId: kind === 'review' ? reviewer : target,
        kind, ...(text.trim() ? { text: text.trim() } : {}), handoff, policy: selectedPolicy,
        ...(selectedPolicy === 'worker_reviewer' ? { workerId } : {}), autoContinue: !solo && automatic && (kind === 'review' || handoff),
        turnLimit: limit, pauseOnObjection: !solo && pauseOnObjection, ...(logPath ? { logPath } : {}), branch,
        ...(review ? { reviewBase: review.base } : {}), confirmReady: true } });
      onMessage(`${record.status.toUpperCase()}: ${record.error ?? `${standalone ? 'Standalone instruction' : planning ? 'Plan' : 'Implementation'} started. The server owns this run.`}`);
      if (record.status !== 'rejected') { setText(''); setBaselineChoice(''); }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Phase start failed.');
      if (!(error instanceof HttpError) || error.status >= 500) onUncertain(requestId);
    } finally { await Promise.all([refresh(), onRecheck()]); setBusy(false); }
  }
  return <section className="composer implementation" aria-label={planning ? 'Plan setup' : 'Implementation setup'}>
    <div className="section-heading"><h2>{planning ? 'Plan' : 'Implementation'}</h2><span className="badge">{planning ? 'IGNORED DOCUMENTS · NO CODE EDITS' : 'SEND / COMMIT / RELAY'}</span></div>
    <p className="muted">{planning ? 'Each planner drafts independently, one at a time. Then refine one shared plan. Coding starts only after the separate approval and branch gates.' : 'Send an instruction, commit the current changes, or choose committed changes for peer review. Commit does not start a review.'}</p>
    <div className="register-actions">
      <p className="muted">{git ? `Current: ${git.branch ?? 'detached HEAD'} at ${git.head.slice(0, 12)} · ${git.clean ? 'clean' : 'uncommitted changes'}. ${git.integration ? `${git.branch} is an integration branch: a starting point, not an implementation branch.` : git.primary ? `Integration branch: ${git.primary}.` : 'No default branch is recorded; configured integration branches apply.'}` : 'Workspace Git state is unavailable.'}</p>
      <button type="button" disabled={busy || checking} onClick={() => { setConfirmed(''); setChecking(true); void onRecheck().finally(() => { setPreviewRevision((revision) => revision + 1); setChecking(false); }); }}>{checking ? 'Checking…' : 'Recheck'}</button>
    </div>
    {(workspaceError || workspace?.gitError) && <p className="notice error" role="alert">{workspaceError || workspace?.gitError} Recheck before starting.</p>}
    {planning && !blocked && git && !git.clean && <section className="notice workspace-changes" aria-label="Uncommitted changes">
      <h3>Plan needs a clean checkout</h3>
      <p>Resolve conflicts, then commit the intended changes on your task branch. Creating a branch alone does not make the checkout clean.</p>
      <ul aria-label="Blocking files">{git.changes.map((change) => <li key={change.path}>
        <span>{change.status === '??' ? 'Untracked' : ['DD','AU','UD','UA','DU','AA','UU'].includes(change.status) ? 'Unmerged' : [change.status[0] !== ' ' && 'Staged', change.status[1] !== ' ' && 'Unstaged'].filter(Boolean).join(' + ')}</span>
        <code>{change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}</code>
      </li>)}</ul>
      {git.changeCount > git.changes.length && <p>Showing {git.changes.length} of {git.changeCount} changed paths. Inspect the full list locally with <code>git status</code>.</p>}
      <p>Plain Send can continue without a handoff commit. Commit snapshots the current changes without finishing pending requests. Then choose a Review baseline and use Relay in Implementation to request peer review.</p>
      <p>Keep unrelated work separate, or prepare another clean worktree yourself. Staged and unstaged changes may be different tasks; CoderCrew will not combine, stage, commit, stash or discard them.</p>
      {state.legacyEnabled && group?.members.length === 2 && <p>To keep changes uncommitted, use the <strong>Staging fallback</strong> option below for supervised two-agent review.</p>}
    </section>}
    {!group ? <p>Select at least one agent in Workspaces to start.</p> : members.length > 2 ? <p className="notice" role="status">Your group has {members.length} agents. Plan and Implementation currently execute with one or two agents; larger-group execution is not enabled yet. Your selection is saved. Choose one or two members to start a run.</p> : <>
      <div className="register-grid">
        {planning && <p className="muted">Workspace group: {group.members.map((id) => state.sessions.find((session) => session.id === id)?.label ?? id).join(' ⇄ ')}. Every planner is required; the same group continues into Implementation.</p>}
        <div className="field"><label htmlFor="collaboration">{planning ? 'After planning: collaboration' : 'Collaboration'}</label><select id="collaboration" disabled={blocked || busy || solo} value={selectedPolicy} onChange={(e) => setPolicy(e.target.value as CollaborationPolicy)}>
          {solo ? <option value="solo">Solo work</option> : <><option value="peer">Peer relay</option><option value="worker_reviewer">Worker + reviewer</option></>}</select></div>
        {selectedPolicy === 'worker_reviewer' && <div className="field"><label htmlFor="worker">Worker</label><select id="worker" value={workerId} disabled={blocked || busy} onChange={(e) => setWorker(e.target.value)}>
          {members.map((id) => <option key={id} value={id}>{state.sessions.find((s) => s.id === id)?.label ?? id}</option>)}</select><small>The other member reviews without editing project files.</small></div>}
        {planning && selectedPolicy === 'peer' && <div className="field"><label htmlFor="first-implementer">First implementer</label><select id="first-implementer" value={target} disabled={blocked || busy} onChange={(e) => setActor(e.target.value)}>{members.map((id) => <option key={id} value={id}>{state.sessions.find((s) => s.id === id)?.label ?? id}</option>)}</select></div>}
        <div className="field"><label htmlFor="branch-choice">Implementation branch</label><select id="branch-choice" value={branchChoice} disabled={blocked || busy} onChange={(e) => setChoice(e.target.value)}>
          <option value="">{planning ? 'Decide at the plan checkpoint' : 'Choose…'}</option>{git?.branch && !git.integration && <option value="stay">Continue on {git.branch}</option>}<option value="new">Create and check out a new branch</option></select>
          {git?.integration && <small>{git.branch} stays clean: task work and review commits go to a task branch, created here or as a task worktree in Projects. Integrate the accepted result afterwards with a separate squash merge or pull request.</small>}</div>
        {branchChoice === 'new' && <div className="field"><label htmlFor="new-branch">New branch name</label><input id="new-branch" value={branchName} disabled={blocked || busy} placeholder="task/my-change" onChange={(e) => setBranchName(e.target.value)} /></div>}
        {needsBaseline && <div className="field"><label htmlFor="task-baseline">Task baseline commit</label><input id="task-baseline" value={taskBase} disabled={blocked || busy} placeholder="Full commit ID where this task began" onChange={(e) => setBaseline(e.target.value)} />
          <small>{git?.taskBase ? 'Inferred from the nearest integration branch; confirm or correct it. It is recorded permanently for this task.' : 'Where this task began cannot be inferred unambiguously from the integration branches (diverged tips or criss-cross history). Enter the commit; it is recorded permanently for this task.'}</small></div>}
      </div>
      {planning && <p className="fine">Prepare a narrow <code>.codercrew/plans/</code> ignore rule yourself. No branch is created during Plan. Output permissions are cooperative and validated, not native CLI sandbox isolation.</p>}
      <label htmlFor="implementation-instruction">{planning ? 'Shared task brief' : 'Instruction or review context'}</label><textarea id="implementation-instruction" rows={3} value={text} disabled={blocked || busy} maxLength={1900} onChange={(e) => setText(e.target.value)} />
      {!planning && !solo && <p className="fine">For Commit and Relay, text is optional context. The current changes are committed as they stand; unfinished requests can be recorded for the peer.</p>}
      <details className="agreement"><summary>Collaboration settings</summary>
        <label className="readiness"><input type="checkbox" checked={trackLog} disabled={blocked || busy} onChange={(e) => setTrackLog(e.target.checked)} />Also track the journal in the repository</label>
        {trackLog ? <><label>Tracked relay log<input aria-label="Tracked relay log" value={log} disabled={blocked || busy} onChange={(e) => setLog(e.target.value)} /></label>
          <p className="fine">A nonignored JSON-lines file mirroring every journal entry inside its handoff commit, so report-only turns also commit. The agent creates it in its first handoff commit; existing entries must use the same schema.</p></>
          : <p className="fine">The handoff journal stays in CoderCrew’s history: turns, reviewed ranges, findings and reported checks. Report-only turns publish no commit. Export it from Status; promote enduring knowledge into the repository’s documents when finishing the task.</p>}
        {(planning || !solo) && <><label className="readiness"><input type="checkbox" checked={automatic} disabled={blocked || busy} onChange={(e) => setAutomatic(e.target.checked)} />{planning ? 'Automatic collaboration across both phases' : 'Automatic collaboration after the initial review'}</label>
        <label className="readiness turn-limit">{planning ? 'Maximum automatic turns across both phases' : 'Maximum automatic implementation turns'}<input type="number" aria-label={planning ? 'Maximum automatic turns across both phases' : 'Maximum automatic implementation turns'} min={1} max={200} value={limit} disabled={blocked || busy} onChange={(e) => setLimit(Number(e.target.value))} /></label>
        <label className="readiness"><input type="checkbox" checked={pauseOnObjection} disabled={blocked || busy} onChange={(e) => setPauseOnObjection(e.target.checked)} />Pause on a reviewer objection</label>
        <p className="fine">{pauseOnObjection ? 'An objection waits for you; Next turn sends the findings to the author.' : 'An objection is sent straight back to the author as the next automatic turn, within the turn budget. A finding that needs a human decision still pauses.'}</p>
        {planning && <><label className="readiness"><input type="checkbox" checked={requireApproval} disabled={blocked || busy} onChange={(e) => setRequireApproval(e.target.checked)} />Require my approval before implementation</label>
          <p className="fine">{requireApproval ? 'Agreement always waits for your approval.' : automatic ? 'You preauthorize Implementation after agreement, subject to branch consent and all safety checks.' : 'Approval is waived, but Implementation still waits for your explicit continuation.'}</p></>}</>}
      </details>
      <label className="readiness"><input type="checkbox" aria-label={planning ? 'Ready for planning' : 'Ready for implementation'} checked={ready} disabled={planning ? disabled : sendDisabled} onChange={(e) => setConfirmed(e.target.checked ? key : '')} />
        I checked every selected and unselected agent sharing this checkout: all are settled, prompts are empty, and no background writers remain. {planning ? 'I authorize document-only planning and the displayed post-plan settings; any branch choice applies only after Plan finishes.' : 'Send authorizes only this instruction. Commit authorizes one snapshot of all staged, unstaged and nonignored untracked changes as they stand, without completing pending requests or starting a review. Commit current changes & relay also authorizes review from the selected baseline through that snapshot by the named peer. Relay actions authorize the displayed branch choice and scoped handoff commits.'}</label>
      <div className="register-actions">
        <button className="primary" title={`${(planning ? planBlockedReason : blockedReason) ? `${planning ? planBlockedReason : blockedReason} ` : ''}${planning ? 'Start document-only planning.' : 'Send one instruction to the selected worker. No automatic commit, branch change, or relay; committing requires an explicit instruction.'}`} aria-describedby={planBlockedReason ? planReasonId : undefined} disabled={(planning ? disabled : sendDisabled) || !ready || !text.trim()} onClick={() => void start('work', false)}>{planning ? 'Start Plan' : `Send ${targetName}`}</button>
        {!planning && <button title={`${blockedReason || (git?.clean ? 'No uncommitted changes. ' : '')}Commit ${targetName}: snapshot all staged, unstaged and nonignored untracked changes as they stand. No new implementation or automatic relay. One local handoff commit with Git hooks disabled; project checks still run.`} disabled={disabled || !ready || !!git?.clean} onClick={() => void start('commit', false)}>Commit {targetName}</button>}
        {!planning && !solo && <>
          <label className="baseline">Review baseline<select aria-label="Review baseline" value={chosen} disabled={disabled} onChange={(e) => setBaselineChoice(e.target.value)}>
            {!last && <option value="">Reading commits…</option>}
            {candidates.map((candidate, index) => <option key={candidate.sha} value={candidate.sha}>{candidate.sha.slice(0, 6)} · {candidate.subject.slice(0, 60)}{markerOf(index) ? ` — ${markerOf(index)}` : ''}</option>)}
            <option value="other">Another commit…</option>
          </select></label>
          {snapshotRelay ? <button title={`${reviewBlockedReason || (chosen === 'other' && !recent?.data ? 'Enter a baseline commit and preview it first.' : last?.error || (!selectedRange ? 'Reading the commits to review…' : ''))} ${targetName} snapshots all staged, unstaged and nonignored untracked changes as they stand, then the controller relays the selected baseline through the new commit to ${reviewerName} after validating publication and completion. No pending requests are implemented. One local handoff commit with Git hooks disabled; project checks still run.`} disabled={disabled || !ready || !selectedRange} onClick={() => void start('commit', true, selectedRange)}>Commit current changes & relay {reviewerName}</button>
            : <button title={`${reviewBlockedReason || (chosen !== 'other' && (last?.error || (!last?.data ? 'Reading the commits to review…' : ''))) || (chosen === 'other' && !recent?.data ? 'Enter a baseline commit and preview it first.' : '')} Relay ${reviewerName}: review every commit after the chosen baseline through the displayed HEAD. The earliest baseline is everything new to ${reviewerName}; the latest is the last commit only. ${selectedPolicy === 'worker_reviewer' ? 'The reviewer reports without changing project content.' : 'The peer may improve accepted code.'}`} disabled={disabled || !git?.clean || !ready || !selectedRange} onClick={() => void start('review', true, selectedRange)}>Relay {reviewerName}</button>}
        </>}

      </div>
      {planBlockedReason && <p className="fine" role="status" id={planReasonId}>{planBlockedReason}</p>}
      {!planning && !solo && snapshotRelay && <p className="fine">{targetName} commits the current changes; {reviewerName} reviews all changes after the selected baseline through the new snapshot. Choose current HEAD to review only the current changes.</p>}
      {!planning && !solo && last?.error && <p className="fine" role="alert">{last.error}</p>}
      {!planning && !solo && chosen !== 'other' && chosenIndex > 0 && recent?.error && <p className="fine" role="alert">{recent.error}</p>}
      {!planning && !solo && chosen !== 'other' && chosenIndex > 0 && !recent && <p className="fine">Reading the commits after <code>{chosen.slice(0, 6)}</code>…</p>}
      {!planning && !solo && chosen !== 'other' && selectedRange && <p className="fine">Relay {reviewerName}: {selectedRange.commits.length} {selectedRange.commits.length === 1 ? 'commit' : 'commits'}{snapshotRelay ? ' plus current changes' : ''} after <code>{chosen.slice(0, 6)}</code> through {snapshotRelay ? <>the new snapshot (current HEAD <code>{selectedRange.head.slice(0, 6)}</code>)</> : <code>{selectedRange.head.slice(0, 6)}</code>}{markerOf(chosenIndex) ? <> — <strong>{markerOf(chosenIndex)}</strong></> : ''}{chosenIndex === 0 && last?.data?.since === 'task' ? ` (${reviewerName} has published nothing on this branch)` : ''}. Newest: {selectedRange.commits[0]?.subject}.</p>}
      {!planning && !solo && chosen === 'other' && <section className="notice" aria-label="Another baseline">
        <label>Review baseline SHA<input aria-label="Review baseline SHA" value={reviewBase} disabled={blocked || busy} onChange={(e) => setReviewBase(e.target.value)} placeholder="Full commit ID immediately before the changes to review" /></label>
        <p>The baseline itself is excluded. All commits after it through {snapshotRelay ? 'the new snapshot' : 'the displayed HEAD'} are included; author and date are not used to guess the range.</p>
        <button disabled={blocked || busy || previewing !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(reviewBase.trim())} onClick={() => void previewBase(reviewBase.trim())}>{previewing ? 'Reading commits…' : 'Preview commits'}</button>
        {recent?.error && <p role="alert">{recent.error}</p>}
        {recent?.data && <><p>Relay {reviewerName}: {recent.data.commits.length} commits{snapshotRelay ? ' plus current changes' : ''} after <code>{recent.data.base.slice(0, 6)}</code> through {snapshotRelay ? <>the new snapshot (current HEAD <code>{recent.data.head.slice(0, 6)}</code>)</> : <code>{recent.data.head.slice(0, 6)}</code>}. Confirm Ready for implementation after checking this range.</p>
          <ul aria-label="Commits to review">{recent.data.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 6)}</code> {commit.subject}</li>)}</ul></>}
      </section>}
      <p className="fine">{planning ? 'Opening this phase or changing a setting does not send work. Initial peer drafts stay out of assignments until the complete-roster barrier.' : 'A completed chain is not final task acceptance.'}</p>
    </>}
  </section>;
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
