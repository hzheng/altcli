'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommandRecord } from '../contracts/api';
import type { Group, ReviewPreview, WorkspaceGit } from '../contracts/implementation';
import type { ManagedSession, WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { useRemembered } from '../client/memory';
import { paneRequest, sendAction, type AfterSend, type PaneAction } from '../core/pane-actions';
import { isSha, type RunSettings } from './RunSettings';

type Preview = { key: string; data?: ReviewPreview; error?: string };
/** The last gate: everything else is in place, so the card shows what a confirmation would authorize instead of this reason. */
const NOT_READY = 'Confirm Ready for implementation after checking every agent and the displayed range.';
/** Read-only previews of one review range for one recipient. Every range is read by the server; nothing here is estimated or sent. */
function useReviewRange({ token, group, git, logPath, recipient, reviewTaskBase, commitPending, enabled, recheck, memoryKey, onPreview }: {
  token: string; group: Group; git?: WorkspaceGit; logPath?: string; recipient?: string; reviewTaskBase: string; commitPending: boolean; enabled: boolean;
  recheck: number; memoryKey: string; onPreview: () => void;
}) {
  const [baselineChoice, setBaselineChoice] = useRemembered(`${memoryKey}:choice`, ''); // '' = earliest candidate, a SHA, or 'other'
  const [reviewBase, setReviewBase] = useRemembered(`${memoryKey}:typed`, '');
  const [lastPreview, setLastPreview] = useState<Preview>(); const [explicitPreview, setExplicitPreview] = useState<Preview>();
  // Loading belongs to one request at a time: only the newest preview may show or clear it, whether it finishes or is cancelled.
  const previewRequests = useRef(0); const [previewing, setPreviewing] = useState(0);
  const previewKey = JSON.stringify([group.id, git?.head, logPath ?? null, recipient, reviewTaskBase, recheck, commitPending]);
  const last = lastPreview?.key === previewKey ? lastPreview : undefined;
  // Candidate baselines come from the server's first-parent chain, earliest (everything new to the recipient) to latest (the last commit only).
  const candidates = last?.data?.candidates ?? [];
  const chosen = baselineChoice === 'other' ? 'other' : candidates.some((candidate) => candidate.sha === baselineChoice) ? baselineChoice : candidates[0]?.sha ?? (last?.error ? 'other' : '');
  const chosenIndex = candidates.findIndex((candidate) => candidate.sha === chosen);
  // Any baseline other than the earliest is previewed as its own exact range; the typed one only on request.
  const explicitBase = chosen === 'other' ? reviewBase.trim() : chosenIndex > 0 ? chosen : '';
  const recent = explicitPreview?.key === JSON.stringify([previewKey, explicitBase]) ? explicitPreview : undefined;
  const selectedRange: ReviewPreview | undefined = chosenIndex === 0 ? last?.data : recent?.data;
  async function previewBase(base: string, signal?: AbortSignal) {
    if (!enabled || !git || !isSha(base)) return;
    const key = JSON.stringify([previewKey, base]); const request = ++previewRequests.current; setPreviewing(request); onPreview();
    try { const data = await api<ReviewPreview>(token, 'implementation/preview', { body: { groupId: group.id, head: git.head, ...(logPath ? { logPath } : {}), base, commitPending }, signal }); if (!signal?.aborted) setExplicitPreview({ key, data }); }
    catch (error) { if (!signal?.aborted) setExplicitPreview({ key, error: error instanceof Error ? error.message : 'Could not preview this range.' }); }
    finally { setPreviewing((current) => current === request ? 0 : current); }
  }
  useEffect(() => {
    if (!enabled || !git || chosen === 'other' || chosenIndex <= 0 || recent) return;
    const abort = new AbortController(); void previewBase(chosen, abort.signal); return () => abort.abort();
  }, [enabled, chosen, chosenIndex, previewKey, !!recent]); // previewBase reads the same keys as previewKey
  // This effect only reads committed objects. Sending always requires an explicit button click.
  useEffect(() => {
    if (!enabled || !git || !recipient || !isSha(reviewTaskBase)) return;
    const abort = new AbortController();
    void api<ReviewPreview>(token, 'implementation/preview', { body: { groupId: group.id, head: git.head, ...(logPath ? { logPath } : {}), recipient, taskBase: reviewTaskBase, commitPending }, signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setLastPreview({ key: previewKey, data }); })
      .catch((error) => { if (!abort.signal.aborted) setLastPreview({ key: previewKey, error: error instanceof Error ? error.message : 'Could not read the commits to review.' }); });
    return () => abort.abort();
  }, [token, enabled, group.id, git?.head, logPath, recipient, reviewTaskBase, previewKey]);
  // Blocking follows the selected range: a refused derived range explains itself only until a typed baseline previews successfully.
  const hint = selectedRange ? '' : chosen === 'other' ? 'Enter a baseline commit and preview it first.' : last?.error || recent?.error || 'Reading the commits to review…';
  const reset = () => { setBaselineChoice(''); setReviewBase(''); };
  return { last, candidates, chosen, chosenIndex, recent, selectedRange, previewing, previewBase, setBaselineChoice, reviewBase, setReviewBase, hint, reset,
    consent: enabled ? [chosen, recent?.data ?? null, last?.data ?? null] : null };
}
type ReviewRange = ReturnType<typeof useReviewRange>;

/** The Review baseline selector with its exact range line and the typed "Another commit" preview. */
function RangePicker({ range, recipientName, snapshot, disabled, inputDisabled }: { range: ReviewRange; recipientName: string; snapshot: boolean; disabled: boolean; inputDisabled: boolean }) {
  const { last, candidates, chosen, chosenIndex, recent, selectedRange } = range;
  const earliestLabel = last?.data?.since === 'recipient' ? `all since ${recipientName}'s last commit` : 'all since the task baseline';
  const markerOf = (index: number) => [index === 0 ? `earliest: ${earliestLabel}` : '', index === candidates.length - 1 ? snapshot ? 'latest: current changes only' : 'latest: last commit only' : ''].filter(Boolean).join(' · ');
  return <>
    <label className="baseline">Review baseline<select aria-label="Review baseline" value={chosen} disabled={disabled} onChange={(e) => range.setBaselineChoice(e.target.value)}>
      {!last && <option value="">Reading commits…</option>}
      {candidates.map((candidate, index) => <option key={candidate.sha} value={candidate.sha}>{candidate.sha.slice(0, 6)} · {candidate.subject.slice(0, 60)}{markerOf(index) ? ` — ${markerOf(index)}` : ''}</option>)}
      <option value="other">Another commit…</option>
    </select></label>
    {last?.error && !(chosen === 'other' && recent?.data) && <p className="fine" role="alert">{last.error}</p>}
    {chosen !== 'other' && chosenIndex > 0 && recent?.error && <p className="fine" role="alert">{recent.error}</p>}
    {chosen !== 'other' && chosenIndex > 0 && !recent && <p className="fine">Reading the commits after <code>{chosen.slice(0, 6)}</code>…</p>}
    {chosen !== 'other' && selectedRange && <p className="fine">Relay {recipientName}: {selectedRange.commits.length} {selectedRange.commits.length === 1 ? 'commit' : 'commits'}{snapshot ? ' plus current changes' : ''} after <code>{chosen.slice(0, 6)}</code> through {snapshot ? <>the new snapshot (current HEAD <code>{selectedRange.head.slice(0, 6)}</code>)</> : <code>{selectedRange.head.slice(0, 6)}</code>}{markerOf(chosenIndex) ? <> — <strong>{markerOf(chosenIndex)}</strong></> : ''}{chosenIndex === 0 && last?.data?.since === 'task' ? ` (${recipientName} has published nothing on this branch)` : ''}. Newest: {selectedRange.commits[0]?.subject}.</p>}
    {chosen === 'other' && <section className="notice" aria-label="Another baseline">
      <label>Review baseline SHA<input aria-label="Review baseline SHA" value={range.reviewBase} disabled={inputDisabled} onChange={(e) => range.setReviewBase(e.target.value)} placeholder="Full commit ID immediately before the changes to review" /></label>
      <p>The baseline itself is excluded. All commits after it through {snapshot ? 'the new snapshot' : 'the displayed HEAD'} are included; author and date are not used to guess the range.</p>
      <button type="button" disabled={inputDisabled || range.previewing !== 0 || !isSha(range.reviewBase.trim())} onClick={() => void range.previewBase(range.reviewBase.trim())}>{range.previewing ? 'Reading commits…' : 'Preview commits'}</button>
      {recent?.error && <p role="alert">{recent.error}</p>}
      {recent?.data && <><p>Relay {recipientName}: {recent.data.commits.length} commits{snapshot ? ' plus current changes' : ''} after <code>{recent.data.base.slice(0, 6)}</code> through {snapshot ? <>the new snapshot (current HEAD <code>{recent.data.head.slice(0, 6)}</code>)</> : <code>{recent.data.head.slice(0, 6)}</code>}. Confirm Ready for implementation after checking this range.</p>
        <ul aria-label="Commits to review">{recent.data.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 6)}</code> {commit.subject}</li>)}</ul></>}
    </section>}
  </>;
}

