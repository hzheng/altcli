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
  finishes?: TaskFinish[];
  updates?: WorktreeUpdate[];
  renames?: WorktreeRename[];
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

/** Align a linked task worktree's branch with the local integration branch (main, else the recorded default) in place, keeping its
 * directory, ignored environment and agents. `update` replays only the commits after the proven integrated boundary, so squashed
 * work is skipped; `rebase` replays every commit since the merge base, like `git rebase main`; `reset` drops the branch's commits
 * and uncommitted tracked changes, like `git reset --hard main`. Absent means `update`. */
export type WorktreeUpdateMode = 'update' | 'rebase' | 'reset';
export interface WorktreeUpdateInput { projectId: string; worktreeId: string; mode?: WorktreeUpdateMode }
export interface WorktreeUpdatePreview extends WorktreeUpdateInput {
  mode: WorktreeUpdateMode;
  requestId: string;
  worktree: WorktreeIdentity;
  branch: string;
  head: string;
  targetRef: string;
  targetHead: string;
  /** How the boundary was proven: the target contains the task commits (ancestry), a squash (checkpoint or exact patch) contains them,
   * or `base`: the plain merge base, so every task commit after it is replayed. `reset` replays nothing: the target replaces the branch. */
  boundaryBy: 'ancestry' | 'squash' | 'base' | 'reset';
  /** The last task commit whose content the target already contains; replay starts after it. Equals `head` when fully integrated,
   * and the target head for a reset. */
  boundary: string;
  /** Commits after the boundary, oldest first, each with the tree it produces on the target. Empty for a fully integrated branch. */
  replay: { sha: string; subject: string; tree: string }[];
  /** Tree of the new branch tip. */
  tree: string;
  /** The old tip is an ancestor of the new one, so no history is rewritten. */
  fastForward: boolean;
  /** The familiar Git command this is equivalent to, for orientation; `commands` is what actually runs. */
  equivalent: string;
  /** The exact Git operations confirmation authorizes, for display. */
  commands: string[];
  /** Reset only (null otherwise): the commits no longer on the branch (kept under the recovery ref) and the uncommitted tracked
   * changes that are discarded for good. Untracked and ignored files stay. The fingerprint pins the content shown. */
  lost: { commits: number; recent: { sha: string; subject: string }[]; changes: number; paths: string[]; fingerprint: string } | null;
  /** Server digest of every pinned field above except requestId; the compact confirmation repeats it. */
  consent: string;
}
/** One confirmation accepts the previewed changes and agent risks. confirmBranch is optional for older clients. */
export interface WorktreeUpdateRequest { projectId: string; worktreeId: string; mode?: WorktreeUpdateMode; requestId: string; consent: string; confirmBranch?: string; confirm: true }
/** The durable consent record: the re-derived preview, plus the create-only ref that keeps the old tip. */
export interface WorktreeUpdateConfirm extends WorktreeUpdatePreview { recoveryRef: string; confirm: true }
export interface WorktreeUpdate {
  input: WorktreeUpdateConfirm;
  status: 'applying' | 'updated' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
  /** The new branch tip, recorded before the branch moves (the target head, or the last replayed commit). */
  commit: string | null;
}

