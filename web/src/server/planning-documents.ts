import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CapturedPlanResult, PlanDocument, PlanningRun, PlanResult, PlanTurn } from '../contracts/planning.ts';
import { AppError } from '../core/errors.ts';
import { readBounded as readBoundedFile } from './bounded-read.ts';
import { assertClean, gitRead } from './commit-handoff.ts';
import { isWithin } from './paths.ts';

const fail = (text: string): never => { throw new AppError('PLAN_ARTIFACT', text, 409); };
export const planHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const MAX_DOCUMENT = 128 * 1024;
/** Reject links and non-directory parents before any capture. This is not hostile-process isolation. */
async function safePath(root: string, child: string): Promise<void> {
  let path = root;
  const parts = child.split('/');
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!info) continue;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || await realpath(path) !== path) fail(`Unsafe planning path: ${join(root, child)}. Use ordinary unlinked files in the plan directory.`);
  }
}
const readBounded = (path: string, maximum: number) => readBoundedFile(path, maximum, fail, 'Planning output');
/** A link at the plan root would redirect every plan write, possibly into the checkout, so it is refused before being
 * followed; the resolved root must also lie outside the bound worktree. */
async function assertPlanRoot(root: string, worktree: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`Unsafe plan directory: ${root}. Use an ordinary directory, not a link.`);
  if (isWithin(await realpath(worktree), await realpath(root))) fail(`The plan directory ${root} is inside the checkout. Keep CoderCrew's data directory outside every project.`);
}
/** Creates CoderCrew's plan directory and returns its canonical path once it is known to be safe for this worktree. */
export async function planRoot(dataDir: string, worktree: string): Promise<string> {
  const path = join(dataDir, 'plans'); await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPlanRoot(path, worktree); return realpath(path);
}
/** Plan documents live in CoderCrew's data directory, outside every checkout, so no ignore rule is involved. */
export async function validatePlanPaths(plan: PlanningRun): Promise<void> {
  // Earlier runs stored checkout-relative .codercrew/plans/ paths; they are refused rather than resolved against a guess.
  if (!isAbsolute(plan.directory)) fail('This planning run keeps its documents inside the checkout, an earlier layout. Take over and start a new Plan.');
  const root = dirname(plan.directory); await assertPlanRoot(root, plan.worktree.root);
  for (const path of [...Object.values(plan.drafts).map((d) => d.path), plan.planPath]) await safePath(root, relative(root, path));
}
/** Concurrency is one: every nonassigned task artifact must match its captured bytes. */
export async function assertPlanArtifacts(plan: PlanningRun, allowedOutput?: string): Promise<void> {
  await validatePlanPaths(plan);
  const expected = new Map<string, PlanDocument | null>(Object.values(plan.drafts).map((d) => [d.path, d.document]));
  expected.set(plan.planPath, plan.current?.path === plan.planPath ? plan.current : null);
  const names = await readdir(plan.directory).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
  for (const name of names) if (!expected.has(join(plan.directory, name))) fail(`Unexpected planning artifact: ${join(plan.directory, name)}. Reconcile it; no file was removed.`);
  for (const [path, document] of expected) {
    if (path === allowedOutput) continue;
    const text = await readBounded(path, MAX_DOCUMENT);
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
  const path = turn.identity.outputPath;
  const text = await readBounded(path, MAX_DOCUMENT);
  const document = text === null ? null : { text, hash: planHash(text) };
  if (result.outputHash !== (document?.hash ?? null) || (result.outcome !== 'blocked' && !text?.trim())) fail('Planning result hash does not identify a complete, nonempty output.');
  if (result.outcome === 'object' && document?.hash !== turn.identity.inputHash) fail('An objecting planner must not edit the shared plan. Preserve the evidence and reconcile.');
  await assertPlanBaseline(plan);
  await assertPlanArtifacts(plan, turn.identity.outputPath);
  if (await readBounded(path, MAX_DOCUMENT) !== text || await readBounded(turn.resultPath, 32 * 1024) !== raw) fail('Planning output changed during capture; ownership was not transferred.');
  return { result, document };
}
