import type { CommandInput, CommandRecord, ConsoleState, EventInput, PaneIdentity, SessionRegistration, TurnEvent } from './api.ts';

export interface WorktreeIdentity { root: string; gitDir: string; indexPath: string }
export interface ManagedSession extends SessionRegistration {
  /** A new registration is a new instance, even when the human label is reused. */
  registrationId: string;
  worktree: WorktreeIdentity | null;
  /** Pid of the CLI in the pane's foreground when registered; a different pid later means the CLI exited or restarted. */
  cliPid?: string | null;
}
/** Whether the registered CLI instance is still the one in the pane. */
export interface InstanceState { agentId: string; status: 'current' | 'replaced' | 'unknown' }
/** `turnLimit` is the run's maximum number of automatic turns, frozen at start; the server default is 20. */
export interface StartInput extends CommandInput { pairId?: string; autoContinue?: boolean; turnLimit?: number }
export type RunStatus = 'running' | 'paused' | 'completed' | 'stopped';
export interface RelayRun {
  id: string;
  repository: string;
  lockKey: string;
  pairId: string | null;
  participants: ManagedSession[];
  autoContinue: boolean;
  pauseRequested: boolean;
  status: RunStatus;
  reason: string;
  currentCommandId: string;
  automaticTurns: number;
  turnLimit: number;
  createdAt: string;
  updatedAt: string;
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
  status: 'planned' | 'dispatching' | 'delivered' | 'finished' | 'uncertain' | 'rejected';
  sessionId: string | null;
  sourceTurnId: string | null;
  continuation: boolean;
  /** Processes under the pane just before delivery; a completion is clear only when nothing newer survives. */
  baselineProcesses: ProcessRecord[] | null;
}
export interface HookEvent extends Omit<EventInput, 'event'> {
  event: 'turn_started' | 'turn_complete' | 'outcome';
  commandId?: string;
  sourceTurnId?: string;
  identity?: PaneIdentity;
  /** Missing lifecycle evidence stays unknown; it is not converted into idle. */
  backgroundState?: 'clear' | 'active' | 'unknown';
  /** The hook process posting this event. It runs under the pane while reporting, so process evidence must not count it. */
  reporterPid?: string;
}
/** A recent command with the run and pair it belonged to, for history filtering. Null when it predates the run ledger. */
export interface HistoryCommand extends CommandRecord { runId: string | null; pairId: string | null }
export interface WorkflowState extends ConsoleState {
  sessions: ManagedSession[];
  commands: HistoryCommand[];
  runs: RelayRun[];
  /** Operational state is not truncated with the recent-history view. */
  executions: Execution[];
  instances: InstanceState[];
}
export interface HookReceipt { accepted: boolean; reason: string; event: TurnEvent | null }
export interface RunAction { runId: string; action: 'pause' | 'takeover'; confirmReady?: true }
