import type { WorktreeCreateInput, WorktreePreviewInput, WorktreeRemovalInput, WorktreeRemoveInput } from '../contracts/projects.ts';
import { AppError } from './errors.ts';
import { object, requestId } from './validation.ts';
import { sha } from './implementation-validation.ts';

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new AppError('INVALID_WORKTREE', 'Expected a nonempty single-line value.');
  return value;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new AppError('INVALID_WORKTREE', 'Unknown worktree field.');
}
const previewFields = ['projectId', 'sourceWorktreeId', 'branch'];
export function parseWorktreePreview(value: unknown): WorktreePreviewInput {
  const body = object(value); fields(body, previewFields);
  const branch = text(body.branch);
  if (branch.length > 150 || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch)) throw new AppError('INVALID_WORKTREE', 'Use a branch name of at most 150 letters, digits, slashes, dots, underscores or hyphens.');
  return { projectId: text(body.projectId), sourceWorktreeId: text(body.sourceWorktreeId), branch };
}
export function parseWorktreeCreate(value: unknown): WorktreeCreateInput {
  const body = object(value); fields(body, [...previewFields, 'requestId', 'source', 'sourceBranch', 'sourceHead', 'path', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the displayed branch, starting commit and destination.');
  const source = object(body.source); fields(source, ['root', 'gitDir', 'indexPath']);
  return { ...parseWorktreePreview({ projectId: body.projectId, sourceWorktreeId: body.sourceWorktreeId, branch: body.branch }),
    requestId: requestId(body.requestId), source: { root: text(source.root), gitDir: text(source.gitDir), indexPath: text(source.indexPath) },
    sourceBranch: body.sourceBranch === null ? null : text(body.sourceBranch), sourceHead: sha(body.sourceHead), path: text(body.path), confirm: true };
}
export function parseWorktreeReconcile(value: unknown): string {
  const body = object(value); fields(body, ['requestId']); return requestId(body.requestId);
}

export function parseRemovalPreview(value: unknown): WorktreeRemovalInput {
  const body = object(value); fields(body, ['projectId', 'worktreeId']);
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId) };
}
export function parseRemoval(value: unknown): WorktreeRemoveInput {
  const body = object(value);
  fields(body, ['projectId', 'worktreeId', 'requestId', 'worktree', 'branch', 'head', 'targetRef', 'targetHead', 'integratedBy', 'integratedCommit', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact worktree removal.');
  const worktree = object(body.worktree); fields(worktree, ['root', 'gitDir', 'indexPath']);
  if (body.integratedBy !== 'ancestry' && body.integratedBy !== 'squash') throw new AppError('INVALID_WORKTREE', 'Invalid integration evidence.');
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), requestId: requestId(body.requestId),
    worktree: { root: text(worktree.root), gitDir: text(worktree.gitDir), indexPath: text(worktree.indexPath) },
    branch: text(body.branch), head: sha(body.head), targetRef: text(body.targetRef), targetHead: sha(body.targetHead),
    integratedBy: body.integratedBy, integratedCommit: sha(body.integratedCommit), confirm: true };
}
