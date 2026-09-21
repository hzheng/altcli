import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CapturedPlanResult, PlanDocument, PlanningRun, PlanResult, PlanTurn } from '../contracts/planning.ts';
import { AppError } from '../core/errors.ts';
import { readBounded as readBoundedFile } from './bounded-read.ts';
import { assertClean, gitRead } from './commit-handoff.ts';

const fail = (text: string): never => { throw new AppError('PLAN_ARTIFACT', text, 409); };
export const planHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const MAX_DOCUMENT = 128 * 1024;
/** Reject links and non-directory parents before any capture. This is not hostile-process isolation. */
async function safePath(root: string, relative: string): Promise<void> {
  let path = root;
  const parts = relative.split('/');
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!info) continue;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || await realpath(path) !== path) fail(`Unsafe planning path: ${relative}. Use ordinary unlinked files inside this checkout.`);
  }
}
const readBounded = (path: string, maximum: number) => readBoundedFile(path, maximum, fail, 'Planning output');
export async function validatePlanPaths(plan: PlanningRun): Promise<void> {
  const root = plan.worktree.root;
  // A broad .codercrew exclusion could hide a tracked relay log; require a narrow planning exclusion.
  if (await gitRead(root, ['check-ignore', '--no-index', '--', '.codercrew/scope-check'], true)) fail('Narrow the ignore rule to .codercrew/plans/ yourself; the controller does not edit ignore rules.');
  for (const path of [...Object.values(plan.drafts).map((d) => d.path), plan.planPath]) {
    await safePath(root, path);
    if (!await gitRead(root, ['check-ignore', '--no-index', '--', path], true) || await gitRead(root, ['ls-files', '-z', '--', path])) fail(`Planning output must be ignored and untracked: ${path}. Add a narrow .codercrew/plans/ exclusion before Start.`);
  }
}
/** Concurrency is one: every nonassigned task artifact must match its captured bytes. */
export async function assertPlanArtifacts(plan: PlanningRun, allowedOutput?: string): Promise<void> {
  await validatePlanPaths(plan);
  const expected = new Map<string, PlanDocument | null>(Object.values(plan.drafts).map((d) => [d.path, d.document]));
  expected.set(plan.planPath, plan.current?.path === plan.planPath ? plan.current : null);
  const names = await readdir(join(plan.worktree.root, plan.directory)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
  for (const name of names) if (!expected.has(`${plan.directory}/${name}`)) fail(`Unexpected planning artifact: ${plan.directory}/${name}. Reconcile it; no file was removed.`);
  for (const [path, document] of expected) {
    if (path === allowedOutput) continue;
    const text = await readBounded(join(plan.worktree.root, path), MAX_DOCUMENT);
    if (text !== (document?.text ?? null)) fail(`Protected planning artifact changed: ${path}. Reconcile the writers.`);
  }
}
export async function assertPlanBaseline(plan: PlanningRun): Promise<void> {
  try { await assertClean(plan.worktree.root, plan.request.baseline.branch, plan.request.baseline.head); }
  catch (error) {
    const paths = (await gitRead(plan.worktree.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).slice(0, 2000);
    throw new AppError('PLAN_BASELINE', `Planning must preserve its clean branch and code baseline. ${paths || (error instanceof Error ? error.message : 'Recheck the checkout.')}`, 409);
  }
}
export async function capturePlanResult(plan: PlanningRun, turn: PlanTurn): Promise<CapturedPlanResult> {
  await assertPlanBaseline(plan);
  await assertPlanArtifacts(plan, turn.identity.outputPath);
  const raw = await readBounded(turn.resultPath, 32 * 1024);
  if (!raw) fail('The assigned planning result was not published before completion. Inspect the planner; nothing was inferred from a draft file.');
  let result: PlanResult;
  try { result = JSON.parse(raw!); } catch { return fail('Invalid planning result JSON.'); }
  if (!result! || typeof result !== 'object' || Object.keys(result).sort().join(',') !== 'identity,model,outcome,outputHash,reason,summary' || !isDeepStrictEqual(result.identity, turn.identity)) fail('Planning result identity or schema does not match this assignment.');
  if (typeof result.model !== 'string' || !result.model.trim() || result.model.length > 200 || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 8000 || (result.reason !== null && (typeof result.reason !== 'string' || result.reason.length > 8000))) fail('Invalid or oversized planning result explanation.');
  const review = turn.identity.action === 'review';
  if (!(review ? ['accept','object','blocked'] : ['complete','blocked']).includes(result.outcome) || (['object','blocked'].includes(result.outcome) && !result.reason?.trim())) fail('The planning decision does not match its assigned action or lacks a blocking reason.');
  const path = join(plan.worktree.root, turn.identity.outputPath);
  const text = await readBounded(path, MAX_DOCUMENT);
  const document = text === null ? null : { text, hash: planHash(text) };
  if (result.outputHash !== (document?.hash ?? null) || (result.outcome !== 'blocked' && !text?.trim())) fail('Planning result hash does not identify a complete, nonempty output.');
  if (result.outcome === 'object' && document?.hash !== turn.identity.inputHash) fail('An objecting planner must not edit the shared plan. Preserve the evidence and reconcile.');
  await assertPlanBaseline(plan);
  await assertPlanArtifacts(plan, turn.identity.outputPath);
  if (await readBounded(path, MAX_DOCUMENT) !== text || await readBounded(turn.resultPath, 32 * 1024) !== raw) fail('Planning output changed during capture; ownership was not transferred.');
  return { result, document };
}