export interface PaneActionsProps {
  token: string; state: WorkflowState; group: Group; agent: ManagedSession; git?: WorkspaceGit; workspaceError: string;
  /** Discovery of the workspace's live agents; a change revokes readiness. */
  agentsKey: string;
  settings: RunSettings;
  /** First reason every action in this card is blocked (shared checkout gates, then this agent's own), or empty. */
  blockedReason: string;
  busy: boolean;
  /** Runs one request under the console-wide submission guard. */
  submit: (work: () => Promise<void>) => Promise<void>;
  /** The console's single readiness slot: the exact displayed state it was given for, so at most one card is ready. */
  consent: string; setConsent: (update: (current: string) => string) => void;
  /** The checkout's newest run and its status; a run started or finished anywhere revokes readiness. */
  runMark: string;
  recheck: number; draftKey: string;
  refresh: () => Promise<void>; onRecheck: () => Promise<void>; onMessage: (message: string) => void; onUncertain: (id: string) => void;
}
/** The actions under one agent pane. Every control's first delivery goes to this card's agent; nothing is sent from an effect. */
export function PaneActions(p: PaneActionsProps) {
  const { settings: s, agent, group, git } = p;
  const members = group.members; const pair = members.length === 2;
  const label = (id?: string) => p.state.sessions.find((session) => session.id === id)?.label ?? 'agent';
  const fixedRoles = s.selectedPolicy === 'worker_reviewer';
  const canSend = !fixedRoles || agent.id === s.workerId;
  const canReview = pair && (!fixedRoles || agent.id !== s.workerId);
  const peerId = pair ? members.find((id) => id !== agent.id) : undefined;
  const name = agent.label; const peerName = label(peerId);
  const dirty = git?.clean === false; const clean = git?.clean === true;
  const [text, setText] = useRemembered(`${p.draftKey}:text`, '');
  const [afterChoice, setAfter] = useRemembered<AfterSend>(`${p.draftKey}:after`, 'nothing');
  const after: AfterSend = afterChoice === 'commit_relay' && !pair ? 'nothing' : afterChoice;
  const [note, setNote] = useRemembered(`${p.draftKey}:note`, '');
  const [context, setContext] = useRemembered(`${p.draftKey}:context`, '');
  const [reviewOpen, setReviewOpen] = useRemembered(`${p.draftKey}:reviewOpen`, false);
  // An empty instruction with a commit follow-up hands off the current changes as they stand instead of doing new work.
  const handoffOnly = !text.trim() && after !== 'nothing' && dirty;
  // A refused start is shown in the card that sent it, cleared by the next attempt or Recheck.
  const [startError, setStartError] = useState('');
  useEffect(() => { setStartError(''); }, [p.recheck]);
  const keyRef = useRef('');
  const revoke = () => p.setConsent((current) => current === keyRef.current ? '' : current);
  const snapshot = useReviewRange({ token: p.token, group, git, logPath: s.logPath, recipient: peerId, reviewTaskBase: s.reviewTaskBase, commitPending: true,
    enabled: canSend && pair && dirty && after === 'commit_relay', recheck: p.recheck, memoryKey: `${p.draftKey}:snapshot`, onPreview: revoke });
  const review = useReviewRange({ token: p.token, group, git, logPath: s.logPath, recipient: agent.id, reviewTaskBase: s.reviewTaskBase, commitPending: false,
    enabled: canReview && clean, recheck: p.recheck, memoryKey: `${p.draftKey}:review`, onPreview: revoke });
  const registrations = Object.fromEntries(members.map((id) => [id, p.state.sessions.find((session) => session.id === id)?.registrationId ?? '']));
  const instances = members.map((id) => p.state.instances.find((instance) => instance.agentId === id)?.status);
  const key = JSON.stringify(['pane', agent.id, agent.registrationId, group.id, group.revision, registrations, instances, p.agentsKey, git ?? null, p.workspaceError,
    s.consent, after, handoffOnly, snapshot.consent, review.consent, p.runMark, p.recheck]);
  keyRef.current = key;
  // Once the displayed checkout, settings or range change, returning to old values must not revive consent.
  const consented = useRef(key);
  useEffect(() => { if (consented.current !== key) { const previous = consented.current; consented.current = key; p.setConsent((current) => current === previous ? '' : current); } }, [key]);
  const ready = p.consent === key;
  const common = p.blockedReason || (p.busy ? 'Wait for the current request to finish.' : '') || (p.workspaceError || !git ? 'Recheck the workspace Git state before starting.' : '');
  const branchLabel = s.branchChoice === 'new' ? `new branch ${s.branchName.trim() || '…'}` : s.branchChoice === 'stay' ? git?.branch ?? 'this branch' : 'the chosen branch';
  function reasonFor(action: PaneAction): string {
    if (common) return common;
    const sending = action === 'send' || action === 'send_commit' || action === 'send_commit_relay';
    if (sending && !text.trim()) return action === 'send' ? `Enter an instruction for ${name}.` : `Enter an instruction for ${name}; there are no uncommitted changes to hand off.`;
    if (action !== 'send' && s.branchReason) return s.branchReason;
    if ((action === 'commit' || action === 'commit_relay') && git!.clean) return 'No uncommitted changes. ';
    if (action === 'relay' && !git!.clean) return 'Commit or separate the current changes first.';
    if (action === 'commit_relay') { if (snapshot.hint) return snapshot.hint; }
    if (action === 'relay') { if (review.hint) return review.hint; }
    if (!ready) return NOT_READY;
    return '';
  }
  async function start(action: PaneAction) {
    const range = action === 'commit_relay' ? snapshot.selectedRange : action === 'relay' ? review.selectedRange : undefined;
    if (reasonFor(action) || !git) return;
    if ((action === 'commit_relay' || action === 'relay') && (!range || range.head !== git.head)) return;
    const requestId = crypto.randomUUID();
    const request = paneRequest({ action, requestId, groupId: group.id, groupRevision: group.revision, registrations, agentId: agent.id, policy: s.selectedPolicy, workerId: s.workerId,
      text: action === 'commit' || action === 'commit_relay' ? '' : action === 'relay' ? context : text, reviewNote: note, branch: s.branch(), automatic: s.automatic, turnLimit: s.limit,
      pauseOnObjection: s.pauseOnObjection, logPath: s.logPath, reviewBase: range?.base });
    p.setConsent(() => ''); setStartError('');
    await p.submit(async () => {
      try {
        const record = await api<CommandRecord>(p.token, request.path, { body: request.body });
        if (record.status === 'rejected') setStartError(`REJECTED: ${record.error ?? 'The server refused this start.'}`);
        else {
          p.onMessage(`${record.status.toUpperCase()}: ${record.error ?? `${action === 'send' ? 'Standalone instruction' : 'Implementation'} started. The server owns this run.`}`);
          // Clear only the inputs this action consumed.
          if (action === 'relay') { setContext(''); review.reset(); } else { setText(''); if (action === 'commit_relay') snapshot.reset(); if (action === 'commit_relay' || action === 'send_commit_relay') setNote(''); }
        }
      } catch (error) {
        setStartError(error instanceof Error ? error.message : 'Start failed.');
        if (!(error instanceof HttpError) || error.status >= 500) p.onUncertain(requestId);
      } finally { await Promise.all([p.refresh(), p.onRecheck()]); }
    });
  }
  const ids = useId();
  const sendChoice: PaneAction = handoffOnly ? after === 'commit_relay' ? 'commit_relay' : 'commit' : sendAction(after); const sendReason = reasonFor(sendChoice);
  const sendLabel = handoffOnly ? after === 'commit_relay' ? `Commit current changes & relay ${peerName}` : `Commit current changes ${name}`
    : after === 'commit' ? `Send & commit ${name}` : after === 'commit_relay' ? `Send & commit ${name} → relay ${peerName}` : `Send ${name}`;
  const noChange = `If ${name} changes nothing, it reports without ${s.logPath ? 'a project change (the tracked journal line is still committed)' : 'a commit'} and nothing is relayed.`;
  const sendHelp = handoffOnly ? after === 'commit_relay'
      ? `${name} snapshots all staged, unstaged and nonignored untracked changes as they stand, then the controller relays the selected baseline through the new commit to ${peerName} after validating publication and completion. No pending requests are implemented. One local handoff commit with Git hooks disabled; project checks still run.`
      : `Commit current changes ${name}: snapshot all staged, unstaged and nonignored untracked changes as they stand. No new implementation or automatic relay. One local handoff commit with Git hooks disabled; project checks still run.`
    : after === 'nothing' ? `Send one instruction to ${name}. No automatic commit, branch change, or relay; committing requires an explicit instruction.`
    : `${name} carries out this instruction, then publishes one handoff commit on ${branchLabel}${dirty ? ', including the current uncommitted changes' : ''}${after === 'commit_relay' ? `; the controller then relays that commit to ${peerName} for review after validating publication and completion. ${peerName} reviews only what ${name} commits for this instruction` : ' and stops'}. ${noChange}`;
  const authorization = handoffOnly ? `${name} commits the ${git!.changeCount} uncommitted ${git!.changeCount === 1 ? 'path' : 'paths'} as they stand on ${branchLabel}, without new work${after === 'commit_relay' ? `; ${peerName} then reviews the selected baseline through that snapshot` : ', then stops'}.`
    : after === 'nothing' ? `${name} carries out this instruction only. No commit, branch change or relay.`
    : `${name} carries out this instruction and publishes the result on ${branchLabel}${dirty ? `, including the ${git!.changeCount} uncommitted ${git!.changeCount === 1 ? 'path' : 'paths'} already present` : ''}, then ${after === 'commit_relay' ? `${peerName} reviews only what ${name} commits (after ${git?.head.slice(0, 7)})` : 'stops'}. Changed project content is committed.`;
  const relevant = after === 'nothing' ? [s.selectedPolicy === 'worker_reviewer' ? `worker ${name}` : s.selectedPolicy === 'solo' ? 'solo' : 'peer relay']
    : [branchLabel, s.selectedPolicy === 'worker_reviewer' ? 'worker + reviewer' : s.selectedPolicy === 'solo' ? 'solo' : 'peer relay', `${s.limit} turns`];
  const relayHelp = `Relay ${name}: review every commit after the chosen baseline through the displayed HEAD. The earliest baseline is everything new to ${name}; the latest is the last commit only. ${fixedRoles ? 'The reviewer reports without changing project content.' : 'The peer may improve accepted code.'}`;
  const title = (reason: string, help: string) => `${reason ? `${reason} ` : ''}${help}`;
  const openSettings = () => { s.setOpen(true); document.getElementById('run-settings')?.scrollIntoView({ block: 'nearest' }); };
  const inputOff = !!common;
  return <section className="pane-actions" aria-label={`Actions for ${name}`}>
    <p className="zone-label"><span aria-hidden="true">⌨️</span> Command · {canSend ? `Send to ${name}` : `${name} reviews`}</p>
    {canSend && <>
      <label className="sr-only" htmlFor={`${ids}-text`}>Instruction for {name}</label>
      <textarea id={`${ids}-text`} rows={2} value={text} maxLength={1900} placeholder={dirty && after !== 'nothing' ? `Instruction for ${name} — leave empty to hand off the ${git!.changeCount} uncommitted ${git!.changeCount === 1 ? 'path' : 'paths'} as they stand` : `Instruction for ${name}`} onChange={(e) => setText(e.target.value)} />
      <div className="after-send"><label htmlFor={`${ids}-after`}>After send</label>
        <select id={`${ids}-after`} value={after} disabled={p.busy} onChange={(e) => setAfter(e.target.value as AfterSend)}>
          <option value="nothing">Nothing</option><option value="commit">Commit</option>{pair && <option value="commit_relay">Commit &amp; relay</option>}</select>
        <small>Runs after {name} finishes this instruction, not after delivery.</small></div>
      {after === 'commit_relay' && pair && <>
        <label className="sr-only" htmlFor={`${ids}-note`}>Relay note for {peerName}</label>
        <textarea id={`${ids}-note`} rows={2} value={note} disabled={inputOff} maxLength={1900} placeholder={`Relay note for ${peerName} (optional): what to look at when reviewing`} onChange={(e) => setNote(e.target.value)} />
      </>}
      {handoffOnly && after === 'commit_relay' && <><RangePicker range={snapshot} recipientName={peerName} snapshot disabled={inputOff} inputDisabled={inputOff} />
        <p className="fine">{peerName} reviews all changes after the selected baseline through the new snapshot. Choose current HEAD to review only the current changes.</p></>}
    </>}
    {!canSend && <p className="fine">Reviewer: reviews without editing project files. Change roles in settings.</p>}
    <div className="ready-row">
      <label className="readiness"><input type="checkbox" aria-label="Ready for implementation" checked={ready} disabled={inputOff} onChange={(e) => p.setConsent(() => e.target.checked ? key : '')} />
        <span>All agents in this checkout are settled: empty prompts, no background writers. {canSend && <span className="muted">({relevant.join(' · ')})</span>}</span></label>
      {canSend && <button type="button" className="primary" title={title(sendReason, sendHelp)} aria-describedby={`${ids}-line`} disabled={!!sendReason} onClick={() => void start(sendChoice)}>{sendLabel}</button>}
    </div>
    {canSend && <p className="fine pane-line" id={`${ids}-line`}>{sendReason && sendReason !== NOT_READY ? sendReason : authorization}
      {/* A settings gap is fixed in the shared settings, so the reason opens them. */}
      {sendReason && sendReason === s.branchReason && <button type="button" className="quiet inline-link" onClick={openSettings}>Settings</button>}</p>}
    {startError && <p className="notice error" role="alert">{startError}</p>}
    {canReview && clean && <details className="pane-disclosure" open={reviewOpen} onToggle={(e) => setReviewOpen(e.currentTarget.open)}>
      <summary>Committed review</summary>
      <p className="fine">{name} reviews every commit after the selected baseline through {git!.head.slice(0, 7)} on {git!.branch ?? 'detached HEAD'}; the range is not filtered by author.</p>
      <label htmlFor={`${ids}-context`}>Review context for {name} (optional)</label>
      <textarea id={`${ids}-context`} rows={2} value={context} disabled={inputOff} maxLength={1900} onChange={(e) => setContext(e.target.value)} />
      <div className="pane-buttons"><button type="button" title={title(reasonFor('relay'), relayHelp)} disabled={!!reasonFor('relay')} onClick={() => void start('relay')}>Relay {name}</button></div>
      <RangePicker range={review} recipientName={name} snapshot={false} disabled={inputOff} inputDisabled={inputOff} />
    </details>}
    <details className="pane-disclosure authorizes"><summary>What each action authorizes</summary>
      <p className="fine">Readiness means every selected and unselected agent sharing this checkout is settled: prompts are empty and no background writers remain. Send authorizes only its instruction; with a Commit follow-up it also authorizes one handoff commit on the displayed branch choice, and with Commit &amp; relay one review of that commit by the named peer, who also receives the relay note. With the instruction empty, Commit current changes authorizes one snapshot of all staged, unstaged and nonignored untracked changes as they stand, without completing pending requests; with a relay it also authorizes review from the selected baseline through that snapshot. Relay authorizes review of the displayed range and scoped handoff commits. A completed chain is not final task acceptance.</p>
    </details>
  </section>;
}
