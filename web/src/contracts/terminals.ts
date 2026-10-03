import type { PaneIdentity } from './api.ts';
import type { ProcessRecord, WorktreeIdentity } from './workflow.ts';
export type TerminalTarget = { agentId: string; registrationId: string } | { launchId: string };
export interface TerminalOpen { protocol: 2; target: TerminalTarget; cols: number; rows: number; clientInstanceId: string }
export interface TerminalConnection { connectionId: string; ticket: string; bootId: string; label: string; paneId: string; sessionId: string }
export interface ManualPane { identity: PaneIdentity; cwd: string; processes: ProcessRecord[]; agent?: boolean; command?: string; dead?: boolean }
export interface ManualWriter {
  connectionId: string; clientInstanceId: string; generation: string; target: TerminalTarget;
  identity: PaneIdentity | null; sessionId: string | null;
  revision: number; live: boolean; bytes: number; inputMayHaveOccurred: boolean;
}
export interface ManualSession {
  /** Captured at admission. Null (or absent in historical records) covers the whole server. */
  scope?: WorktreeIdentity | null;
  /** The original grant fields are retained for archived records. Current ownership is in writers. */
  id: string; revision: number; bootId: string; clientInstanceId: string; connectionId: string;
  generation: string; target: TerminalTarget; live: boolean; reconciliationRequired: boolean;
  inputMayHaveOccurred: boolean; bytes: number; createdAt: string; updatedAt: string; reason: string;
  panes: ManualPane[]; runs: { id: string; commandId: string; priorStatus: string }[];
  writers: ManualWriter[]; recoveryRequired: boolean;
  /** Initial targets ever admitted in this period, including writers that have stopped. */
  targets: TerminalTarget[];
  humanDecision?: { requestId: string; note: string; at: string };
  backgroundDecision?: { requestId: string; note: string; at: string; authorization: import('./background-actions.ts').BackgroundAuthorization };
  settlement?: { requestId: string; nativeRevision: number; keyboardRevision: number };
}
export interface KeyboardSettlement { manualSessionId: string; revision: number }
export interface KeyboardInput {
  requestId: string; action: 'acquire' | 'release' | 'releaseSettled'; expectedGeneration: string;
  expectedBootId: string; confirmReady?: boolean;
  /** For a checked releaseSettled handoff: input since confirmation invalidates the release. */
  expectedRevision?: number;
  /** Exact subsequent command authorized by this checked release. */
  handoffRequestId?: string;
}
export interface KeyboardResult { generation: string; manualSession: ManualSession | null; writer: boolean; reason: string }
export interface KeyboardBatch {
  requestId: string; expectedBootId: string; manualSessionId: string; expectedRevision: number;
  writers: { connectionId: string; generation: string; revision: number }[];
  confirmReady?: boolean; handoffRequestId?: string;
}
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
/** One explicit image insertion in the same ordered input lane: the server derives the verified reference from the attachment and
 * writes it once, without Enter, only if the writer still shows the expected pane in the expected session on this boot. */
export interface NativeImageInput { generation: string; seq: number; image: { attachmentId: string; bootId: string; paneId: string; sessionId: string } }
export const TERMINAL_LIMITS = {
  hostConnections: 8, sessionConnections: 4, outputFrame: 16 * 1024, outputHigh: 1024 * 1024,
  outputLow: 256 * 1024, inputFrame: 4096, inputQueue: 256 * 1024,
  leaseMs: 30_000, stallMs: 10_000, ticketMs: 10_000, handshakeMs: 5000,
} as const;
