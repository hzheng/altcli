'use client';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CommandRecord, SessionRegistration } from '../contracts/api';
import type { ActivityReset, HistoryExport, ManagedSession, RelayRun, Workspace, WorkspaceDiscovery, WorkspaceResetResult, WorkflowState } from '../contracts/workflow';
import type { ProjectWorktree } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { MemoryContext, useRemembered, type PageMemory } from '../client/memory';
import { nameOf, workspaceKey, Workspaces } from './Workspaces';
import { RunPolicy } from './Implementation';
import { PlanningProgress } from './PlanningProgress';
import { PaneActions } from './PaneActions';
import { PlanSetup } from './PlanSetup';
import { RunSettingsBar, useRunSettings, type Phase } from './RunSettings';
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
/** Follows new output while the reader is at the bottom; a reader who scrolled up keeps their place. A hidden pane (Focus, the narrow
 * layout or a hidden section) has no layout, so polling never overwrites its saved place; it is restored when the pane is shown again. */
function Output({ text, label, memoryKey }: { text: string; label: string; memoryKey: string }) {
  const memory = useContext(MemoryContext);
  const ref = useRef<HTMLPreElement>(null);
  const place = useRef((memory.get(memoryKey) as { top: number; stick: boolean } | undefined) ?? { top: 0, stick: true });
  const restore = useCallback(() => { const el = ref.current; if (!el || !el.clientHeight) return; el.scrollTop = place.current.stick ? el.scrollHeight : place.current.top; }, []);
  useEffect(restore, [text, restore]);
  useEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(restore); observer.observe(el); return () => observer.disconnect();
  }, [restore]);
  return <pre ref={ref} tabIndex={0} aria-label={label} onScroll={(e) => { const el = e.currentTarget; if (!el.clientHeight) return;
    place.current = { top: el.scrollTop, stick: el.scrollHeight - el.scrollTop - el.clientHeight < 8 }; memory.set(memoryKey, place.current); }}>{text}</pre>;
}
/** A view and command client. There is intentionally no effect that sends another turn. */
export function Console() {
  // Page memory for drafts and choices. Lock replaces it: hooks that stay mounted above the unlock form must not keep old values.
  const [memory, setMemory] = useState<PageMemory>(() => new Map());
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [state, setState] = useState<WorkflowState | null>(null);
  const [discovery, setDiscovery] = useState<WorkspaceDiscovery | null>(null); const [discoveryError, setDiscoveryError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null); const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(null);
  const [text, setText] = useState(''); const [ready, setReady] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true); const [busy, setBusy] = useState(false); const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [updated, setUpdated] = useState(0);
  const [clock, setClock] = useState(Date.now()); const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [statusReset, setStatusReset] = useState<Omit<ActivityReset, 'confirmReady'> | null>(null);
  const [layout, setLayout] = useState<'parallel' | 'focus'>('parallel');
  const [turnLimit, setTurnLimit] = useState(String(DEFAULT_TURN_LIMIT));
  const [legacy, setLegacy] = useState(false);
  const [phase, setPhase] = useState<Phase>('implementation');
  // One readiness slot for the whole console: the exact displayed state a confirmation was given for, so at most one card is ready.
  const [consent, setConsent] = useState('');
  const [recheckRevision, setRecheckRevision] = useState(0); const [viewEpoch, setViewEpoch] = useState(0);
  // History follows the selected pair by default; "All" or a specific pair is an explicit choice that then sticks.
  const [historyPair, setHistoryPair] = useState<'all' | 'selected' | string>('selected'); const [historyOrder, setHistoryOrder] = useState<'desc' | 'asc'>('desc');
  const submission = useRef(false); const generation = useRef(0); const readNumber = useRef(0); const discoveryRead = useRef(0);
  const scrolls = useRef<Partial<Record<Tab, number>>>({});
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
  // Both sections stay mounted; each keeps its own page scroll across switches.
  useEffect(() => { if (tab) window.scrollTo(0, scrolls.current[tab] ?? 0); }, [tab]);
  const showTab = (next: Tab) => { if (tab) scrolls.current[tab] = window.scrollY; setTab(next); };
  const sessions = state?.sessions ?? [];
  const project = workspace?.root ?? sessions[0]?.repository;
  const projectSessions = sessions.filter((s) => s.repository === project);
  const card = discovery?.workspaces.find((w) => workspace ? workspaceKey(w) === workspace.key : w.worktree.root === project);
  const selectedProject = discovery?.projects?.find((p) => p.worktrees.some((w) => w.path === project));
  const selectedTree = selectedProject?.worktrees.find((w) => w.path === project);
  const setupHolds = discovery?.projects?.flatMap((p) => [...p.creations.filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => op.input.path), ...(p.removals ?? []).filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => op.input.worktree.root)]) ?? [];
  const setupHeld = !!project && setupHolds.includes(project);
  const groups = state?.groups ?? [];
  const pairs = groups.map((g) => ({ ...g, sessions: g.members }));
  const historicalPairIds = [...new Set((state?.commands ?? []).flatMap((command) => command.groupId ? [command.groupId] : []))]
    .filter((id) => !pairs.some((candidate) => candidate.id === id));
  const pair = pairs.find((p) => p.repository === project && p.cwd === card?.cwd && p.members.length > 0);
  const members = pair?.members ?? [];
  const git = card?.git;
  // Drafts, settings and the displayed pane are remembered per workspace and group, never carried into another workspace.
  const ws = card ? workspaceKey(card) : project ?? '';
  const scope = `${ws}\0${pair?.id ?? ''}`;
  const implementationSettings = useRunSettings(memory, `run:${scope}`, git, members, 'implementation');
  const planSettings = useRunSettings(memory, `run:${scope}`, git, members, 'plan');
  const [agentsOpen, setAgentsOpen] = useRemembered(`agents:${ws}`, false, memory);
  const [historyOpen, setHistoryOpen] = useRemembered(`history:${ws}`, false, memory);
  const [advancedOpen, setAdvancedOpen] = useRemembered(`advanced:${ws}`, false, memory);
  const [paneChoice, setPaneChoice] = useRemembered<string | null>(`pane:${ws}`, null, memory);
  const showLegacy = legacy && state?.legacyEnabled && pair?.sessions.length === 2;
  // The internal sentinel follows the active pair while the control shows that pair's single, starred option.
  const historyFilter = historyPair === 'selected' ? pair ? `pair:${pair.id}` : 'all' : historyPair;
  const visible = pair ? projectSessions.filter((s) => pair.sessions.includes(s.id)) : projectSessions;
  const owned = (state?.runs ?? []).filter((r) => r.repository === project && ['running','waiting','paused'].includes(r.status));
  const transportHold = state?.reservations.find((r) => r.repository === project);
  // A finished run is current status only while its frozen participants are the agents shown here; a run of removed or
  // renamed-away agents is history and stays reachable under Command history.
  const latestRun = owned[0] ?? state?.runs.find((r) => r.repository === project && r.participants.every((p) => projectSessions.some((s) => s.id === p.id)));
  const newest = state?.runs.find((r) => r.repository === project);
  const runMark = JSON.stringify(newest ? [newest.id, newest.status] : null);
  const statuses = new Map(state ? projectSessions.map((s) => [s.id, statusOf(s, latestRun, state)] as const) : []);
  const working = projectSessions.find((s) => ['working', 'sending'].includes(statuses.get(s.id)?.badge ?? ''))?.id ?? null;
  const lastActive = [...projectSessions].sort((a, b) => (statuses.get(b.id)?.when ?? '').localeCompare(statuses.get(a.id)?.when ?? ''))[0]?.id ?? null;
  // One displayed pane drives Focus and the narrow layout. An explicit choice sticks; until one is made, the view follows a working agent.
  const current = visible.find((s) => s.id === paneChoice) ?? visible.find((s) => s.id === working) ?? visible.find((s) => s.id === lastActive) ?? visible[0];
  const displayed = current?.id;
  const groupInstances = visible.map((s) => [s.id, state?.instances.find((i) => i.agentId === s.id)?.status]);
  const readinessKey = JSON.stringify([pair, card?.agents, current?.id, current?.registrationId, groupInstances]);
  useEffect(() => { setReady(false); setResetFor(null); setStatusReset(null); }, [readinessKey, project]);
  // Readiness and confirmations attest to what was on screen, so any view switch revokes them. Drafts and choices stay.
  const viewKey = JSON.stringify([tab, phase, layout, displayed]);
  useEffect(() => { setConsent(''); setReady(false); setResetFor(null); setStatusReset(null); setViewEpoch((epoch) => epoch + 1); }, [viewKey]);
  const chooseLayout = (next: 'parallel' | 'focus') => { setLayout(next); try { localStorage.setItem(LAYOUT, next); } catch { /* preference only */ } };
  const stale = !!error || clock - updated > 10000;
  // A reading that is not current cannot back a confirmation; readiness must be given again once it is.
  useEffect(() => { if (stale) { setConsent(''); setReady(false); } }, [stale]);
  // Every selected collaborator is validated by the server, including a peer that is not the command target.
  const resetAgents = visible.filter((s) => !s.registrationId || state?.instances.find((i) => i.agentId === s.id)?.status === 'replaced');
  const unknownAgents = state?.mode === 'tmux' ? visible.filter((s) => !resetAgents.includes(s) && state.instances.find((i) => i.agentId === s.id)?.status !== 'current') : [];
  const identityBlockedReason = resetAgents.length ? `Reset workspace required for ${resetAgents.map((s) => s.label).join(', ')}. Inspect the panes and use Reset workspace above before sending.`
    : unknownAgents.length ? `The host cannot confirm the CLI process for ${unknownAgents.map((s) => s.label).join(', ')}. Recheck before sending.` : '';
  // Gates shared by every card of this checkout, then each card's own agent.
  const sharedReason = identityBlockedReason || (stale ? 'The console is not current. Wait for it to reconnect.' : '')
    || (setupHeld ? 'A worktree operation is applying or uncertain. Reconcile it in Projects before starting work.' : '')
    || (!state?.inputEnabled ? 'Read-only console: the host has disabled input.' : '')
    || (owned.length ? 'A run owns this checkout. Wait for it to finish, or use Pause / take over above.' : '')
    || (transportHold ? 'An older uncertain delivery holds this workspace. Inspect and acknowledge it above.' : '')
    || (unknownRequest ? 'A request has an uncertain result. Inspect it above before sending again.' : '')
    || (checking ? 'Wait for Recheck to finish.' : '')
    || (!!pair && !limitValid ? 'Set the staging fallback maximum automatic turns to 1–200.' : '');
  const cardReason = (s?: ManagedSession) => !s ? 'Choose an agent first.' : !s.registrationId ? `Recheck ${s.label} before sending: its identity is not registered.`
    : state?.snapshots.find((snapshot) => snapshot.agentId === s.id)?.status !== 'available' ? `${s.label}'s pane cannot be captured right now. Recheck before sending.` : '';
  const blocked = busy || !!sharedReason || !!cardReason(current);
  const resetKey = JSON.stringify([project, readinessKey]);
  const resetBlocked = busy || stale || setupHeld || owned.length > 0 || !!transportHold || !!unknownRequest || !project || !!discoveryError || !!discovery?.error;
  const workspaceError = discoveryError || discovery?.error || '';
  const select = (id: string) => { setPaneChoice(id); setReady(false); };
  function chooseWorkspace(chosen: Workspace) {
    const choice = { key: workspaceKey(chosen), root: chosen.worktree.root };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setReady(false); scrolls.current.console = 0; showTab('console');
  }
  function chooseWorktree(chosen: ProjectWorktree) {
    const choice = { key: `worktree:${chosen.id}`, root: chosen.path };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setReady(false); scrolls.current.console = 0; showTab('console');
  }
  function lock() {
    generation.current++; readNumber.current++; discoveryRead.current++; setToken(''); setDraftToken(''); setState(null); setDiscovery(null); setTab(null); setReady(false);
    setMessage(''); setError(''); setDiscoveryError(''); setUnknownRequest(null); setResetFor(null); setConsent('');
    // Lock forgets drafts and form state; server-owned runs continue and are relearned from the server after unlocking.
    setMemory(new Map()); scrolls.current = {};
  }
  /** Runs one request under the console-wide submission guard, so two rapid clicks cannot create competing starts. */
  async function guarded(work: () => Promise<void>) {
    if (submission.current) return;
    submission.current = true; setBusy(true);
    try { await work(); } finally { submission.current = false; setBusy(false); }
  }
  const recheckAll = () => Promise.all([refresh(), recheck()]).then(() => {});
  function recheckNow() {
    setConsent(''); setChecking(true);
    void recheckAll().finally(() => { setRecheckRevision((revision) => revision + 1); setChecking(false); });
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
  // The journal is app data: a repository clone cannot recover it, so the console offers it as a downloadable backup.
  async function exportHistory() {
    if (!project || submission.current) return;
    submission.current = true; setBusy(true);
    try {
      const history = await api<HistoryExport>(token, `history/export?repository=${encodeURIComponent(project)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `codercrew-history-${nameOf(project)}-${history.exportedAt.replace(/[:.]/g, '-')}.json`;
      anchor.click(); URL.revokeObjectURL(url);
      setMessage(`Exported ${history.runs.length} run${history.runs.length === 1 ? '' : 's'} and ${history.journal.length} journal entr${history.journal.length === 1 ? 'y' : 'ies'} for ${project}.`);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'History export failed.'); }
    finally { submission.current = false; setBusy(false); }
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
  const connection = <div className="connection">{stale ? 'Not current' : 'Connected'}<small>{updated ? new Date(updated).toLocaleTimeString() : 'Connecting'}</small></div>;
  const actionable = !!pair && members.length <= 2;
  const settings = phase === 'plan' ? planSettings : implementationSettings;
  const settingsNotice = !pair ? 'Select at least one agent in Projects to start.' : members.length > 2
    ? `Your group has ${members.length} agents. Plan and Implementation currently execute with one or two agents; larger-group execution is not enabled yet. Your selection is saved. Choose one or two members to start a run.` : '';
  // Discovery and the saved session share a full pane identity: pane, socket and tmux server.
  const locationOf = (s: ManagedSession) => card?.agents.find((a) => a.identity.paneId === s.identity.paneId && a.identity.socketPath === s.identity.socketPath
    && a.identity.serverPid === s.identity.serverPid && a.identity.serverStarted === s.identity.serverStarted)?.location;
  const common = { token, state: state!, git, workspaceError, agentsKey: JSON.stringify(card?.agents ?? null), busy, submit: guarded, consent, setConsent, runMark,
    recheck: recheckRevision, refresh, onRecheck: recheckAll, onMessage: setMessage, onUncertain: setUnknownRequest };
  return <MemoryContext.Provider value={memory}><main className="console-shell">
    <header className="topbar"><div className="wordmark"><span className="brand-mark">C</span> CoderCrew</div>
      <nav className="section-tabs" aria-label="Sections">
        <button type="button" className={tab === 'console' ? 'selected' : ''} aria-pressed={tab === 'console'} onClick={() => showTab('console')}>Console</button>
        <button type="button" className={tab === 'workspaces' ? 'selected' : ''} aria-pressed={tab === 'workspaces'} onClick={() => showTab('workspaces')}>Projects</button></nav>
      <div className="toolbar">{state?.mode === 'mock' && <span className="muted toolbar-note">Simulated panes. No commands reach real terminals.</span>}
        <span className="badge">{state?.mode === 'mock' ? 'MOCK MODE' : 'LOCAL HOST'}</span><button className="quiet" onClick={lock} disabled={busy}>Lock</button></div></header>
    {tab === 'workspaces' ? <div className="page-heading"><div><p className="eyebrow">PROJECT · WORKTREE · TASK</p><h1>Projects and agents</h1>
        <p className="muted">Choose an existing worktree or explicitly create one for a new task. Opening a console never starts work.</p></div>{connection}</div>
      : <div className="page-heading compact"><h1>Agent console</h1>{connection}</div>}
    {error && <div className="notice error" role="alert">{error} <button onClick={() => void refresh()}>Refresh</button></div>}
    {state && <>
    <div className="section-panel" hidden={tab !== 'workspaces'}>
      {feedback}
      <Workspaces token={token} disabled={busy} discovery={discovery} discoveryError={discoveryError} onRecheck={() => recheck()}
        inputEnabled={state.inputEnabled} runs={state.runs} selectedRoot={project ?? null} onSelectWorktree={chooseWorktree}
        deliveryRepositories={state.reservations.map((reservation) => reservation.repository)}
        sessions={sessions} pairs={groups} lockedRepositories={[...setupHolds, ...state.runs.filter((run) => ['running','waiting','paused'].includes(run.status)).map((run) => run.repository)]}
        selectedKey={workspace?.key ?? null} onSelectWorkspace={chooseWorkspace} viewEpoch={viewEpoch}
        onChanged={async (notice) => { setMessage(notice); await Promise.all([refresh(), recheck()]); }} />
    </div>
    <div className="section-panel" hidden={tab !== 'console'}>
      <div className="context-bar">
        <span className="context-project"><strong>{selectedProject?.name ?? (project ? nameOf(project) : 'No project')}</strong> {project && <span className="mono muted" title={project}>{project}</span>}</span>
        {(card || selectedTree) && <span>Branch <span className="mono">{(card ?? selectedTree)?.branch ?? 'detached HEAD'}</span>{git && <span className="mono muted"> @ {git.head.slice(0, 7)} · {git.clean ? 'clean' : `${git.changeCount} uncommitted`}{git.integration ? ' · integration branch' : ''}</span>}</span>}
        <span>{pair ? <>Group <strong>{pair.name}</strong> <span className="muted">{pair.sessions.map((id) => sessions.find((s) => s.id === id)?.label ?? id).join(' ⇄ ')}</span></> : <span className="muted">No group in use</span>}</span>
        <span className="context-actions"><button type="button" className="quiet" disabled={busy || checking} onClick={recheckNow}>{checking ? 'Checking…' : 'Recheck'}</button>
          <button type="button" className="quiet" onClick={() => showTab('workspaces')}>Projects →</button></span>
      </div>
      {(workspaceError || card?.gitError) && <p className="notice error" role="alert">{workspaceError || card?.gitError} Recheck before starting.</p>}
      {setupHeld && <p className="notice">This worktree operation is applying or uncertain. Inspect and reconcile its result in Projects before starting work.</p>}
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
      {statusReset && <section className="panel" aria-label="Reset agent status">
        <h2>Reset status for {projectSessions.find((s) => s.id === statusReset.agentId)?.label}</h2>
        <p>A backend restart can lose activity evidence for a quiet CLI. Inspect this agent’s terminal: it must be at an empty prompt with no background writers. This marks it Ready based on your inspection; it does not restart the CLI or certify a completed turn.</p>
        <button type="button" disabled={busy || owned.length > 0 || !!transportHold} onClick={() => void resetActivity()}>I checked the terminal — mark Ready</button>{' '}
        <button type="button" disabled={busy} onClick={() => setStatusReset(null)}>Cancel status reset</button>
      </section>}
      {owned.map((run) => <section key={run.id} className="panel run-card" aria-label="Active run">
        <div className="section-heading"><h2>{run.status === 'paused' ? 'Run paused' : 'Run active'}</h2><span className="badge">{run.automaticTurns}/{run.turnLimit} automatic turns</span></div>
        <p><span className="badge">{run.implementation ? 'IMPLEMENTATION' : run.planning ? 'PLAN' : run.standalone ? 'STANDALONE' : 'LEGACY STAGING'}</span> {run.participants.map((s) => s.label).join(' ⇄ ')} · {run.implementation?.group.name ?? run.planning?.group.name ?? run.pairId ?? 'single-agent turn'}</p><p>{run.reason}</p>
        {run.implementation && <p className="mono">{run.implementation.policy} · {run.implementation.branch} · turn {run.implementation.turn} · accepted {run.implementation.acceptedSha.slice(0, 12)}{run.implementation.candidateSha ? ` · candidate ${run.implementation.candidateSha.slice(0, 12)}` : ''}</p>}
        {run.planning && <PlanningProgress token={token} run={run} git={card?.git} disabled={busy || stale || !state.inputEnabled} refresh={refresh} onMessage={setMessage} onStop={() => void action(run, 'pause')} viewEpoch={viewEpoch} />}
        {run.status === 'waiting' && (run.implementation || run.planning?.next) && <button disabled={busy || stale || !state.inputEnabled} onClick={() => void action(run, 'continue')}>{run.planning && !run.implementation ? 'I checked readiness — Next planning turn' : 'I checked readiness — Next turn'}</button>}
        {run.status === 'waiting' && run.implementation && <RunPolicy key={`${run.id}:${run.implementation.revision}`} token={token} run={run} disabled={busy || stale} onChanged={refresh} onMessage={setMessage} />}
        <button disabled={busy} onClick={() => void action(run, 'pause')}>Pause / take over</button>
        {takeover === run.id && <div className="notice">Pause does not interrupt any process. Inspect all participants, stop background writers, and resolve any partially typed input before releasing ownership.
          <button disabled={busy} onClick={() => void action(run, 'takeover')}>I checked every participant; release ownership</button><button onClick={() => setTakeover(null)}>Keep paused</button></div>}
      </section>)}
      {latestRun && !owned.some((r) => r.id === latestRun.id) && <section className="panel latest-run" aria-label="Latest run">
        <p><span className={`badge ${latestRun.status === 'stopped' ? 'warning' : ''}`}>RUN {latestRun.status.toUpperCase()} · {latestRun.automaticTurns}/{latestRun.turnLimit} automatic turns</span>{' '}
          <span className="muted">{latestRun.participants.map((p) => p.label).join(' ⇄ ')}{latestRun.implementation ? ` (group "${latestRun.implementation.group.name}")` : latestRun.planning ? ` (planning group "${latestRun.planning.group.name}")` : latestRun.pairId ? ` (group "${latestRun.pairId}")` : ' (single-agent turn)'} · {latestRun.reason} · {timeOf(latestRun.updatedAt)}</span></p>
        {latestRun.implementation?.latestPublication && <p className="muted">{latestRun.implementation.latestPublication.sha === latestRun.implementation.latestPublication.entry.parent ? 'Report only, no commit' : <>Commit <span className="mono">{latestRun.implementation.latestPublication.sha.slice(0, 12)}</span></>} · {latestRun.implementation.latestPublication.entry.summary}<br />
          Checks reported by the agent: {latestRun.implementation.latestPublication.entry.checks.join('; ') || 'none reported'}</p>}
        {latestRun.planning && <details><summary>Retained plan and authorization</summary>
          <PlanningProgress token={token} run={latestRun} disabled refresh={refresh} onMessage={setMessage} onStop={() => {}} /></details>}
      </section>}
      {feedback}
      {!projectSessions.length && <section className="panel empty-console"><h2>No eligible agents here yet</h2>
        <p className="muted">{selectedTree?.error ?? card?.agents.find((agent) => agent.reason && (agent.kind === 'codex' || agent.kind === 'claude'))?.reason ?? (project ? <>Start coding CLIs in <span className="mono">{project}</span>, then Recheck in Projects. Collaborators need the same directory. No registration is needed.</> : 'Choose a project and worktree with running coding agents. Nothing is sent until you explicitly start work.')}</p>
        <button type="button" className="primary" onClick={() => showTab('workspaces')}>Open Projects</button></section>}
      {!!projectSessions.length && <>
        {!showLegacy && <RunSettingsBar settings={settings} git={git} members={members} sessions={sessions} displayed={displayed} disabled={busy || !!sharedReason} notice={settingsNotice} onPhase={setPhase} />}
        <div className="target-row"><nav className="agent-tabs" aria-label="Command target">{visible.map((s) => <button key={s.id} className={s.id === current?.id ? 'selected' : ''} aria-pressed={s.id === current?.id} onClick={() => select(s.id)}>
            <Icon badge={statuses.get(s.id)?.badge ?? 'unknown'} />{s.label}</button>)}</nav>
          <div className="row-tools"><div className="segmented" role="group" aria-label="Pane layout">
              <button className={layout === 'parallel' ? 'selected' : 'quiet'} aria-pressed={layout === 'parallel'} onClick={() => chooseLayout('parallel')}>Parallel</button>
              <button className={layout === 'focus' ? 'selected' : 'quiet'} aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}>Focus</button></div></div></div>
        <section className={`panes ${layout}`} aria-label="Agent output">{visible.map((s) => {
          const snapshot = state.snapshots.find((p) => p.agentId === s.id);
          const execution = state.executions.find((e) => e.agentId === s.id);
          const ended = state.turns.find((t) => t.agentId === s.id && t.receivedAt >= s.registeredAt);
          // While this pane has a command in flight, an older accepted outcome must not look like that command's result. A
          // participant whose turn is over keeps its label (an objection reason stays readable while the partner corrects).
          const visibleOutcome = !execution || ended?.commandId === execution.commandId ? ended : undefined;
          const status = statuses.get(s.id)!; const activity = state.activities?.find((a) => a.agentId === s.id);
          const resetStatusBlocked = busy || owned.length > 0 || !!transportHold || !s.cliPid || state.instances.find((i) => i.agentId === s.id)?.status !== 'current';
          const location = locationOf(s);
          return <article key={s.id} aria-label={`${s.label} pane`} hidden={layout === 'focus' && s.id !== displayed} className={`pane ${s.id === displayed ? 'active' : ''}`}>
            <div className="pane-heading"><h2><Icon badge={status.badge} />{s.label}</h2><span className="mono muted">{s.agentType}{location ? ` · ${location}` : ''} · {s.identity.paneId}</span>
              <span className="badge">{execution ? execution.status.toUpperCase() : 'NO ACTIVE CONTROLLER TURN'}</span></div>
            <div className="pane-status"><span className="state"><Icon badge={status.badge} />{status.badge}</span><span className="pane-detail" title={status.detail}>{status.detail}</span>
              {status.when && <span className="mono muted">{timeOf(status.when)}</span>}
              {activity?.state === 'unknown' && <button type="button" disabled={resetStatusBlocked}
                title={owned.length || transportHold ? 'Reconcile the owned run before resetting activity.' : !s.cliPid || state.instances.find((i) => i.agentId === s.id)?.status !== 'current' ? 'Recover the CLI identity before resetting activity.' : 'Restore Ready after inspecting this terminal.'}
                onClick={() => setStatusReset({ agentId: s.id, registrationId: s.registrationId, expectedUpdatedAt: activity.updatedAt })}>Reset status</button>}</div>
            {visibleOutcome?.outcome && <div className={`outcome ${visibleOutcome.outcome}`}>{visibleOutcome.outcome}: {visibleOutcome.reason}</div>}
            <Output label={`${s.label} output`} memoryKey={`scroll:${ws}:${s.id}`} text={(snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text) || 'Waiting for a capture'} />
            <div className="pane-footer"><span>{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : ''}</span></div>
            {actionable && phase === 'implementation' && !showLegacy && <PaneActions {...common} group={pair} agent={s} settings={implementationSettings}
              blockedReason={sharedReason || cardReason(s)} draftKey={`draft:${scope}:${s.id}`} />}
            {actionable && showLegacy && s.id === current?.id && <p className="fine pane-hint">The staging fallback is on: use its composer below.</p>}
          </article>;
        })}</section>
        {phase === 'plan' && !showLegacy && <PlanSetup {...common} group={pair && members.length ? pair : undefined} settings={planSettings} displayed={displayed}
          blockedReason={sharedReason || cardReason(current)} draftKey={`plan:${scope}`} />}
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
            Prefer automatic continuation for the next explicitly started run of group &quot;{pair.name}&quot;. Plain Send never relays; Send &amp; relay requests one review even when this preference is off, and only if the worker changed the worktree.</label>}
          {pair && <label className="readiness turn-limit">Maximum automatic turns per run
            <input type="number" inputMode="numeric" aria-label="Maximum automatic turns" min={1} max={200} step={1} value={turnLimit} disabled={busy || owned.length > 0} aria-invalid={!limitValid}
              onChange={(e) => { setTurnLimit(e.target.value); try { localStorage.setItem(TURN_LIMIT, e.target.value); } catch { /* preference only */ } }} />
            <span className="muted">1–200, default {DEFAULT_TURN_LIMIT}; frozen into the run when it starts.</span></label>}
          {!pair && <p className="fine">No group in use: Send &amp; relay is unavailable and Relay reviews without a partner. Choose a group in Projects to relay between two agents.</p>}
        </section>}
        <details className="panel status" open={agentsOpen} onToggle={(e) => setAgentsOpen(e.currentTarget.open)}>
          <summary><h2>Agents in this checkout</h2><span className="muted">{projectSessions.length}</span></summary>
          <table><thead><tr><th>Agent</th><th>State</th><th>Detail</th><th>When</th></tr></thead>
            <tbody>{projectSessions.map((s) => { const status = statuses.get(s.id)!;
              const activity = state.activities?.find((a) => a.agentId === s.id);
              const resetStatusBlocked = busy || owned.length > 0 || !!transportHold || !s.cliPid || state.instances.find((i) => i.agentId === s.id)?.status !== 'current';
              return <tr key={s.id}><td>{s.label} <small className="mono muted">{s.agentType}</small></td>
                <td><span className="state"><Icon badge={status.badge} />{status.badge}</span></td>
                <td className="command-text">{status.detail}
                  {/* Each control exists once: an agent shown as a card resets its status there. */}
                  {activity?.state === 'unknown' && !visible.some((v) => v.id === s.id) && <div><button type="button" disabled={resetStatusBlocked}
                    onClick={() => setStatusReset({ agentId: s.id, registrationId: s.registrationId, expectedUpdatedAt: activity.updatedAt })}>Reset status</button></div>}
                </td><td className="mono muted">{status.when ? timeOf(status.when) : ''}</td></tr>; })}</tbody></table>
        </details>
        <details className="history" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}><summary>Command history</summary>
          <div className="history-tools">
            <label>Group <select aria-label="History pair filter" value={historyFilter} onChange={(e) => setHistoryPair(pair && e.target.value === `pair:${pair.id}` ? 'selected' : e.target.value)}>
              <option value="all">All</option>
              {pairs.map((p) => <option key={p.id} value={`pair:${p.id}`}>{p.name} ({nameOf(p.repository)}){p.id === pair?.id ? ' *' : ''}</option>)}
              {historicalPairIds.map((id) => <option key={id} value={`pair:${id}`}>{id} (removed)</option>)}
            </select></label>
            <button type="button" className="quiet" aria-label="Toggle history order" onClick={() => setHistoryOrder((o) => o === 'desc' ? 'asc' : 'desc')}>{historyOrder === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}</button>
            <button type="button" className="quiet" disabled={busy || !project} title="Download this worktree’s runs, turns and handoff journal (reviewed ranges, findings, plans, reported checks, archived handoff patches) as JSON. Cloning the repository does not recover it." onClick={() => void exportHistory()}>Export history</button>
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
        <details className="advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}><summary>Advanced</summary>
          {state.legacyEnabled ? <label className="readiness"><input type="checkbox" aria-label="Staging fallback" checked={!!showLegacy} disabled={pair?.sessions.length !== 2} onChange={(e) => setLegacy(e.target.checked)} />Show deprecated staging fallback (supervised two-agent relay; no branch handoffs or fixed roles)</label>
            : <p className="fine">Deprecated staging fallback is temporarily disabled by the host.</p>}
        </details>
      </>}
      <details className="advanced"><summary>How this works</summary>
        <p className="fine">Each card acts on the agent above it. Send delivers an instruction; After send can add one handoff commit, or a commit and one review by the named peer. Current changes snapshots work as it stands, and Committed review asks this agent to review a committed range. Every action names its recipients and needs a fresh readiness confirmation.</p>
        <p className="fine">The server owns every run, validates and deduplicates correlated completions, and pauses on unknown background work. No effect in this page sends commands. A completed chain is not final task acceptance.</p>
        <p className="fine">Viewing another worktree never changes a running relay. Pause a run before manual terminal takeover. Locking this view or disconnecting your phone does not interrupt workers.</p>
      </details>
    </div>
    </>}
  </main></MemoryContext.Provider>;
}
