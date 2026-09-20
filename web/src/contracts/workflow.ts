import type { AgentId, AgentType, CommandInput, CommandRecord, ConsoleState, EventInput, PaneIdentity, SessionRegistration, TurnEvent } from './api.ts';
import type { Group, ImplementationRun, ImplementationTurn, StandaloneStart, WorkspaceGit } from './implementation.ts';
import type { PlanningRun, PlanTurn } from './planning.ts';
import type { Project } from './projects.ts';

export interface WorktreeIdentity { root: string; gitDir: string; indexPath: string }
export interface ManagedSession extends SessionRegistration {
  /** A new registration is a new instance, even when the human label is reused. */
  registrationId: string;
  worktree: WorktreeIdentity | null;
  /** Pid of the CLI in the pane's foreground when registered; a different pid later means the CLI exited or restarted. */
  cliPid?: string | null;
  cwd?: string;
}
/** Whether the registered CLI instance is still the one in the pane. */
export interface InstanceState { agentId: string; status: 'current' | 'replaced' | 'unknown' }
/** CLI activity from native events or explicit human-ready confirmation, never transcript inference.
 * Independent of background-process quiescence and permission to continue a run. */
export interface AgentActivity { agentId: string; state: 'ready' | 'working' | 'idle' | 'interrupted' | 'unknown'; updatedAt: string | null; detail: string }
/** Explicit human recovery of missing display evidence; never releases execution ownership. */
export interface ActivityReset { agentId: string; registrationId: string; expectedUpdatedAt: string | null; confirmReady: true }
/** `turnLimit` is the run's maximum number of automatic turns, frozen at start; the server default is 20. */
export interface StartInput extends CommandInput { pairId?: string; autoContinue?: boolean; turnLimit?: number; pauseOnObjection?: boolean }
export type RunStatus = 'running' | 'waiting' | 'paused' | 'completed' | 'stopped';
export interface RelayRun {
  id: string;
  repository: string;
  lockKey: string;
  pairId: string | null;
  participants: ManagedSession[];
  autoContinue: boolean;
  /** Agreement frozen with the run and changeable at a settled boundary: objections pause instead of routing to the author. */
  pauseOnObjection: boolean;
  pauseRequested: boolean;
  status: RunStatus;
  reason: string;
  currentCommandId: string;
  automaticTurns: number;
  turnLimit: number;
  createdAt: string;
  updatedAt: string;
  implementation?: ImplementationRun;
  planning?: PlanningRun;
  standalone?: StandaloneStart;
}
/** A live process under a registered pane, as the host reported it. */
export interface ProcessRecord { pid: string; command: string }
/** Server-side background-work evidence for a completion whose hook payload cannot report it (Codex notify). */
export interface BackgroundEvidence { state: 'clear' | 'active'; detail: string }
export interface Execution {
  commandId: string;
  runId: string;
  agentId: string;
  input: CommandInput;
  wireText: string;
  status: 'planned' | 'dispatching' | 'delivered' | 'finished' | 'interrupted' | 'uncertain' | 'rejected';
  sessionId: string | null;
  sourceTurnId: string | null;
  continuation: boolean;
  /** Processes under the pane just before delivery; a completion is clear only when nothing newer survives. */
  baselineProcesses: ProcessRecord[] | null;
  /** Read-only worktree digest just before delivery, for a handoff instruction; a review is scheduled only when the completion digest differs. */
  baselineWorktree: string | null;
  implementation?: ImplementationTurn;
  planning?: PlanTurn;
}
export interface HookEvent extends Omit<EventInput, 'event'> {
  event: 'session_started' | 'turn_started' | 'turn_complete' | 'turn_interrupted' | 'outcome';
  commandId?: string;
  sourceTurnId?: string;
  identity?: PaneIdentity;
  /** Missing lifecycle evidence stays unknown; it is not converted into idle. */
  backgroundState?: 'clear' | 'active' | 'unknown';
  /** The hook process posting this event. It runs under the pane while reporting, so process evidence must not count it. */
  reporterPid?: string;
  /** CLI process and timestamp captured at the native start, retained unchanged by its matching completion. */
  cliPid?: string;
  startedAt?: string;
}
/** A recent command with the run and pair it belonged to, for history filtering. Null when it predates the run ledger. */
export interface HistoryCommand extends CommandRecord { runId: string | null; pairId: string | null; groupId: string | null }
export interface WorkflowState extends ConsoleState {
  groups: Group[];
  legacyEnabled: boolean;
  sessions: ManagedSession[];
  commands: HistoryCommand[];
  runs: RelayRun[];
  /** Operational state is not truncated with the recent-history view. */
  executions: Execution[];
  instances: InstanceState[];
  activities?: AgentActivity[];
}
export interface HookReceipt { accepted: boolean; reason: string; event: TurnEvent | null }
export interface RunAction { runId: string; action: 'pause' | 'takeover' | 'continue'; confirmReady?: true; expectedCommandId?: string }

/** How discovery classified a pane's foreground process. Only codex and claude can be group members. */
export type DiscoveredKind = AgentType | 'shell';
/** One live pane inside a discovered workspace: read-only inventory, not a registration, lifecycle or readiness signal. */
export interface WorkspaceAgent {
  identity: PaneIdentity;
  /** Current tmux location as session:window.pane; informational and may change. */
  location: string;
  command: string;
  kind: DiscoveredKind;
  /** A known coding CLI in a safe pane. Shells, unidentified processes and dead, copy-mode or synchronized panes are not. */
  eligible: boolean;
  reason: string | null;
  /** The saved label when registered; coding CLIs otherwise use the tmux session name, separate from pane identity. */
  label: string;
  registeredAs: AgentId | null;
  /** Read-only identity proposal for an eligible pane. Persisted only by an explicit edit or Start. */
  session?: ManagedSession;
}
/** A canonical current working directory inside a Git worktree, with the live panes found there on one tmux server. */
export interface Workspace {
  cwd: string;
  socketPath: string;
  worktree: WorktreeIdentity;
  /** The checked-out branch, or null on a detached HEAD. */
  branch: string | null;
  agents: WorkspaceAgent[];
  /** Pane IDs included by default; users can exclude any eligible member. */
  group: string[] | null;
  git?: WorkspaceGit;
  gitError?: string;
  /** Other workspace directories that resolve to this worktree and index; they cannot run conflicting work. */
  sharesIndexWith: string[];
}
export interface SkippedDirectory { cwd: string; panes: number; reason: string }
export interface WorkspaceDiscovery {
  /** Project-centered inventory; workspaces below retain the exact-directory collaboration contract. */
  projects?: Project[];
  workspaces: Workspace[];
  /** Directories with live panes that are not inside a Git worktree or could not be inspected. */
  skipped: SkippedDirectory[];
  /** Set when the pane listing itself failed, e.g. no tmux server. */
  error: string | null;
  discoveredAt: string;
}
/** Forget every registration and group on one checkout so the user can name and group from scratch. */
export interface WorkspaceReset { repository: string; confirmReady: true }
export interface WorkspaceResetResult { sessions: AgentId[]; pairs: string[]; groups: string[] }
