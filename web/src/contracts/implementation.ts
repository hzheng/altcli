import type { ManagedSession, WorktreeIdentity } from './workflow.ts';
import type { FrozenPlan } from './planning.ts';

export type CollaborationPolicy = 'solo' | 'peer' | 'worker_reviewer';
export type ImplementationAction = 'work' | 'review' | 'review_and_improve';
export interface Group {
  id: string;
  name: string;
  repository: string;
  cwd: string | null;
  members: string[];
  revision: number;
  createdAt: string;
  /** Stable compatibility identity; legacy runs retain their original pairId. */
  legacyPairId: string | null;
}
export interface GroupInput { name: string; members: string[] }
export interface GroupSelection { members: string[]; expectedRevision: number; registrations: Record<string, string> }
export interface GitChange {
  /** Two-column Git porcelain status: index, then worktree; ?? means untracked. */
  status: string;
  path: string;
  originalPath: string | null;
}
export interface BranchState {
  branch: string | null;
  head: string;
  primary: string | null;
  clean: boolean;
  /** First 100 changed paths, relative to the worktree root. */
  changes: GitChange[];
  changeCount: number;
}
/** The workspace branch reading plus the host's integration-branch policy applied to it. */
export interface WorkspaceGit extends BranchState {
  /** The checked-out branch is the default or a configured integration branch: a creation base, never an implementation branch. */
  integration: boolean;
  /** Where task work on this branch begins: the head itself when no commit lies beyond an integration tip, the merge base when
   * one is unambiguous, null when the user must confirm it. Null on an integration branch. */
  taskBase: string | null;
}
export interface BranchConsent {
  branch: string | null;
  head: string;
  /** Absent means explicitly stay on the displayed named branch. */
  newBranch?: string;
  /** Confirmed permanent task baseline when staying on an existing task branch; an ancestor of head. If absent, infer it from integration tips or refuse ambiguous history. */
  taskBase?: string;
}
export interface ImplementationStart {
  requestId: string;
  groupId: string;
  groupRevision: number;
  registrations: Record<string, string>;
  agentId: string;
  kind: 'work' | 'commit' | 'review';
  text?: string;
  /** With commit, authorize review from reviewBase through the new snapshot after validated publication; false commits and stops. */
  handoff: boolean;
  policy: CollaborationPolicy;
  workerId?: string;
  autoContinue: boolean;
  turnLimit: number;
  /** Agreement: a reviewer objection pauses for the human instead of being routed to the author. Default false. */
  pauseOnObjection?: boolean;
  logPath: string;
  branch: BranchConsent;
  /** Excluded baseline for review, including commit with handoff (defaults to the pre-snapshot HEAD). */
  reviewBase?: string;
  confirmReady: true;
}
/** Plain Send: no branch setup, publication contract, or automatic successor. */
export type StandaloneStart = Pick<ImplementationStart, 'requestId' | 'groupId' | 'groupRevision' | 'registrations' | 'agentId' | 'policy' | 'workerId' | 'confirmReady'> & { text: string };
export interface ImplementationPolicy {
  policy: CollaborationPolicy;
  workerId: string | null;
  revision: number;
}
export interface PolicyChange {
  runId: string;
  expectedCommandId: string;
  expectedRevision: number;
  policy: 'peer' | 'worker_reviewer';
  workerId?: string;
  autoContinue: boolean;
  /** Omitted keeps the run's current objection agreement. */
  pauseOnObjection?: boolean;
}
export interface ImplementationRun extends ImplementationPolicy {
  phase: 'implementation';
  handoff: 'commit';
  group: Group;
  cwd: string;
  worktree: WorktreeIdentity;
  branch: string;
  consent: BranchConsent;
  setup: 'pending' | 'applying' | 'ready' | 'uncertain';
  logPath: string;
  taskBaseSha: string;
  acceptedSha: string;
  candidateSha: string | null;
  candidateAuthor: string | null;
  expectedParentSha: string;
  turn: number;
  findings: string | null;
  latestPublication: Publication | null;
  next: { agentId: string; action: ImplementationAction; text: string; handoff: boolean } | null;
  request: ImplementationStart;
  /** Initial work only: captured input for the first implementation or snapshot turn. */
  initialWorktreeFingerprint?: string;
}
/** Copy these assignment fields verbatim into the appended JSON line. */
export interface HandoffIdentity {
  schema: 1;
  runId: string;
  commandId: string;
  turn: number;
  policyRevision: number;
  phase: 'implementation';
  action: ImplementationAction;
  agentId: string;
  registrationId: string;
  parent: string;
  base: string;
  reviewBase: string | null;
  reviewHead: string | null;
}
export interface HandoffEntry extends HandoffIdentity {
  model: string;
  decision: 'accept' | 'object' | null;
  reason: string | null;
  needsHuman: boolean;
  summary: string;
  checks: string[];
}
export interface ImplementationTurn {
  identity: HandoffIdentity;
  published?: Publication;
}
export interface Publication { sha: string; projectChanged: boolean; entry: HandoffEntry }
export type PublicationResult = { publication: Publication; error?: never } | { error: string; publication?: never };
export interface CommitAssignment {
  identity: HandoffIdentity;
  branch: string;
  cwd: string;
  root: string;
  logPath: string;
  instruction: string;
  task: string;
  findings: string | null;
  participant: Pick<ManagedSession, 'agentType' | 'label'>;
  /** Snapshot current changes without implementing pending requests; first work turn only. */
  commitOnly?: true;
  frozenPlan?: FrozenPlan;
  /** Present only on the first work assignment, never on reviews or later work turns. */
  initialWorktreeFingerprint?: string;
}

/** Read-only preview of `base..head`. Without `base`, the baseline is the newest first-parent commit that
 * `recipient` published (per the tracked relay log), or `taskBase` when the recipient has none on this branch. */
export interface ReviewPreviewInput { groupId: string; head: string; logPath: string; base?: string; recipient?: string; taskBase?: string; commitPending?: boolean }
export interface ReviewPreview {
  base: string;
  /** Subject of the baseline commit, so every candidate baseline can be labelled. */
  baseSubject: string;
  head: string;
  /** How the baseline was chosen: the caller's `base`, the recipient's last published commit, or the task baseline. */
  since: 'explicit' | 'recipient' | 'task';
  /** Every commit in `base..head`, newest first (merges include their side commits). */
  commits: { sha: string; subject: string }[];
  /** Baselines a human may choose instead, earliest first: `base`, then HEAD's first-parent ancestors after it. Includes HEAD when a snapshot is pending. */
  candidates: { sha: string; subject: string }[];
}
