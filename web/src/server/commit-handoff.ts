import { execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../core/errors.ts';
import type { BranchState, GitChange, HandoffArchive, HandoffEntry, HandoffIdentity, ImplementationRun, ImplementationTurn, Publication, ReviewPreview, ReviewPreviewInput, WorkspaceGit } from '../contracts/implementation.ts';
import { readBounded } from './bounded-read.ts';
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
/** `path` is the tracked journal mirror to exclude from project content, when the project keeps one. */
export async function validateReviewRange(root: string, base: string, head: string, path: string | null, commitPending = false): Promise<void> {
  if ((await gitRead(root, ['merge-base', base, head])).trim() !== base) fail('The review baseline must be an ancestor of the current candidate.');
  // A pending snapshot can supply the proposal even when the committed portion is empty.
  if (commitPending) return;
  const files = (await gitRead(root, ['diff', '--name-only', '--no-renames', '-z', base, head, '--'])).split('\0').filter(Boolean);
  if (!files.some((p) => p !== path)) fail('This range contains no project proposal to review.');
}
const MAX_RESULT = 64 * 1024;
const MAX_ARCHIVE = 1024 * 1024;
/** Raw Git output bounded by `maxBuffer`; null when the output would exceed it. */
function gitCapture(root: string, args: string[], maxBuffer: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => execFile('git', ['--no-replace-objects', '-C', root, ...args],
    { encoding: 'buffer', timeout: 10000, maxBuffer, env: gitEnvironment(), shell: false },
    (error, stdout) => !error ? resolve(stdout) : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? resolve(null) : reject(new AppError('GIT_STATE', `Git inspection failed (${args[0]}). Recheck the checkout.`, 409))));
}
/** The commit's full patch against its parent, binary content included, when it fits the bound and survives storage as text;
 * otherwise its diffstat marked incomplete. Intermediate revisions outlive squash integration and branch deletion only when
 * `complete` is true: that patch reproduces the commit exactly (`git apply`), which a "Binary files differ" notice would not. */
export async function archiveCommit(root: string, sha: string): Promise<HandoffArchive> {
  const header = ['--no-color', '--no-renames', '--full-index', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--format=commit %H%nparent %P%nauthor %an <%ae>%ndate %aI%n%n    %s%n'];
  const patch = await gitCapture(root, ['show', ...header, '--patch', '--binary', sha, '--'], MAX_ARCHIVE);
  // A text file holding invalid UTF-8 would be silently altered by the JSON store; keep only what can be reproduced.
  if (patch !== null) { try { return { patch: new TextDecoder('utf-8', { fatal: true }).decode(patch), complete: true }; } catch { /* fall back to the diffstat */ } }
  return { patch: await gitRead(root, ['show', ...header, '--stat=200', sha, '--']), complete: false };
}
function validateEntry(raw: unknown, identity: HandoffIdentity): HandoffEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Malformed handoff result.');
  const entry = raw as HandoffEntry;
  const fields = [...Object.keys(identity), 'model', 'decision', 'reason', 'needsHuman', 'summary', 'checks'];
  if (Object.keys(entry).length !== fields.length || Object.keys(entry).some((k) => !fields.includes(k))) fail('The handoff result does not match schema 1.');
  for (const [key, value] of Object.entries(identity)) if (entry[key as keyof HandoffIdentity] !== value) fail(`Handoff identity mismatch: ${key}.`);
  if (typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 16000 || typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 200 || !Array.isArray(entry.checks) || entry.checks.length > 100 || entry.checks.some((s) => typeof s !== 'string' || s.length > 2000)) fail('Missing or oversized handoff summary, model, or checks.');
  if (entry.reason !== null && (typeof entry.reason !== 'string' || entry.reason.length > 16000)) fail('Invalid objection reason.');
  if (typeof entry.needsHuman !== 'boolean' || (entry.decision === 'accept' && entry.needsHuman)) fail('needsHuman must explicitly identify results requiring human direction. Acceptance cannot require a blocking decision.');
  if (identity.action === 'work' ? entry.decision !== null || entry.reason !== null : !['accept', 'object'].includes(entry.decision!)) fail('Work is a proposal; only reviews report accept or object.');
  if (entry.decision === 'object' && !entry.reason?.trim()) fail('An objection requires a reason.');
  return entry;
}
/** The result file outside the checkout is the result channel. Git supplies at most one direct handoff commit on the assigned
 * parent; a report-only turn publishes none unless the project mirrors the journal into a tracked log. */
