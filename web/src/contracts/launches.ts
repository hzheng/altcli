import type { PaneIdentity } from './api.ts';
import type { WorktreeIdentity } from './workflow.ts';
export interface LaunchProfile { id: string; revision: number; label: string; executable: string; args: string[]; adapterHint: 'codex'|'claude'|'manual'; enabled: boolean }
export interface LaunchItem {
  id: string; projectId: string; worktreeId: string; worktree: WorktreeIdentity; commonDir: string; branch: string|null; head: string;
  profile: LaunchProfile; executable: string; sessionName: string; environmentDigest: string;
}
export interface LaunchPreview { requestId: string; digest: string; expiresAt: string; items: LaunchItem[]; blockers: string[] }
export interface LaunchInstance extends LaunchItem {
  status: 'applying'|'starting'|'running'|'exited'|'uncertain'|'reconciled'|'failed';
  phase: 'reserved'|'creating'|'created'|'configured'|'marked'|'executing'|'observed';
  message: string; identity: PaneIdentity|null; sessionId: string|null; windowId: string|null;
  placeholder: PaneIdentity|null; updatedAt: string; humanDecision?: { requestId: string; note: string; at: string };
}
export interface LaunchBatch { requestId: string; previewDigest: string; items: LaunchInstance[]; createdAt: string }
