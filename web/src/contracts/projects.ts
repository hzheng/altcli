import type { WorktreeIdentity } from './workflow.ts';

/** Local repository identity; remotes and branch names are not keys. */
export interface ProjectRecord { id: string; name: string; commonDir: string; directoryName: string }
export interface ProjectWorktree {
  id: string;
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  identity: WorktreeIdentity | null;
  error: string | null;
}
export interface Project extends ProjectRecord {
  worktrees: ProjectWorktree[];
  error: string | null;
  creations: WorktreeCreation[];
  removals?: WorktreeRemoval[];
  integrations?: WorktreeIntegration[];
  discards?: WorktreeDiscard[];
}
export interface WorktreePreviewInput { projectId: string; sourceWorktreeId: string; branch: string }
export interface WorktreePreview extends WorktreePreviewInput {
  requestId: string;
  source: WorktreeIdentity;
  sourceBranch: string | null;
  sourceHead: string;
  path: string;
}
export interface WorktreeCreateInput extends WorktreePreview { confirm: true }
export interface WorktreeCreation {
  input: WorktreeCreateInput;
  status: 'applying' | 'ready' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
}

export interface WorktreeRemovalInput { projectId: string; worktreeId: string }
export interface WorktreeRemovalPreview extends WorktreeRemovalInput {
  requestId: string;
  worktree: WorktreeIdentity;
  branch: string;
  head: string;
  targetRef: string;
  targetHead: string;
  integratedBy: 'ancestry' | 'squash';
  integratedCommit: string;
}
export interface WorktreeRemoveInput extends WorktreeRemovalPreview { confirm: true }
export interface WorktreeRemoval {
  input: WorktreeRemoveInput;
  status: 'applying' | 'removed' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
}

/** Squash integration of a task branch into the integration branch, run in the checkout that has that branch checked out. */
export interface WorktreeIntegrationInput { projectId: string; worktreeId: string; /** Inclusive endpoint; omitted means current HEAD. */ through?: string }
export interface WorktreeIntegrationPreview extends WorktreeIntegrationInput {
  requestId: string;
  /** The task worktree whose branch is integrated; it is not modified. */
  worktree: WorktreeIdentity;
  branch: string;
  head: string;
  /** Resolved inclusive endpoint of this batch; HEAD remains pinned separately. */
  through: string;
  /** Previous verified squash commit on the target, or null for the first batch. */
  previousCommit: string | null;
  /** Uncommitted changes in the task worktree are not part of the squash. */
  dirty: boolean;
  targetRef: string;
  targetHead: string;
  /** The clean checkout with the integration branch checked out, where the squash commit is made. */
  target: WorktreeIdentity;
  mergeBase: string;
  commitCount: number;
  /** Up to 100 of the commits being squashed, newest first. */
  commits: { sha: string; subject: string }[];
  /** The merged tree computed without conflicts by `git merge-tree`; the squash commit must have exactly this tree. */
  tree: string;
  /** Editable default commit message. */
  message: string;
  /** The exact Git operations confirmation authorizes, for display. */
  commands: string[];
  /** Server digest of every pinned field above except requestId and message; the compact confirmation repeats it instead of the preview. */
  consent: string;
}
/** Compact confirmation: the server re-derives the preview and requires its consent digest to match, so the request stays
 * within the HTTP body limit however many commits the preview listed. */
export interface WorktreeIntegrateRequest { projectId: string; worktreeId: string; through?: string; requestId: string; consent: string; message: string; confirm: true }
/** The durable consent record: the re-derived preview with the confirmed message. */
export interface WorktreeIntegrateInput extends WorktreeIntegrationPreview { confirm: true }
export interface WorktreeIntegration {
  /** Historical result retained after removal/discard; no longer a batch checkpoint. */
  retired?: boolean;
  input: WorktreeIntegrateInput;
  status: 'applying' | 'integrated' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
  /** The squash commit on the integration branch once verified. */
  commit: string | null;
}

/** Forced removal of a task worktree and deletion of its branch without integration evidence. */
export interface WorktreeDiscardInput { projectId: string; worktreeId: string }
export interface WorktreeDiscardPreview extends WorktreeDiscardInput {
  requestId: string;
  worktree: WorktreeIdentity;
  branch: string;
  head: string;
  targetRef: string;
  targetHead: string;
  /** Modified or nonignored untracked files that would be lost. */
  dirty: boolean;
  changeCount: number;
  /** Digest of HEAD, index entries, unstaged content and untracked file contents: consent binds to this exact content, not just its file count. */
  fingerprint: string;
  /** Commits on the branch that the integration branch does not contain; they become unreachable once the branch is deleted. */
  unmergedCommits: number;
}
/** `confirmBranch` must repeat the branch name exactly. */
export interface WorktreeDiscardConfirm extends WorktreeDiscardPreview { confirmBranch: string; confirm: true }
/** Completes an uncertain discard whose worktree is verified gone while its branch still sits at the confirmed head. */
export interface WorktreeDiscardFinish { requestId: string; confirm: true }
export interface WorktreeDiscard {
  input: WorktreeDiscardConfirm;
  status: 'applying' | 'discarded' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
  /** Set by inspection when only `git branch -D` is left: the directory and Git worktree entry are gone and the branch is at the confirmed head. */
  branchRemains?: boolean;
}
