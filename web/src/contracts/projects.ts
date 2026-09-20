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
