import type { BranchConsent, Group, ImplementationStart } from './implementation.ts';
import type { ManagedSession, WorktreeIdentity } from './workflow.ts';

export type PlanAction = 'draft' | 'synthesize' | 'review' | 'revise';
export type PlanOutcome = 'complete' | 'accept' | 'object' | 'blocked';
/** Implementation membership and branch consent are separate from planning membership/approval. */
export type PlannedImplementation = Omit<ImplementationStart, 'requestId' | 'text' | 'kind' | 'autoContinue' | 'turnLimit' | 'confirmReady' | 'reviewBase' | 'branch'> & { branch: BranchConsent | null };
export interface PlanStart {
  requestId: string;
  groupId: string;
  groupRevision: number;
  registrations: Record<string, string>;
  text: string;
  baseline: { branch: string | null; head: string };
  autoContinue: boolean;
  requireApproval: boolean;
  /** Shared automatic-turn budget; not reset on entry into Implementation. */
  turnLimit: number;
  pauseOnObjection?: boolean;
  implementation: PlannedImplementation;
  confirmReady: true;
}
export interface PlanIdentity {
  schema: 1;
  phase: 'plan';
  runId: string;
  commandId: string;
  epoch: number;
  briefRevision: number;
  rosterRevision: number;
  policyRevision: number;
  agentId: string;
  registrationId: string;
  action: PlanAction;
  baseline: string;
  /** Absolute path of the one document this turn may write, in CoderCrew's data directory, never inside the checkout. */
  outputPath: string;
  inputRevision: number | null;
  inputHash: string | null;
}
/** Written before lifecycle completion to the exact external result path in the assignment. */
export interface PlanResult {
  identity: PlanIdentity;
  outcome: PlanOutcome;
  outputHash: string | null;
  model: string;
  summary: string;
  reason: string | null;
}
export interface PlanDocument { text: string; hash: string }
export interface PlanVersion extends PlanDocument {
  path: string;
  revision: number;
  briefRevision: number;
  author: string;
  commandId: string;
}
export interface DraftAssignment {
  agentId: string;
  commandId: string;
  path: string;
  status: 'queued' | 'running' | 'finalized';
  document: PlanDocument | null;
  briefRevision: number;
}
export interface CapturedPlanResult { result: PlanResult; document: PlanDocument | null }
export type PlanCapture = { captured: CapturedPlanResult; error?: never } | { error: string; captured?: never };
export interface PlanTurn { identity: PlanIdentity; resultPath: string; captured?: CapturedPlanResult }
export interface FrozenPlan {
  transitionId: string;
  authorizedAt: string;
  authority: 'human' | 'automatic';
  overrideReason: string | null;
  epoch: number;
  briefRevision: number;
  policyRevision: number;
  rosterRevision: number;
  baseline: string;
  brief: string;
  planningGroup: Group;
  planners: ManagedSession[];
  automaticPolicy: { autoContinue: boolean; requireApproval: boolean; turnLimit: number; pauseOnObjection: boolean; automaticTurnsBeforeTransition: number };
  plan: PlanVersion;
  endorsements: Record<string, number>;
  objections: Record<string, string>;
  implementation: PlannedImplementation;
}
export interface PlanningRun {
  phase: 'plan';
  group: Group;
  participants: ManagedSession[];
  implementationParticipants: ManagedSession[];
  cwd: string;
  worktree: WorktreeIdentity;
  epoch: number;
  brief: string;
  briefRevision: number;
  policyRevision: number;
  /** Canonical absolute <data directory>/plans/<run ID>, holding every draft and plan.md; runs never write plans into the checkout. */
  directory: string;
  planPath: string;
  /** Ordered, N-shaped roster/assignments; dispatch cap is currently two, concurrency one. */
  required: string[];
  drafts: Record<string, DraftAssignment>;
  step: 'drafts' | 'synthesis' | 'refinement' | 'checkpoint' | 'implemented';
  current: PlanVersion | null;
  endorsements: Record<string, number>;
  endorsementHistory: { agentId: string; revision: number; briefRevision: number }[];
  objections: Record<string, string>;
  next: { agentId: string; action: PlanAction } | null;
  frozen: FrozenPlan | null;
  request: PlanStart;
}
export interface PlanningAssignment {
  identity: PlanIdentity;
  root: string;
  cwd: string;
  branch: string | null;
  brief: string;
  resultPath: string;
  /** Absent during independent drafting, including peer summaries. */
  drafts?: { agentId: string; document: PlanDocument }[];
  plan?: PlanVersion;
  findings?: Record<string, string>;
}
export interface PlanDecision {
  runId: string;
  expectedCommandId: string;
  expectedRevision: number;
  expectedHash: string;
  expectedBriefRevision: number;
  expectedPolicyRevision: number;
  action: 'approve' | 'changes';
  text?: string;
  agentId?: string;
  overrideReason?: string;
  /** Supplies missing branch consent, never changes the recorded members or roles. */
  branch?: BranchConsent;
  confirmReady: true;
}
