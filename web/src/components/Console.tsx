'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandRecord, SessionRegistration } from '../contracts/api';
import type { ActivityReset, RelayRun, Workspace, WorkspaceDiscovery, WorkspaceResetResult, WorkflowState } from '../contracts/workflow';
import type { ProjectWorktree } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { nameOf, workspaceKey, Workspaces } from './Workspaces';
import { Implementation, RunPolicy } from './Implementation';
import { PlanningProgress } from './PlanningProgress';
const PREFERENCE = 'codercrew.autoRelay';
const LAYOUT = 'codercrew.paneLayout';
const TURN_LIMIT = 'codercrew.turnLimit';
const WORKSPACE = 'codercrew.workspace';
const DEFAULT_TURN_LIMIT = 20;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString();
type Tab = 'console' | 'workspaces';
/** The selected workspace card and the checkout it belongs to; the console shows the agents registered on that checkout. */
interface WorkspaceChoice { key: string; root: string }
interface AgentStatus { badge: 'ready' | 'working' | 'sending' | 'waiting' | 'attention' | 'unknown' | 'idle' | 'interrupted'; detail: string; when: string | null }
/** Native activity stays visible; an inactive peer may wait on another participant's current relay turn. */
function statusOf(agent: SessionRegistration, run: RelayRun | undefined, state: WorkflowState): AgentStatus {
  const controller = controllerStatusOf(agent, run, state);
  const activity = state.activities?.find((a) => a.agentId === agent.id);
  if (activity && activity.state !== 'unknown') {
    const waitingOnPeer = run?.status === 'running' && state.executions.some((execution) =>
      execution.runId === run.id && execution.commandId === run.currentCommandId && execution.agentId !== agent.id &&
      ['planned', 'dispatching', 'delivered'].includes(execution.status));
    if (controller.badge === 'waiting' && waitingOnPeer && (activity.state === 'idle' || activity.state === 'ready')) {
      return { ...controller, detail: `${controller.detail} ${activity.detail}` };
    }
    const ownership = run?.participants.some((p) => p.id === agent.id) && ['running', 'paused', 'waiting'].includes(run.status)
      ? `Controller run ${run.status}. ${run.status === 'paused' ? 'Pause does not interrupt the worker.' : ''}` : 'No controller-owned turn.';
    return { badge: activity.state, detail: `${activity.detail} ${ownership}`, when: activity.updatedAt };
  }
  return controller;
}
function controllerStatusOf(agent: SessionRegistration, run: RelayRun | undefined, state: WorkflowState): AgentStatus {
  if (state.instances.find((i) => i.agentId === agent.id)?.status === 'replaced') {
    return { badge: 'attention', detail: 'The CLI process changed. Inspect and reconcile any owned run. Once ownership is released, a supported CLI in the same pane and directory is rediscovered automatically. See recovery below if its identity still cannot be refreshed.', when: null };
  }
  const active = run && ['running','waiting','paused'].includes(run.status) && run.participants.some((p) => p.id === agent.id);
  if (active && run.status === 'waiting') return { badge: 'waiting', detail: run.planning && !run.implementation ? run.reason : 'Publication validated. Waiting for a deliberate Next turn.', when: run.updatedAt };
  const execution = state.executions.find((e) => e.agentId === agent.id);
  const command = state.commands.find((c) => c.id === execution?.commandId);
  if (active && execution) {
    const task = execution.input.kind === 'relay' ? 'a review of the partner\'s work' : `"${execution.input.text}"`;
    if (execution.status === 'interrupted') return { badge: 'interrupted', detail: run.reason, when: run.updatedAt };
    if (run.status === 'paused') return { badge: 'attention', detail: `Controller paused; the worker was not interrupted. Assigned task: ${task}. ${run.reason}`, when: run.updatedAt };
    if (execution.status === 'delivered') return { badge: 'waiting', detail: `Delivered ${task}; waiting for CLI lifecycle evidence of activity.`, when: command?.createdAt ?? null };
    if (execution.status === 'uncertain') return { badge: 'attention', detail: 'Delivery uncertain; inspect the terminal before doing anything else.', when: run.updatedAt };
    return { badge: 'sending', detail: `Being sent ${task}`, when: null };
  }
  if (active) {
    const current = state.executions.find((e) => e.commandId === run.currentCommandId);
    const busy = run.participants.find((p) => p.id === current?.agentId);
    if (run.planning && !run.implementation) return { badge: 'waiting', detail: `Plan: ${busy?.label ?? 'another planner'} has the only active document grant.`, when: run.updatedAt };
    // A plain Send never routes to the partner; that says nothing about its activity outside this run.
    if (current?.input.kind === 'instruction' && current.input.handoff !== true) return { badge: 'unknown', detail: `Not part of this turn; ${busy?.label ?? 'the partner'} is on a plain Send. No current lifecycle evidence for this agent.`, when: null };
    return { badge: 'waiting', detail: `Waiting for ${busy?.label ?? 'the partner'} to finish`, when: null };
  }
  if (run?.status === 'stopped' && run.participants.some((p) => p.id === agent.id)) return { badge: 'unknown', detail: 'Controller ownership was released. This agent may still be working; reconciliation does not stop it. Inspect its terminal for current activity.', when: run.updatedAt };
  const report = run?.implementation?.latestPublication;
  if (report?.entry.agentId === agent.id && run!.updatedAt >= agent.registeredAt) return { badge: 'unknown', detail: `Last ${report.entry.decision ?? 'proposal'}: ${report.entry.summary}. Current agent activity is unknown.`, when: run!.updatedAt };
  // A turn recorded before this registration belongs to an earlier CLI instance and says nothing about this one.
  const last = state.turns.find((t) => t.agentId === agent.id && t.receivedAt >= agent.registeredAt);
  if (!last) return { badge: 'unknown', detail: 'No current lifecycle evidence. Agent activity is unknown; inspect the terminal before sending.', when: null };
  const result = last.outcome ? `${last.outcome}${last.reason ? ` — ${last.reason}` : ''}` : 'finished; no RELAY-OUTCOME line';
  return { badge: 'unknown', detail: `Last recorded turn: ${result}. Current agent activity is unknown.`, when: last.receivedAt };
}
const Icon = ({ badge }: { badge: AgentStatus['badge'] }) => <span className={`state-icon ${badge}`} title={badge} aria-hidden="true" />;
/** Follows new output while the reader is at the bottom; a reader who scrolled up keeps their place. */
function Output({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null); const stick = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text]);
  return <pre ref={ref} tabIndex={0} aria-label={label} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }}>{text}</pre>;
}
/** A view and command client. There is intentionally no effect that sends another turn. */
export function Console() {
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [state, setState] = useState<WorkflowState | null>(null);
  const [discovery, setDiscovery] = useState<WorkspaceDiscovery | null>(null); const [discoveryError, setDiscoveryError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null); const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState(''); const [ready, setReady] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [updated, setUpdated] = useState(0);
  const [clock, setClock] = useState(Date.now()); const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [statusReset, setStatusReset] = useState<Omit<ActivityReset, 'confirmReady'> | null>(null);
  const [layout, setLayout] = useState<'parallel' | 'focus'>('parallel'); const [focusOverride, setFocusOverride] = useState<string | null>(null);
  const [turnLimit, setTurnLimit] = useState(String(DEFAULT_TURN_LIMIT));
  const [legacy, setLegacy] = useState(false);
  const [phase, setPhase] = useState<'plan' | 'implementation'>('implementation');
  // History follows the selected pair by default; "All" or a specific pair is an explicit choice that then sticks.
  const [historyPair, setHistoryPair] = useState<'all' | 'selected' | string>('selected'); const [historyOrder, setHistoryOrder] = useState<'desc' | 'asc'>('desc');
  const submission = useRef(false); const generation = useRef(0); const readNumber = useRef(0); const discoveryRead = useRef(0);
  useEffect(() => { try { if (localStorage.getItem(PREFERENCE) === 'false') setAutoContinue(false); if (localStorage.getItem(LAYOUT) === 'focus') setLayout('focus');
    const limit = localStorage.getItem(TURN_LIMIT); if (limit && /^\d+$/.test(limit)) setTurnLimit(limit);
    // Remembered selections initialize the view only; the server validates every group at start.
    const saved = JSON.parse(localStorage.getItem(WORKSPACE) ?? 'null') as Partial<WorkspaceChoice> | null;
    if (typeof saved?.key === 'string' && typeof saved.root === 'string') setWorkspace({ key: saved.key, root: saved.root }); } catch { /* preference only */ } }, []);
  const limitValue = /^\d+$/.test(turnLimit) ? Number(turnLimit) : NaN; const limitValid = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 200;
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const read = ++readNumber.current; const version = generation.current;
    try { const next = await api<WorkflowState>(token, 'state', { signal });
      if (version === generation.current && read === readNumber.current) { setState(next); setUpdated(Date.now()); setError(''); }
    } catch (caught) { if (!signal?.aborted && version === generation.current && read === readNumber.current) setError(caught instanceof Error ? caught.message : 'Connection failed.'); }
  }, [token]);
  const recheck = useCallback(async (signal?: AbortSignal) => {
    const read = ++discoveryRead.current; const version = generation.current;
    try { const next = await api<WorkspaceDiscovery>(token, 'workspaces', { signal });
      if (version === generation.current && read === discoveryRead.current) { setDiscovery(next); setDiscoveryError(''); }
    } catch (caught) { if (!signal?.aborted && version === generation.current && read === discoveryRead.current) setDiscoveryError(caught instanceof Error ? caught.message : 'Discovery failed.'); }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(abort.signal); if (!abort.signal.aborted) timer = setTimeout(poll, 2000); };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [token, refresh]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await recheck(abort.signal); if (!abort.signal.aborted) timer = setTimeout(poll, 5000); };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [token, recheck]);
  // First view: the console when agents are already named, otherwise setup. Later switches are the user's.
  useEffect(() => { if (state && tab === null) setTab(state.sessions.length ? 'console' : 'workspaces'); }, [state, tab]);
  const sessions = state?.sessions ?? [];
  const project = workspace?.root ?? sessions[0]?.repository;
  const projectSessions = sessions.filter((s) => s.repository === project);
  const card = discovery?.workspaces.find((w) => workspace ? workspaceKey(w) === workspace.key : w.worktree.root === project);
  const selectedProject = discovery?.projects?.find((p) => p.worktrees.some((w) => w.path === project));
  const selectedTree = selectedProject?.worktrees.find((w) => w.path === project);
  const setupHolds = discovery?.projects?.flatMap((p) => p.creations.filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => op.input.path)) ?? [];
  const setupHeld = !!project && setupHolds.includes(project);
  const groups = state?.groups ?? [];
  const pairs = groups.map((g) => ({ ...g, sessions: g.members }));
  const historicalPairIds = [...new Set((state?.commands ?? []).flatMap((command) => command.groupId ? [command.groupId] : []))]
    .filter((id) => !pairs.some((candidate) => candidate.id === id));
  const pair = pairs.find((p) => p.repository === project && p.cwd === card?.cwd && p.members.length > 0);
  const showLegacy = legacy && state?.legacyEnabled && pair?.sessions.length === 2;
  // The internal sentinel follows the active pair while the control shows that pair's single, starred option.
  const historyFilter = historyPair === 'selected' ? pair ? `pair:${pair.id}` : 'all' : historyPair;
  const visible = pair ? projectSessions.filter((s) => pair.sessions.includes(s.id)) : projectSessions;
  const current = visible.find((s) => s.id === selected) ?? visible[0];
  const groupInstances = visible.map((s) => [s.id, state?.instances.find((i) => i.agentId === s.id)?.status]);
  const readinessKey = JSON.stringify([pair, card?.agents, current?.id, current?.registrationId, groupInstances]);
  useEffect(() => { setReady(false); setResetFor(null); setStatusReset(null); }, [readinessKey, project]);
  const owned = (state?.runs ?? []).filter((r) => r.repository === project && ['running','waiting','paused'].includes(r.status));
  const transportHold = state?.reservations.find((r) => r.repository === project);
  // A finished run is current status only while its frozen participants are the agents shown here; a run of removed or
  // renamed-away agents is history and stays reachable under Command history.
  const latestRun = owned[0] ?? state?.runs.find((r) => r.repository === project && r.participants.every((p) => projectSessions.some((s) => s.id === p.id)));
  const statuses = new Map(state ? projectSessions.map((s) => [s.id, statusOf(s, latestRun, state)] as const) : []);
  const working = projectSessions.find((s) => ['working', 'sending'].includes(statuses.get(s.id)?.badge ?? ''))?.id ?? null;
  const lastActive = [...projectSessions].sort((a, b) => (statuses.get(b.id)?.when ?? '').localeCompare(statuses.get(a.id)?.when ?? ''))[0]?.id ?? null;
  // A new working agent takes the focus back from a manual tab choice.
  useEffect(() => { if (working) setFocusOverride(null); }, [working]);
  const preferredFocus = focusOverride ?? working ?? lastActive ?? current?.id;
  const focused = visible.some((s) => s.id === preferredFocus) ? preferredFocus : visible[0]?.id;
  const shown = layout === 'focus' ? visible.filter((s) => s.id === focused) : visible;
  const chooseLayout = (next: 'parallel' | 'focus') => { setLayout(next); try { localStorage.setItem(LAYOUT, next); } catch { /* preference only */ } };
  const stale = !!error || clock - updated > 10000;
  // Every selected collaborator is validated by the server, including a peer that is not the command target.
  const resetAgents = visible.filter((s) => !s.registrationId || state?.instances.find((i) => i.agentId === s.id)?.status === 'replaced');
  const unknownAgents = state?.mode === 'tmux' ? visible.filter((s) => !resetAgents.includes(s) && state.instances.find((i) => i.agentId === s.id)?.status !== 'current') : [];
  const identityBlockedReason = resetAgents.length ? `Reset workspace required for ${resetAgents.map((s) => s.label).join(', ')}. Inspect the panes and use Reset workspace above before sending.`
    : unknownAgents.length ? `The host cannot confirm the CLI process for ${unknownAgents.map((s) => s.label).join(', ')}. Recheck before sending.` : '';
  const available = state?.snapshots.find((s) => s.agentId === current?.id)?.status === 'available';
  const blocked = busy || stale || setupHeld || !state?.inputEnabled || !current?.registrationId || !!identityBlockedReason || !available || owned.length > 0 || !!transportHold || !!unknownRequest || (!!pair && !limitValid);
  const resetKey = JSON.stringify([project, readinessKey]);
  const resetBlocked = busy || stale || setupHeld || owned.length > 0 || !!transportHold || !!unknownRequest || !project || !!discoveryError || !!discovery?.error;
  const select = (id: string) => { setSelected(id); setReady(false); setText(''); setMessage(''); };
  function chooseWorkspace(chosen: Workspace) {
    const choice = { key: workspaceKey(chosen), root: chosen.worktree.root };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setSelected(null); setFocusOverride(null); setReady(false);
    setTab('console');
  }
  function chooseWorktree(chosen: ProjectWorktree) {
    const choice = { key: `worktree:${chosen.id}`, root: chosen.path };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setSelected(null); setFocusOverride(null); setReady(false); setTab('console');
  }
  function lock() {
    generation.current++; readNumber.current++; discoveryRead.current++; setToken(''); setDraftToken(''); setState(null); setDiscovery(null); setTab(null); setReady(false);
    setSelected(null); setMessage(''); setError(''); setDiscoveryError(''); setUnknownRequest(null); setResetFor(null);
  }
  async function resetWorkspace() {
    if (resetBlocked || resetFor !== resetKey || submission.current || !project) return;
    submission.current = true; setBusy(true); setReady(false);
    try {
      const result = await api<WorkspaceResetResult>(token, 'workspaces/reset', { body: { repository: project, confirmReady: true } });
      setResetFor(null);
      setMessage(`Reset ${nameOf(project)}: cleared ${result.sessions.length} saved name(s) and ${result.groups.length} group setting(s). Live agents are rediscovered; history is kept.`);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Workspace reset failed.'); }
    finally { await Promise.all([refresh(), recheck()]); submission.current = false; setBusy(false); }
  }
  async function send(kind: 'relay' | 'instruction', handoff = false) {
    if (blocked || !ready || !current || submission.current) return;
    submission.current = true; setBusy(true); setReady(false);
    const requestId = crypto.randomUUID();
    try {
      const record = await api<CommandRecord>(token, 'commands', { body: { requestId, agentId: current.id, kind,
        ...(text.trim() ? { text: text.trim() } : {}), handoff,
        ...(pair ? { pairId: pair.id, turnLimit: limitValue } : {}), autoContinue: !!pair && autoContinue && (kind === 'relay' || handoff), confirmReady: true } });
      setMessage(`${record.status.toUpperCase()}: ${record.error ?? 'Terminal delivery recorded. The server owns this run until completion or human takeover.'}`);
      if (record.status !== 'rejected') setText('');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Command failed.');
      if (!(caught instanceof HttpError) || caught.status >= 500) setUnknownRequest(requestId);
    } finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function action(run: RelayRun, operation: 'pause' | 'takeover' | 'continue') {
    if (submission.current) return;
    submission.current = true; setBusy(true);
    try {
      await api(token, 'runs', { body: { runId: run.id, action: operation, ...(operation !== 'pause' ? { confirmReady: true } : {}), ...(operation === 'continue' ? { expectedCommandId: run.currentCommandId } : {}) } });
      setMessage(operation === 'continue' ? 'Next turn requested.' : operation === 'pause' ? 'Run paused. The current agent was not interrupted.' : 'Human takeover recorded. Nothing was replayed or marked successful.');
      if (operation === 'pause') setTakeover(run.id); else { setTakeover(null); setReady(false); }
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Action failed.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function releaseLegacy() {
    if (!transportHold || submission.current) return;
    submission.current = true; setBusy(true);
    try { await api(token, 'control/release', { body: { expectedCommandId: transportHold.activeCommandId, confirmReady: true } });
      setMessage('Legacy delivery acknowledged. Nothing was replayed or marked successful.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Could not acknowledge delivery.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function resetActivity() {
    if (!statusReset || submission.current) return;
    submission.current = true; setBusy(true);
    try {
      await api(token, 'activities/reset', { body: { ...statusReset, confirmReady: true } });
      setMessage('Status reset to Ready based on your terminal inspection. Workspace configuration is preserved.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Status recovery failed.'); }
    finally { setStatusReset(null); await refresh(); submission.current = false; setBusy(false); }
  }
  if (!token) return <main className="unlock-shell">
    <div className="wordmark"><span className="brand-mark">C</span> CoderCrew</div>
    <section className="unlock-card"><p className="eyebrow">YOUR AGENTS. ONE CONSOLE.</p><h1>Stay in control.</h1>
      <form onSubmit={(e) => { e.preventDefault(); setToken(draftToken.trim()); setDraftToken(''); }}>
        <label htmlFor="token">Host access token</label><input id="token" type="password" autoComplete="off" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} required />
        <button className="primary">Open console</button>
      </form><p className="fine">The token stays in page memory. Locking or closing this page does not pause a server-owned run.</p>
    </section></main>;
  const feedback = message && <p className="feedback" role="status">{message}</p>;
  return <main className="console-shell">
    <header className="topbar"><div className="wordmark"><span className="brand-mark">C</span> CoderCrew</div>
      <nav className="section-tabs" aria-label="Sections">
        <button type="button" className={tab === 'console' ? 'selected' : ''} aria-pressed={tab === 'console'} onClick={() => setTab('console')}>Console</button>
        <button type="button" className={tab === 'workspaces' ? 'selected' : ''} aria-pressed={tab === 'workspaces'} onClick={() => setTab('workspaces')}>Projects</button></nav>
      <div className="toolbar"><span className="badge">{state?.mode === 'mock' ? 'MOCK MODE' : 'LOCAL HOST'}</span><button className="quiet" onClick={lock} disabled={busy}>Lock</button></div></header>
    <div className="page-heading"><div><p className="eyebrow">{tab === 'workspaces' ? 'PROJECT · WORKTREE · TASK' : 'SERVER-OWNED RUNS'}</p><h1>{tab === 'workspaces' ? 'Projects and agents' : 'Agent console'}</h1>
        <p className="muted">{tab === 'workspaces' ? 'Choose an existing worktree or explicitly create one for a new task. Opening a console never starts work.' : 'Viewing another worktree never changes a running relay.'}</p></div>
      <div className="connection">{stale ? 'Not current' : 'Connected'}<small>{updated ? new Date(updated).toLocaleTimeString() : 'Connecting'}</small></div></div>
    {error && <div className="notice error" role="alert">{error} <button onClick={() => void refresh()}>Refresh</button></div>}
    {state?.mode === 'mock' && <div className="notice">Simulated panes. No commands reach real terminals.</div>}
    {state && tab === 'workspaces' && <>
      {feedback}
      <Workspaces token={token} disabled={busy} discovery={discovery} discoveryError={discoveryError} onRecheck={() => recheck()}
        inputEnabled={state.inputEnabled} runs={state.runs} selectedRoot={project ?? null} onSelectWorktree={chooseWorktree}
        sessions={sessions} pairs={groups} lockedRepositories={[...setupHolds, ...state.runs.filter((run) => ['running','waiting','paused'].includes(run.status)).map((run) => run.repository)]}
        selectedKey={workspace?.key ?? null} onSelectWorkspace={chooseWorkspace}
        onChanged={async (notice) => { setMessage(notice); await Promise.all([refresh(), recheck()]); }} />
    </>}
    {state && tab === 'console' && <>
      <div className="context-bar">
        <span><strong>{selectedProject?.name ?? (project ? nameOf(project) : 'No project')}</strong> {project && <span className="mono muted">{project}</span>}</span>
        {(card || selectedTree) && <span>Branch <span className="mono">{(card ?? selectedTree)?.branch ?? 'detached HEAD'}</span></span>}
        <span>{pair ? <>Group <strong>{pair.name}</strong> <span className="muted">{pair.sessions.map((id) => sessions.find((s) => s.id === id)?.label ?? id).join(' ⇄ ')}</span></> : <span className="muted">No group in use</span>}</span>
        <button type="button" className="quiet" onClick={() => setTab('workspaces')}>Projects →</button>
      </div>
      {setupHeld && <p className="notice">This worktree creation is applying or uncertain. Inspect and reconcile its result in Projects before starting work.</p>}
      {!projectSessions.length && <section className="panel empty-console"><h2>No eligible agents here yet</h2>
        <p className="muted">{selectedTree?.error ?? (project ? <>Start coding CLIs in <span className="mono">{project}</span>, then Recheck in Projects. Collaborators need the same directory. No registration is needed.</> : 'Choose a project and worktree with running coding agents. Nothing is sent until you explicitly start work.')}</p>
        <button type="button" className="primary" onClick={() => setTab('workspaces')}>Open Projects</button></section>}
      {!!projectSessions.length && <>
        <div className="target-row"><nav className="agent-tabs" aria-label="Command target">{visible.map((s) => <button key={s.id} className={s.id === current?.id ? 'selected' : ''} aria-pressed={s.id === current?.id} onClick={() => { select(s.id); setFocusOverride(s.id); }}>
            <Icon badge={statuses.get(s.id)?.badge ?? 'unknown'} />{s.label}</button>)}</nav>
          <div className="row-tools"><div className="segmented" role="group" aria-label="Pane layout">
              <button className={layout === 'parallel' ? 'selected' : 'quiet'} aria-pressed={layout === 'parallel'} onClick={() => chooseLayout('parallel')}>Parallel</button>
              <button className={layout === 'focus' ? 'selected' : 'quiet'} aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}>Focus</button></div></div></div>
        <section className={`panes ${layout}`} aria-label="Agent output">{shown.map((s) => {
          const snapshot = state?.snapshots.find((p) => p.agentId === s.id);
          const execution = state?.executions.find((e) => e.agentId === s.id);
          const ended = state?.turns.find((t) => t.agentId === s.id && t.receivedAt >= s.registeredAt);
          // While this pane has a command in flight, an older accepted outcome must not look like that command's result. A
          // participant whose turn is over keeps its label (an objection reason stays readable while the partner corrects).
          const visibleOutcome = !execution || ended?.commandId === execution.commandId ? ended : undefined;
          return <article key={s.id} className={`pane ${s.id === current?.id ? 'active' : ''}`}>
            <div className="pane-heading"><h2><Icon badge={statuses.get(s.id)?.badge ?? 'unknown'} />{s.label}</h2><span className="mono muted">{s.agentType} · {s.identity.paneId}</span></div>
            <div className="pane-meta"><span>{s.repository}</span><span className="badge">{execution ? execution.status.toUpperCase() : 'NO ACTIVE CONTROLLER TURN'}</span></div>
            {visibleOutcome?.outcome && <div className={`outcome ${visibleOutcome.outcome}`}>{visibleOutcome.outcome}: {visibleOutcome.reason}</div>}
            <Output label={`${s.label} output`} text={(snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text) || 'Waiting for a capture'} />
            <div className="pane-footer"><span>{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : ''}</span></div>
          </article>;
        })}</section>
        {state && <details className="panel status" open>
          <summary><h2>Status</h2>
            {latestRun && <span className={`badge ${latestRun.status === 'paused' ? 'warning' : ''}`}>{latestRun.status === 'running' ? 'RUN ACTIVE' : `RUN ${latestRun.status.toUpperCase()}`} · {latestRun.automaticTurns}/{latestRun.turnLimit} automatic turns</span>}</summary>
          {latestRun ? <p className="muted">{latestRun.participants.map((p) => p.label).join(' ⇄ ')}{latestRun.implementation ? ` (group "${latestRun.implementation.group.name}")` : latestRun.planning ? ` (planning group "${latestRun.planning.group.name}")` : latestRun.pairId ? ` (group "${latestRun.pairId}")` : ' (single-agent turn)'} · {latestRun.reason} · {timeOf(latestRun.updatedAt)}</p>
            : <p className="muted">No run with the current agents in this workspace. Earlier runs stay in the history below.</p>}
          {latestRun?.implementation?.latestPublication && <p className="muted">Commit <span className="mono">{latestRun.implementation.latestPublication.sha.slice(0, 12)}</span> · {latestRun.implementation.latestPublication.entry.summary}<br />
            Checks reported by the agent: {latestRun.implementation.latestPublication.entry.checks.join('; ') || 'none reported'}</p>}
          <table><thead><tr><th>Agent</th><th>State</th><th>Detail</th><th>When</th></tr></thead>
            <tbody>{projectSessions.map((s) => { const status = statuses.get(s.id)!;
              const activity = state.activities?.find((a) => a.agentId === s.id);
              const resetBlocked = busy || owned.length > 0 || !!transportHold || !s.cliPid || state.instances.find((i) => i.agentId === s.id)?.status !== 'current';
              return <tr key={s.id}><td>{s.label} <small className="mono muted">{s.agentType}</small></td>
                <td><span className="state"><Icon badge={status.badge} />{status.badge}</span></td>
                <td className="command-text">{status.detail}
                  {activity?.state === 'unknown' && <div><button type="button" disabled={resetBlocked}
                    title={owned.length || transportHold ? 'Reconcile the owned run before resetting activity.' : !s.cliPid || state.instances.find((i) => i.agentId === s.id)?.status !== 'current' ? 'Recover the CLI identity before resetting activity.' : 'Restore Ready after inspecting this terminal.'}
                    onClick={() => setStatusReset({ agentId: s.id, registrationId: s.registrationId, expectedUpdatedAt: activity.updatedAt })}>Reset status</button></div>}
                </td><td className="mono muted">{status.when ? timeOf(status.when) : ''}</td></tr>; })}</tbody></table>
        </details>}
        {statusReset && <section className="panel" aria-label="Reset agent status">
          <h2>Reset status for {projectSessions.find((s) => s.id === statusReset.agentId)?.label}</h2>
          <p>A backend restart can lose activity evidence for a quiet CLI. Inspect this agent’s terminal: it must be at an empty prompt with no background writers. This marks it Ready based on your inspection; it does not restart the CLI or certify a completed turn.</p>
          <button type="button" disabled={busy || owned.length > 0 || !!transportHold} onClick={() => void resetActivity()}>I checked the terminal — mark Ready</button>{' '}
          <button type="button" disabled={busy} onClick={() => setStatusReset(null)}>Cancel status reset</button>
        </section>}
        {owned.map((run) => <section key={run.id} className="panel" aria-label="Active run">
          <div className="section-heading"><h2>{run.status === 'paused' ? 'Run paused' : 'Run active'}</h2><span className="badge">{run.automaticTurns}/{run.turnLimit} automatic turns</span></div>
          <p><span className="badge">{run.implementation ? 'IMPLEMENTATION' : run.planning ? 'PLAN' : run.standalone ? 'STANDALONE' : 'LEGACY STAGING'}</span> {run.participants.map((s) => s.label).join(' ⇄ ')} · {run.implementation?.group.name ?? run.planning?.group.name ?? run.pairId ?? 'single-agent turn'}</p><p>{run.reason}</p>
          {run.implementation && <p className="mono">{run.implementation.policy} · {run.implementation.branch} · turn {run.implementation.turn} · accepted {run.implementation.acceptedSha.slice(0, 12)}{run.implementation.candidateSha ? ` · candidate ${run.implementation.candidateSha.slice(0, 12)}` : ''}</p>}
          {run.planning && <PlanningProgress token={token} run={run} git={card?.git} disabled={busy || stale || !state.inputEnabled} refresh={refresh} onMessage={setMessage} onStop={() => void action(run, 'pause')} />}
          {run.status === 'waiting' && (run.implementation || run.planning?.next) && <button disabled={busy || stale || !state.inputEnabled} onClick={() => void action(run, 'continue')}>{run.planning && !run.implementation ? 'I checked readiness — Next planning turn' : 'I checked readiness — Next turn'}</button>}
          {run.status === 'waiting' && run.implementation && <RunPolicy key={`${run.id}:${run.implementation.revision}`} token={token} run={run} disabled={busy || stale} onChanged={refresh} onMessage={setMessage} />}
          <button disabled={busy} onClick={() => void action(run, 'pause')}>Pause / take over</button>
          {takeover === run.id && <div className="notice">Pause does not interrupt any process. Inspect all participants, stop background writers, and resolve any partially typed input before releasing ownership.
            <button disabled={busy} onClick={() => void action(run, 'takeover')}>I checked every participant; release ownership</button><button onClick={() => setTakeover(null)}>Keep paused</button></div>}
        </section>)}
        {latestRun?.planning && !owned.some((r) => r.id === latestRun.id) && <details className="panel"><summary>Retained plan and authorization</summary>
          <PlanningProgress token={token} run={latestRun} disabled refresh={refresh} onMessage={setMessage} onStop={() => {}} /></details>}
        {unknownRequest && <div className="notice error" role="alert">Request {unknownRequest} has an uncertain HTTP result. Inspect its server run and the terminal; do not resend it.
          <button onClick={() => setUnknownRequest(null)}>I checked the server and terminal</button></div>}
        {!!resetAgents.length && <section className="notice" aria-label="Agent identity changed">
          <p>{owned.length ? 'CLI identity changed for' : 'Workspace reset required for'} {resetAgents.map((s) => s.label).join(', ')}. A saved CLI identity is outdated. Inspect these panes and confirm the intended CLIs are running.</p>
          {owned.length ? <p>A run still owns this checkout. Use Pause / take over above and inspect every participant before releasing ownership. A restarted CLI in the same pane and directory will then be rediscovered automatically, keeping names and group settings.</p>
            : <p>No active run owns this checkout, so Pause / take over is not shown. This pane still cannot be matched to its saved identity. Inspect it before resetting the workspace configuration, then confirm readiness before sending again.</p>}
          {setupHeld && <p>A setup operation still owns this checkout. Reconcile it in Projects before resetting.</p>}
          {resetFor !== resetKey ? <button type="button" disabled={resetBlocked} onClick={() => setResetFor(resetKey)}>Reset workspace…</button>
            : <><p>Reset saved names and group selection for every agent on <span className="mono">{project}</span>? Live agents will appear with their default names. Files, commits, running CLIs and command history are kept.</p>
              <button type="button" disabled={resetBlocked} onClick={() => void resetWorkspace()}>Confirm workspace reset</button>
              <button type="button" disabled={busy} onClick={() => setResetFor(null)}>Keep configuration</button></>}
        </section>}
        {!!unknownAgents.length && <div className="notice">The host cannot confirm the CLI process for {unknownAgents.map((s) => s.label).join(', ')}. Recheck before sending.</div>}
        {transportHold && !owned.length && <div className="notice">An older uncertain delivery holds this workspace. Inspect its terminals and any partially typed input before acknowledging. Nothing is replayed. <button disabled={busy} onClick={() => void releaseLegacy()}>I checked the legacy delivery</button></div>}
        {!showLegacy && <><section className="panel phase-choice" aria-label="Task phases"><h2>Choose a starting phase</h2><div className="segmented" role="group" aria-label="Start phase">
          <button className={phase === 'plan' ? 'selected' : 'quiet'} aria-pressed={phase === 'plan'} onClick={() => setPhase('plan')}>1 · Plan</button>
          <button className={phase === 'implementation' ? 'selected' : 'quiet'} aria-pressed={phase === 'implementation'} onClick={() => setPhase('implementation')}>2 · Implementation</button></div>
          <p className="fine">Plan is optional. Plan produces documents and an approval checkpoint; Implementation supports standalone instructions and committed relay. This choice only configures a new run.</p></section>
          <Implementation key={`${card?.cwd}:${pair?.id}:${phase}`} token={token} state={state} group={groups.find((g) => g.id === pair?.id)} workspace={card} selectedAgent={current?.id}
            phase={phase} blocked={blocked} blockedReason={identityBlockedReason} workspaceError={discoveryError || discovery?.error || ''} refresh={refresh} onRecheck={() => Promise.all([refresh(), recheck()]).then(() => {})} onMessage={setMessage} onUncertain={setUnknownRequest} /></>}
        {state.legacyEnabled ? <label className="readiness"><input type="checkbox" aria-label="Staging fallback" checked={!!showLegacy} disabled={pair?.sessions.length !== 2} onChange={(e) => setLegacy(e.target.checked)} />Show deprecated staging fallback (supervised two-agent relay; no branch handoffs or fixed roles)</label>
          : <p className="fine">Deprecated staging fallback is temporarily disabled by the host.</p>}
        {showLegacy && <section className="composer"><div className="section-heading"><h2>Legacy staging: send to {current?.label}</h2><span className="badge">{owned.length ? 'EXECUTION OWNED' : 'MANUAL START'}</span></div>
          {!state?.inputEnabled && <p>Read-only console: the host has disabled input.</p>}
          <form onSubmit={(e) => { e.preventDefault(); void send('instruction'); }}>
            <label className="sr-only" htmlFor="instruction">Instruction to {current?.label}</label>
            <div className="command-line"><textarea id="instruction" autoComplete="off" rows={3} value={text} disabled={blocked} maxLength={1900} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send('instruction'); } }} placeholder="Instruction or optional review context. ⌘/Ctrl+Enter sends." />
              <button className="primary" disabled={blocked || !ready || !text.trim()}>Send {current?.label}</button>
              <button type="button" disabled={blocked || !ready || !text.trim() || !pair} onClick={() => void send('instruction', true)}>Send {current?.label} &amp; relay {state.sessions.find((session) => pair?.sessions.includes(session.id) && session.id !== current?.id)?.label} ↗</button>
              <button type="button" disabled={blocked || !ready} onClick={() => void send('relay')}>Relay {current?.label} ↗</button></div>
            <label className="readiness"><input type="checkbox" aria-label="Ready to send" checked={ready} disabled={blocked} onChange={(e) => setReady(e.target.checked)} />
              I checked that all participants are at empty prompts, have no background writers, use their standard Git index, and will remain under controller ownership for this run.</label>
          </form>
          {pair && <label className="readiness auto"><input type="checkbox" aria-label="Auto-relay" checked={autoContinue} disabled={busy || owned.length > 0} onChange={(e) => { setAutoContinue(e.target.checked); try { localStorage.setItem(PREFERENCE, String(e.target.checked)); } catch { /* preference only */ } }} />
            Prefer automatic continuation for the next explicitly started run of group "{pair.name}". Plain Send never relays; Send &amp; relay requests one review even when this preference is off, and only if the worker changed the worktree.</label>}
          {pair && <label className="readiness turn-limit">Maximum automatic turns per run
            <input type="number" inputMode="numeric" aria-label="Maximum automatic turns" min={1} max={200} step={1} value={turnLimit} disabled={busy || owned.length > 0} aria-invalid={!limitValid}
              onChange={(e) => { setTurnLimit(e.target.value); try { localStorage.setItem(TURN_LIMIT, e.target.value); } catch { /* preference only */ } }} />
            <span className="muted">1–200, default {DEFAULT_TURN_LIMIT}; frozen into the run when it starts.</span></label>}
          {!pair && <p className="fine">No group in use: Send &amp; relay is unavailable and Relay reviews without a partner. Choose a group in Projects to relay between two agents.</p>}
          <p className="fine">The server validates and deduplicates correlated completions. Unknown background-work state pauses a run. No fresh-event effect in this page sends commands.</p>
        </section>}
        <details className="history"><summary>Command history</summary>
          <div className="history-tools">
            <label>Group <select aria-label="History pair filter" value={historyFilter} onChange={(e) => setHistoryPair(pair && e.target.value === `pair:${pair.id}` ? 'selected' : e.target.value)}>
              <option value="all">All</option>
              {pairs.map((p) => <option key={p.id} value={`pair:${p.id}`}>{p.name} ({nameOf(p.repository)}){p.id === pair?.id ? ' *' : ''}</option>)}
              {historicalPairIds.map((id) => <option key={id} value={`pair:${id}`}>{id} (removed)</option>)}
            </select></label>
            <button type="button" className="quiet" aria-label="Toggle history order" onClick={() => setHistoryOrder((o) => o === 'desc' ? 'asc' : 'desc')}>{historyOrder === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}</button>
          </div>
          {(() => {
            const wanted = historyFilter.startsWith('pair:') ? historyFilter.slice(5) : undefined;
            const rows = (state?.commands ?? []).filter((c) => historyFilter === 'all' || (wanted !== undefined && c.groupId === wanted));
            if (historyOrder === 'asc') rows.reverse(); // The server supplies stable newest-first append order; reversing preserves timestamp ties.
            return rows.length ? <table><thead><tr><th>Time</th><th>Agent</th><th>Group</th><th>Command</th><th>Delivery</th></tr></thead>
              <tbody>{rows.map((c) => <tr key={c.id}><td className="mono muted">{new Date(c.createdAt).toLocaleString()}</td><td>{sessions.find((s) => s.id === c.agentId)?.label ?? c.agentId}</td>
                <td className="muted">{c.groupId ? groups.find((p) => p.id === c.groupId)?.name ?? c.groupId : ''}</td><td className="command-text">{c.text}</td><td>{c.status}</td></tr>)}</tbody></table>
              : <p className="empty-history">No commands match this filter.</p>;
          })()}</details>
      </>}
      {feedback}
      <p className="fine">Pause a run before manual terminal takeover. Locking this view or disconnecting your phone does not interrupt workers.</p>
    </>}
  </main>;
}
