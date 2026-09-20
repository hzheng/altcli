import { execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../core/errors.ts';
import type { BranchState, GitChange, HandoffEntry, HandoffIdentity, ImplementationRun, Publication, ReviewPreview, ReviewPreviewInput, WorkspaceGit } from '../contracts/implementation.ts';
import { gitEnvironment, worktreeFingerprint } from './worktree.ts';

const fail = (message: string): never => { throw new AppError('COMMIT_HANDOFF', message, 409); };
/** Argument-only Git calls with canonical environment; no repository config or network writes. */
export function gitRead(root: string, args: string[], allowFailure = false): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['--no-replace-objects', '-C', root, ...args],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: gitEnvironment(), shell: false },
    (error, stdout) => error && !(allowFailure && error.code === 1) ? reject(new AppError('GIT_STATE', `Git inspection failed (${args[0]}). Recheck the checkout.`, 409)) : resolve(stdout)));
}
/** Whether any index entry is assume-unchanged (lowercase tag) or skip-worktree (S). The listing is scanned as it streams,
 * so a large repository's tracked-file count never exceeds a buffer and turns a clean checkout into a failed inspection. */
function hiddenIndexFlags(root: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-replace-objects', '-C', root, 'ls-files', '-v', '-z'], { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 10000);
    let hidden = false; let entryStart = true;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const byte of chunk) { // each NUL-terminated entry begins with its one-letter tag
        if (entryStart && ((byte >= 0x61 && byte <= 0x7a) || byte === 0x53)) hidden = true;
        entryStart = byte === 0;
      }
    });
    const failed = () => { clearTimeout(timer); reject(new AppError('GIT_STATE', 'Git inspection failed (ls-files). Recheck the checkout.', 409)); };
    child.on('error', failed);
    child.on('close', (code) => { if (code !== 0) return failed(); clearTimeout(timer); resolve(hidden); });
  });
}
/** The repository's default branch as recorded locally in origin/HEAD, read without fetching; null when unknown. */
export async function defaultBranch(root: string): Promise<string | null> {
  return (await gitRead(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], true)).trim().replace(/^origin\//, '') || null;
}
export async function branchState(root: string): Promise<BranchState> {
  const [branch, head, status, primary, hidden] = await Promise.all([
    gitRead(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true),
    gitRead(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    gitRead(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']),
    defaultBranch(root),
    hiddenIndexFlags(root),
  ]);
  if (hidden) fail('The index hides tracked files through assume-unchanged or skip-worktree flags. Reconcile those flags before implementation.');
  const entries = status.split('\0'); const changes: GitChange[] = []; let changeCount = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i]!; const code = entry.slice(0, 2);
    // In -z format a rename/copy is destination first, then a separate NUL-delimited source.
    const originalPath = /[RC]/.test(code) ? entries[++i]! : null;
    changeCount++;
    if (changes.length < 100) changes.push({ status: code, path: entry.slice(3), originalPath });
  }
  // The local remote HEAD is read without fetching. Unknown remains visible and every start explicitly confirms its branch.
  return { branch: branch.trim() || null, head: head.trim(), primary, clean: status.length === 0, changes, changeCount };
}
export async function assertClean(root: string, branch: string | null, head: string): Promise<BranchState> {
  const state = await branchState(root);
  if (!state.clean) fail('The index and nonignored worktree must be clean. Commit or reconcile your changes before continuing.');
  if (state.branch !== branch || state.head !== head) fail('The checked-out branch or commit changed. Recheck and make a fresh branch choice.');
  return state;
}
/** The first work turn may finish captured unfinished work; every other turn starts clean. */
export async function assertWorktreeInput(root: string, branch: string | null, head: string, fingerprint?: string): Promise<BranchState> {
  if (!fingerprint) return assertClean(root, branch, head);
  const state = await branchState(root);
  if (state.branch !== branch || state.head !== head) fail('The checked-out branch or commit changed. Recheck and make a fresh branch choice.');
  if (await worktreeFingerprint(root) !== fingerprint) fail('The unfinished work changed after the handoff started. Inspect the checkout before continuing.');
  return state;
}
/** Names that are starting points, never implementation branches: the detected default branch plus the host's configured list. */
export const integrationNames = (primary: string | null, configured: string[]): string[] => [...new Set([...(primary ? [primary] : []), ...configured])];
/** False for a commit that does not exist here, so a mistyped user-supplied baseline is refused rather than reported as a Git failure. */
export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  if (!(await gitRead(root, ['rev-parse', '--verify', '--quiet', `${ancestor}^{commit}`], true)).trim()) return false;
  return new Promise((resolve, reject) => execFile('git', ['--no-replace-objects', '-C', root, 'merge-base', '--is-ancestor', ancestor, descendant],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: gitEnvironment(), shell: false },
    (error) => !error ? resolve(true) : error.code === 1 ? resolve(false) : reject(new AppError('GIT_STATE', 'Git inspection failed (merge-base). Recheck the checkout.', 409))));
}
/** Read-only integration policy for a checkout: whether its branch is an integration branch, and where its task work begins.
 * The baseline is the head itself when no commit lies beyond an integration tip, the single nearest merge base when the local
 * or origin integration tips agree, and null (confirm by hand) when they diverge or no tip exists. */
