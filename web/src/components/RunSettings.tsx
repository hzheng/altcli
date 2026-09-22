'use client';
import type { BranchConsent, CollaborationPolicy, WorkspaceGit } from '../contracts/implementation';
import type { ManagedSession } from '../contracts/workflow';
import { useRemembered, type PageMemory } from '../client/memory';

export type Phase = 'plan' | 'implementation';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isSha = (value: string) => SHA.test(value);

/** Settings for the next run of one workspace group and phase, remembered in page memory. Every committed card action and Start Plan
 * reads them; plain Send uses only the policy and fixed worker. */
export function useRunSettings(memory: PageMemory, prefix: string, git: WorkspaceGit | undefined, members: string[], phase: Phase) {
  const at = (field: string) => `${prefix}:${phase}:${field}`;
  const [policy, setPolicy] = useRemembered<CollaborationPolicy>(at('policy'), 'peer', memory);
  const [worker, setWorker] = useRemembered(at('worker'), '', memory);
  const [actor, setActor] = useRemembered(at('actor'), '', memory);
  const [choice, setChoice] = useRemembered<string | null>(at('branch'), null, memory);
  const [branchName, setBranchName] = useRemembered(at('newBranch'), '', memory);
  const [baseline, setBaseline] = useRemembered<string | null>(at('taskBase'), null, memory);
  const [trackLog, setTrackLog] = useRemembered(at('trackLog'), false, memory);
  const [log, setLog] = useRemembered(at('log'), 'RELAY-LOG.jsonl', memory);
  const [automatic, setAutomatic] = useRemembered(at('automatic'), true, memory);
  const [limit, setLimit] = useRemembered(at('limit'), 20, memory);
  const [pauseOnObjection, setPauseOnObjection] = useRemembered(at('pauseOnObjection'), false, memory);
  const [requireApproval, setRequireApproval] = useRemembered(at('requireApproval'), true, memory);
  const [open, setOpen] = useRemembered(at('open'), false, memory);
  const [advanced, setAdvanced] = useRemembered(at('advanced'), false, memory);
  const planning = phase === 'plan';
  const solo = members.length === 1;
  const selectedPolicy: CollaborationPolicy = solo ? 'solo' : policy;
  const workerId = members.includes(worker) ? worker : members[0];
  // The journal lives in CoderCrew; mirroring it into a tracked file is an explicit project preference, off by default.
  const logPath = trackLog && log.trim() ? log.trim() : undefined;
  // An integration branch is a starting point only: the picker never offers to continue on it, and the server refuses it too.
  const branchChoice = choice ?? (git?.branch && !git.integration ? 'stay' : '');
  // Staying on an existing task branch keeps its permanent baseline; when it cannot be inferred, the user confirms it.
  const needsBaseline = branchChoice === 'stay' && !!git && !git.integration && git.taskBase !== git.head;
  const taskBase = baseline ?? git?.taskBase ?? '';
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= 200;
  // A new branch begins at the displayed head; an existing task branch reviews back to its confirmed baseline.
  const reviewTaskBase = branchChoice === 'new' ? git?.head ?? '' : taskBase.trim();
  /** Why a committed action (or Start Plan) cannot use these settings; empty when they are complete. */
  const branchReason = !git ? 'Recheck the workspace Git state.'
    : !planning && !branchChoice ? 'Choose the implementation branch in settings.'
    : branchChoice === 'stay' && (!git.branch || git.integration) ? 'Choose a task branch in settings.'
    : branchChoice === 'new' && !branchName.trim() ? 'Enter the new branch name in settings.'
    : needsBaseline && !isSha(taskBase.trim()) ? 'Enter the full task baseline commit in settings.'
    : !limitValid ? 'Set the maximum automatic turns to a whole number from 1 to 200.' : '';
  const branch = (): BranchConsent => ({ branch: git!.branch, head: git!.head, ...(branchChoice === 'new' ? { newBranch: branchName.trim() } : needsBaseline ? { taskBase: taskBase.trim() } : {}) });
  /** Every displayed value a confirmation depends on; a change revokes readiness. */
  const consent = [phase, selectedPolicy, workerId, planning ? actor : null, branchChoice, branchName, taskBase, automatic, requireApproval, limit, pauseOnObjection, logPath ?? null];
  return { phase, planning, policy, setPolicy, worker, setWorker, actor, setActor, choice, setChoice, branchName, setBranchName, baseline, setBaseline,
    trackLog, setTrackLog, log, setLog, automatic, setAutomatic, limit, setLimit, pauseOnObjection, setPauseOnObjection, requireApproval, setRequireApproval,
    open, setOpen, advanced, setAdvanced, solo, selectedPolicy, workerId, logPath, branchChoice, needsBaseline, taskBase, limitValid, reviewTaskBase, branchReason, branch, consent };
}
export type RunSettings = ReturnType<typeof useRunSettings>;

