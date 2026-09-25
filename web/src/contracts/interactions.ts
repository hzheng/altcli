import type { ManagedSession, ProcessRecord } from './workflow.ts';

export interface InteractionInput {
  requestId: string; runId: string; commandId: string; agentId: string; registrationId: string;
  sessionId: string; sourceTurnId: string; expectedRevision: number; confirmPresent: true;
  purpose: 'detail' | 'answer' | 'key'; text?: string; key?: 'Enter' | 'Escape'; confirmInterrupt?: true;
}
export interface InteractionRecord {
  input: InteractionInput; repository: string; status: 'recorded' | 'sending' | 'delivered' | 'rejected' | 'uncertain';
  createdAt: string; updatedAt: string; error: string | null;
}
/** A hold belongs to the entire run/index, never only to the next recipient pane. */
export interface InteractionHold {
  revision: number; active: boolean; fault: boolean;
  origin?: 'keyboard';
  disposition?: 'complete' | 'automatic' | 'waiting' | 'plan';
}
export interface CheckpointInput {
  requestId: string; runId: string; commandId: string; expectedRevision: number;
  action: 'review_input' | 'restore'; confirmReady: true;
}
export interface Checkpoint {
  runId: string; commandId: string; revision: number; kind: 'interaction' | 'waiting';
  capturedAt: string;
  fingerprint: string; branch: string | null; result: string; sessions: ManagedSession[];
  processes: Record<string, ProcessRecord[]>; external: Record<string, ExternalActivity>;
  fault: boolean; reason: string | null;
}
/** Native observation only; never substitutes for the assigned command's result. */
export interface ExternalActivity {
  agentId: string; sessionId: string; sourceTurnId: string; cliPid: string; startedAt: string;
  state: 'working' | 'clear' | 'unknown';
  startEvidence: string; finishEvidence?: string;
}
