import { describe, expect, it } from 'vitest';
import type { Project, WorktreeIntegration } from '../contracts/projects';
import { worktreeHolds } from './worktree-holds';

const identity = (root: string) => ({ root, gitDir: `${root}/.git`, indexPath: `${root}/.git/index` });
const tree = (path: string, branch: string, main = false) => ({ id: `tree-${path}`, path, branch, head: 'a'.repeat(40), main, identity: identity(path), error: null });
const project = (extra: Partial<Project> = {}): Project => ({ id: 'p', name: 'repo', commonDir: '/repo/.git', directoryName: 'repo', error: null, creations: [],
  worktrees: [tree('/repo', 'main', true), tree('/tasks/ui', 'feature/ui')], ...extra });
const squash = (status: WorktreeIntegration['status'], worktree = '/tasks/ui') => ({ status, message: 'Inspect it.', updatedAt: '', commit: null,
  input: { branch: 'feature/ui', targetRef: 'refs/heads/main', target: identity('/repo'), worktree: identity(worktree) } }) as unknown as WorktreeIntegration;

describe('worktreeHolds', () => {
  it('holds both checkouts of an unresolved squash and points to the task worktree that shows it', () => {
    const reason = 'Squash of feature/ui into main is uncertain. Inspect it on the feature/ui worktree in Projects before starting work.';
    expect(worktreeHolds([project({ integrations: [squash('uncertain')] })])).toEqual([{ root: '/repo', reason }, { root: '/tasks/ui', reason }]);
  });
  it('points to Projects when the squashed worktree is gone, and releases a squash with a recorded result', () => {
    expect(worktreeHolds([project({ integrations: [squash('applying', '/tasks/gone')] })])[0])
      .toEqual({ root: '/repo', reason: 'Squash of feature/ui into main is applying. Inspect it in Projects before starting work.' });
    expect(worktreeHolds([project({ integrations: [squash('integrated'), squash('failed')] })])).toEqual([]);
  });
  it('covers discards and Finish branch, which the server also refuses', () => {
    const discard = { status: 'uncertain', input: { branch: 'feature/old', worktree: identity('/tasks/old') } };
    const finish = { status: 'awaiting_git', preview: { branch: 'feature/done', worktree: identity('/tasks/done') } };
    expect(worktreeHolds([project({ discards: [discard], finishes: [finish] } as unknown as Partial<Project>)])).toEqual([
      { root: '/tasks/old', reason: 'Discard of worktree feature/old is uncertain. Inspect it in Projects before starting work.' },
      { root: '/tasks/done', reason: 'Finish branch owns feature/done (awaiting git). Inspect or complete it in Projects before starting work.' }]);
  });
});
