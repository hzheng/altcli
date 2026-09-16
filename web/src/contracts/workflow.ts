import type { CommandInput, ConsoleState, EventInput, PaneIdentity, SessionRegistration, TurnEvent } from './api.ts';

export interface WorktreeIdentity { root: string; gitDir: string; indexPath: string }
export interface ManagedSession extends SessionRegistration {
  /** A new registration is a new instance, even when the human label is reused. */
  registrationId: string;
  worktree: WorktreeIdentity | null;
}
export interface StartInput extends CommandInput { pairId?: string; autoContinue?: boolean }
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
}
export interface HookEvent extends Omit<EventInput, 'event'> {
  event: 'turn_started' | 'turn_complete' | 'outcome';
  commandId?: string;
  sourceTurnId?: string;
  identity?: PaneIdentity;
  /** Missing lifecycle evidence stays unknown; it is not converted into idle. */
  backgroundState?: 'clear' | 'active' | 'unknown';
}
export interface WorkflowState extends ConsoleState {
  sessions: ManagedSession[];
  runs: RelayRun[];
  /** Operational state is not truncated with the recent-history view. */
  executions: Execution[];
}
export interface HookReceipt { accepted: boolean; reason: string; event: TurnEvent | null }
export interface RunAction { runId: string; action: 'pause' | 'takeover'; confirmReady?: true }