/** Rename a linked task worktree's branch in place. Files and the directory are unchanged; `commands` also lists the renames of app-launched tmux sessions named after the old branch. */
export interface WorktreeRenameInput { projectId: string; worktreeId: string; newBranch: string }
export interface WorktreeRenamePreview extends WorktreeRenameInput {
  requestId: string;
  worktree: WorktreeIdentity;
  /** The current branch name. */
  branch: string;
  head: string;
  /** Digest of HEAD, index entries, unstaged and untracked content: uncommitted work is carried unchanged, never touched. */
  fingerprint: string;
  dirty: boolean;
  /** Recorded squash batches whose boundary carries over to the new name. */
  checkpoints: number;
  commands: string[];
}
export interface WorktreeRenameConfirm extends WorktreeRenamePreview { confirm: true }
export interface WorktreeRename {
  input: WorktreeRenameConfirm;
  status: 'applying' | 'renamed' | 'uncertain' | 'failed';
  message: string;
  updatedAt: string;
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

/** Read-only listing of one host directory for choosing a project's starting checkout. Browsing creates and changes nothing. */
export interface DirectoryListInput { path?: string; hidden?: boolean }
export interface DirectoryEntry {
  name: string;
  /** Where choosing this entry navigates: for a symbolic link, its resolved destination. */
  path: string;
  /** A `.git` entry exists. This is only a hint: separate Git directories and submodules also have one, so only the listed
   * directory itself is classified by Git. */
  gitCandidate: boolean;
  /** The link's own path when this entry is a symbolic link to a directory; null otherwise. */
  linkedFrom: string | null;
}
/** Git's classification of the listed directory when it is inside a checkout. A main checkout may be on any branch. */
export interface CheckoutObservation {
  root: string;
  commonDir: string;
  kind: 'main' | 'linked';
  branch: string | null;
  head: string | null;
  /** The default branch recorded locally (origin/HEAD), or null when not recorded. */
  defaultBranch: string | null;
  /** For a linked worktree: the repository's accessible, non-bare main checkout. */
  mainCheckout: string | null;
  /** Why no main checkout is offered for a linked worktree. */
  mainCheckoutNote: string | null;
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirectoryEntry[];
  /** More entries exist than were read or returned; type a path to go elsewhere. */
  truncated: boolean;
  checkout: CheckoutObservation | null;
  checkoutError: string | null;
}
/** What the user saw when choosing a checkout. Add inspects the path again and refuses when any of it changed. */
export interface ExpectedCheckout { root: string; commonDir: string; branch: string | null }
export interface ProjectAddInput { path: string; expected?: ExpectedCheckout }

/** Finish branch: close the tmux sessions AltCLI launched for one linked task worktree, then optionally remove it (branch kept) or
 * discard it (branch deleted) through the existing confirmed operations. Nothing here merges, and nothing runs automatically. */
export type FinishOutcome = 'close' | 'remove' | 'discard';
export interface FinishInput { projectId: string; worktreeId: string }
/** A process seen in a launched pane. `started` guards against PID reuse; `infrastructure` marks known CLI helpers, which are still
 * terminated and still count as survivors, but do not by themselves mean the pane is busy. */
export interface FinishProcess { pid: string; command: string; started: string | null; infrastructure: boolean }
export interface FinishPane {
  paneId: string; windowId: string; cwd: string; command: string; dead: boolean;
  /** The registered agent label in this pane, if any, and its current activity. */
  agent: string | null; activity: 'working' | 'ready' | 'idle' | 'interrupted' | 'unknown' | null;
  /** The pane's own process (the CLI), then its descendants and other processes on its terminal. */
  root: FinishProcess | null; processes: FinishProcess[];
}
export interface FinishSession {
  launchId: string; sessionName: string; sessionId: string; windowId: string;
  server: { pid: string; started: string; socketPath: string };
  closable: boolean; reason: string | null; clients: number; panes: FinishPane[];
}
export interface FinishGit {
  branch: string; head: string; targetRef: string | null; targetHead: string | null;
  /** Commits on the task branch not in the target, and the reverse; different tips alone do not mean unmerged work. */
  ahead: number | null; behind: number | null; dirty: boolean | null; changeCount: number | null;
  integration: 'integrated' | 'not_proven' | 'unavailable'; integratedBy: 'ancestry' | 'squash' | null; integratedCommit: string | null; note: string | null;
}
export interface FinishPreview extends FinishInput {
  requestId: string;
  /** Digest of the evidence a session stop consents to: identities, session scope, activity and processes, occupancy. */
  digest: string;
  worktree: WorktreeIdentity; branch: string;
  sessions: FinishSession[];
  /** Other panes in this worktree. AltCLI never closes them; they still block removal and discard. */
  others: { paneId: string; location: string; command: string }[];
  git: FinishGit;
  run: { id: string; status: string } | null;
  /** Hard refusals: nothing can be confirmed until they are resolved. */
  blockers: string[];
  /** Working/unknown activity, an exited pane with unknown background effects, or task processes beyond the CLI: stopping needs acknowledgement. */
  active: boolean;
}
export interface FinishConfirm { requestId: string; digest: string; outcome: FinishOutcome; stopActive: boolean; confirm: true }
export interface FinishSessionResult {
  sessionId: string; sessionName: string; launchId: string;
  /** attempted: the kill may have run and its result was not recorded; uncertain: absence could not be verified. */
  status: 'pending' | 'attempted' | 'closed' | 'uncertain' | 'skipped';
  /** Processes seen immediately before the kill, and those still alive afterwards (same PID and start time). */
  retained: FinishProcess[]; survivors: FinishProcess[];
  evidence: 'clear' | 'survivors' | 'unknown' | null;
}
export type FinishStatus = 'applying' | 'uncertain' | 'attention' | 'awaiting_git' | 'git_applying' | 'git_uncertain' | 'done' | 'failed';
export interface TaskFinish {
  requestId: string; input: FinishConfirm; preview: FinishPreview;
  status: FinishStatus; step: 'sessions' | 'git';
  /** Compare-and-set revision: overlapping confirm, continue and reconcile calls never execute a step twice. */
  revision: number;
  message: string; sessions: FinishSessionResult[];
  /** The removal or discard this finish started, inspected by its own request ID and never reissued. */
  child: { kind: 'removal' | 'discard'; requestId: string } | null;
  decision?: { note: string; at: string };
  updatedAt: string;
}
export interface FinishContinue { requestId: string; revision: number; removal?: WorktreeRemoveInput; discard?: WorktreeDiscardConfirm }
export interface FinishReconcile { requestId: string; revision: number; action: 'inspect' | 'decide' | 'abandon'; note?: string }
/** Statuses that keep this finish as the worktree's owner. */
export const FINISH_HOLDING: readonly FinishStatus[] = ['applying', 'uncertain', 'attention', 'awaiting_git', 'git_applying', 'git_uncertain'];