export async function readPublication(run: ImplementationRun, turn: ImplementationTurn, outcome?: string): Promise<{ publication: Publication; archive: HandoffArchive | null }> {
  const { identity } = turn; const root = run.worktree.root;
  if (!turn.resultPath) fail('This turn was assigned before the handoff journal existed and has no result path. Reconcile it by hand.');
  const state = await branchState(root);
  if (state.branch !== run.branch || !state.clean) fail('Publication has a changed branch or uncommitted leftovers. Reconcile before transferring ownership.');
  const raw = await readBounded(turn.resultPath, MAX_RESULT, fail, 'The handoff result');
  if (raw === null) fail('The assigned handoff result was not published before completion. Inspect the agent; nothing was inferred from the commit or terminal.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw!); } catch { return fail('The handoff result is not valid JSON.'); }
  const entry = validateEntry(parsed, identity);
  const committed = state.head !== identity.parent;
  if (committed) {
    const lineage = (await gitRead(root, ['rev-list', '--parents', '-n', '1', state.head])).trim().split(' ');
    if (lineage.length !== 2 || lineage[1] !== identity.parent) fail('Expected at most one direct, single-parent handoff commit on the assigned parent.');
    if (!(await gitRead(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', identity.parent, state.head, '--'])).split('\0').filter(Boolean).length) fail('An empty commit is not a handoff. Report-only results need no commit.');
  }
  if (run.logPath !== null) {
    if (!committed) fail('This project mirrors the journal into a tracked relay log: append the entry there inside one handoff commit.');
    await assertLogPath(root, run.logPath);
    const [before, after] = await Promise.all([logAt(root, identity.parent, run.logPath), logAt(root, state.head, run.logPath)]);
    if ((before && !before.endsWith('\n')) || !after.startsWith(before)) fail('Earlier relay-log entries were rewritten.');
    const appended = after.slice(before.length);
    if (!appended.endsWith('\n') || appended.slice(0, -1).includes('\n') || Buffer.byteLength(appended, 'utf8') > MAX_RESULT) fail('Append exactly one bounded JSON line to the relay log.');
    let mirrored: unknown;
    try { mirrored = JSON.parse(appended); } catch { return fail('The appended relay-log entry is not valid JSON.'); }
    if (!isDeepStrictEqual(mirrored, entry)) fail('The appended relay-log line differs from the published handoff result.');
  }
  // The initial combined action proposes the entire selected range, including earlier committed work.
  const proposalBase = identity.turn === 1 && run.request.kind === 'commit' && run.request.handoff ? run.acceptedSha : identity.parent;
  const files = proposalBase === state.head ? [] : (await gitRead(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', proposalBase, state.head, '--'])).split('\0').filter(Boolean);
  const projectChanged = files.some((p) => p !== run.logPath);
  if (projectChanged && (identity.action === 'review' || entry.decision === 'object')) fail('This reviewer changed project content without permission.');
  const normalized = identity.action === 'work' ? null : entry.decision === 'object' ? 'strong_objection' : projectChanged ? 'accept_and_improve' : 'accept_without_improvement';
  if (outcome && outcome !== normalized) fail('The structured completion outcome contradicts the published handoff.');
  const archive = committed ? await archiveCommit(root, state.head) : null;
  await assertClean(root, run.branch, state.head); // reject changes during inspection
  if (await readBounded(turn.resultPath, MAX_RESULT, fail, 'The handoff result') !== raw) fail('The handoff result changed during validation; ownership was not transferred.');
  return { publication: { sha: state.head, projectChanged, entry }, archive };
}

/** The newest commit on HEAD's first-parent chain back to `taskBase` (inclusive) at which the recipient completed a turn per the
 * journal, or null. A merged side branch, a rewritten history or an imported file is never such a receipt: only the journal's
 * validated publications count, and only where Git ancestry shows this checkout contains them. Git author and date are never used. */
export async function lastPublishedBy(root: string, head: string, taskBase: string, publishedBy: (shas: string[]) => Set<string>): Promise<string | null> {
  // Past 101 commits the range is over the preview cap anyway.
  const chain = (await gitRead(root, ['rev-list', '--first-parent', '--max-count=101', `${taskBase}..${head}`])).trim().split('\n').filter(Boolean);
  const seen = publishedBy([...chain, taskBase]);
  return chain.find((sha) => seen.has(sha)) ?? (seen.has(taskBase) ? taskBase : null);
}
/** Read committed objects only, and pin both ends of the displayed range. */
export async function previewCommittedRange(root: string, input: ReviewPreviewInput, publishedBy: (agentId: string, shas: string[]) => Set<string>): Promise<ReviewPreview> {
  const current = async () => (await gitRead(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (await current() !== input.head) fail('HEAD changed. Recheck before previewing a review.');
  if (input.taskBase && input.taskBase !== input.head && !await isAncestor(root, input.taskBase, input.head)) fail('The task baseline must be the current commit or one of its ancestors.');
  const recipient = input.base ? null : await lastPublishedBy(root, input.head, input.taskBase!, (shas) => publishedBy(input.recipient!, shas));
  const since = input.base ? 'explicit' : recipient ? 'recipient' : 'task';
  const base = input.base ?? recipient ?? input.taskBase!;
  await validateReviewRange(root, base, input.head, input.logPath ?? null, input.commitPending);
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
