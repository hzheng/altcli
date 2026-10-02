import type { PaneIdentity } from './api.ts';
import type { WorktreeIdentity } from './workflow.ts';
/** purpose: worktree agent launches or Helper, which list and launch only their own profiles. Copies recorded before purposes existed lack
 * it; the host reports every saved profile with one. */
export interface LaunchProfile { id: string; revision: number; label: string; executable: string; args: string[]; adapterHint: 'codex'|'claude'|'manual'; enabled: boolean; purpose?: 'agent'|'helper' }
export interface LaunchItem {
  id: string; projectId: string; worktreeId: string; worktree: WorktreeIdentity; commonDir: string; branch: string|null; head: string;
  profile: LaunchProfile; executable: string; sessionName: string; environmentDigest: string;
  /** ADR-0024: a launched coding agent's role, and the recorded task workspace it was launched into (null when its checkout is not
   * one, such as a base checkout or a launch made before workspaces were recorded). Absent on schema-19 records until migration. */
  role?: 'workspace-agent'; workspaceId?: string | null;
}
export interface LaunchPreview { requestId: string; digest: string; expiresAt: string; items: LaunchItem[]; blockers: string[] }
export interface LaunchInstance extends LaunchItem {
  status: 'applying'|'starting'|'running'|'exited'|'uncertain'|'reconciled'|'failed';
  phase: 'reserved'|'creating'|'created'|'configured'|'marked'|'executing'|'observed';
  message: string; identity: PaneIdentity|null; sessionId: string|null; windowId: string|null;
  placeholder: PaneIdentity|null; updatedAt: string; humanDecision?: { requestId: string; note: string; at: string };
  /** Explicitly closed or cleaned up: no longer a terminal or discovery target; history is kept. */
  closed?: ({ finishId: string } | { cleanupId: string }) & { at: string };
  cleanup?: { requestId: string; digest: string; status: 'applying'|'uncertain'|'done'; acknowledgedAt: string; confirmStop?: true };
}
export interface LaunchBatch { requestId: string; previewDigest: string; items: LaunchInstance[]; createdAt: string }
export interface LaunchCleanupPreview {
  requestId: string; digest: string; expiresAt: string; launchId: string; sessionName: string;
  state: 'dead'|'missing'|'live'|'blocked'; blockers: string[];
}