export async function taskBaseline(root: string, state: BranchState, configured: string[]): Promise<Pick<WorkspaceGit, 'integration' | 'taskBase'>> {
  const names = integrationNames(state.primary, configured);
  if (state.branch !== null && names.includes(state.branch)) return { integration: true, taskBase: null };
  const wanted = new Set(names.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`]));
  const refs = (await gitRead(root, ['for-each-ref', '--format=%(refname) %(objectname)', '--', ...wanted])).split('\n').filter(Boolean).map((line) => line.split(' '));
  const tips = [...new Set(refs.filter(([name]) => wanted.has(name!)).map(([, sha]) => sha!))];
  // Criss-cross histories may have multiple equally good bases for a single tip. Never let Git choose one implicitly.
  const bases = [...new Set((await Promise.all(tips.map((tip) => gitRead(root, ['merge-base', '--all', state.head, tip], true)))).flatMap((output) => output.trim().split('\n')).filter(Boolean))];
  if (!bases.length) return { integration: false, taskBase: null };
  if (bases.includes(state.head)) return { integration: false, taskBase: state.head };
  const nearest = (await gitRead(root, ['merge-base', '--independent', ...bases])).split('\n').filter(Boolean);
  return { integration: false, taskBase: nearest.length === 1 ? nearest[0]! : null };
}
export async function assertLogPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await lstat(current).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
    if (stat?.isSymbolicLink()) fail('The relay log and its parent directories must not be symlinks.');
    if (stat && await realpath(current) !== current) fail('The relay log must remain inside the canonical checkout.');
  }
  if (await gitRead(root, ['check-ignore', '--no-index', '--', path], true)) fail('The relay log is ignored. Choose a nonignored path or prepare a narrow ignore rule yourself.');
}
export async function validateExistingLog(root: string, head: string, path: string): Promise<void> {
  const log = await logAt(root, head, path);
  if (!log) return;
  if (!log.endsWith('\n')) fail('The existing log is not a newline-terminated handoff journal. Choose another path.');
  for (const line of log.slice(0, -1).split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { return fail('The existing log contains non-JSON content. Choose another path.'); }
    if (!entry || entry.schema !== 1 || entry.phase !== 'implementation' || typeof entry.commandId !== 'string' || typeof entry.parent !== 'string' || !['work','review','review_and_improve'].includes(entry.action)) fail('The selected path is not a schema-1 implementation journal.');
  }
}
export async function validateNewBranch(root: string, name: string): Promise<void> {
  if ((await gitRead(root, ['check-ref-format', '--branch', name])).trim() !== name) fail('Invalid new branch name.');
  if ((await gitRead(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${name}`])).trim()) fail('That branch already exists. Choose a new name; existing branches are never overwritten.');
}
/** Existing-checkout setup mutation: called once under its persisted owner and scoped consent. Never retried. */
export async function createConsentedBranch(root: string, name: string, head: string): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'switch', '-c', name, head],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: gitEnvironment(), shell: false },
    (error) => error ? reject(new AppError('BRANCH_UNCERTAIN', 'Branch setup did not return a confirmed result. Inspect the checkout; it will not be retried.', 409)) : resolve()));
}
async function logAt(root: string, sha: string, path: string): Promise<string> {
  const entry = await gitRead(root, ['ls-tree', '-z', sha, '--', path]);
  if (!entry) return '';
  if (!/^100644 blob [0-9a-f]+\t/.test(entry) || entry.split('\0').filter(Boolean).length !== 1) fail('The relay log must be an ordinary nonexecutable tracked file.');
  return gitRead(root, ['show', `${sha}:${path}`]);
}
export async function validateReviewRange(root: string, base: string, head: string, path: string, commitPending = false): Promise<void> {
  if ((await gitRead(root, ['merge-base', base, head])).trim() !== base) fail('The review baseline must be an ancestor of the current candidate.');
  // A pending snapshot can supply the proposal even when the committed portion is empty.
  if (commitPending) return;
  const files = (await gitRead(root, ['diff', '--name-only', '--no-renames', '-z', base, head, '--'])).split('\0').filter(Boolean);
  if (!files.some((p) => p !== path)) fail('This range contains no project proposal to review.');
}
export async function readPublication(run: ImplementationRun, identity: HandoffIdentity, outcome?: string): Promise<Publication> {
  const root = run.worktree.root;
  const state = await branchState(root);
  if (state.branch !== run.branch || !state.clean) fail('Publication has a changed branch or uncommitted leftovers. Reconcile before transferring ownership.');
  const lineage = (await gitRead(root, ['rev-list', '--parents', '-n', '1', state.head])).trim().split(' ');
  if (lineage.length !== 2 || lineage[1] !== identity.parent || state.head === identity.parent) fail('Expected exactly one direct, single-parent handoff commit.');
  await assertLogPath(root, run.logPath);
  const [before, after] = await Promise.all([logAt(root, identity.parent, run.logPath), logAt(root, state.head, run.logPath)]);
  if ((before && !before.endsWith('\n')) || !after.startsWith(before)) fail('Earlier relay-log entries were rewritten.');
  const appended = after.slice(before.length);
  if (!appended.endsWith('\n') || appended.slice(0, -1).includes('\n') || Buffer.byteLength(appended, 'utf8') > 65536) fail('Append exactly one bounded JSON line to the relay log.');
  let raw: unknown;
  try { raw = JSON.parse(appended); } catch { return fail('The appended relay-log entry is not valid JSON.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Malformed relay-log entry.');
  const entry = raw as HandoffEntry;
  const fields = [...Object.keys(identity), 'model', 'decision', 'reason', 'needsHuman', 'summary', 'checks'];
  if (Object.keys(entry).length !== fields.length || Object.keys(entry).some((k) => !fields.includes(k))) fail('The relay-log entry does not match schema 1.');
  for (const [key, value] of Object.entries(identity)) if (entry[key as keyof HandoffIdentity] !== value) fail(`Handoff identity mismatch: ${key}.`);
  if (typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 16000 || typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 200 || !Array.isArray(entry.checks) || entry.checks.length > 100 || entry.checks.some((s) => typeof s !== 'string' || s.length > 2000)) fail('Missing or oversized handoff summary, model, or checks.');
  if (entry.reason !== null && (typeof entry.reason !== 'string' || entry.reason.length > 16000)) fail('Invalid objection reason.');
  if (typeof entry.needsHuman !== 'boolean' || (entry.decision === 'accept' && entry.needsHuman)) fail('needsHuman must explicitly identify results requiring human direction. Acceptance cannot require a blocking decision.');
  if (identity.action === 'work' ? entry.decision !== null || entry.reason !== null : !['accept', 'object'].includes(entry.decision!)) fail('Work is a proposal; only reviews report accept or object.');
  if (entry.decision === 'object' && !entry.reason?.trim()) fail('An objection requires a reason.');
  // The initial combined action proposes the entire selected range, including earlier committed work.
  const proposalBase = identity.turn === 1 && run.request.kind === 'commit' && run.request.handoff ? run.acceptedSha : identity.parent;
  const files = (await gitRead(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', proposalBase, state.head, '--'])).split('\0').filter(Boolean);
  const projectChanged = files.some((p) => p !== run.logPath);
  if (projectChanged && (identity.action === 'review' || entry.decision === 'object')) fail('This reviewer changed project content without permission.');
  const normalized = identity.action === 'work' ? null : entry.decision === 'object' ? 'strong_objection' : projectChanged ? 'accept_and_improve' : 'accept_without_improvement';
  if (outcome && outcome !== normalized) fail('The structured completion outcome contradicts the committed handoff.');
  await assertClean(root, run.branch, state.head); // reject changes during inspection
  return { sha: state.head, projectChanged, entry };
}

/** The newest handoff commit `agentId` published on the first-parent chain after `taskBase`, or null. A handoff commit has
 * exactly one parent and appends exactly one journal entry naming that parent and the agent (the shape readPublication
 * accepts). A merge, a rewritten journal, or an imported entry is not evidence that the agent saw this checkout.
 * Git author and date are never used. */
export async function lastPublishedBy(root: string, head: string, taskBase: string, path: string, agentId: string): Promise<string | null> {
  await validateExistingLog(root, head, path);
  // Only commits that touched the log can be handoffs. Past 101 of them the range is over the preview cap anyway.
  const touched = (await gitRead(root, ['rev-list', '--first-parent', '--max-count=101', `${taskBase}..${head}`, '--', path])).trim().split('\n').filter(Boolean);
  for (const sha of touched) {
    const lineage = (await gitRead(root, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
    if (lineage.length !== 2) continue;
    const parent = lineage[1]!;
    const [before, after] = await Promise.all([logAt(root, parent, path), logAt(root, sha, path)]);
    if (!after.startsWith(before)) continue;
    const appended = after.slice(before.length).split('\n').filter(Boolean);
    if (appended.length !== 1) continue;
    let entry: HandoffEntry; try { entry = JSON.parse(appended[0]!); } catch { continue; }
    if (entry.agentId === agentId && entry.parent === parent) return sha;
  }
  return null;
}
/** Read committed objects only, and pin both ends of the displayed range. */
export async function previewCommittedRange(root: string, input: ReviewPreviewInput): Promise<ReviewPreview> {
  const current = async () => (await gitRead(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (await current() !== input.head) fail('HEAD changed. Recheck before previewing a review.');
  if (input.taskBase && input.taskBase !== input.head && !await isAncestor(root, input.taskBase, input.head)) fail('The task baseline must be the current commit or one of its ancestors.');
  const recipient = input.base ? null : await lastPublishedBy(root, input.head, input.taskBase!, input.logPath, input.recipient!);
  const since = input.base ? 'explicit' : recipient ? 'recipient' : 'task';
  const base = input.base ?? recipient ?? input.taskBase!;
  await validateReviewRange(root, base, input.head, input.logPath, input.commitPending);
  const fields = (await gitRead(root, ['log', '--max-count=101', '--format=%H%x00%s', '-z', `${base}..${input.head}`, '--'])).split('\0');
  const commits: ReviewPreview['commits'] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ sha: fields[i]!, subject: fields[i + 1]! });
  if (commits.length > 100) fail('This range exceeds 100 commits. Choose a more recent baseline.');
  const baseSubject = (await gitRead(root, ['log', '--max-count=1', '--format=%s', base, '--'])).trimEnd();
  // Later baselines are the first-parent ancestors of HEAD after `base`: a linear chain, unlike the full range listing.
  const chain = (await gitRead(root, ['log', '--first-parent', '--max-count=101', '--format=%H%x00%s', '-z', `${base}..${input.head}`, '--'])).split('\0');
  const candidates: ReviewPreview['candidates'] = [{ sha: base, subject: baseSubject }];
  for (let i = chain.length - 2; i >= 2; i -= 2) candidates.push({ sha: chain[i - 1]!, subject: chain[i]! });
  if (input.commitPending && base !== input.head) candidates.push({ sha: input.head, subject: commits[0]!.subject });
  if (await current() !== input.head) fail('HEAD changed while previewing. Recheck the workspace.');
  return { base, baseSubject, head: input.head, since, commits, candidates };
}