const policyName = (policy: CollaborationPolicy) => policy === 'solo' ? 'Solo work' : policy === 'peer' ? 'Peer relay' : 'Worker + reviewer';

/** The compact summary of the next run's settings, with the phase switch and a collapsed editor. */
export function RunSettingsBar({ settings, git, members, sessions, displayed, disabled, notice, onPhase }: {
  settings: RunSettings; git?: WorkspaceGit; members: string[]; sessions: ManagedSession[];
  /** The displayed pane's agent, the default first implementer. */
  displayed?: string;
  disabled: boolean;
  /** Replaces the summary and editor when the group cannot run (none selected, or more members than execution supports). */
  notice?: string;
  onPhase: (phase: Phase) => void;
}) {
  const s = settings; const planning = s.planning;
  const label = (id?: string) => sessions.find((session) => session.id === id)?.label ?? id ?? 'agent';
  const branchSummary = s.branchChoice === 'stay' ? `Continue on ${git?.branch}` : s.branchChoice === 'new' ? `New branch ${s.branchName.trim() || '…'}` : planning ? 'Branch at the plan checkpoint' : 'No branch chosen';
  const summary = [
    `${planning ? 'After planning: ' : ''}${policyName(s.selectedPolicy)}${s.selectedPolicy === 'worker_reviewer' ? ` (worker ${label(s.workerId)})` : ''}`,
    branchSummary,
    ...(s.solo && !planning ? [] : [s.automatic ? planning ? 'Automatic across both phases' : 'Automatic after the initial review' : 'Manual Next turn']),
    `${s.limit} turns`,
    ...(s.solo ? [] : [s.pauseOnObjection ? 'Objections pause' : 'Objections → author']),
    ...(planning ? [s.requireApproval ? 'Approval required' : 'Approval waived'] : []),
    ...(s.logPath ? [`Tracked log ${s.logPath}`] : []),
  ];
  const warning = planning ? (s.branchReason && s.branchChoice ? s.branchReason : '') : s.branchReason;
  const off = disabled;
  return <section className="run-settings" id="run-settings" aria-label={planning ? 'Plan settings' : 'Implementation settings'}>
    <div className="run-summary">
      <span className="muted">Next run</span>
      <div className="segmented" role="group" aria-label="Start phase">
        <button type="button" className={planning ? 'selected' : 'quiet'} aria-pressed={planning} onClick={() => onPhase('plan')}>1 · Plan</button>
        <button type="button" className={!planning ? 'selected' : 'quiet'} aria-pressed={!planning} onClick={() => onPhase('implementation')}>2 · Implementation</button></div>
      {notice ? <span className="summary-text">{notice}</span> : <span className="summary-text">{summary.join(' · ')}</span>}
      {!notice && warning && <span className="badge warning">{warning}</span>}
      {!notice && <details className="settings-editor" open={s.open} onToggle={(e) => s.setOpen(e.currentTarget.open)}><summary>Edit settings</summary>
        {git?.integration && <p className="fine">{git.branch} is an integration branch: a starting point, not an implementation branch.</p>}
        <div className="register-grid">
          {planning && <p className="muted field-wide">Workspace group: {members.map(label).join(' ⇄ ')}. Every planner is required; the same group continues into Implementation.</p>}
          <div className="field"><label htmlFor={`${s.phase}-collaboration`}>{planning ? 'After planning: collaboration' : 'Collaboration'}</label><select id={`${s.phase}-collaboration`} disabled={off || s.solo} value={s.selectedPolicy} onChange={(e) => s.setPolicy(e.target.value as CollaborationPolicy)}>
            {s.solo ? <option value="solo">Solo work</option> : <><option value="peer">Peer relay</option><option value="worker_reviewer">Worker + reviewer</option></>}</select></div>
          {s.selectedPolicy === 'worker_reviewer' && <div className="field"><label htmlFor={`${s.phase}-worker`}>Worker</label><select id={`${s.phase}-worker`} value={s.workerId} disabled={off} onChange={(e) => s.setWorker(e.target.value)}>
            {members.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select><small>The other member reviews without editing project files.</small></div>}
          {planning && s.selectedPolicy === 'peer' && <div className="field"><label htmlFor="first-implementer">First implementer</label><select id="first-implementer" value={members.includes(s.actor) ? s.actor : members.includes(displayed ?? '') ? displayed : members[0]} disabled={off} onChange={(e) => s.setActor(e.target.value)}>{members.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></div>}
          <div className="field"><label htmlFor={`${s.phase}-branch-choice`}>Implementation branch</label><select id={`${s.phase}-branch-choice`} value={s.branchChoice} disabled={off} onChange={(e) => s.setChoice(e.target.value)}>
            <option value="">{planning ? 'Decide at the plan checkpoint' : 'Choose…'}</option>{git?.branch && !git.integration && <option value="stay">Continue on {git.branch}</option>}<option value="new">Create and check out a new branch</option></select>
            {git?.integration && <small>{git.branch} stays clean: task work and review commits go to a task branch, created here or as a task worktree in Projects. Integrate the accepted result afterwards with a separate squash merge or pull request.</small>}</div>
          {s.branchChoice === 'new' && <div className="field"><label htmlFor={`${s.phase}-new-branch`}>New branch name</label><input id={`${s.phase}-new-branch`} value={s.branchName} disabled={off} placeholder="task/my-change" onChange={(e) => s.setBranchName(e.target.value)} /></div>}
          {s.needsBaseline && <div className="field"><label htmlFor={`${s.phase}-task-baseline`}>Task baseline commit</label><input id={`${s.phase}-task-baseline`} value={s.taskBase} disabled={off} placeholder="Full commit ID where this task began" onChange={(e) => s.setBaseline(e.target.value)} />
            <small>{git?.taskBase ? 'Inferred from the nearest integration branch; confirm or correct it. It is recorded permanently for this task.' : 'Where this task began cannot be inferred unambiguously from the integration branches (diverged tips or criss-cross history). Enter the commit; it is recorded permanently for this task.'}</small></div>}
        </div>
        <details className="agreement" open={s.advanced} onToggle={(e) => s.setAdvanced(e.currentTarget.open)}><summary>Collaboration settings</summary>
          <label className="readiness"><input type="checkbox" checked={s.trackLog} disabled={off} onChange={(e) => s.setTrackLog(e.target.checked)} />Also track the journal in the repository</label>
          {s.trackLog ? <><label>Tracked relay log<input aria-label="Tracked relay log" value={s.log} disabled={off} onChange={(e) => s.setLog(e.target.value)} /></label>
            <p className="fine">A nonignored JSON-lines file mirroring every journal entry inside its handoff commit, so report-only turns also commit. The agent creates it in its first handoff commit; existing entries must use the same schema.</p></>
            : <p className="fine">The handoff journal stays in CoderCrew’s history: turns, reviewed ranges, findings and reported checks. Report-only turns publish no commit. Export it from Command history; promote enduring knowledge into the repository’s documents when finishing the task.</p>}
          {(planning || !s.solo) && <><label className="readiness"><input type="checkbox" checked={s.automatic} disabled={off} onChange={(e) => s.setAutomatic(e.target.checked)} />{planning ? 'Automatic collaboration across both phases' : 'Automatic collaboration after the initial review'}</label>
          <label className="readiness turn-limit">{planning ? 'Maximum automatic turns across both phases' : 'Maximum automatic implementation turns'}<input type="number" aria-label={planning ? 'Maximum automatic turns across both phases' : 'Maximum automatic implementation turns'} min={1} max={200} value={s.limit} disabled={off} onChange={(e) => s.setLimit(Number(e.target.value))} /></label>
          <label className="readiness"><input type="checkbox" checked={s.pauseOnObjection} disabled={off} onChange={(e) => s.setPauseOnObjection(e.target.checked)} />Pause on a reviewer objection</label>
          <p className="fine">{s.pauseOnObjection ? 'An objection waits for you; Next turn sends the findings to the author.' : 'An objection is sent straight back to the author as the next automatic turn, within the turn budget. A finding that needs a human decision still pauses.'}</p>
          {planning && <><label className="readiness"><input type="checkbox" checked={s.requireApproval} disabled={off} onChange={(e) => s.setRequireApproval(e.target.checked)} />Require my approval before implementation</label>
            <p className="fine">{s.requireApproval ? 'Agreement always waits for your approval.' : s.automatic ? 'You preauthorize Implementation after agreement, subject to branch consent and all safety checks.' : 'Approval is waived, but Implementation still waits for your explicit continuation.'}</p></>}</>}
        </details>
      </details>}
    </div>
  </section>;
}
