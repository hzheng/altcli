import type { GlobalAIInstance, GlobalAIPreview, ToolReply } from './global-ai.ts';
import type { LaunchProfile } from './launches.ts';

export interface BackgroundAssessment {
  itemId: string; itemRevision: number; summary: string; likelyCause: string; nextSteps: string[]; uncertainties: string[];
  evidence: { id: string; note: string; source: string; revision: string }[];
  surface: 'control_access' | 'plan_checkpoint' | 'launch_card' | 'none';
}
export interface BackgroundInstance extends Omit<GlobalAIInstance, 'role'> {
  role: 'background';
  /** A lazy reservation launches only after enablement and an eligible issue. */
  environment: string;
  providerVersion: string;
}
export interface BackgroundPreview extends GlobalAIPreview {
  providerVersion: string;
  disclosure: string;
  limits: BackgroundLimits;
}
export interface BackgroundLimits {
  active: number; settleMs: number; startsPerHour: number; spacingMs: number; deadlineMs: number;
  toolCalls: number; evidenceBytes: number; assessmentBytes: number; stdoutBytes: number; pending: number; failures: number; history: number;
}
export const BACKGROUND_LIMITS: BackgroundLimits = {
  active: 1, settleMs: 20000, startsPerHour: 10, spacingMs: 30000, deadlineMs: 120000,
  toolCalls: 12, evidenceBytes: 65536, assessmentBytes: 8192, stdoutBytes: 1048576, pending: 100, failures: 3, history: 200,
};
export interface BackgroundSettings {
  revision: number; enabled: boolean; paused: boolean; needsInspection: boolean; failures: number;
  instance: BackgroundInstance | null; message: string;
}
export interface BackgroundAttempt {
  id: string; instanceId: string; enablement: number; itemId: string; itemRevision: number; sourceVersion: number;
  status: 'claimed' | 'running' | 'succeeded' | 'stale' | 'failed' | 'canceled' | 'uncertain';
  admittedAt: string; finishedAt: string | null; deadline: string; pid: number | null;
  sessionId: string; model: string | null; message: string; calls: number; evidenceBytes: number;
  evidence: { id: string; reply: ToolReply }[]; assessment: BackgroundAssessment | null;
}
/** Trusted native runner receipt. The assessment remains untrusted model output until independently validated. */
export interface BackgroundReceipt {
  settled: boolean; pid: number | null; sessionId: string; model: string | null;
  status: 'succeeded' | 'failed' | 'canceled'; category: string; assessment: unknown;
}
export interface BackgroundJob {
  id: string; executable: string; directory: string; sessionId: string; deadlineMs: number; args: string[]; prompt: string;
}
export type BackgroundRunnerInput = { method: 'poll' } | { method: 'control'; attemptId: string }
  | { method: 'started'; attemptId: string; pid: number } | { method: 'complete'; attemptId: string; result: BackgroundReceipt };
export interface BackgroundView {
  settings: BackgroundSettings; profiles: LaunchProfile[]; attempts: BackgroundAttempt[];
  explanations: BackgroundAttempt[];
  available: boolean; limits: BackgroundLimits; pending: number;
}
