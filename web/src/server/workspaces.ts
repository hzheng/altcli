import { realpath } from 'node:fs/promises';
import type { AdapterMode, SessionRegistration } from '../contracts/api.ts';
import type { WorkspaceDiscovery } from '../contracts/workflow.ts';
import { messageOf } from '../core/errors.ts';
import { groupWorkspaces, type DirectoryInspection } from '../core/workspaces.ts';
import type { ListedPane, TerminalAdapter } from './adapters/terminal.ts';
import { currentBranch, resolveWorktree } from './worktree.ts';
import { branchState, taskBaseline } from './commit-handoff.ts';
/** Simulated checkouts: the demo project sits on its integration branch, every other directory on a task branch at its baseline. */
const mockBranch = (cwd: string) => cwd === '/demo/project' ? 'main' : `task/${cwd.split('/').filter(Boolean).pop() ?? 'work'}`;
/** Read-only inspection of one pane directory. Mock panes have no filesystem: each directory is its own worktree on "main". */
async function inspect(cwd: string, mode: AdapterMode): Promise<DirectoryInspection> {
  if (mode === 'mock') return { cwd, worktree: { root: cwd, gitDir: `${cwd}/.git`, indexPath: `${cwd}/.git/index` }, branch: mockBranch(cwd) };
  try {
    const canonical = await realpath(cwd);
    const worktree = await resolveWorktree(canonical);
    return { cwd: canonical, worktree, branch: worktree ? await currentBranch(canonical) : null };
  } catch (error) { return { error: messageOf(error) }; }
}
/** Workspace cards from every live pane on the configured tmux server, detached sessions included. Reads tmux, the
 * filesystem and Git; writes nothing and registers nothing. A stale card is never a live session. */
export async function discoverWorkspaces(adapter: TerminalAdapter, mode: AdapterMode, sessions: SessionRegistration[], integrationBranches: string[] = []): Promise<WorkspaceDiscovery> {
  const discoveredAt = new Date().toISOString();
  let panes: ListedPane[];
  try { panes = await adapter.listPanes(); } catch (error) { return { workspaces: [], skipped: [], error: messageOf(error), discoveredAt }; }
  const inspections = new Map<string, DirectoryInspection>();
  await Promise.all([...new Set(panes.map((p) => p.cwd))].map(async (cwd) => { inspections.set(cwd, await inspect(cwd, mode)); }));
  const result = groupWorkspaces(panes, inspections, sessions);
  await Promise.all(result.workspaces.map(async (workspace) => {
    if (mode === 'mock') {
      const branch = mockBranch(workspace.cwd); const head = 'a'.repeat(40);
      workspace.git = { branch, primary: 'main', head, clean: true, changes: [], changeCount: 0, integration: branch === 'main', taskBase: branch === 'main' ? null : head }; return;
    }
    try { const state = await branchState(workspace.worktree.root); workspace.git = { ...state, ...await taskBaseline(workspace.worktree.root, state, integrationBranches) }; }
    catch (error) { workspace.gitError = messageOf(error); }
  }));
  return { ...result, error: null, discoveredAt };
}
