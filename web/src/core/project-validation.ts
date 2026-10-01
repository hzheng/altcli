import type { DirectoryListInput, ExpectedCheckout, FinishConfirm, FinishContinue, FinishInput, FinishOutcome, FinishReconcile, ProjectAddInput, RepositorySettingsInput, WorktreeCreateInput, WorktreeDiscardConfirm, WorktreeDiscardFinish, WorktreeDiscardInput, WorktreeIntegrateRequest, WorktreeIntegrationInput, WorktreeIntegrationRelease, WorktreePreviewInput, WorktreeRemovalInput, WorktreeRemoveInput, WorktreeRenameConfirm, WorktreeRenameInput, WorktreeUpdateInput, WorktreeUpdateMode, WorktreeUpdateRequest } from '../contracts/projects.ts';
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
export function parseIntegrationRelease(value: unknown): WorktreeIntegrationRelease {
  const body = object(value); fields(body, ['requestId', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm clearing the squash hold.');
  return { requestId: requestId(body.requestId), confirm: true };
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
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'through', 'acknowledgeActivity']);
  if (body.through !== undefined && (typeof body.through !== 'string' || !/^[0-9a-f]{7,64}$/i.test(body.through))) throw new AppError('INVALID_WORKTREE', 'Enter a commit SHA (at least 7 hexadecimal characters), or leave it empty for HEAD.');
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), ...(body.through === undefined ? {} : { through: (body.through as string).toLowerCase() }), ...acknowledged(body) };
}
/** The commit message is the one editable field: printable, newlines allowed, and at most 8 KiB once JSON-encoded (core/squash-message.ts). */
function commitMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new AppError('INVALID_WORKTREE', 'Enter a printable commit message.');
  if (!messageFits(value)) throw new AppError('INVALID_WORKTREE', 'The commit message exceeds 8 KiB once JSON-encoded. Shorten it.');
  return value;
}
/** Only an explicit true acknowledges possibly active agents; anything else is refused rather than read as false. */
function acknowledged(body: Record<string, unknown>): { acknowledgeActivity?: true } {
  if (body.acknowledgeActivity === undefined) return {};
  if (body.acknowledgeActivity !== true) throw new AppError('INVALID_WORKTREE', 'acknowledgeActivity must be true when present.');
  return { acknowledgeActivity: true };
}
/** Server-generated identifiers are far shorter; the bound keeps every accepted compact request within the 16 KiB body limit. */
const MAX_IDENTIFIER = 200;
export function parseIntegrate(value: unknown): WorktreeIntegrateRequest {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'through', 'acknowledgeActivity', 'requestId', 'consent', 'message', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact squash integration.');
  if (typeof body.consent !== 'string' || !/^[0-9a-f]{64}$/.test(body.consent)) throw new AppError('INVALID_WORKTREE', 'Confirm the previewed squash; its consent digest is missing.');
  const projectId = text(body.projectId); const worktreeId = text(body.worktreeId);
  if (projectId.length > MAX_IDENTIFIER || worktreeId.length > MAX_IDENTIFIER) throw new AppError('INVALID_WORKTREE', 'Recheck the project; its identifiers are not ones this host issued.');
  return { projectId, worktreeId, ...(body.through === undefined ? {} : { through: sha(body.through) }), ...acknowledged(body), requestId: requestId(body.requestId), consent: body.consent, message: commitMessage(body.message), confirm: true };
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

export function parseDirectoryList(value: unknown): DirectoryListInput {
  const body = object(value); fields(body, ['path', 'hidden']);
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw new AppError('INVALID_DIRECTORY', 'hidden must be true or false.');
  const path = body.path === undefined ? undefined : text(body.path);
  if (path !== undefined && !path.startsWith('/')) throw new AppError('INVALID_DIRECTORY', 'Enter an absolute directory path.');
  return { ...(path === undefined ? {} : { path }), ...(body.hidden === undefined ? {} : { hidden: body.hidden }) };
}
function expectedCheckout(value: unknown): ExpectedCheckout {
  const expected = object(value); fields(expected, ['root', 'commonDir', 'branch']);
  return { root: text(expected.root), commonDir: text(expected.commonDir), branch: expected.branch === null ? null : text(expected.branch) };
}
export function parseProjectAdd(value: unknown): ProjectAddInput {
  const body = object(value); fields(body, ['path', 'expected']);
  const path = text(body.path);
  if (body.expected === undefined) return { path };
  return { path, expected: expectedCheckout(body.expected) };
}
/** A repository's confirmed base checkout, local integration branch and default agents (at most six instances, as one launch). */
export function parseRepositorySettings(value: unknown): RepositorySettingsInput {
  const body = object(value); fields(body, ['projectId', 'expectedRevision', 'basePath', 'integrationBranch', 'launchDefaults', 'expected']);
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new AppError('INVALID_WORKTREE', 'Send the settings revision you edited.');
  const integrationBranch = text(body.integrationBranch);
  if (integrationBranch.length > 150 || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(integrationBranch)) throw new AppError('INVALID_WORKTREE', 'Use a local branch name of at most 150 letters, digits, slashes, dots, underscores or hyphens.');
  if (!Array.isArray(body.launchDefaults) || body.launchDefaults.length > 6) throw new AppError('INVALID_WORKTREE', 'Choose at most six default agent profiles.');
  const launchDefaults = body.launchDefaults.map((row) => {
    const entry = object(row); fields(entry, ['profileId', 'count']);
    if (!Number.isSafeInteger(entry.count) || (entry.count as number) < 1 || (entry.count as number) > 6) throw new AppError('INVALID_WORKTREE', 'Each default agent count is 1 to 6.');
    return { profileId: text(entry.profileId), count: entry.count as number };
  });
  if (new Set(launchDefaults.map((d) => d.profileId)).size !== launchDefaults.length) throw new AppError('INVALID_WORKTREE', 'List each default profile once, with its count.');
  if (launchDefaults.reduce((sum, d) => sum + d.count, 0) > 6) throw new AppError('INVALID_WORKTREE', 'Default agents may start at most six instances, like one launch.');
  return { projectId: text(body.projectId), expectedRevision: body.expectedRevision as number, basePath: text(body.basePath), integrationBranch, launchDefaults,
    ...(body.expected === undefined ? {} : { expected: expectedCheckout(body.expected) }) };
}

export function parseFinishInput(value: unknown): FinishInput {
  const body = object(value); fields(body, ['projectId', 'worktreeId']);
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId) };
}
export function parseFinishConfirm(value: unknown): FinishConfirm {
  const body = object(value); fields(body, ['requestId', 'digest', 'outcome', 'stopActive', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm closing exactly the previewed sessions.');
  if (!['close', 'remove', 'discard'].includes(String(body.outcome))) throw new AppError('INVALID_WORKTREE', 'Choose close, remove or discard.');
  if (typeof body.stopActive !== 'boolean') throw new AppError('INVALID_WORKTREE', 'stopActive must be true or false.');
  if (typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest)) throw new AppError('INVALID_WORKTREE', 'Expected the preview digest.');
  return { requestId: requestId(body.requestId), digest: body.digest, outcome: body.outcome as FinishOutcome, stopActive: body.stopActive, confirm: true };
}
export function parseFinishContinue(value: unknown): FinishContinue {
  const body = object(value); fields(body, ['requestId', 'revision', 'removal', 'discard']);
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) throw new AppError('INVALID_WORKTREE', 'Expected the finish revision.');
  if ((body.removal === undefined) === (body.discard === undefined)) throw new AppError('INVALID_WORKTREE', 'Continue with exactly one confirmed removal or discard.');
  return { requestId: requestId(body.requestId), revision: body.revision as number,
    ...(body.removal !== undefined ? { removal: parseRemoval(body.removal) } : { discard: parseDiscard(body.discard) }) };
}
export function parseFinishReconcile(value: unknown): FinishReconcile {
  const body = object(value); fields(body, ['requestId', 'revision', 'action', 'note']);
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) throw new AppError('INVALID_WORKTREE', 'Expected the finish revision.');
  if (!['inspect', 'decide', 'abandon'].includes(String(body.action))) throw new AppError('INVALID_WORKTREE', 'Choose inspect, decide or abandon.');
  const note = body.note === undefined ? undefined : text(body.note);
  if (body.action === 'decide' && (!note?.trim() || note.length > 1000)) throw new AppError('INVALID_WORKTREE', 'Record what you inspected, in at most 1,000 characters.');
  return { requestId: requestId(body.requestId), revision: body.revision as number, action: body.action as FinishReconcile['action'], ...(note === undefined ? {} : { note }) };
}

