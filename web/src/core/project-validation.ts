import type { WorktreeCreateInput, WorktreeDiscardConfirm, WorktreeDiscardFinish, WorktreeDiscardInput, WorktreeIntegrateRequest, WorktreeIntegrationInput, WorktreePreviewInput, WorktreeRemovalInput, WorktreeRemoveInput } from '../contracts/projects.ts';
import { AppError } from './errors.ts';
import { object, requestId } from './validation.ts';
import { sha } from './implementation-validation.ts';
import { messageFits } from './squash-message.ts';

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
const identity = (value: unknown) => { const body = object(value); fields(body, ['root', 'gitDir', 'indexPath']); return { root: text(body.root), gitDir: text(body.gitDir), indexPath: text(body.indexPath) }; };
export function parseIntegrationPreview(value: unknown): WorktreeIntegrationInput {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'through']);
  if (body.through !== undefined && (typeof body.through !== 'string' || !/^[0-9a-f]{7,64}$/i.test(body.through))) throw new AppError('INVALID_WORKTREE', 'Enter a commit SHA (at least 7 hexadecimal characters), or leave it empty for HEAD.');
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), ...(body.through === undefined ? {} : { through: (body.through as string).toLowerCase() }) };
}
/** The commit message is the one editable field: printable, newlines allowed, and at most 8 KiB once JSON-encoded (core/squash-message.ts). */
function commitMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new AppError('INVALID_WORKTREE', 'Enter a printable commit message.');
  if (!messageFits(value)) throw new AppError('INVALID_WORKTREE', 'The commit message exceeds 8 KiB once JSON-encoded. Shorten it.');
  return value;
}
/** Server-generated identifiers are far shorter; the bound keeps every accepted compact request within the 16 KiB body limit. */
const MAX_IDENTIFIER = 200;
export function parseIntegrate(value: unknown): WorktreeIntegrateRequest {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'through', 'requestId', 'consent', 'message', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact squash integration.');
  if (typeof body.consent !== 'string' || !/^[0-9a-f]{64}$/.test(body.consent)) throw new AppError('INVALID_WORKTREE', 'Confirm the previewed squash; its consent digest is missing.');
  const projectId = text(body.projectId); const worktreeId = text(body.worktreeId);
  if (projectId.length > MAX_IDENTIFIER || worktreeId.length > MAX_IDENTIFIER) throw new AppError('INVALID_WORKTREE', 'Recheck the project; its identifiers are not ones this host issued.');
  return { projectId, worktreeId, ...(body.through === undefined ? {} : { through: sha(body.through) }), requestId: requestId(body.requestId), consent: body.consent, message: commitMessage(body.message), confirm: true };
}
export function parseDiscardPreview(value: unknown): WorktreeDiscardInput {
  const body = object(value); fields(body, ['projectId', 'worktreeId']);
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId) };
}
export function parseDiscard(value: unknown): WorktreeDiscardConfirm {
  const body = object(value);
  fields(body, ['projectId', 'worktreeId', 'requestId', 'worktree', 'branch', 'head', 'targetRef', 'targetHead', 'dirty', 'changeCount', 'fingerprint', 'unmergedCommits', 'confirmBranch', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact worktree discard.');
  if (typeof body.dirty !== 'boolean' || !Number.isSafeInteger(body.changeCount) || Number(body.changeCount) < 0 || !Number.isSafeInteger(body.unmergedCommits) || Number(body.unmergedCommits) < 0) throw new AppError('INVALID_WORKTREE', 'Invalid discard preview.');
  const branch = text(body.branch);
  if (body.confirmBranch !== branch) throw new AppError('CONFIRM_REQUIRED', 'Type the exact branch name to confirm discarding it.');
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), requestId: requestId(body.requestId), worktree: identity(body.worktree),
    branch, head: sha(body.head), targetRef: text(body.targetRef), targetHead: sha(body.targetHead), dirty: body.dirty, changeCount: Number(body.changeCount),
    fingerprint: sha(body.fingerprint), unmergedCommits: Number(body.unmergedCommits), confirmBranch: branch, confirm: true };
}
export function parseDiscardFinish(value: unknown): WorktreeDiscardFinish {
  const body = object(value); fields(body, ['requestId', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm deleting the remaining branch.');
  return { requestId: requestId(body.requestId), confirm: true };
}
