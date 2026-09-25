import type { PaneIdentity } from './api.ts';
import type { ProcessRecord } from './workflow.ts';
export type TerminalTarget = { agentId: string; registrationId: string } | { launchId: string };
export interface TerminalOpen { target: TerminalTarget; cols: number; rows: number; clientInstanceId: string }
export interface TerminalConnection { connectionId: string; ticket: string; bootId: string; label: string; paneId: string; sessionId: string }
export interface ManualPane { identity: PaneIdentity; cwd: string; processes: ProcessRecord[]; agent?: boolean; command?: string; dead?: boolean }
export interface ManualSession {
  id: string; revision: number; bootId: string; clientInstanceId: string; connectionId: string;
  generation: string; target: TerminalTarget; live: boolean; reconciliationRequired: boolean;
  inputMayHaveOccurred: boolean; bytes: number; createdAt: string; updatedAt: string; reason: string;
  panes: ManualPane[]; runs: { id: string; commandId: string; priorStatus: string }[];
  humanDecision?: { requestId: string; note: string; at: string };
}
export interface KeyboardInput {
  requestId: string; action: 'acquire' | 'release' | 'releaseSettled'; expectedGeneration: string;
  transfer?: boolean; confirmReady?: boolean;
}
export interface KeyboardResult { generation: string; manualSession: ManualSession | null; writer: boolean; reason: string }
export type ManualReconcile = { requestId: string; manualSessionId: string; expectedRevision: number } &
  ({ confirmReady: true } | { confirmInspected: true; note: string });
export type TerminalFrame =
  | { type: 'reset'; generation: string; cols: number; rows: number; bootId: string; native: boolean; reason: string }
  | { type: 'out'; generation: string; sequence: number; bytes: number; data: string }
  | { type: 'keyboard'; generation: string; manualSessionId: string | null; writer: boolean; reason: string }
  | { type: 'active'; paneId: string; command: string; sessionId: string; label: string; size?: string }
  | { type: 'hb' }
  | { type: 'closed'; reason: string };
export interface NativeInput { generation: string; seq: number; encoding: 'utf8' | 'binary'; data: string }
export const TERMINAL_LIMITS = {
  hostConnections: 8, sessionConnections: 4, outputFrame: 16 * 1024, outputHigh: 1024 * 1024,
  outputLow: 256 * 1024, inputFrame: 4096, inputQueue: 256 * 1024,
  leaseMs: 30_000, stallMs: 10_000, ticketMs: 10_000, handshakeMs: 5000,
} as const;