function updateMode(value: unknown): WorktreeUpdateMode {
  if (value === undefined) return 'update';
  if (value === 'update' || value === 'rebase' || value === 'reset') return value;
  throw new AppError('INVALID_WORKTREE', 'Choose update, rebase or reset.');
}
export function parseUpdatePreview(value: unknown): Required<WorktreeUpdateInput> {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'mode']);
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), mode: updateMode(body.mode) };
}
/** Compact confirmation: the server re-derives the preview and requires its consent digest to match. */
export function parseUpdate(value: unknown): WorktreeUpdateRequest & { mode: WorktreeUpdateMode } {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'mode', 'requestId', 'consent', 'confirmBranch', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact worktree update.');
  if (typeof body.consent !== 'string' || !/^[0-9a-f]{64}$/.test(body.consent)) throw new AppError('INVALID_WORKTREE', 'Confirm the previewed update; its consent digest is missing.');
  const projectId = text(body.projectId); const worktreeId = text(body.worktreeId);
  if (projectId.length > MAX_IDENTIFIER || worktreeId.length > MAX_IDENTIFIER) throw new AppError('INVALID_WORKTREE', 'Recheck the project; its identifiers are not ones this host issued.');
  const confirmBranch = body.confirmBranch === undefined ? undefined : text(body.confirmBranch);
  if (confirmBranch !== undefined && confirmBranch.length > MAX_IDENTIFIER) throw new AppError('INVALID_WORKTREE', 'Type the exact branch name.');
  return { projectId, worktreeId, mode: updateMode(body.mode), requestId: requestId(body.requestId), consent: body.consent, ...(confirmBranch === undefined ? {} : { confirmBranch }), confirm: true };
}
function branchName(value: unknown): string {
  const branch = text(value);
  if (branch.length > 150 || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch)) throw new AppError('INVALID_WORKTREE', 'Use a branch name of at most 150 letters, digits, slashes, dots, underscores or hyphens.');
  return branch;
}
export function parseRenamePreview(value: unknown): WorktreeRenameInput {
  const body = object(value); fields(body, ['projectId', 'worktreeId', 'newBranch']);
  return { projectId: text(body.projectId), worktreeId: text(body.worktreeId), newBranch: branchName(body.newBranch) };
}
/** The whole preview is the consent; the server re-derives it and refuses any difference, including the content fingerprint. */
export function parseRename(value: unknown): WorktreeRenameConfirm {
  const body = object(value);
  fields(body, ['projectId', 'worktreeId', 'newBranch', 'requestId', 'worktree', 'branch', 'head', 'fingerprint', 'dirty', 'checkpoints', 'commands', 'confirm']);
  if (body.confirm !== true) throw new AppError('CONFIRM_REQUIRED', 'Confirm the exact branch rename.');
  const worktree = object(body.worktree); fields(worktree, ['root', 'gitDir', 'indexPath']);
  if (typeof body.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.fingerprint)) throw new AppError('INVALID_WORKTREE', 'Confirm the previewed rename; its content fingerprint is missing.');
  if (typeof body.dirty !== 'boolean' || !Number.isInteger(body.checkpoints) || (body.checkpoints as number) < 0 || (body.checkpoints as number) > 10000) throw new AppError('INVALID_WORKTREE', 'Invalid rename preview.');
  if (!Array.isArray(body.commands) || body.commands.length > 10) throw new AppError('INVALID_WORKTREE', 'Invalid rename preview.');
  return { ...parseRenamePreview({ projectId: body.projectId, worktreeId: body.worktreeId, newBranch: body.newBranch }), requestId: requestId(body.requestId),
    worktree: { root: text(worktree.root), gitDir: text(worktree.gitDir), indexPath: text(worktree.indexPath) }, branch: text(body.branch), head: sha(body.head),
    fingerprint: body.fingerprint, dirty: body.dirty, checkpoints: body.checkpoints as number, commands: body.commands.map(text), confirm: true };
}
