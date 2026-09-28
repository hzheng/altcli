'use client';
import { BlockedHandoff } from './BlockedHandoff';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { CommandRecord, HostConfig, SessionRegistration } from '../contracts/api';
import type { HistoryExport, ManagedSession, RelayRun, Workspace, WorkspaceDiscovery, WorkspaceResetResult, WorkflowState } from '../contracts/workflow';
import type { ProjectWorktree } from '../contracts/projects';
import { TERMINAL_LIMITS } from '../contracts/terminals';
import { api, HttpError } from '../client/api';
import { MemoryContext, useRemembered, type PageMemory } from '../client/memory';
import { nameOf, workspaceKey, Workspaces } from './Workspaces';
import { RunPolicy } from './Implementation';
import { PlanningProgress } from './PlanningProgress';
import { PaneActions } from './PaneActions';
import { LaunchProfiles } from './LaunchProfiles';
import { NativeTerminal, type NativeTerminalHandle } from './NativeTerminal';
import { useKeyboardControls, keyboardOwnerOf } from './KeyboardSelector';
import { StatusIcon } from './Hint';
import { PlanSetup } from './PlanSetup';
import { CheckpointControls, InteractionComposer } from './InteractionControls';
import { RunSettingsBar, useRunSettings, type Phase } from './RunSettings';
import { MANUAL_ACKNOWLEDGEMENT, TakeControl } from './ControlAccess';
import { controlItems } from '../core/control-items';
const PREFERENCE = 'altcli.autoRelay';
const LAYOUT = 'altcli.paneLayout';
const CONTROL_PLACEMENT = 'altcli.controlPlacement';
const TURN_LIMIT = 'altcli.turnLimit';
const WORKSPACE = 'altcli.workspace';
/** Off by default: with the preference on, the token is kept in this browser so reopening the page unlocks without typing it. */
const STAY_UNLOCKED = 'altcli.stayUnlocked';
const SAVED_TOKEN = 'altcli.token';
const DEFAULT_TURN_LIMIT = 20;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString();
type Tab = 'console' | 'workspaces' | 'settings' | 'about';
/** The selected workspace card and the checkout it belongs to; the console shows the agents registered on that checkout. */
interface WorkspaceChoice { key: string; root: string; projectId?: string }
/** What one Take control confirmation clears, with the identities its requests are checked against. */
interface TakePlan { request: string | null; runs: { id: string; commandId: string; status: string; label: string }[]; delivery: string | null; manual: { id: string; revision: number }[] }
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
      ? `The controller is ${run.status === 'paused' ? 'paused but still holds' : run.status === 'waiting' ? 'waiting for you and still holds' : 'driving'} this agent's turns.${run.status === 'paused' ? ' Pause does not interrupt the worker.' : ''}` : 'Not driven by the controller.';
    return { badge: activity.state, detail: `${activity.detail} ${ownership}`, when: activity.updatedAt };
  }
  if (controller.badge === 'unknown' && activity?.state === 'unknown' && state.instances.find((i) => i.agentId === agent.id)?.status === 'current') {
    return { ...controller, detail: `A backend restart can clear activity evidence. Inspect this terminal before using Reset status. ${controller.detail}` };
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
  if (run?.status === 'stopped' && run.participants.some((p) => p.id === agent.id)) return { badge: 'unknown', detail: 'You took control back from the controller. This agent may still be working; taking over does not stop it. Inspect its terminal for current activity.', when: run.updatedAt };
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
  const [clientInstanceId] = useState(() => crypto.randomUUID());
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [stayUnlocked, setStayUnlocked] = useState(false);
  const [state, setState] = useState<WorkflowState | null>(null);
  const [discovery, setDiscovery] = useState<WorkspaceDiscovery | null>(null); const [discoveryError, setDiscoveryError] = useState('');
  const [tab, setTab] = useState<Tab | null>(null); const [workspace, setWorkspace] = useState<WorkspaceChoice | null>(null);
  const [text, setText] = useState(''); const [ready, setReady] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true); const [busy, setBusy] = useState(false); const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [updated, setUpdated] = useState(0);
  const [clock, setClock] = useState(Date.now()); const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [layout, setLayout] = useState<'parallel' | 'focus'>('parallel');
  // Phone widths show only the active pane (CSS); Control access offers to show a writer that is out of view.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => { const query = window.matchMedia('(max-width: 760px)'); const update = () => setNarrow(query.matches); update();
    query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  // Alternate placements of the one control pane: beside the stage on wide screens, or a drawer on phones. Never a second composer.
  const [controlPlacement, setControlPlacement] = useState<'below' | 'side'>('below');
  const [controlDrawer, setControlDrawer] = useState(false);
  const controlPane = useRef<HTMLElement>(null); const drawerToggle = useRef<HTMLButtonElement>(null);
  // The one Control access panel and its entry; the panel hosts the composers' readiness checks in this slot.
  const accessPanel = useRef<HTMLElement>(null); const accessEntry = useRef<HTMLButtonElement>(null); const stage = useRef<HTMLDivElement>(null);
  const [readinessSlot, setReadinessSlot] = useState<HTMLElement | null>(null);
  const terminals = useRef(new Map<string, NativeTerminalHandle>());
  const [turnLimit, setTurnLimit] = useState(String(DEFAULT_TURN_LIMIT));
  // One readiness slot for the whole console: the exact displayed state a confirmation was given for, so at most one card is ready.
  const [consent, setConsent] = useState('');
  const [recheckRevision, setRecheckRevision] = useState(0); const [viewEpoch, setViewEpoch] = useState(0);
  const [historyOrder, setHistoryOrder] = useState<'desc' | 'asc'>('desc');
  // The host's effective configuration, read once per unlock for the Settings tab.
  const [config, setConfig] = useState<HostConfig | null>(null); const [configError, setConfigError] = useState('');
  const submission = useRef(false); const generation = useRef(0); const readNumber = useRef(0); const discoveryRead = useRef(0);
  const scrolls = useRef<Partial<Record<Tab, number>>>({});
  useEffect(() => { try { if (localStorage.getItem(PREFERENCE) === 'false') setAutoContinue(false); if (localStorage.getItem(LAYOUT) === 'focus') setLayout('focus'); if (localStorage.getItem(CONTROL_PLACEMENT) === 'side') setControlPlacement('side');
    // A remembered token unlocks on load; the server still checks it on every request, and a refused one is forgotten.
    if (localStorage.getItem(STAY_UNLOCKED) === 'true') { setStayUnlocked(true); const saved = localStorage.getItem(SAVED_TOKEN); if (saved && /^[0-9a-f]{64}$/i.test(saved)) setToken(saved); }
    const limit = localStorage.getItem(TURN_LIMIT); if (limit && /^\d+$/.test(limit)) setTurnLimit(limit);
    // Remembered selections initialize the view only; the server validates every group at start.
    const saved = JSON.parse(localStorage.getItem(WORKSPACE) ?? 'null') as Partial<WorkspaceChoice> | null;
    if (typeof saved?.key === 'string' && typeof saved.root === 'string') setWorkspace({ key: saved.key, root: saved.root,
      ...(typeof saved.projectId === 'string' ? { projectId: saved.projectId } : {}) }); } catch { /* preference only */ } }, []);
  const limitValue = /^\d+$/.test(turnLimit) ? Number(turnLimit) : NaN; const limitValid = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 200;
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const read = ++readNumber.current; const version = generation.current;
    try { const next = await api<WorkflowState>(token, 'state', { signal });
      if (version === generation.current && read === readNumber.current) { setState(next); setUpdated(Date.now()); setError(''); }
    } catch (caught) { if (!signal?.aborted && version === generation.current && read === readNumber.current) {
      setError(caught instanceof Error ? caught.message : 'Connection failed.');
      // A token the host refuses must not keep unlocking this device.
      if (caught instanceof HttpError && caught.status === 401) { try { localStorage.removeItem(SAVED_TOKEN); } catch { /* preference only */ } }
    } }
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
  useEffect(() => {
    if (!token) return;
    const version = generation.current; const abort = new AbortController();
    api<HostConfig>(token, 'config', { signal: abort.signal }).then((next) => { if (version === generation.current) { setConfig(next); setConfigError(''); } })
      .catch((caught) => { if (!abort.signal.aborted && version === generation.current) setConfigError(caught instanceof Error ? caught.message : 'Could not read the host configuration.'); });
    return () => abort.abort();
  }, [token]);
  // First view: the console when agents are already named, otherwise setup. Later switches are the user's.
  useEffect(() => { if (state && tab === null) setTab(state.sessions.length ? 'console' : 'workspaces'); }, [state, tab]);
  // Both sections stay mounted; each keeps its own page scroll across switches.
  useEffect(() => { if (tab) window.scrollTo(0, scrolls.current[tab] ?? 0); }, [tab]);
  const showTab = (next: Tab) => { if (tab) scrolls.current[tab] = window.scrollY; setTab(next); };
  const sessions = state?.sessions ?? [];
  const project = workspace?.root ?? sessions[0]?.repository;
  const projectSessions = sessions.filter((s) => s.repository === project);
  const card = discovery?.workspaces.find((w) => workspace ? workspaceKey(w) === workspace.key : w.worktree.root === project);
  // Older preferences have only a path, which may already have been discarded. The retained operation still identifies its project.
  const previousProjects = discovery?.projects?.filter(p => [...(p.removals ?? []), ...(p.discards ?? [])].some(op => op.input.worktree.root === project)) ?? [];
  const selectedProject = workspace?.projectId ? discovery?.projects?.find(p => p.id === workspace.projectId)
    : discovery?.projects?.find(p => p.worktrees.some(w => w.path === project)) ?? (previousProjects.length === 1 ? previousProjects[0] : undefined);
  const selectedProjectId = selectedProject?.id;
  useEffect(() => {
    if (!workspace || workspace.projectId || !selectedProjectId) return;
    const choice = { ...workspace, projectId: selectedProjectId };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
  }, [workspace, selectedProjectId]);
  const selectedTree = selectedProject?.worktrees.find((w) => w.path === project);
  const missingTree = !!selectedProject && !selectedProject.error && !selectedTree && !discoveryError && !discovery?.error;
  const projectOptions = (discovery?.projects ?? []).map((p) => ({ project: p, firstAgentTree: [...p.worktrees]
    .sort((a, b) => Number(b.main) - Number(a.main))
    .find(tree => discovery?.workspaces.some(w => w.worktree.root === tree.path && w.agents.some(a => a.eligible || a.observable))) }));
  const worktreeOptions = [...(selectedProject?.worktrees ?? [])].sort((a, b) => Number(b.main) - Number(a.main));
  const setupHolds = discovery?.projects?.flatMap((p) => [...p.creations.filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => op.input.path),
    ...[...(p.removals ?? []), ...(p.updates ?? []), ...(p.renames ?? [])].filter((op) => ['applying', 'uncertain'].includes(op.status)).map((op) => op.input.worktree.root)]) ?? [];
  const setupHeld = !!project && setupHolds.includes(project);
  const groups = state?.groups ?? [];
  const pairs = groups.map((g) => ({ ...g, sessions: g.members }));
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
  const [paneChoice, setPaneChoice] = useRemembered<string | null>(`pane:${ws}`, null, memory);
  const [latestOpen, setLatestOpen] = useRemembered(`latest:${ws}`, false, memory);
  // Page memory, not per workspace: the entry and its panel serve every tab. Opening or closing never changes a run or a confirmation.
  const [accessOpen, setAccessOpen] = useRemembered('controlAccess', false, memory);
  // The phase shown for the next run is remembered per workspace, like its drafts, so returning to a workspace shows its own choice.
  const [phase, setPhase] = useRemembered<Phase>(`phase:${ws}`, 'implementation', memory);
  // The run/transition whose phase this workspace last followed: each transition is applied once, so a later click is never overridden.
  const [followedPhase, setFollowedPhase] = useRemembered<string | null>(`phaseFollowed:${ws}`, null, memory);
  const [settingsTab, setSettingsTab] = useRemembered<'preferences' | 'host'>('settingsTab', 'preferences', memory);
  // Stage relay is uncommitted review on main or the default branch; Commit relay needs a task branch. The mode is view state only.
  const [relayMode, setRelayMode] = useRemembered<'stage' | 'commit'>(`relayMode:${ws}`, 'stage', memory);
  const stageEligible = !!git?.stageRelay?.eligible;
  const stageAvailable = stageEligible && !!state?.legacyEnabled && pair?.sessions.length === 2;
  const visible = pair ? projectSessions.filter((s) => pair.sessions.includes(s.id)) : projectSessions;
  const inputBlocks = new Map(projectSessions.flatMap(s => {
    // By pane identity: discovered agents without a saved registration have no registeredAs.
    const pane = state?.panes.find(p => p.identity.socketPath === s.identity.socketPath && p.identity.paneId === s.identity.paneId);
    const reason = pane?.inMode ? 'Tmux copy mode. Automated input is blocked; exit copy mode in the terminal to resume.'
      : pane?.synchronized ? 'Tmux synchronized input is enabled. Disable it before using automated input.' : null;
    return reason ? [[s.id, reason] as const] : [];
  }));
  const groupInputBlock = visible.find(s => inputBlocks.has(s.id));
  const owned = (state?.runs ?? []).filter((r) => r.repository === project && ['running','waiting','paused'].includes(r.status));
  const transportHold = state?.reservations.find((r) => r.repository === project);
  // A finished run is current status only while its frozen participants are the agents shown here; a run of removed or
  // renamed-away agents is history and stays reachable under Command history.
  const latestRun = owned[0] ?? state?.runs.find((r) => r.repository === project && r.participants.every((p) => projectSessions.some((s) => s.id === p.id)));
  // The owned run's actual phase: a Plan run gains `implementation` in place when its frozen transition begins (planning data remains).
  // Only this worktree's owned run counts, never a completed run or another worktree.
  const phaseRun = owned[0];
  const runPhase: Phase | null = phaseRun?.implementation ? 'implementation' : phaseRun?.planning ? 'plan' : null;
  const runPhaseKey = phaseRun && runPhase ? `${phaseRun.id}:${runPhase === 'plan' ? 'plan' : phaseRun.planning?.frozen?.transitionId ?? 'implementation'}` : null;
  // Outside Plan, the terminals and Control share one frame behind a Terminal/Control switch. An owned run's actual phase decides, so
  // choosing the next run's phase never re-lays out an active Plan. The switch is view state only and is never changed by an effect.
  const layoutPhase = runPhase ?? phase; const merged = layoutPhase === 'implementation';
  const [surface, setSurface] = useRemembered<'terminal' | 'control'>(`surface:${ws}`, 'terminal', memory);
  const showTerminals = !merged || surface === 'terminal'; const showControl = !merged || surface === 'control';
  // View state only: this never sends, continues or decides anything. A plan key never rolls back a run already followed into Implementation.
  useEffect(() => {
    if (!runPhase || !runPhaseKey || runPhaseKey === followedPhase) return;
    if (runPhase === 'plan' && followedPhase?.startsWith(`${phaseRun!.id}:`)) return;
    setFollowedPhase(runPhaseKey); setPhase(runPhase);
  }, [runPhase, runPhaseKey, followedPhase, phaseRun, setFollowedPhase, setPhase]);
  const newest = state?.runs.find((r) => r.repository === project);
  const runMark = JSON.stringify(newest ? [newest.id, newest.status] : null);
  const statuses = new Map(state ? projectSessions.map((s) => [s.id, statusOf(s, latestRun, state)] as const) : []);
  const working = projectSessions.find((s) => ['working', 'sending'].includes(statuses.get(s.id)?.badge ?? ''))?.id ?? null;
  const lastActive = [...projectSessions].sort((a, b) => (statuses.get(b.id)?.when ?? '').localeCompare(statuses.get(a.id)?.when ?? ''))[0]?.id ?? null;
  // One selected agent is both the displayed pane (Focus, narrow layout) and the Control recipient. It starts on a working agent and
  // is then held, so a later working agent never retargets Control; only a click, or that agent leaving the view, changes it.
  const current = visible.find((s) => s.id === paneChoice) ?? visible.find((s) => s.id === working) ?? visible.find((s) => s.id === lastActive) ?? visible[0];
  const displayed = current?.id;
  useEffect(() => { if (displayed && displayed !== paneChoice) setPaneChoice(displayed); }, [displayed, paneChoice, setPaneChoice]);
  const groupInstances = visible.map((s) => [s.id, state?.instances.find((i) => i.agentId === s.id)?.status]);
  const readinessKey = JSON.stringify([pair, card?.agents, current?.id, current?.registrationId, groupInstances, [...inputBlocks], git?.branch, git?.head]);
  useEffect(() => { setConsent(''); setReady(false); setResetFor(null); }, [readinessKey, project]);
  // Readiness and confirmations attest to what was on screen, so any view switch revokes them. Drafts and choices stay.
  const viewKey = JSON.stringify([tab, phase, layout, displayed, merged && surface, relayMode]);
  useEffect(() => { setConsent(''); setReady(false); setResetFor(null); setViewEpoch((epoch) => epoch + 1); }, [viewKey]);
  const chooseLayout = (next: 'parallel' | 'focus') => { setLayout(next); try { localStorage.setItem(LAYOUT, next); } catch { /* preference only */ } };
  const chooseControlPlacement = (next: 'below' | 'side') => { setControlPlacement(next); try { localStorage.setItem(CONTROL_PLACEMENT, next); } catch { /* preference only */ } };
  const focusControlPane = () => controlPane.current?.focus();
  // Opening moves focus into the drawer; closing returns it to the toggle so the keyboard destination stays clear.
  const toggleDrawer = (open: boolean) => { setControlDrawer(open); requestAnimationFrame(() => open ? focusControlPane() : drawerToggle.current?.focus()); };
  const stale = !!error || clock - updated > 10000;
  const inputRun = owned[0] && (owned[0].implementation || owned[0].planning || owned[0].standalone) ? owned[0] : null;
  const showStage = stageAvailable && relayMode === 'stage' && phase === 'implementation' && !inputRun;
  // A reading that is not current cannot back a confirmation; readiness must be given again once it is.
  useEffect(() => { if (stale) { setConsent(''); setReady(false); } }, [stale]);
  // Every selected collaborator is validated by the server, including a peer that is not the command target.
  const resetAgents = visible.filter((s) => !s.registrationId || state?.instances.find((i) => i.agentId === s.id)?.status === 'replaced');
  const unknownAgents = state?.mode === 'tmux' ? visible.filter((s) => !resetAgents.includes(s) && state.instances.find((i) => i.agentId === s.id)?.status !== 'current') : [];
  const identityBlockedReason = resetAgents.length ? `Reset workspace required for ${resetAgents.map((s) => s.label).join(', ')}. Inspect the panes and use Reset workspace above before sending.`
    : unknownAgents.length ? `The host cannot confirm the CLI process for ${unknownAgents.map((s) => s.label).join(', ')}. Recheck before sending.` : '';
  // Gates shared by every card of this checkout, then each card's own agent.
  const manualHeld = !!state?.manualSessions?.length;
  // Distinguishes a live keyboard elsewhere from an unresolved record for the terminal badges.
  const liveManual = state?.manualSessions?.find((m) => m.live);
  const keyboardHolder = liveManual ? liveManual.clientInstanceId === clientInstanceId ? 'this-browser' as const : 'other-browser' as const : manualHeld ? 'unresolved' as const : null;
  const keyboardTarget = liveManual?.target;
  const keyboardAgent = keyboardTarget && 'agentId' in keyboardTarget ? visible.find(s => s.id === keyboardTarget.agentId && s.registrationId === keyboardTarget.registrationId) : undefined;
  const keyboardHandoff = liveManual && state?.manualSessions?.length === 1 && liveManual.clientInstanceId === clientInstanceId && !liveManual.runs.length && keyboardAgent ? {
    manual: liveManual, label: keyboardAgent.label, release: async (requestId: string) => {
      const terminal = terminals.current.get(keyboardAgent.id);
      if (!terminal) throw Error('The keyboard terminal is no longer connected. Inspect manual input before sending.');
      return terminal.releaseForSend(liveManual, requestId);
    },
  } : undefined;
  // The one server-wide keyboard as the server reports it, independent of the selected checkout.
  const keyboardOwner = keyboardOwnerOf(state?.manualSessions, clientInstanceId, () => keyboardAgent && { key: keyboardAgent.id, label: keyboardAgent.label },
    (target) => 'agentId' in target ? state?.sessions.find((s) => s.id === target.agentId && s.registrationId === target.registrationId)?.label : undefined);
  const affectedRuns = (state?.runs ?? []).filter((r) => ['running','waiting','paused'].includes(r.status)).map((r) => `${r.id} · ${r.status}`);
  const dispatchReason = identityBlockedReason
    || (groupInputBlock ? `${groupInputBlock.label}: ${inputBlocks.get(groupInputBlock.id)}` : '') || (stale ? 'The console is not current. Wait for it to reconnect.' : '')
    || (setupHeld ? 'A worktree operation is applying or uncertain. Reconcile it in Projects before starting work.' : '')
    || (!state?.inputEnabled ? 'Read-only console: the host has disabled input.' : '')
    || (owned.length ? 'The controller is driving the agents in this checkout. Wait for it to finish, or pause it and take control in Control access.' : '')
    || (transportHold ? 'An older uncertain delivery holds this workspace. Check its terminals, then take control in Control access.' : '')
    || (unknownRequest ? 'A request has an uncertain result. Check the terminal, then take control in Control access before sending again.' : '')
    || (checking ? 'Wait for Recheck to finish.' : '')
    || (!!pair && !limitValid ? 'Set the Stage relay maximum automatic turns to 1–200.' : '');
  const manualReason = manualHeld ? 'Manual terminal input holds dispatch across this server. Release and reconcile it in Control access first.' : '';
  const sharedReason = manualReason || dispatchReason;
  const implementationReason = (keyboardHandoff ? '' : manualReason) || dispatchReason;
  const cardReason = (s?: ManagedSession) => !s ? 'Choose an agent first.' : !s.registrationId ? `Recheck ${s.label} before sending: its identity is not registered.`
    : state?.snapshots.find((snapshot) => snapshot.agentId === s.id)?.status !== 'available' ? `${s.label}'s pane cannot be captured right now. Recheck before sending.` : '';
  const blocked = busy || !!sharedReason || !!cardReason(current);
  const resetKey = JSON.stringify([project, readinessKey]);
  const resetBlocked = busy || stale || setupHeld || owned.length > 0 || !!transportHold || !!unknownRequest || !project || !!discoveryError || !!discovery?.error;
  const workspaceError = discoveryError || discovery?.error || '';
  const select = (id: string) => { setPaneChoice(id); setReady(false); };
  const openAccess = (target: HTMLElement | null = null) => { setControlDrawer(false); setAccessOpen(true); requestAnimationFrame(() => { const destination = target ?? accessPanel.current; destination?.focus(); destination?.scrollIntoView({ block: target ? 'nearest' : 'start' }); }); };
  const closeAccess = () => { setAccessOpen(false); requestAnimationFrame(() => accessEntry.current?.focus()); };
  /** Inspection only: shows an agent's terminal and leaves Control access open. Changing the view clears earlier confirmations; nothing is sent. */
  const showAgentTerminal = (id: string) => { if (tab !== 'console') showTab('console'); select(id); if (merged) setSurface('terminal');
    requestAnimationFrame(() => stage.current?.scrollIntoView({ block: 'nearest' })); };
  const showControlSurface = () => { if (tab !== 'console') showTab('console'); if (merged) setSurface('control'); requestAnimationFrame(() => controlPane.current?.scrollIntoView({ block: 'nearest' })); };
  /** Moves focus to the already visible action; a still-current confirmation is kept. */
  const returnToAction = () => { controlPane.current?.focus(); controlPane.current?.scrollIntoView({ block: 'nearest' }); };
  // A card's terminal is on screen in the Console; Focus and phone widths show only the selected one.
  const inView = (id: string) => tab === 'console' && showTerminals && (id === displayed || (layout === 'parallel' && !narrow));
  const keyboard = useKeyboardControls({ owner: keyboardOwner, affected: affectedRuns, disabled: !token || busy || stale || !state?.inputEnabled || !config?.terminalEnabled,
    viewEpoch, refresh, options: visible.filter((s) => s.registrationId).map((s) => ({ key: s.id, label: s.label, inView: inView(s.id) })),
    handle: (key) => terminals.current.get(key), onShow: showAgentTerminal });
  const unknownActivity = projectSessions.filter((s) => state?.activities?.find((a) => a.agentId === s.id)?.state === 'unknown');
  const otherWorktrees = [...new Set((state?.manualSessions ?? []).flatMap((m) => m.runs)
    .map((r) => state?.runs.find((run) => run.id === r.id)?.repository).filter((repo): repo is string => !!repo && repo !== project))];
  const access = controlItems({ keyboard: keyboardOwner && { kind: keyboardOwner.kind, label: keyboardOwner.label },
    manual: (state?.manualSessions ?? []).map((m) => ({ live: m.live, runs: m.runs.length })), run: owned[0] ? { status: owned[0].status } : null, otherWorktrees,
    unknownRequest: !!unknownRequest, transportHold: !!transportHold && !owned.length, resetAgents: resetAgents.map((s) => s.label), unknownAgents: unknownAgents.map((s) => s.label),
    unknownActivity: unknownActivity.map((s) => s.label), inputBlocks: visible.filter((s) => inputBlocks.has(s.id)).map((s) => ({ label: s.label, reason: inputBlocks.get(s.id)! })),
    agentReason: current && state ? cardReason(current) : '', setupHeld, stale: !!state && stale, checking, inputEnabled: state?.inputEnabled !== false });
  function chooseWorkspace(chosen: Workspace) {
    const choice = { key: workspaceKey(chosen), root: chosen.worktree.root,
      projectId: discovery?.projects?.find(p => p.worktrees.some(w => w.path === chosen.worktree.root))?.id };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setReady(false); scrolls.current.console = 0; showTab('console');
  }
  function chooseWorktree(chosen: ProjectWorktree) {
    const choice = { key: `worktree:${chosen.id}`, root: chosen.path,
      projectId: discovery?.projects?.find(p => p.worktrees.some(w => w.id === chosen.id))?.id };
    setWorkspace(choice); try { localStorage.setItem(WORKSPACE, JSON.stringify(choice)); } catch { /* preference only */ }
    setReady(false); scrolls.current.console = 0; showTab('console');
  }
  function switchWorktree(chosen: ProjectWorktree) {
    const directories = discovery?.workspaces.filter(w => w.worktree.root === chosen.path) ?? [];
    if (directories.length === 1) chooseWorkspace(directories[0]!);
    else chooseWorktree(chosen);
  }
  /** Keeps or drops the token in this browser according to the preference. Lock always drops it. */
  function rememberToken(next: boolean, current = token) {
    setStayUnlocked(next);
    try { localStorage.setItem(STAY_UNLOCKED, String(next)); if (next && current) localStorage.setItem(SAVED_TOKEN, current); else localStorage.removeItem(SAVED_TOKEN); } catch { /* preference only */ }
  }
  function unlock(entered: string) {
    setToken(entered); setDraftToken('');
    if (stayUnlocked) try { localStorage.setItem(SAVED_TOKEN, entered); } catch { /* preference only */ }
  }
  function lock() {
    void api(token, 'terminals/revoke', {body:{clientInstanceId}}).catch(() => {});
    try { localStorage.removeItem(SAVED_TOKEN); } catch { /* preference only */ }
    generation.current++; readNumber.current++; discoveryRead.current++; setToken(''); setDraftToken(''); setState(null); setDiscovery(null); setTab(null); setReady(false);
    setMessage(''); setError(''); setDiscoveryError(''); setUnknownRequest(null); setResetFor(null); setConsent(''); setConfig(null); setConfigError('');
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
    if (blocked || !ready || !current || !pair || !git?.branch || submission.current) return;
    submission.current = true; setBusy(true); setReady(false);
    const requestId = crypto.randomUUID();
    try {
      const standalone = kind === 'instruction' && !handoff;
      // The run is bound to the branch and commit on screen; the server refuses a start or delivery after either changes.
      // Plain Send keeps the standalone contract, including instructions that deliberately change HEAD.
      const record = await api<CommandRecord>(token, standalone ? 'instructions' : 'commands', { body: standalone ? {
        requestId, agentId: current.id, groupId: pair.id, groupRevision: pair.revision, policy: 'peer',
        registrations: Object.fromEntries(pair.members.map((id) => [id, state?.sessions.find((session) => session.id === id)?.registrationId ?? ''])),
        text: text.trim(), confirmReady: true,
      } : { requestId, agentId: current.id, kind,
        ...(text.trim() ? { text: text.trim() } : {}), handoff, pairId: pair.id, turnLimit: limitValue,
        autoContinue: autoContinue && (kind === 'relay' || handoff), stage: { branch: git.branch, head: git.head }, confirmReady: true } });
      setMessage(`${record.status.toUpperCase()}: ${record.error ?? 'Terminal delivery recorded. The server owns this run until completion or human takeover.'}`);
      if (record.status !== 'rejected') setText('');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Command failed.');
      if (!(caught instanceof HttpError) || caught.status >= 500) setUnknownRequest(requestId);
    } finally { await refresh(); submission.current = false; setBusy(false); }
  }
  /** Pause and the controller's own continuations; taking control is `takeControl` below. */
  async function action(run: RelayRun, operation: 'pause' | 'continue' | 'recheck') {
    if (submission.current) return;
    submission.current = true; setBusy(true);
    try {
      await api(token, 'runs', { body: { runId: run.id, action: operation, ...(operation !== 'pause' ? { confirmReady: true } : {}), ...(['continue', 'recheck'].includes(operation) ? { expectedCommandId: run.currentCommandId } : {}), ...(operation === 'recheck' ? { expectedRevision: run.blockedHandoff?.revision } : {}) } });
      setMessage(operation === 'recheck' ? 'Handoff rechecked; the frozen continuation policy was applied.' : operation === 'continue' ? 'Next turn requested.' : 'Controller paused. The current agent was not interrupted.');
      if (operation !== 'pause') setReady(false);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Action failed.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  // The journal is app data: a repository clone cannot recover it, so the console offers it as a downloadable backup.
  async function exportHistory() {
    if (!project || submission.current) return;
    submission.current = true; setBusy(true);
    try {
      const history = await api<HistoryExport>(token, `history/export?repository=${encodeURIComponent(project)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `altcli-history-${nameOf(project)}-${history.exportedAt.replace(/[:.]/g, '-')}.json`;
      anchor.click(); URL.revokeObjectURL(url);
      setMessage(`Exported ${history.runs.length} run${history.runs.length === 1 ? '' : 's'} and ${history.journal.length} journal entr${history.journal.length === 1 ? 'y' : 'ies'} for ${project}.`);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'History export failed.'); }
    finally { submission.current = false; setBusy(false); }
  }
  /** Why an agent's unknown status cannot be reset right now, or empty. Shown beside the button, not only on hover. */
  const resetStatusReason = (s: ManagedSession) => owned.length ? 'Take control first: a status reset cannot resolve a command the controller still holds.'
    : transportHold ? 'Take control first: an older delivery still holds this checkout.'
    : !s.cliPid || state?.instances.find((i) => i.agentId === s.id)?.status !== 'current' ? 'Recover the CLI identity first: this pane cannot be matched to its saved instance.'
    : busy ? 'Wait for the current request to finish.' : '';
  /** One click, after the notes said what to check: marks a quiet agent Ready based on the user's own inspection of its terminal. */
  async function markReady(s: ManagedSession) {
    const activity = state?.activities?.find((a) => a.agentId === s.id);
    if (!activity || submission.current) return;
    submission.current = true; setBusy(true);
    try {
      await api(token, 'activities/reset', { body: { agentId: s.id, registrationId: s.registrationId, expectedUpdatedAt: activity.updatedAt, confirmReady: true } });
      setMessage(`Status reset to Ready for ${s.label} based on your terminal inspection. Workspace configuration is preserved.`);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Status recovery failed.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  /** One confirmation, then the existing requests in order: clear the uncertain-request warning, end this checkout's controller runs,
   * release an older delivery hold, and record the decision on earlier manual input. Each request keeps its server checks and expected
   * identity; the first refusal or unknown response stops the rest and says what already happened. Nothing is retried. */
  async function takeControl(plan: TakePlan) {
    if (submission.current) return;
    submission.current = true; setBusy(true); setConsent(''); setReady(false);
    const done: string[] = [];
    try {
      if (plan.request) { setUnknownRequest(null); done.push('cleared the uncertain-request warning'); }
      for (const run of plan.runs) {
        await api(token, 'runs', { body: { runId: run.id, action: 'takeover', confirmReady: true, expectedCommandId: run.commandId } });
        done.push(`ended the controller's run for ${run.label}`);
      }
      if (plan.delivery) {
        await api(token, 'control/release', { body: { expectedCommandId: plan.delivery, confirmReady: true } }); done.push('released the older delivery hold');
      }
      for (const manual of plan.manual) {
        await api(token, 'terminals/reconcile', { body: { requestId: crypto.randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision, confirmInspected: true, note: MANUAL_ACKNOWLEDGEMENT } });
        done.push('recorded your decision on earlier manual input');
      }
      setMessage(`You have control: ${done.join('; ')}. Nothing was replayed, interrupted or marked successful.`);
    } catch (caught) {
      const unknown = !(caught instanceof HttpError) || caught.status >= 500;
      setMessage(`${unknown ? 'The last step’s result is unknown' : 'Stopped'}: ${caught instanceof Error ? caught.message : 'Taking control failed.'} ${done.length ? `Already done: ${done.join('; ')}.` : 'No steps were confirmed complete.'} ${unknown ? 'The last step may have completed; later steps were not sent. ' : ''}Nothing was retried; check the current state before trying again.`);
    } finally { await refresh(); submission.current = false; setBusy(false); }
  }
  if (!token) return <main className="unlock-shell">
    <div className="wordmark"><span className="brand-mark">A</span> AltCLI</div>
    <section className="unlock-card"><p className="eyebrow">YOUR AGENTS. ONE CONSOLE.</p><h1>Stay in control.</h1>
      <form onSubmit={(e) => { e.preventDefault(); unlock(draftToken.trim()); }}>
        <label htmlFor="token">Host access token</label><input id="token" type="password" autoComplete="off" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} required />
        <button className="primary">Open console</button>
      </form><p className="fine">{stayUnlocked ? 'This device stays unlocked until you press Lock (a Settings preference); the token is kept in this browser.' : 'The token stays in page memory.'} Locking or closing this page does not pause a server-owned run.</p>
    </section></main>;
  const feedback = message && <p className="feedback" role="status">{message}</p>;
  // Separates the terminal stage from a group-wide command section below it; decorative, the section names itself.
  const commandDivider = <div className="command-divider" aria-hidden="true"><span>⌨️ Command</span></div>;
  // Connection to this host only; it says nothing about agent activity or readiness. The last update moves into the help text.
  const lastUpdate = updated ? new Date(updated).toLocaleTimeString() : 'never';
  const connection = <div className="connection">{!updated && !error
    ? <StatusIcon icon="⏳" label="Connecting" align="end" help="Connecting to the host. Actions stay disabled until the first update arrives." />
    : stale ? <StatusIcon icon="🔴" label="Not current" align="end" help={`Not current: ${error || 'no update for more than 10 seconds'}. Last update ${lastUpdate}. Actions that depend on current state stay disabled until the console reconnects.`} />
    : <StatusIcon icon="🟢" label="Connected" align="end" help={`Connected to the host. Last update ${lastUpdate}; the console refreshes every 2 seconds.`} />}</div>;
  const keyboardLabel = !keyboardOwner || keyboardOwner.kind === 'unresolved' ? 'nobody' : keyboardOwner.kind === 'this-browser' ? `${keyboardOwner.label} (this browser)` : keyboardOwner.label;
  // The global Control access entry, then the server-wide keyboard owner, then connection status: on every tab.
  const headingStatus = <div className="heading-status">
    {state && <button type="button" ref={accessEntry} className={`quiet access-entry${access.attention ? ' attention' : ''}`} aria-expanded={accessOpen} aria-controls="control-access"
      onClick={() => accessOpen ? closeAccess() : openAccess()}>{access.attention && <span aria-hidden="true">⚠ </span>}Control access · {access.summary}{access.attention && <span className="sr-only"> (action needed)</span>}</button>}
    {state && (config?.terminalEnabled || manualHeld) && <StatusIcon icon="⌨️" label={`Keyboard: ${keyboardLabel}`} align="end"
      help={`Server-wide keyboard: ${keyboardLabel}. ${stale ? 'This is the last reported owner; the console is not current. ' : ''}Claim it with ⌨️ at the terminal where you want to type. Release and reconciliation are in Control access.`} />}
    {connection}
  </div>;
  const actionable = !!pair && members.length <= 2;
  // What one Take control confirmation would clear, as observed now; each step carries the identity its request is checked against.
  const unresolvedManual = (state?.manualSessions ?? []).filter((m) => !m.live);
  const takePlan: TakePlan = { request: unknownRequest, runs: owned.map((r) => ({ id: r.id, commandId: r.currentCommandId, status: r.status, label: r.participants.map((p) => p.label).join(' ⇄ ') })),
    delivery: !owned.length && transportHold ? transportHold.activeCommandId : null, manual: unresolvedManual.map((m) => ({ id: m.id, revision: m.revision })) };
  const takeSteps = [
    ...(takePlan.request ? [`Clear the warning for request ${takePlan.request}; nothing is resent.`] : []),
    ...takePlan.runs.map((r) => `End the controller’s ${r.status} run for ${r.label}; it stops sending and judging turns.`),
    ...(takePlan.delivery ? ['Release the older delivery hold; nothing is replayed.'] : []),
    ...(takePlan.manual.length ? [`Record that you accept possible effects of earlier manual input (${takePlan.manual.length === 1 ? 'one record' : `${takePlan.manual.length} records`}), lifting the server-wide hold. Runs in other worktrees keep their own holds.`] : []),
  ];
  // The composer on screen in Control, mirroring its render conditions below. Its readiness check is shown only in Control access, and
  // only while the Console shows that composer, so a confirmation always attests to the action on screen.
  const composer = !projectSessions.length ? null : showStage ? 'stage' : inputRun ? current ? 'input' : null
    : phase === 'plan' ? 'plan' : current && actionable && phase === 'implementation' ? 'implementation' : null;
  const readinessHere = !!composer && tab === 'console' && showControl;
  const settings = phase === 'plan' ? planSettings : implementationSettings;
  const settingsNotice = !pair ? 'Select at least one agent in Projects to start.' : members.length > 2
    ? `Your group has ${members.length} agents. Plan and Implementation currently execute with one or two agents; larger-group execution is not enabled yet. Your selection is saved. Choose one or two members to start a run.` : '';
  // Discovery and the saved session share a full pane identity: pane, socket and tmux server.
  const locationOf = (s: ManagedSession) => card?.agents.find((a) => a.identity.paneId === s.identity.paneId && a.identity.socketPath === s.identity.socketPath
    && a.identity.serverPid === s.identity.serverPid && a.identity.serverStarted === s.identity.serverStarted)?.location;
  const common = { token, state: state!, git, workspaceError, agentsKey: JSON.stringify([card?.agents ?? null, [...inputBlocks]]), busy, submit: guarded, consent, setConsent, runMark,
    recheck: recheckRevision, refresh, onRecheck: recheckAll, onMessage: setMessage, onUncertain: setUnknownRequest, readinessSlot };
  return <MemoryContext.Provider value={memory}><main className="console-shell">
    <header className="topbar"><div className="wordmark"><span className="brand-mark">A</span> AltCLI</div>
      <nav className="section-tabs" aria-label="Sections">
        <button type="button" className={tab === 'console' ? 'selected' : ''} aria-pressed={tab === 'console'} onClick={() => showTab('console')}>Console</button>
        <button type="button" className={tab === 'workspaces' ? 'selected' : ''} aria-pressed={tab === 'workspaces'} onClick={() => showTab('workspaces')}>Projects</button>
        <button type="button" className={tab === 'settings' ? 'selected' : ''} aria-pressed={tab === 'settings'} onClick={() => showTab('settings')}>Settings</button>
        <button type="button" className={tab === 'about' ? 'selected' : ''} aria-pressed={tab === 'about'} onClick={() => showTab('about')}>About</button></nav>
      <div className="toolbar">{state?.mode === 'mock' && <span className="muted toolbar-note">Simulated panes. No commands reach real terminals.</span>}
        <span className="badge">{state?.mode === 'mock' ? 'MOCK MODE' : 'LOCAL HOST'}</span>
        <button className="quiet" onClick={lock} disabled={busy}>Lock</button></div></header>
    {tab === 'workspaces' ? <div className="page-heading"><div><p className="eyebrow">PROJECT · WORKTREE · TASK</p><h1>Projects and agents</h1>
        <p className="muted">Choose an existing worktree or explicitly create one for a new task. Opening a console never starts work.</p></div>{headingStatus}</div>
      : tab === 'settings' ? <div className="page-heading compact"><h1>Settings</h1>{headingStatus}</div>
      : tab === 'about' ? <div className="page-heading compact"><h1>About AltCLI</h1>{headingStatus}</div>
      : <div className="page-heading compact"><h1>Agent console</h1>{headingStatus}</div>}
    {error && <div className="notice error" role="alert">{error} <button onClick={() => void refresh()}>Refresh</button></div>}
    {state && <>
      {/* The one Control access panel: workflow takeover, recovery and action readiness appear here once. Keyboard claims stay at their terminals. It sits outside the
          tab and surface guards, so recovery stays reachable on any tab and with no agents. Opening or closing it changes nothing. */}
      <section id="control-access" ref={accessPanel} tabIndex={-1} className="panel control-access" aria-label="Control access" hidden={!accessOpen}>
        <div className="section-heading"><h2>Control access</h2><button type="button" className="quiet" onClick={closeAccess}>Close</button></div>
        <p className="fine access-scope">{project ? <>Checkout <span className="mono">{project}</span></> : 'No checkout selected'}{current ? <> · selected agent <strong>{current.label}</strong></> : ''}
          {' · '}workflow {owned[0] ? `${owned[0].status} (controller)` : 'not driven by the controller'}
          {' · '}keyboard {keyboardLabel}</p>
        {!!access.items.length && <><h3>Before you take control</h3>
        <ul className="access-items" aria-label="What to notice">{access.items.map((item) => <li key={item.id} className={item.attention ? 'attention' : undefined}>
          <span className="badge">{item.scope === 'server' ? 'Server-wide' : 'This checkout'}</span> <span>{item.text}</span>
          {item.id === 'setup' && <button type="button" className="quiet inline-link" onClick={() => showTab('workspaces')}>Open Projects</button>}
          {(item.id === 'process' || item.id === 'agent') && <button type="button" className="quiet inline-link" disabled={busy || checking} onClick={recheckNow}>Recheck agents</button>}</li>)}
          {unresolvedManual.map((m) => <li key={m.id} className="muted">Earlier manual input: {m.reason} {m.bytes} input bytes · {m.runs.length} affected runs.</li>)}</ul></>}
        {/* Optional, one click each, once nothing holds this checkout: the notes above say what to look at first. */}
        {!owned.length && unknownActivity.map((s) => { const block = resetStatusReason(s);
          return <div key={s.id} className="pane-buttons access-agent" role="group" aria-label={`Status of ${s.label}`}>
            {visible.some((v) => v.id === s.id) && <button type="button" className="quiet" onClick={() => showAgentTerminal(s.id)}>Show {s.label} terminal</button>}
            <button type="button" disabled={!!block} title={block || `Once ${s.label}'s terminal shows an empty prompt with no background writers. This does not restart the CLI or certify a turn.`} onClick={() => void markReady(s)}>Mark {s.label} Ready</button>
            {block && <span className="reset-reason">{block}</span>}</div>; })}
        {!!resetAgents.length && <div className="access-item" role="group" aria-label="Workspace reset">
          <div className="pane-buttons"><button type="button" className="quiet" disabled={busy || checking} onClick={recheckNow}>{checking ? 'Checking…' : 'Recheck agents'}</button>
            {resetFor !== resetKey && <button type="button" disabled={resetBlocked} onClick={() => setResetFor(resetKey)}>Reset workspace…</button>}</div>
          {resetFor === resetKey && <><p>Reset saved names and group selection for every agent on <span className="mono">{project}</span>? Live agents will appear with their default names. Files, commits, running CLIs and command history are kept.</p>
            <div className="pane-buttons"><button type="button" disabled={resetBlocked} onClick={() => void resetWorkspace()}>Confirm workspace reset</button>
            <button type="button" disabled={busy} onClick={() => setResetFor(null)}>Keep configuration</button></div></>}</div>}
        {takeSteps.length ? <TakeControl key={JSON.stringify([takePlan, viewEpoch])} steps={takeSteps} disabled={busy} onConfirm={() => void takeControl(takePlan)}
          onPause={owned.some((r) => r.status !== 'paused') ? () => { for (const run of owned.filter((r) => r.status !== 'paused')) void action(run, 'pause'); } : undefined} />
          : <p className="fine">No controller run, uncertain delivery or earlier manual input needs takeover.
            {liveManual && ' The keyboard still holds dispatch; check its owner in the notes above.'}</p>}
        {config?.terminalEnabled && <section className="access-section" aria-label="Keyboard"><h3>Keyboard <span className="muted">· server-wide</span></h3>
          {keyboard.recovery}</section>}
        <section className="access-section" aria-label="Workflow"><h3>Controller <span className="muted">· this checkout</span></h3>
          {owned.map((run) => <section key={run.id} className="panel run-card" aria-label="Who controls the agents">
            <div className="section-heading"><h2>{run.status === 'paused' ? 'Controller paused · inspect the checkpoint' : run.status === 'waiting' ? 'Controller waiting for your Next turn' : 'Controller is driving the agents'}</h2><span className="badge">{run.automaticTurns}/{run.turnLimit} automatic turns</span></div>
            <p><span className="badge">{run.implementation ? 'IMPLEMENTATION' : run.planning ? 'PLAN' : run.standalone ? 'STANDALONE' : run.stage ? 'STAGE RELAY' : 'STAGE RELAY (PRE-UPGRADE)'}</span> {run.participants.map((s) => s.label).join(' ⇄ ')} · {run.implementation?.group.name ?? run.planning?.group.name ?? run.pairId ?? 'single-agent turn'}</p>
            {(() => { // Which command this run owns: the current turn's target and its text, so a paused run is recognisable.
              const turn = state.executions.find((e) => e.commandId === run.currentCommandId);
              const text = run.standalone?.text ?? turn?.input.text ?? '';
              const target = run.participants.find((p) => p.id === turn?.agentId)?.label;
              return text || target ? <p className="run-command">{target ? <>{turn?.status === 'delivered' || turn?.status === 'finished' ? 'Sent to' : 'For'} <strong>{target}</strong>{text ? ': ' : ''}</> : ''}{text && <span className="command-text" title={text}>“{text.length > 160 ? `${text.slice(0, 160)}…` : text}”</span>}</p> : null;
            })()}
            <p>{run.reason}</p>
            {run.status === 'paused' && run.blockedHandoff && <BlockedHandoff key={`${run.blockedHandoff.revision}:${viewEpoch}`} handoff={run.blockedHandoff}
              disabled={busy || stale || !state.inputEnabled || !!state.manualSessions?.some(s => s.live || s.reconciliationRequired)} onRecheck={() => void action(run, 'recheck')} />}
            <p className="fine run-meaning">The controller is this server: while it drives this checkout it decides what these agents are sent next and judges their completions. Agents: {run.participants.map((p) => `${p.label} ${statuses.get(p.id)?.badge ?? 'unknown'}`).join(' · ')}.{run.status === 'paused' ? ' The controller is paused, not the agents.' : ''}</p>
            {run.implementation && <p className="mono">{run.implementation.policy} · {run.implementation.branch} · turn {run.implementation.turn} · accepted {run.implementation.acceptedSha.slice(0, 12)}{run.implementation.candidateSha ? ` · candidate ${run.implementation.candidateSha.slice(0, 12)}` : ''}</p>}
            {run.planning && <PlanningProgress token={token} run={run} git={card?.git} disabled={busy || stale || !state.inputEnabled} refresh={refresh} onMessage={setMessage} onStop={() => void action(run, 'pause')} viewEpoch={viewEpoch} />}
            {run.status === 'waiting' && (run.implementation || run.planning?.next) && <button disabled={busy || stale || !state.inputEnabled} onClick={() => void action(run, 'continue')}>{run.planning && !run.implementation ? 'I checked readiness — Next planning turn' : 'I checked readiness — Next turn'}</button>}
            {run.status === 'waiting' && run.implementation && <RunPolicy key={`${run.id}:${run.implementation.revision}`} token={token} run={run} disabled={busy || stale} onChanged={refresh} onMessage={setMessage} />}
            {/* Letting the controller continue is the alternative to taking control above. */}
            {run.status === 'paused' && state.checkpoints?.filter((cp) => cp.runId === run.id && cp.commandId === run.currentCommandId).map((cp) => <CheckpointControls key={`${cp.runId}:${cp.revision}`} token={token} checkpoint={cp} disabled={busy || stale || !state.inputEnabled} refresh={refresh} />)}
          </section>)}
          {latestRun && !owned.some((r) => r.id === latestRun.id) && <details className="panel latest-run" open={latestOpen} onToggle={(e) => setLatestOpen(e.currentTarget.open)}>
            <summary><h2>Last command the controller drove</h2><span className={`badge ${latestRun.status === 'stopped' ? 'warning' : ''}`}>{latestRun.status === 'stopped' ? 'CONTROL RETURNED TO YOU' : latestRun.status.toUpperCase()} · {latestRun.automaticTurns}/{latestRun.turnLimit} automatic turns</span></summary>
            <p className="muted">{latestRun.participants.map((p) => p.label).join(' ⇄ ')}{latestRun.implementation ? ` (group "${latestRun.implementation.group.name}")` : latestRun.planning ? ` (planning group "${latestRun.planning.group.name}")` : latestRun.pairId ? ` (group "${latestRun.pairId}")` : ' (single-agent turn)'} · {latestRun.reason} · {timeOf(latestRun.updatedAt)}</p>
            {latestRun.implementation?.latestPublication && <p className="muted">{latestRun.implementation.latestPublication.sha === latestRun.implementation.latestPublication.entry.parent ? 'Report only, no commit' : <>Commit <span className="mono">{latestRun.implementation.latestPublication.sha.slice(0, 12)}</span></>} · {latestRun.implementation.latestPublication.entry.summary}<br />
              Checks reported by the agent: {latestRun.implementation.latestPublication.entry.checks.join('; ') || 'none reported'}</p>}
            {latestRun.planning && <details><summary>Retained plan and authorization</summary>
              <PlanningProgress token={token} run={latestRun} disabled refresh={refresh} onMessage={setMessage} onStop={() => {}} /></details>}
          </details>}
          {!owned.length && !latestRun && <p className="fine">The controller is not driving this checkout: no command is in flight, and nothing it drove earlier involves the agents shown here.</p>}
        </section>
        <section className="access-section" aria-label="Action readiness"><h3>Action readiness</h3>
          {!composer ? <p className="fine">No action is available for this checkout.</p>
            : !readinessHere && <p className="fine">{tab !== 'console' ? 'Readiness is confirmed while the Console shows its action.' : 'Show Control to confirm readiness for its action. Changing the view clears an earlier confirmation, so return from inspecting terminals before confirming.'}
              <button type="button" className="quiet inline-link" onClick={showControlSurface}>{tab !== 'console' ? 'Go to Console' : 'Show Control'}</button></p>}
          {/* Each composer renders its own check here; its consent key and checked state stay with that composer. */}
          <div ref={setReadinessSlot} className="readiness-slot" hidden={!readinessHere} />
          {showStage && <div hidden={!readinessHere}><label className="readiness"><input type="checkbox" aria-label="Ready to send" checked={ready} disabled={blocked} onChange={(e) => setReady(e.target.checked)} />
            I checked that all participants are at empty prompts, have no background writers, use their standard Git index, and will remain under controller ownership for this run.</label>
            <p className="fine">Applies to the Stage relay actions for {current?.label}.</p></div>}
          {readinessHere && <button type="button" className="quiet" onClick={returnToAction}>Return to action</button>}
        </section>
      </section>
    <div className="section-panel" hidden={tab !== 'workspaces'}>
      {feedback}
      <Workspaces token={token} disabled={busy} discovery={discovery} discoveryError={discoveryError} onRecheck={() => recheck()}
        inputEnabled={state.inputEnabled} runs={state.runs} selectedRoot={project ?? null} onSelectWorktree={chooseWorktree}
        deliveryRepositories={state.reservations.map((reservation) => reservation.repository)}
        launchEnabled={config?.launchEnabled === true} manualHeld={manualHeld} sessions={sessions} pairs={groups} lockedRepositories={[...setupHolds, ...state.runs.filter((run) => ['running','waiting','paused'].includes(run.status)).map((run) => run.repository)]}
        onSelectWorkspace={chooseWorkspace} viewEpoch={viewEpoch}
        onChanged={async (notice) => { setMessage(notice); await Promise.all([refresh(), recheck()]); }} />
    </div>
    <div className="section-panel" hidden={tab !== 'console'}>
      <div className="context-bar">
        <div className="context-project">
          <div className="context-switches">
            <label>Project<select aria-label="Switch project" value={selectedProject?.id ?? ''} disabled={!projectOptions.length} onChange={event => {
              const tree = projectOptions.find(option => option.project.id === event.target.value)?.firstAgentTree; if (tree) switchWorktree(tree);
            }}>
              {!selectedProject && <option value="" disabled>Choose project</option>}
              {projectOptions.map(({ project: p, firstAgentTree }) => <option key={p.id} value={p.id} disabled={!firstAgentTree}>{p.name}{firstAgentTree ? '' : ' — no agents'}</option>)}
            </select></label>
            <label>Worktree<select aria-label="Switch worktree" title={project} value={selectedTree?.id ?? ''} disabled={!worktreeOptions.length} onChange={event => {
              const tree = worktreeOptions.find(t => t.id === event.target.value); if (tree) switchWorktree(tree);
            }}>
              {!selectedTree && <option value="" disabled>Choose worktree</option>}
              {/* The branch is shown to the right; the option names the checkout by its path only. */}
              {worktreeOptions.map(tree => <option key={tree.id} value={tree.id}>{tree.main ? `Main checkout · ${tree.path}` : tree.path}</option>)}
            </select></label>
          </div>
          {project && <span className="mono muted" title={project}>{project}</span>}
        </div>
        {(card || selectedTree) && <span>Branch <span className="mono">{(card ?? selectedTree)?.branch ?? 'detached HEAD'}</span>{git && <span className="mono muted"> @ {git.head.slice(0, 7)} · {git.clean ? 'clean' : `${git.changeCount} uncommitted`}{git.integration ? ' · integration branch' : ''}</span>}</span>}
        <span>{pair ? <>Group <strong>{pair.name}</strong> <span className="muted">{pair.sessions.map((id) => sessions.find((s) => s.id === id)?.label ?? id).join(' ⇄ ')}</span></> : <span className="muted">No group in use</span>}</span>
        <span className="context-actions"><button type="button" className="quiet" disabled={busy || checking} onClick={recheckNow}>{checking ? 'Checking…' : 'Recheck'}</button>
          <button type="button" className="quiet" onClick={() => showTab('workspaces')}>Projects →</button></span>
      </div>
      {(workspaceError || card?.gitError) && <p className="notice error" role="alert">{workspaceError || card?.gitError} Recheck before starting.</p>}
      {setupHeld && <p className="notice">This worktree operation is applying or uncertain. Inspect and reconcile its result in Projects before starting work.</p>}
      {unknownRequest && <div className="notice error" role="alert">Request {unknownRequest} has an uncertain HTTP result. Inspect its server run and the terminal; do not resend it.
        Check the terminal, then take control in Control access to clear it.</div>}
      {!!resetAgents.length && <section className="notice" aria-label="Agent identity changed">
        <p>{owned.length ? 'CLI identity changed for' : 'Workspace reset required for'} {resetAgents.map((s) => s.label).join(', ')}. A saved CLI identity is outdated. Inspect these panes and confirm the intended CLIs are running.</p>
        {owned.length ? <p>The controller is still driving the agents in this checkout. Pause it in Control access, inspect every participant, then take control. A restarted CLI in the same pane and directory will then be rediscovered automatically, keeping names and group settings.</p>
          : <p>The controller is not driving this checkout, so there is nothing to pause or take over. This pane still cannot be matched to its saved identity. Inspect it before resetting the workspace configuration, then confirm readiness before sending again.</p>}
        {setupHeld && <p>A setup operation still owns this checkout. Reconcile it in Projects before resetting.</p>}
        <p>Recheck, or reset the workspace, in Control access.</p>
      </section>}
      {!!unknownAgents.length && <div className="notice">The host cannot confirm the CLI process for {unknownAgents.map((s) => s.label).join(', ')}. Recheck before sending.</div>}
      {transportHold && !owned.length && <div className="notice">An older uncertain delivery holds this workspace. Inspect its terminals and any partially typed input before taking control in Control access. Nothing is replayed.</div>}
      {feedback}
      {!projectSessions.length && <section className="panel empty-console"><h2>No eligible agents here yet</h2>
        <p className="muted">{missingTree ? <>This worktree is no longer available. Choose another worktree in {selectedProject.name}.</> : selectedProject?.error ?? selectedTree?.error ?? card?.agents.find((agent) => agent.reason && (agent.kind === 'codex' || agent.kind === 'claude'))?.reason ?? (project ? <>Start coding CLIs in <span className="mono">{project}</span>, then Recheck in Projects. Collaborators need the same directory. No registration is needed.</> : 'Choose a project and worktree with running coding agents. Nothing is sent until you explicitly start work.')}</p>
        <button type="button" className="primary" onClick={() => showTab('workspaces')}>Open Projects</button></section>}
      {!!projectSessions.length && <>
        <RunSettingsBar settings={settings} git={git} members={members} sessions={sessions} displayed={current?.id} disabled={busy || !!(phase === 'implementation' && !showStage ? implementationReason : sharedReason)} notice={settingsNotice} stage={showStage} onPhase={setPhase} />
        {/* Watch zone: a recessed stage of terminal captures. Commands sit under each capture or below the stage, never over it. */}
        {/* Outside Plan this is one frame: the switch shows the terminals or Control, and the hidden surface stays mounted. */}
        <div className={`workbench${merged ? ` merged ${surface}` : controlPlacement === 'side' ? ' side' : ''}`}>
        <div className="terminal-stage" ref={stage}>
        <div className="target-row"><h2 className="stage-title"><span aria-hidden="true">🖥️</span> {config?.terminalEnabled ? <>Native terminals <span className="stage-cue">native CLI · claim keyboard at a terminal{merged ? '' : ' · controls below'}</span></> : <>Live terminals <span className="stage-cue">captured output{merged ? '' : ' · controls below'}</span></>}</h2>
          {/* The one agent selector: the shown terminal and the Control recipient together. It never selects the keyboard writer. */}
          <div className="stage-target"><span className="target-caption">Agent</span><nav className="agent-tabs" aria-label="Agent">{visible.map((s) => <button key={s.id} className={s.id === displayed ? 'selected' : ''} aria-pressed={s.id === displayed} onClick={() => select(s.id)}>
            <Icon badge={statuses.get(s.id)?.badge ?? 'unknown'} />{s.label}</button>)}</nav></div>
          <div className="row-tools">
            {/* Outside Plan: which surface the frame shows. Switching is view state only; it clears confirmations and sends nothing. */}
            {merged && <div className="segmented surface-switch" role="group" aria-label="Terminal or Control">
              <button type="button" className={surface === 'terminal' ? 'selected' : 'quiet'} aria-pressed={surface === 'terminal'} onClick={() => setSurface('terminal')}>Terminal</button>
              <button type="button" className={surface === 'control' ? 'selected' : 'quiet'} aria-pressed={surface === 'control'} onClick={() => setSurface('control')}>Control</button></div>}
            {showTerminals && <div className="segmented" role="group" aria-label="Pane layout">
              <button className={layout === 'parallel' ? 'selected' : 'quiet'} aria-pressed={layout === 'parallel'} onClick={() => chooseLayout('parallel')}>Parallel</button>
              <button className={layout === 'focus' ? 'selected' : 'quiet'} aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}>Focus</button></div>}
            {/* Plan only. Wide screens (CSS): where the one control pane sits. */}
            {!merged && <div className="segmented control-placement" role="group" aria-label="Control pane placement">
              <button className={controlPlacement === 'below' ? 'selected' : 'quiet'} aria-pressed={controlPlacement === 'below'} onClick={() => chooseControlPlacement('below')}>Control below</button>
              <button className={controlPlacement === 'side' ? 'selected' : 'quiet'} aria-pressed={controlPlacement === 'side'} onClick={() => chooseControlPlacement('side')}>Control beside</button></div>}
            {/* Plan only. Phones (CSS): the same control pane as a bottom drawer. */}
            {!merged && <button type="button" ref={drawerToggle} className="quiet drawer-toggle" aria-expanded={controlDrawer} aria-controls="altcli-control"
              onClick={() => toggleDrawer(!controlDrawer)}>{controlDrawer ? 'Close control drawer' : 'Open control drawer'}</button>}</div></div>
        {/* With Control shown, the selected agent's status stays on screen. */}
        {merged && surface === 'control' && current && statuses.get(current.id) && <div className="stage-status" role="group" aria-label={`${current.label} status`}>
          <span className="state"><Icon badge={statuses.get(current.id)!.badge} />{statuses.get(current.id)!.badge}</span><span className="pane-detail" title={statuses.get(current.id)!.detail}>{statuses.get(current.id)!.detail}</span>
          {statuses.get(current.id)!.when && <span className="mono muted">{timeOf(statuses.get(current.id)!.when!)}</span>}
          <button type="button" className="quiet inline-link" onClick={() => showAgentTerminal(current.id)}>Show {current.label} terminal</button></div>}
        <section className={`panes ${layout}`} aria-label="Agent output" hidden={!showTerminals}>{visible.map((s) => {
          const snapshot = state.snapshots.find((p) => p.agentId === s.id);
          const execution = state.executions.find((e) => e.agentId === s.id);
          const ended = state.turns.find((t) => t.agentId === s.id && t.receivedAt >= s.registeredAt);
          // While this pane has a command in flight, an older accepted outcome must not look like that command's result. A
          // participant whose turn is over keeps its label (an objection reason stays readable while the partner corrects).
          const visibleOutcome = !execution || ended?.commandId === execution.commandId ? ended : undefined;
          const status = statuses.get(s.id)!; const activity = state.activities?.find((a) => a.agentId === s.id);
          const location = locationOf(s);
          return <article key={s.id} aria-label={`${s.label} pane`} hidden={layout === 'focus' && s.id !== displayed} className={`pane ${s.id === displayed ? 'active' : ''}`}>
            {/* A pointer shortcut for the Agent selector above, for Parallel where every card is visible. */}
            <div className="pane-heading" onClick={() => { if (s.id !== displayed) select(s.id); }}><h2><Icon badge={status.badge} />{s.label}</h2><span className="mono muted pane-meta">{s.agentType}{location ? ` · ${location}` : ''}</span>
              <span className="badge">{execution ? execution.status.toUpperCase() : 'NO ACTIVE CONTROLLER TURN'}</span></div>
            <div className="pane-status"><span className="state">{status.badge}</span><span className="pane-detail" title={status.detail}>{status.detail}</span>
              {status.when && <span className="mono muted">{timeOf(status.when)}</span>}
              {/* Resetting an unknown status is confirmed in Control access. */}
              {activity?.state === 'unknown' && <span className="muted">Reset status in Control access.</span>}</div>
            {inputBlocks.has(s.id) && <p className="notice" role="status">{inputBlocks.get(s.id)}</p>}
            {visibleOutcome?.outcome && <div className={`outcome ${visibleOutcome.outcome}`}>{visibleOutcome.outcome}: {visibleOutcome.reason}</div>}
            {config?.terminalEnabled && s.registrationId ? <NativeTerminal ref={handle => {if(handle)terminals.current.set(s.id,handle);else terminals.current.delete(s.id);}} token={token} target={{agentId:s.id,registrationId:s.registrationId}} clientInstanceId={clientInstanceId} viewEpoch={viewEpoch} label={s.label} capturedAt={snapshot?.capturedAt} keyboardButton={keyboard.claimButton(s.id)} keyboardControl={keyboard.claimControl(s.id)}
              holder={keyboardHolder} cliChanged={state.instances.find((i) => i.agentId === s.id)?.status === 'replaced'} held={manualHeld} refresh={refresh} fallback={<Output label={`${s.label} output`} memoryKey={`scroll:${ws}:${s.id}`} text={(snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text) || 'Waiting for a capture'} />} /> : <Output label={`${s.label} output`} memoryKey={`scroll:${ws}:${s.id}`} text={(snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text) || 'Waiting for a capture'} />}
            {/* A tmux-style status line: the boundary between the capture above and any command section below. */}
            <div className="pane-footer"><span className="mono">{s.identity.paneId}</span><span>{(!config?.terminalEnabled || !s.registrationId) && snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : ''}</span></div>
          </article>;
        })}</section>
        </div>
        <section ref={controlPane} id="altcli-control" tabIndex={-1} className={`control-pane${controlDrawer && !merged ? ' drawer' : ''}`} aria-label="Control" hidden={!showControl}
          onKeyDown={(e) => { if (controlDrawer && !merged && e.key === 'Escape') { e.stopPropagation(); toggleDrawer(false); } }}>
          {/* Names the recipient chosen by the Agent selector; Plan setup is the one control addressed to the whole group. */}
          <div className="control-heading"><h2>Control{phase === 'plan' && !inputRun ? <span className="control-recipient"> · All agents</span> : current && <span className="control-recipient"> · {current.label}</span>}</h2>{controlDrawer && !merged && <button type="button" className="quiet drawer-close" onClick={() => toggleDrawer(false)}>Close drawer</button>}</div>
          <div className="control-body">
          {stageAvailable && phase === 'implementation' && !inputRun && <div className="relay-mode">
            <div className="segmented" role="group" aria-label="Relay mode">
              <button type="button" className={relayMode === 'stage' ? 'selected' : 'quiet'} aria-pressed={relayMode === 'stage'} onClick={() => setRelayMode('stage')}>Stage relay</button>
              <button type="button" className={relayMode === 'commit' ? 'selected' : 'quiet'} aria-pressed={relayMode === 'commit'} onClick={() => setRelayMode('commit')}>Send options</button></div>
            <p className="fine">{relayMode === 'stage' ? <>Uncommitted review on <span className="mono">{git?.branch}</span>: accepted changes are staged and nothing is committed for you.</>
              : 'Send one instruction, optionally followed by Stage relay. Open a task branch for committed handoffs.'}</p></div>}
          {stageEligible && !stageAvailable && phase === 'implementation' && !inputRun && !!members.length && <p className="fine">{!state.legacyEnabled
            ? <>Stage relay is disabled on this host (<span className="mono">ALTCLI_ENABLE_LEGACY_RELAY=false</span>). Remove that line or set it to true, then restart the host.</>
            : <>Stage relay on <span className="mono">{git?.branch}</span> needs a two-member group. Select two agents in Projects.</>}</p>}
          {current && inputRun && <InteractionComposer key={current.id} token={token} state={state} run={inputRun} agent={current} draftKey={`draft:${scope}:${current.id}`} disabled={busy || stale || setupHeld || manualHeld || !state.inputEnabled || !!identityBlockedReason || !!cardReason(current)} viewEpoch={viewEpoch} refresh={refresh} readinessSlot={readinessSlot} />}
          {current && actionable && !inputRun && phase === 'implementation' && !showStage && <PaneActions key={current.id} {...common} group={pair} agent={current} settings={implementationSettings} blockedReason={implementationReason || cardReason(current)} keyboardHandoff={keyboardHandoff} viewEpoch={viewEpoch} draftKey={`draft:${scope}:${current.id}`} onOpenAccess={() => openAccess(readinessSlot?.querySelector('input'))} />}
        {phase === 'plan' && !inputRun && <>{commandDivider}<PlanSetup {...common} group={pair && members.length ? pair : undefined} settings={planSettings} displayed={current?.id}
          blockedReason={sharedReason || cardReason(current)} draftKey={`plan:${scope}`} /></>}
        {showStage && commandDivider}
        {showStage && <section className="composer command-zone" aria-label="Stage relay"><div className="section-heading"><h2>Stage relay: send to {current?.label}</h2><span className="badge">{owned.length ? 'EXECUTION OWNED' : 'MANUAL START'}</span></div>
          {!state?.inputEnabled && <p>Read-only console: the host has disabled input.</p>}
          <p className="fine">Reviews changes in this checkout; accepted changes are staged. Commit the finished fix yourself. The run stays on <span className="mono">{git?.branch}</span> at <span className="mono">{git?.head.slice(0, 7)}</span> and stops if either changes.</p>
          <form onSubmit={(e) => { e.preventDefault(); void send('instruction'); }}>
            <label className="sr-only" htmlFor="instruction">Instruction to {current?.label}</label>
            <div className="command-line"><textarea id="instruction" autoComplete="off" rows={3} value={text} disabled={blocked} maxLength={1900} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send('instruction'); } }} placeholder="Instruction or optional review context. ⌘/Ctrl+Enter sends." />
              <button className="primary" disabled={blocked || !ready || !text.trim()}>Send {current?.label}</button>
              <button type="button" disabled={blocked || !ready || !text.trim()} onClick={() => void send('instruction', true)}>Send {current?.label} &amp; stage-relay to {state.sessions.find((session) => pair?.sessions.includes(session.id) && session.id !== current?.id)?.label} ↗</button>
              <button type="button" disabled={blocked || !ready} onClick={() => void send('relay')}>Stage-relay review by {current?.label} ↗</button></div>
            {!blocked && !ready && <p className="fine">Confirm readiness in Control access.</p>}
            {!busy && (sharedReason || cardReason(current)) && <p className="fine" role="status">{sharedReason || cardReason(current)}</p>}
          </form>
          {pair && <label className="readiness auto"><input type="checkbox" aria-label="Auto-relay" checked={autoContinue} disabled={busy || owned.length > 0} onChange={(e) => { setAutoContinue(e.target.checked); try { localStorage.setItem(PREFERENCE, String(e.target.checked)); } catch { /* preference only */ } }} />
            Prefer automatic continuation for the next explicitly started run of group &quot;{pair.name}&quot;. Plain Send never relays; Send &amp; stage-relay requests one review even when this preference is off, and only if the worker changed the worktree.</label>}
          {pair && <label className="readiness turn-limit">Maximum automatic turns per run
            <input type="number" inputMode="numeric" aria-label="Maximum automatic turns" min={1} max={200} step={1} value={turnLimit} disabled={busy || owned.length > 0} aria-invalid={!limitValid}
              onChange={(e) => { setTurnLimit(e.target.value); try { localStorage.setItem(TURN_LIMIT, e.target.value); } catch { /* preference only */ } }} />
            <span className="muted">1–200, default {DEFAULT_TURN_LIMIT}; frozen into the run when it starts.</span></label>}
        </section>}
          </div>
        </section>
        </div>
        <details className="panel status" open={agentsOpen} onToggle={(e) => setAgentsOpen(e.currentTarget.open)}>
          <summary><h2>Agents in this checkout</h2><span className="muted">{projectSessions.length}</span></summary>
          <table><thead><tr><th>Agent</th><th>State</th><th>Detail</th><th>When</th></tr></thead>
            <tbody>{projectSessions.map((s) => { const status = statuses.get(s.id)!;
              const activity = state.activities?.find((a) => a.agentId === s.id);
              return <tr key={s.id}><td>{s.label} <small className="mono muted">{s.agentType}</small></td>
                <td><span className="state"><Icon badge={status.badge} />{status.badge}</span></td>
                <td className="command-text">{status.detail}
                  {/* Each control exists once: status resets are confirmed in Control access. */}
                  {activity?.state === 'unknown' && !visible.some((v) => v.id === s.id) && <div className="muted">Reset status in Control access.</div>}
                </td><td className="mono muted">{status.when ? timeOf(status.when) : ''}</td></tr>; })}</tbody></table>
        </details>
        <details className="history" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}><summary>Command history</summary>
          <div className="history-tools">
            <span className="muted">Commands on <span className="mono">{project ? nameOf(project) : 'this checkout'}</span></span>
            <button type="button" className="quiet" aria-label="Toggle history order" onClick={() => setHistoryOrder((o) => o === 'desc' ? 'asc' : 'desc')}>{historyOrder === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}</button>
            <button type="button" className="quiet" disabled={busy || !project} title="Download this worktree’s runs, turns and handoff journal (reviewed ranges, findings, plans, reported checks, archived handoff patches) as JSON. Cloning the repository does not recover it." onClick={() => void exportHistory()}>Export history</button>
          </div>
          {(() => {
            // Only this checkout's commands: by the run's worktree root, or by the agent's checkout for a command older than the run ledger.
            const rows = (state?.commands ?? []).filter((c) => (c.repository ?? sessions.find((s) => s.id === c.agentId)?.repository) === project);
            if (historyOrder === 'asc') rows.reverse(); // The server supplies stable newest-first append order; reversing preserves timestamp ties.
            return rows.length ? <table><thead><tr><th>Time</th><th>Agent</th><th>Group</th><th>Command</th><th>Delivery</th></tr></thead>
              <tbody>{rows.map((c) => <tr key={c.id}><td className="mono muted">{new Date(c.createdAt).toLocaleString()}</td><td>{sessions.find((s) => s.id === c.agentId)?.label ?? c.agentId}</td>
                <td className="muted">{c.groupId ? groups.find((p) => p.id === c.groupId)?.name ?? c.groupId : ''}</td><td className="command-text">{c.text}</td><td>{c.status}</td></tr>)}</tbody></table>
              : <p className="empty-history">No commands on this checkout yet.</p>;
          })()}
          {!!state.interactions?.some((r) => r.repository === project) && <details><summary>Terminal input history</summary><ul>{state.interactions.filter((r) => r.repository === project).map((r) => <li key={r.input.requestId}>{r.input.agentId} · {r.input.purpose} · {r.status}: <span className="command-text">{r.input.text ?? r.input.key}</span>{r.error && ` — ${r.error}`}</li>)}</ul></details>}
          </details>
      </>}
    </div>
    <div className="section-panel" hidden={tab !== 'settings'}>
      {/* Both sections stay mounted, so switching keeps unsaved profile edits. */}
      <nav className="section-tabs settings-tabs" aria-label="Settings sections">
        <button type="button" className={settingsTab === 'preferences' ? 'selected' : ''} aria-pressed={settingsTab === 'preferences'} onClick={() => setSettingsTab('preferences')}>Console preferences</button>
        <button type="button" className={settingsTab === 'host' ? 'selected' : ''} aria-pressed={settingsTab === 'host'} onClick={() => setSettingsTab('host')}>Host configuration</button></nav>
      {state && <section className="panel" aria-label="Console preferences" hidden={settingsTab !== 'preferences'}>
        <div className="section-heading"><h2>Console preferences</h2><span className="badge">THIS PAGE</span></div>
        <p className="muted">Preferences for this browser page. They never start work on their own.</p>
        <LaunchProfiles token={token} enabled={config?.launchEnabled === true && state?.inputEnabled === true} />
        <label className="readiness"><input type="checkbox" aria-label="Stay unlocked on this device" checked={stayUnlocked} onChange={(e) => rememberToken(e.target.checked)} />
          Stay unlocked on this device: keep the host access token in this browser so reopening the page does not ask for it. Anyone who can use this browser profile can then open the console; the host still checks the token on every request. <strong>Lock</strong> always forgets the token.</label>
      </section>}
      <section className="panel settings-panel" aria-label="Host configuration" hidden={settingsTab !== 'host'}>
        <div className="section-heading"><h2>Host configuration</h2><span className="badge">READ AT START</span></div>
        <p className="muted">These values come from environment variables when the host starts (<span className="mono">web/.env.local</span> written by <span className="mono">node scripts/setup.mjs</span>, or the shell). Change one there and restart the host; this page shows what is in effect now. Each row names its variable.</p>
        {configError && <p className="notice error" role="alert">{configError}</p>}
        {config && <div className="table-scroll"><table><thead><tr><th>Setting</th><th>Value</th><th>Variable</th></tr></thead><tbody>
          {([
            ['tmux binary', config.tmuxPath ? config.tmuxBin === config.tmuxPath ? config.tmuxPath : `${config.tmuxBin} → ${config.tmuxPath}` : `${config.tmuxBin} (not found on PATH)`, 'ALTCLI_TMUX_BIN', 'tmux from PATH'],
            ['tmux socket', config.tmuxSocket ?? 'tmux default', 'ALTCLI_TMUX_SOCKET', `tmux's default socket`],
            ['Data store', config.dataDir, 'ALTCLI_DATA_DIR', '~/.local/share/altcli/<mode>'],
            ['Task worktrees', config.worktreeDir, '', '~/.altcli/<repo>/<branch>'],
            ['Integration branches', `${[...new Set([...config.integrationBranches, 'main'])].join(', ')} + each project's default branch`, 'ALTCLI_INTEGRATION_BRANCHES', 'main, master'],
            ['Adapter', config.mode === 'mock' ? 'mock (simulated panes)' : 'tmux', 'ALTCLI_ADAPTER', 'tmux'],
            ['Native terminals', config.terminalEnabled ? 'enabled' : 'disabled', 'ALTCLI_ENABLE_TERMINAL', 'false'],
            ['Agent launch', config.launchEnabled ? 'enabled' : 'disabled', 'ALTCLI_ENABLE_AGENT_LAUNCH', 'false'],
            ...(config.terminalEnabled ? [
              ['Keyboard scope', 'One browser writer per tmux server; AltCLI dispatch, setup and launch stay held until release and reconciliation', '', 'server-wide'],
              ['Terminal limits', `${TERMINAL_LIMITS.hostConnections} connections per host, ${TERMINAL_LIMITS.sessionConnections} per session; ${TERMINAL_LIMITS.inputFrame / 1024} KiB input frames, 256 KiB paste; ${TERMINAL_LIMITS.outputHigh / 1024 / 1024} MiB output credit; ${TERMINAL_LIMITS.ticketMs / 1000} s ticket, ${TERMINAL_LIMITS.leaseMs / 1000} s heartbeat lease`, '', 'fixed'],
            ] : []),
            ['Console input', config.inputEnabled ? 'enabled' : 'read-only', 'ALTCLI_ENABLE_INPUT', 'true'],
            ['Stage relay', config.legacyEnabled ? 'enabled on main and each project\'s default branch' : 'disabled', 'ALTCLI_ENABLE_LEGACY_RELAY', 'true'],
            ['Allowed origins', config.allowedOrigins.join(', '), 'ALTCLI_ALLOWED_ORIGINS', 'http://127.0.0.1:8787, http://localhost:8787'],
            ['Claude config', config.claudeConfigDir, 'CLAUDE_CONFIG_DIR', '~/.claude'],
            ['Codex home', config.codexHome, 'CODEX_HOME', '~/.codex'],
          ] as [string, string, string, string][]).map(([name, value, variable, fallback]) => <tr key={name}><td>{name}</td><td className="mono command-text">{value}</td>
            <td className="muted">{variable ? <><span className="mono">{variable}</span>{config.environment.includes(variable) ? ' (set)' : <> · default {fallback}</>}</> : `built in · ${fallback}`}</td></tr>)}
        </tbody></table></div>}
        {!config && !configError && <p className="muted">Reading the host configuration…</p>}
      </section>
    </div>
    <div className="section-panel" hidden={tab !== 'about'}>
      <section className="panel about" aria-label="How this works">
        <div className="section-heading"><h2>How this works</h2></div>
        <p>AltCLI is a host-resident console for coding agents running in tmux panes. You can start CLIs yourself or explicitly preview and confirm profile launches when the host enables that feature. The console coordinates their turns.</p>
        <p>The Agent selector above the terminals chooses both the terminal shown and the Control pane's recipient; it starts on a working agent and then changes only when you choose another. Outside Plan, the <strong>Terminal / Control</strong> switch shows one or the other in the same frame. Plan setup addresses the whole group and keeps its own section. <strong>Control access</strong>, at the top of every page, is the one place to take control: keyboard release, manual-input recovery, the controller, other recovery and each action’s readiness check. The keyboard emoji beside it reports the server-wide owner; claim the keyboard at the terminal where you want to type. Send delivers an instruction; After send can add one handoff commit, or a commit and one review by the named peer. Current changes snapshots work as it stands, and Committed review asks this agent to review a committed range. Every action names its recipients and needs a fresh readiness confirmation.</p>
        <p>The server owns every run, validates and deduplicates correlated completions, and pauses on unknown background work. No effect in this page sends commands. A completed chain is not final task acceptance.</p>
        <p>Viewing another worktree never changes a running relay. Pause a run before manual terminal takeover. Locking this view or disconnecting your phone does not interrupt workers.</p>
        <p className="fine">Plan produces documents and an approval checkpoint; Implementation runs committed handoffs on a task branch. Integration branches are starting points only. The detailed design lives in the repository’s README, docs/WORKFLOWS.md and the ADRs.</p>
      </section>
    </div>
    </>}
  </main></MemoryContext.Provider>;
}
