import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionRegistration } from '../contracts/api.ts';
import type { Project, ProjectRecord, ProjectWorktree, WorktreeCreateInput, WorktreeCreation, WorktreeDiscard, WorktreeDiscardConfirm, WorktreeDiscardFinish, WorktreeDiscardInput, WorktreeDiscardPreview, WorktreeIntegrateInput, WorktreeIntegrateRequest, WorktreeIntegration, WorktreeIntegrationInput, WorktreeIntegrationPreview, WorktreePreview, WorktreePreviewInput, WorktreeRemoval, WorktreeRemovalInput, WorktreeRemovalPreview, WorktreeRemoveInput } from '../contracts/projects.ts';
import type { Workspace, WorktreeIdentity } from '../contracts/workflow.ts';
import { AppError, messageOf } from '../core/errors.ts';
import { parseDiscard, parseDiscardFinish, parseDiscardPreview, parseIntegrate, parseIntegrationPreview, parseWorktreeCreate, parseWorktreePreview, parseRemoval, parseRemovalPreview } from '../core/project-validation.ts';
import { terminalFields, terminalText } from '../core/terminal-validation.ts';
import { defaultSquashMessage } from '../core/squash-message.ts';
import { branchState, defaultBranch, integrationNames, validateNewBranch } from './commit-handoff.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { gitEnvironment, resolveWorktree, sameWorktree, worktreeFingerprint } from './worktree.ts';

const idOf = (kind: string, value: unknown) => `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
/** What a squash confirmation consents to: every pinned preview field except the per-preview request ID and the editable message. */
const integrationConsent = (preview: Omit<WorktreeIntegrationPreview, 'requestId' | 'message' | 'consent'>) => createHash('sha256').update(JSON.stringify(canonical(preview))).digest('hex');
const contains = (parent: string, path: string) => { const part = relative(parent, path); return !part || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part)); };
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Bounded Git calls, with no inherited custom index or worktree. Never expose raw stderr (which may contain remote credentials). */
function git(args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', ['--no-replace-objects', ...args], { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment() },
    (error, stdout) => error ? fail(new AppError('PROJECT_GIT', 'Git could not complete the project operation. Inspect the host; nothing will be retried automatically.', 409)) : done(stdout)));
}
/** Like `git`, but exit status 1 is an answer (merge-tree reports conflicts that way), not a failure. */
function gitAnswer(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done, fail) => execFile('git', ['--no-replace-objects', ...args], { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment() },
    (error, stdout) => !error ? done({ code: 0, stdout }) : error.code === 1 ? done({ code: 1, stdout }) : fail(new AppError('PROJECT_GIT', 'Git could not complete the project operation. Inspect the host; nothing will be retried automatically.', 409))));
}
const treeDiff = (from: string, to: string) => ['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', from, to, '--'];
/** Stream the already merged tree into the real index without buffering binary patches or overwriting ignored local files.
 * Both children are awaited; no shell, temporary index, branch movement or background mutation is involved. */
async function stageIntegrationTree(path: string, from: string, to: string): Promise<void> {
  const options = { shell: false as const, timeout: 60000, env: gitEnvironment() };
  const diff = spawn('git', ['--no-replace-objects', '-C', path, ...treeDiff(from, to)], { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
  const apply = spawn('git', ['--no-replace-objects', '-C', path, 'apply', '--index', '--binary', '--whitespace=nowarn'], { ...options, stdio: ['pipe', 'ignore', 'ignore'] });
  apply.stdin.on('error', () => { diff.kill(); });
  diff.stdout.pipe(apply.stdin);
  const outcomes = await Promise.all([diff, apply].map((child) => new Promise<boolean>((resolve) => {
    let failed = false;
    const other = child === diff ? apply : diff;
    child.once('error', () => { failed = true; other.kill(); });
    child.once('close', (code) => { if (code !== 0) other.kill(); resolve(!failed && code === 0); });
  })));
  if (outcomes.some((ok) => !ok)) throw new AppError('INTEGRATION_APPLY', 'The previewed changes could not be staged. Inspect the integration checkout, including ignored files that may obstruct the batch.', 409);
}
export async function commonGitDir(root: string): Promise<string> {
  const path = (await git(['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd();
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new AppError('PROJECT_IDENTITY', 'Git returned an ambiguous common directory.', 409);
  return realpath(path);
}
/** -z avoids quoted paths, spaces and locale-dependent human output. Bare repositories are not runnable checkouts. */
async function worktrees(project: ProjectRecord): Promise<ProjectWorktree[]> {
  const output = await git(['--git-dir', project.commonDir, 'worktree', 'list', '--porcelain', '-z']);
  const entries: Record<string, string>[] = []; let entry: Record<string, string> = {};
  for (const field of output.split('\0')) {
    if (!field) { if (entry.worktree) entries.push(entry); entry = {}; continue; }
    const space = field.indexOf(' '); entry[space < 0 ? field : field.slice(0, space)] = space < 0 ? '' : field.slice(space + 1);
  }
  return Promise.all(entries.filter((row) => !('bare' in row)).map(async (row) => {
    const path = row.worktree!;
    let identity = null; let error: string | null = null;
    try {
      if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('ambiguous path');
      identity = await resolveWorktree(path);
      if (!identity || await commonGitDir(path) !== project.commonDir) throw new Error('changed identity');
    } catch { identity = null; error = 'Worktree is missing, inaccessible, or no longer belongs to this project. Recheck after inspecting the host.'; }
    return { id: idOf('worktree', identity ? [project.id, identity.gitDir, identity.indexPath] : [project.id, path]),
      path: identity?.root ?? path, branch: row.branch?.startsWith('refs/heads/') ? row.branch.slice(11) : null,
      head: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.HEAD ?? '') && !/^0+$/.test(row.HEAD!) ? row.HEAD! : null,
      main: identity?.gitDir === project.commonDir, identity, error };
  }));
}
/** Resolve a not-yet-created path without following dangling symlinks. */
async function futurePath(path: string): Promise<string> {
  if (await exists(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) throw new AppError('WORKTREE_PATH', 'The task-worktree parent is inaccessible.', 409);
  return join(await futurePath(parent), basename(path));
}

/** A checkout under the task-worktree root sits at `<root>/<repository>/<branch>`, so the repository directory names the project, not the branch directory. */
function projectName(commonDir: string, taskRoot: string | null): string {
  const root = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  if (taskRoot && root !== taskRoot && contains(taskRoot, root)) {
    const repository = relative(taskRoot, root).split(process.platform === 'win32' ? /[\\/]/ : '/')[0]!;
    if (repository) return repository;
  }
  return basename(root).replace(/\.git$/, '');
}

/** Read-only inventory plus one explicit, durable setup operation. Never changes run ownership or terminal state. */
export class ProjectCatalog {
  private readonly known = new Map<string, ProjectRecord>();
  private views: Project[] = [];
  private readonly store: Store;
  private readonly config: Config;
  constructor(store: Store, config: Config) {
    this.store = store; this.config = config;
    for (const project of store.projects()) this.known.set(project.id, project);
    for (const operation of store.worktreeRemovals().filter((op) => op.status === 'applying')) this.removalFinish(operation, 'uncertain', 'Backend restarted during removal. Inspect its result; nothing is retried.');
    for (const operation of store.worktreeIntegrations().filter((op) => op.status === 'applying')) this.integrationFinish(operation, 'uncertain', 'Backend restarted during squash integration. Inspect the integration checkout; nothing is retried.');
    for (const operation of store.worktreeDiscards().filter((op) => op.status === 'applying')) this.discardFinish(operation, 'uncertain', 'Backend restarted during discard. Inspect its result; nothing is retried.');
    for (const operation of store.worktreeCreations().filter((op) => op.status === 'applying')) this.finish(operation, 'uncertain', 'Backend restarted during worktree creation. Inspect and reconcile; do not retry.');
  }
  /** Explicit path entry is metadata only: no shell, tmux server creation or Git mutation. */
  async add(value: unknown): Promise<ProjectRecord> {
    if(!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled project changes.', 403);
    const b = terminalFields(value, ['path']); const path = terminalText(b.path, 4096);
    if (!isAbsolute(path)) throw new AppError('PROJECT_PATH', 'Enter an absolute repository directory.');
    let root: string, commonDir: string;
    if (this.config.mode === 'mock') {
      if (!/^\/demo\/[A-Za-z0-9_-]+$/.test(path)) throw new AppError('MOCK_PROJECT', 'Mock repository paths use /demo/name. No real directory is inspected.');
      root = path; commonDir = `${path}/.git`;
    } else {
      const identity = await resolveWorktree(await realpath(path)).catch(() => null);
      if (!identity) throw new AppError('PROJECT_PATH', 'Choose an accessible, non-bare Git checkout.', 409);
      root = identity.root; commonDir = await commonGitDir(root);
      const metadata = await futurePath(this.config.dataDir);
      if (contains(root, metadata) || contains(metadata, root) || contains(commonDir, metadata) || contains(metadata, commonDir)) throw new AppError('PROJECT_PATH', 'Controller metadata and projects must not overlap.', 409);
    }
    const id = idOf('project', commonDir); const existing = this.known.get(id);
    if (existing) { this.store.saveProject(existing); return existing; }
    const name = projectName(commonDir, await this.taskRoot());
    const slug = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'project';
    const record = { id, commonDir, name, directoryName: [...this.known.values()].some(p => p.directoryName.toLowerCase() === slug.toLowerCase()) ? `${slug}-${id.slice(-8)}` : slug };
    this.store.saveProject(record); this.known.set(id, record); return record;
  }
  record(projectId: string): ProjectRecord {
    const project = this.known.get(projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck the project before launching.', 409);
    return project;
  }
  async launchWorktree(projectId: string, worktreeId: string): Promise<ProjectWorktree> {
    const project = this.record(projectId);
    const trees = this.config.mode === 'mock' ? this.views.find(p => p.id === projectId)?.worktrees ?? [] : await worktrees(project);
    const tree = trees.find(t => t.id === worktreeId);
    if (!tree?.identity || tree.error || !tree.head) throw new AppError('WORKTREE_CHANGED', 'Choose an accessible checkout with an initial commit.', 409);
    this.assertWorktreeReady(tree.path, true); return tree;
  }
  async discover(live: Workspace[], sessions: SessionRegistration[]): Promise<Project[]> {
    const roots = [...new Set([...live.map((w) => w.worktree.root), ...sessions.map((s) => s.repository)])].sort();
    let taskRoot: string | null = null;
    try { taskRoot = await this.taskRoot(); } catch { /* An unreadable task root only costs the repository-directory naming below. */ }
    for (const root of roots) {
      try {
        const commonDir = this.config.mode === 'mock' ? `${root}/.git` : await commonGitDir(root);
        const id = idOf('project', commonDir);
        const known = this.known.get(id);
        const name = projectName(commonDir, taskRoot);
        if (known?.name === name) continue;
        const slug = name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
        const collision = [...this.known.values()].some((p) => p.id !== id && p.directoryName.toLowerCase() === slug.toLowerCase());
        const record = { id, commonDir, name, directoryName: collision ? `${slug}-${id.slice(-8)}` : slug };
        this.known.set(id, record);
      } catch { /* Live discovery already carries diagnostics. Saved projects below remain visible when unavailable. */ }
    }
    this.views = await Promise.all([...this.known.values()].map(async (project) => {
      let trees: ProjectWorktree[] = []; let error: string | null = null;
      try {
        trees = this.config.mode === 'mock' ? live.filter((w) => `${w.worktree.root}/.git` === project.commonDir)
          .filter((w, index, all) => all.findIndex((candidate) => candidate.worktree.root === w.worktree.root) === index)
          .map((w) => ({ id: idOf('worktree', [project.id, w.worktree.gitDir, w.worktree.indexPath]), path: w.worktree.root,
            identity: w.worktree, branch: w.branch, head: w.git?.head ?? 'a'.repeat(40), main: true, error: null })) : await worktrees(project);
        if (this.config.mode === 'mock' && !trees.length) {
          const root = dirname(project.commonDir), identity = { root, gitDir: project.commonDir, indexPath: join(project.commonDir, 'index') };
          trees = [{ id: idOf('worktree', [project.id, identity.gitDir, identity.indexPath]), path: root, identity, branch: 'main', head: 'a'.repeat(40), main: true, error: null }];
        }
      } catch { error = 'Project Git metadata is unavailable. Its saved identity has been kept; inspect the host and Recheck.'; }
      return { ...project, worktrees: trees, error, removals: this.store.worktreeRemovals().filter((op) => op.input.projectId === project.id), creations: this.store.worktreeCreations().filter((op) => op.input.projectId === project.id),
        integrations: this.store.worktreeIntegrations().filter((op) => op.input.projectId === project.id), discards: this.store.worktreeDiscards().filter((op) => op.input.projectId === project.id) };
    }));
    return this.views;
  }
  /** Called only by deliberate configuration edits / Start. Merely opening a page writes nothing. */
  remember(root: string): void {
    const project = this.views.find((p) => p.worktrees.some((w) => w.path === root));
    if (project) this.store.saveProject(this.known.get(project.id)!);
  }
  private pendingLaunch(projectId?: string, root?: string): boolean {
    const batches = (this.store.db.prepare('SELECT value FROM launches WHERE id IN (SELECT launch_id FROM launch_reservations)').all() as {value:string}[]).map(r => JSON.parse(r.value) as import('../contracts/launches.ts').LaunchBatch);
    return batches.some(b=>b.items.some(i=>(!projectId || i.projectId===projectId) && (!root || i.worktree.root===root)));
  }
  assertWorktreeReady(root: string, ignoreLaunch = false): void {
    if(!ignoreLaunch && this.pendingLaunch(undefined,root)) throw new AppError('LAUNCH_BUSY','An unresolved launch owns this checkout. Inspect it in Projects.',409);
    if (this.store.worktreeRemovals().some((op) => op.input.worktree.root === root && ['applying', 'uncertain'].includes(op.status))) throw new AppError('WORKTREE_SETUP_BUSY', 'This worktree removal is applying or uncertain. Inspect its result in Projects before using it.', 409);
    if (this.store.worktreeDiscards().some((op) => op.input.worktree.root === root && ['applying', 'uncertain'].includes(op.status))) throw new AppError('WORKTREE_SETUP_BUSY', 'This worktree discard is applying or uncertain. Inspect its result in Projects before using it.', 409);
    if (this.store.worktreeIntegrations().some((op) => (op.input.target.root === root || op.input.worktree.root === root) && ['applying', 'uncertain'].includes(op.status))) throw new AppError('WORKTREE_SETUP_BUSY', 'A squash integration involving this checkout is applying or uncertain. Inspect its result in Projects before using it.', 409);
    if (this.store.worktreeCreations().some((op) => op.input.path === root && ['applying', 'uncertain'].includes(op.status))) throw new AppError('WORKTREE_SETUP_BUSY', 'This worktree creation is still applying or uncertain. Inspect and reconcile it in Projects before binding agents or starting work.', 409);
  }
  private async source(input: WorktreePreviewInput) {
    if (this.config.mode === 'mock') throw new AppError('MOCK_WORKTREE', 'Simulated panes cannot create real Git worktrees.', 409);
    const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'This project is no longer known. Recheck.', 409);
    const source = (await worktrees(project)).find((w) => w.id === input.sourceWorktreeId);
    if (!source?.identity || source.error || !source.head) throw new AppError('WORKTREE_CHANGED', 'Choose an accessible worktree with an initial commit.', 409);
    return { project, source };
  }
  /** The resolved host root for task checkouts. */
  private async taskRoot(): Promise<string> {
    const configured = this.config.worktreeDir ?? join(homedir(), '.altcli');
    if (!isAbsolute(configured)) throw new AppError('WORKTREE_PATH', 'The host task-worktree root must be absolute.', 409);
    return futurePath(configured);
  }
  private async destination(project: ProjectRecord, branch: string): Promise<string> {
    const base = await this.taskRoot();
    const path = join(base, project.directoryName, ...branch.split('/'));
    if (!contains(base, path) || path === base) throw new AppError('WORKTREE_PATH', 'The destination must stay under the task-worktree directory.', 409);
    let parent = path;
    while (parent !== base) {
      if (await exists(parent)) {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || (parent !== path && !info.isDirectory())) throw new AppError('WORKTREE_PATH', 'A destination component is a symlink or not a directory. Choose another branch/path.', 409);
      }
      parent = dirname(parent);
    }
    const metadata = await futurePath(this.config.dataDir);
    if (contains(metadata, path) || contains(path, metadata) || this.views.some((p) => p.worktrees.some((w) => contains(w.path, path) || contains(path, w.path)))) throw new AppError('WORKTREE_PATH', 'The destination overlaps an existing checkout or controller metadata.', 409);
    return path;
  }
  async preview(raw: WorktreePreviewInput): Promise<WorktreePreview> {
    const input = parseWorktreePreview(raw);
    const { project, source } = await this.source(input);
    // A task worktree starts from an integration branch; it never becomes one.
    if (integrationNames(await defaultBranch(source.path), this.config.integrationBranches).includes(input.branch)) throw new AppError('INTEGRATION_BRANCH', `${input.branch} is an integration branch name. Choose a task branch name.`, 409);
    await validateNewBranch(source.path, input.branch);
    const path = await this.destination(project, input.branch);
    if (await exists(path)) throw new AppError('WORKTREE_EXISTS', 'The destination already exists. Nothing will be overwritten.', 409);
    return { ...input, requestId: randomUUID(), source: source.identity!, sourceBranch: source.branch, sourceHead: source.head!, path };
  }
  private finish(operation: WorktreeCreation, status: WorktreeCreation['status'], message: string): WorktreeCreation {
    const updated = { ...operation, status, message, updatedAt: new Date().toISOString() };
    this.store.saveWorktreeCreation(updated); return updated;
  }
  async create(raw: WorktreeCreateInput): Promise<WorktreeCreation> {
    const input = parseWorktreeCreate(raw);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled Git setup and terminal input.', 403);
    const existing = this.store.worktreeCreations().find((op) => op.input.requestId === input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to a different worktree operation.', 409);
      return existing; // never repeat a Git mutation, even after a lost response
    }
    let checked: WorktreePreview;
    try { checked = await this.preview({ projectId: input.projectId, sourceWorktreeId: input.sourceWorktreeId, branch: input.branch }); }
    catch (error) {
      // Another identical request may have claimed/completed while this one was inspecting Git.
      const duplicate = this.store.worktreeCreations().find((op) => op.input.requestId === input.requestId);
      if (duplicate && isDeepStrictEqual(duplicate.input, input)) return duplicate;
      throw error;
    }
    if (!sameWorktree(checked.source, input.source) || checked.sourceBranch !== input.sourceBranch || checked.sourceHead !== input.sourceHead || checked.path !== input.path) throw new AppError('WORKTREE_CHANGED', 'The source checkout, commit or destination changed. Preview and confirm again.', 409);
    const project = this.known.get(input.projectId)!;
    const operation: WorktreeCreation = { input, status: 'applying', message: 'Creating the confirmed task worktree.', updatedAt: new Date().toISOString() };
    const claimed = this.store.db.transaction(() => {
      const duplicate = this.store.worktreeCreations().find((op) => op.input.requestId === input.requestId);
      if (duplicate) {
        if (!isDeepStrictEqual(duplicate.input, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to a different operation.', 409);
        return false;
      }
      if (this.projectHeld(input.projectId)) throw new AppError('PROJECT_SETUP_BUSY', 'Another worktree creation owns this project. Inspect and reconcile it before creating another.', 409);
      this.store.saveProject(project); this.store.saveWorktreeCreation(operation); return true;
    }).immediate();
    if (!claimed) return this.store.worktreeCreations().find((op) => op.input.requestId === input.requestId)!;
    let attempted = false;
    try {
      await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
      const current = await this.source(input);
      if (!sameWorktree(current.source.identity, input.source) || current.source.head !== input.sourceHead || current.source.branch !== input.sourceBranch ||
          await this.destination(project, input.branch) !== input.path || await realpath(dirname(input.path)) !== dirname(input.path) || await exists(input.path)) throw new AppError('WORKTREE_CHANGED', 'Setup changed before creation. Preview again.', 409);
      await validateNewBranch(input.source.root, input.branch);
      attempted = true;
      await git(['-C', input.source.root, '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', 'worktree', 'add', '--no-track', '-b', input.branch, '--', input.path, input.sourceHead]);
      if (!await this.createdExactly(operation)) throw new Error('verification failed');
      return this.finish(operation, 'ready', 'Worktree created. Start your coding agents in its directory, then Recheck. No agents were moved and no run was started.');
    } catch (error) {
      // Before Git ran, the specific recheck failure is the useful diagnostic; afterwards only inspection can tell.
      return this.finish(operation, attempted ? 'uncertain' : 'failed', attempted
        ? 'Git creation or its verification had an uncertain result. Inspect the destination and branch, then reconcile. Nothing is retried or removed automatically.'
        : `${messageOf(error)} Nothing was checked out; preview again after inspecting the host.`);
    }
  }
  private async createdExactly(operation: WorktreeCreation): Promise<boolean> {
    const { input } = operation; const project = this.known.get(input.projectId);
    if (!project || !await exists(input.path)) return false;
    const tree = (await worktrees(project)).find((w) => w.path === input.path);
    if (!tree?.identity || tree.error || tree.branch !== input.branch || tree.head !== input.sourceHead || await realpath(input.path) !== input.path) return false;
    const state = await branchState(input.path);
    return state.clean && state.branch === input.branch && state.head === input.sourceHead;
  }
  async reconcile(requestId: string): Promise<WorktreeCreation> {
    const operation = this.store.worktreeCreations().find((op) => op.input.requestId === requestId);
    if (!operation) throw new AppError('NOT_FOUND', 'Worktree operation not found.', 404);
    if (operation.status !== 'uncertain') return operation; // an in-flight call must finish before reconciliation
    try {
      if (await this.createdExactly(operation)) return this.finish(operation, 'ready', 'The exact clean worktree, branch and starting commit were verified. No Git changes were made by reconciliation.');
      const project = this.known.get(operation.input.projectId)!;
      const trees = await worktrees(project);
      const refs = await git(['--git-dir', project.commonDir, 'for-each-ref', '--format=%(refname)', '--', `refs/heads/${operation.input.branch}`]);
      if (!await exists(operation.input.path) && !trees.some((w) => w.path === operation.input.path) && !refs.trim()) return this.finish(operation, 'failed', 'No destination, worktree entry or task branch exists. The setup hold is released; a new preview is required.');
    } catch { /* Unknown is still owned. Never infer absence from a failed inspection. */ }
    return operation;
  }
  private removalFinish(operation: WorktreeRemoval, status: WorktreeRemoval['status'], message: string): WorktreeRemoval {
    const updated = { ...operation, status, message, updatedAt: new Date().toISOString() };
    this.store.db.transaction(() => {
      if (status === 'removed') this.store.retireWorktreeIntegrations(operation.input.projectId, operation.input.worktreeId);
      this.store.saveWorktreeRemoval(updated);
    })(); return updated;
  }
  private projectHeld(projectId: string): boolean {
    return this.pendingLaunch(projectId) || [...this.store.worktreeCreations(), ...this.store.worktreeRemovals(), ...this.store.worktreeIntegrations(), ...this.store.worktreeDiscards()].some((op) => op.input.projectId === projectId && ['applying', 'uncertain'].includes(op.status));
  }
  /** The local integration branch that verification and squash target: main when it exists, else the recorded default. */
  private async integrationRef(path: string, primary: string | null): Promise<{ name: string; targetRef: string; targetHead: string }> {
    const refs = (await git(['-C', path, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).trim().split('\n');
    const targetRef = refs.includes('refs/heads/main') ? 'refs/heads/main' : primary && refs.includes(`refs/heads/${primary}`) ? `refs/heads/${primary}` : null;
    if (!targetRef) throw new AppError('INTEGRATION_UNKNOWN', 'No local main/default branch is available to verify integration. Update it yourself, then Recheck.', 409);
    return { name: targetRef.replace('refs/heads/', ''), targetRef, targetHead: (await git(['-C', path, 'rev-parse', '--verify', `${targetRef}^{commit}`])).trim() };
  }
  /** An accessible linked task worktree on a named non-integration branch, with its exact current state. */
  private async taskWorktree(projectId: string, worktreeId: string, what: string): Promise<{ project: ProjectRecord; tree: ProjectWorktree & { identity: WorktreeIdentity; head: string; branch: string }; trees: ProjectWorktree[]; primary: string | null }> {
    const project = this.known.get(projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    const trees = await worktrees(project); const tree = trees.find((w) => w.id === worktreeId);
    if (!tree?.identity || tree.error || !tree.head || !tree.branch || tree.main) throw new AppError('WORKTREE_REMOVAL', `Only an accessible linked worktree on a task branch can be ${what}.`, 409);
    if (contains(tree.path, await futurePath(this.config.dataDir)) || await realpath(tree.path) !== tree.path) throw new AppError('WORKTREE_PATH', 'The worktree overlaps controller data or its path changed.', 409);
    const primary = await defaultBranch(tree.path);
    if (integrationNames(primary, this.config.integrationBranches).includes(tree.branch)) throw new AppError('WORKTREE_REMOVAL', `An integration branch worktree cannot be ${what} here.`, 409);
    return { project, tree: tree as ProjectWorktree & { identity: WorktreeIdentity; head: string; branch: string }, trees, primary };
  }
  async previewRemoval(raw: WorktreeRemovalInput): Promise<WorktreeRemovalPreview> {
    const input = parseRemovalPreview(raw);
    if (this.config.mode === 'mock') throw new AppError('MOCK_WORKTREE', 'Simulated panes cannot remove real Git worktrees.', 409);
    const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    const tree = (await worktrees(project)).find((w) => w.id === input.worktreeId);
    if (!tree?.identity || tree.error || !tree.head || !tree.branch || tree.main) throw new AppError('WORKTREE_REMOVAL', 'Only an accessible linked worktree on a task branch can be removed.', 409);
    if (contains(tree.path, await futurePath(this.config.dataDir)) || await realpath(tree.path) !== tree.path) throw new AppError('WORKTREE_PATH', 'The worktree overlaps controller data or its path changed.', 409);
    const state = await branchState(tree.path);
    if (!state.clean || state.head !== tree.head || state.branch !== tree.branch) throw new AppError('WORKTREE_DIRTY', 'The worktree contains modified or untracked files, or changed during inspection.', 409);
    const primary = state.primary;
    if (integrationNames(primary, this.config.integrationBranches).includes(tree.branch)) throw new AppError('WORKTREE_REMOVAL', 'An integration branch worktree cannot be removed here.', 409);
    const refs = (await git(['-C', tree.path, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).trim().split('\n');
    const targetRef = refs.includes('refs/heads/main') ? 'refs/heads/main' : primary && refs.includes(`refs/heads/${primary}`) ? `refs/heads/${primary}` : null;
    if (!targetRef) throw new AppError('INTEGRATION_UNKNOWN', 'No local main/default branch is available to verify integration. Update it yourself, then Recheck.', 409);
    const targetHead = (await git(['-C', tree.path, 'rev-parse', '--verify', `${targetRef}^{commit}`])).trim();
    const bases = (await git(['-C', tree.path, 'merge-base', '--all', tree.head, targetHead])).trim().split('\n');
    if (bases.length !== 1) throw new AppError('INTEGRATION_UNKNOWN', 'The integration baseline is ambiguous.', 409);
    let integratedBy: WorktreeRemovalPreview['integratedBy'] = 'ancestry'; let integratedCommit = tree.head;
    if (bases[0] !== tree.head) {
      const checkpoint = await this.integrationCheckpoint(input.projectId, input.worktreeId, tree.branch, tree.head, targetRef, targetHead, tree.path);
      if (checkpoint?.through === tree.head) return { ...input, requestId: randomUUID(), worktree: tree.identity, branch: tree.branch, head: tree.head, targetRef, targetHead, integratedBy: 'squash', integratedCommit: checkpoint.commit };
      const diff = (from: string, to: string) => git(['-C', tree.path, 'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', from, to, '--']);
      const combined = await diff(bases[0]!, tree.head);
      if (!combined) throw new AppError('INTEGRATION_UNKNOWN', 'No exact integrated commit can be established for this branch.', 409);
      const commits = (await git(['-C', tree.path, 'rev-list', '--first-parent', '--parents', '--max-count=500', `${bases[0]}..${targetHead}`])).trim().split('\n');
      integratedCommit = '';
      for (const line of commits) {
        const [commit, parent, extra] = line.split(' ');
        if (commit && parent && !extra && await diff(parent, commit) === combined) { integratedCommit = commit; break; }
      }
      if (!integratedCommit) throw new AppError('NOT_INTEGRATED', 'The branch is not an ancestor of main and its combined changes do not exactly match a single commit in the latest 500 main/default-branch commits. Removal is unavailable.', 409);
      integratedBy = 'squash';
    }
    return { ...input, requestId: randomUUID(), worktree: tree.identity, branch: tree.branch, head: tree.head, targetRef, targetHead, integratedBy, integratedCommit };
  }
  /** One confirmed non-force removal. Guard is supplied by ControlPlane and rechecks live panes and execution ownership;
   * archive keeps the worktree's published handoff content in the journal before anything is deleted. */
  async remove(raw: WorktreeRemoveInput, guard: (worktree: WorktreeIdentity) => Promise<void>, archive: (worktree: WorktreeIdentity) => Promise<number>): Promise<WorktreeRemoval> {
    const input = parseRemoval(raw);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled Git setup and terminal input.', 403);
    const existing = this.store.worktreeRemovals().find((op) => op.input.requestId === input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) throw new AppError('ID_CONFLICT', 'This removal ID belongs to a different request.', 409);
      return existing;
    }
    const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    const operation: WorktreeRemoval = { input, status: 'applying', message: 'Checking the confirmed worktree removal.', updatedAt: new Date().toISOString() };
    this.store.db.transaction(() => {
      if (this.projectHeld(input.projectId)) throw new AppError('PROJECT_SETUP_BUSY', 'Another worktree operation owns this project. Inspect its result first.', 409);
      this.store.saveProject(project); this.store.saveWorktreeRemoval(operation);
    }).immediate();
    let attempted = false;
    try {
      const checked = await this.previewRemoval({ projectId: input.projectId, worktreeId: input.worktreeId });
      if (!isDeepStrictEqual({ ...checked, requestId: input.requestId, confirm: true }, input)) throw new AppError('WORKTREE_CHANGED', 'The worktree or integration evidence changed. Preview and confirm again.', 409);
      await guard(input.worktree);
      // Guard awaited host inspection; recheck Git and consent immediately before mutation too.
      const final = await this.previewRemoval({ projectId: input.projectId, worktreeId: input.worktreeId });
      if (!isDeepStrictEqual({ ...final, requestId: input.requestId, confirm: true }, input)) throw new AppError('WORKTREE_CHANGED', 'The worktree changed during removal checks.', 409);
      await guard(input.worktree);
      const archived = await archive(input.worktree);
      attempted = true;
      await git(['--git-dir', this.known.get(input.projectId)!.commonDir, '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--', input.worktree.root]);
      if (!await this.removedExactly(operation)) throw new Error('Removal verification failed');
      this.store.clearRepository(input.worktree.root);
      return this.removalFinish(operation, 'removed', `Worktree removed. Its branch, commits and run history are retained${archived ? `; ${archived} handoff commit${archived === 1 ? '' : 's'} archived in the journal` : ''}.`);
    } catch (error) {
      return this.removalFinish(operation, attempted ? 'uncertain' : 'failed', attempted
        ? 'Removal or its verification is uncertain. Inspect the removal result; nothing will be retried or force-removed.' : messageOf(error));
    }
  }
  private async removedExactly(operation: WorktreeRemoval): Promise<boolean> {
    const project = this.known.get(operation.input.projectId);
    return !!project && !await exists(operation.input.worktree.root) && !(await worktrees(project)).some((w) => w.path === operation.input.worktree.root || w.id === operation.input.worktreeId);
  }
  async reconcileRemoval(requestId: string): Promise<WorktreeRemoval> {
    const operation = this.store.worktreeRemovals().find((op) => op.input.requestId === requestId);
    if (!operation) throw new AppError('NOT_FOUND', 'Removal operation not found.', 404);
    if (operation.status !== 'uncertain') return operation;
    try {
      if (await this.removedExactly(operation)) {
        this.store.clearRepository(operation.input.worktree.root);
        return this.removalFinish(operation, 'removed', 'Removal verified. The branch and history are retained; no Git changes were made by inspection.');
      }
      const checked = await this.previewRemoval({ projectId: operation.input.projectId, worktreeId: operation.input.worktreeId });
      if (isDeepStrictEqual({ ...checked, requestId, confirm: true }, operation.input)) return this.removalFinish(operation, 'failed', 'The original clean worktree is still present. No removal was retried; use a new preview if needed.');
    } catch { /* Missing evidence retains ownership. */ }
    return operation;
  }

  private integrationFinish(operation: WorktreeIntegration, status: WorktreeIntegration['status'], message: string, commit: string | null = operation.commit): WorktreeIntegration {
    const updated = { ...operation, status, message, commit, updatedAt: new Date().toISOString() };
    this.store.saveWorktreeIntegration(updated); return updated;
  }
  /** A completed batch is a boundary only in its source and target lineages.
   * Inapplicable records fall back to current Git evidence. Pre-batch records integrated their full HEAD. */
  private async integrationCheckpoint(projectId: string, worktreeId: string, branch: string, head: string, targetRef: string, targetHead: string, path: string): Promise<{ through: string; commit: string } | null> {
    const previous = this.store.worktreeIntegrations().filter((op) => op.status === 'integrated' && !op.retired && op.input.projectId === projectId && op.input.worktreeId === worktreeId && op.input.branch === branch && op.input.targetRef === targetRef).at(-1);
    if (!previous?.commit) return null;
    const through = previous.input.through ?? previous.input.head;
    try {
      if ((await gitAnswer(['-C', path, 'merge-base', '--is-ancestor', previous.commit, targetHead])).code !== 0 ||
        (await gitAnswer(['-C', path, 'merge-base', '--is-ancestor', through, head])).code !== 0) return null;
    } catch { return null; } // Old objects may have been pruned; they cannot override fresh integration/removal evidence.
    return { through, commit: previous.commit };
  }
  /** Read-only: what one squash commit into the integration branch would contain, computed without touching any checkout. */
  async previewIntegration(raw: WorktreeIntegrationInput): Promise<WorktreeIntegrationPreview> {
    const input = parseIntegrationPreview(raw);
    if (this.config.mode === 'mock') throw new AppError('MOCK_WORKTREE', 'Simulated panes cannot integrate real Git branches.', 409);
    const { tree, trees, primary } = await this.taskWorktree(input.projectId, input.worktreeId, 'squashed');
    const source = await branchState(tree.path);
    if (source.head !== tree.head || source.branch !== tree.branch) throw new AppError('WORKTREE_CHANGED', 'The task worktree changed during inspection. Recheck.', 409);
    const through = input.through ? (await git(['-C', tree.path, 'rev-parse', '--verify', `${input.through}^{commit}`])).trim() : tree.head;
    if ((await gitAnswer(['-C', tree.path, 'merge-base', '--is-ancestor', through, tree.head])).code !== 0) throw new AppError('INTEGRATION_RANGE', 'Choose a commit on this task branch.', 409);
    const { name, targetRef, targetHead } = await this.integrationRef(tree.path, primary);
    // The squash commit is made where the integration branch is checked out; Git allows one such checkout at a time.
    const target = trees.find((w) => w.branch === name && w.identity && !w.error && w.path !== tree.path);
    if (!target?.identity) throw new AppError('INTEGRATION_CHECKOUT', `No checkout has ${name} checked out. Check it out in its own worktree yourself, then Recheck.`, 409);
    const state = await branchState(target.path);
    if (state.branch !== name || state.head !== targetHead) throw new AppError('WORKTREE_CHANGED', `The ${name} checkout changed during inspection. Recheck.`, 409);
    if (!state.clean) throw new AppError('INTEGRATION_DIRTY', `The ${name} checkout at ${target.path} has modified or untracked files. Commit or clean it yourself before squashing into it.`, 409);
    await git(['-C', target.path, 'var', 'GIT_COMMITTER_IDENT']).catch(() => { throw new AppError('INTEGRATION_IDENTITY', 'Git has no committer identity here. Configure user.name and user.email, then Recheck.', 409); });
    const previous = await this.integrationCheckpoint(input.projectId, input.worktreeId, tree.branch, tree.head, targetRef, targetHead, tree.path);
    const bases = (await git(['-C', tree.path, 'merge-base', '--all', targetHead, through])).trim().split('\n').filter(Boolean);
    if (bases.length !== 1) throw new AppError('INTEGRATION_UNKNOWN', 'The integration baseline is ambiguous.', 409);
    const mergeBase = previous?.through ?? bases[0]!;
    if (mergeBase === through) throw new AppError('ALREADY_INTEGRATED', `This endpoint is already integrated into ${name}. Choose a later commit, or use Check removal when the whole branch is integrated.`, 409);
    if ((await gitAnswer(['-C', tree.path, 'merge-base', '--is-ancestor', mergeBase, through])).code !== 0) throw new AppError('INTEGRATION_RANGE', 'Choose a commit after the previous squash batch.', 409);
    const merged = await gitAnswer(['-C', target.path, 'merge-tree', '--write-tree', '--no-messages', '--name-only', `--merge-base=${mergeBase}`, targetHead, through]);
    const merge = merged.stdout.split('\n');
    if (merged.code !== 0 || !/^[0-9a-f]{40,64}$/.test(merge[0] ?? '')) {
      const conflicted = [...new Set(merge.slice(1).filter(Boolean))].slice(0, 20);
      throw new AppError('INTEGRATION_CONFLICT', `Squashing ${tree.branch} into ${name} would conflict${conflicted.length ? ` in ${conflicted.join(', ')}` : ''}. Resolve it on the task branch yourself, then Recheck.`, 409);
    }
    const merge_tree = merge[0]!;
    if (merge_tree === (await git(['-C', target.path, 'rev-parse', `${targetHead}^{tree}`])).trim()) throw new AppError('ALREADY_INTEGRATED', `${tree.branch} changes nothing in ${name}. Use Check removal.`, 409);
    const commitCount = Number((await git(['-C', tree.path, 'rev-list', '--count', `${mergeBase}..${through}`])).trim());
    const fields = (await git(['-C', tree.path, 'log', '--max-count=100', '--format=%H%x00%s', '-z', `${mergeBase}..${through}`, '--'])).split('\0');
    const commits: WorktreeIntegrationPreview['commits'] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ sha: fields[i]!, subject: fields[i + 1]! });
    // The default obeys the same budget the confirmation enforces, so a long history never has to be rewritten by hand.
    const message = defaultSquashMessage(tree.branch, mergeBase, through, commitCount, commits);
    const pinned = { ...input, through, previousCommit: previous?.commit ?? null, worktree: tree.identity, branch: tree.branch, head: tree.head, dirty: !source.clean, targetRef, targetHead, target: target.identity,
      mergeBase, commitCount, commits, tree: merge_tree, commands: [`git -C ${target.path} ${treeDiff(targetHead, merge_tree).join(' ')} | git -C ${target.path} apply --index --binary --whitespace=nowarn`, `git -C ${target.path} commit -m <message>`] };
    return { ...pinned, requestId: randomUUID(), message, consent: integrationConsent(pinned) };
  }
  /** One confirmed squash commit on the integration branch, in its own clean checkout. Guard rechecks execution ownership of both checkouts. */
  async integrate(raw: WorktreeIntegrateRequest, guard: (target: WorktreeIdentity, source: WorktreeIdentity) => Promise<void>): Promise<WorktreeIntegration> {
    const request = parseIntegrate(raw);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled Git setup and terminal input.', 403);
    const existing = this.store.worktreeIntegrations().find((op) => op.input.requestId === request.requestId);
    if (existing) {
      if (existing.input.projectId !== request.projectId || existing.input.worktreeId !== request.worktreeId || (existing.input.through ?? existing.input.head) !== (request.through ?? existing.input.head) || existing.input.consent !== request.consent || existing.input.message !== request.message) throw new AppError('ID_CONFLICT', 'This integration ID belongs to a different request.', 409);
      return existing;
    }
    const project = this.known.get(request.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    // The compact confirmation carries only the consent digest; the durable record is the re-derived preview it must still match.
    const changed = new AppError('WORKTREE_CHANGED', 'The task branch, the integration checkout or the merge result changed. Preview and confirm again.', 409);
    const derived = await this.previewIntegration({ projectId: request.projectId, worktreeId: request.worktreeId, ...(request.through ? { through: request.through } : {}) });
    if (derived.consent !== request.consent) throw changed;
    const input: WorktreeIntegrateInput = { ...derived, requestId: request.requestId, message: request.message, confirm: true };
    const operation: WorktreeIntegration = { input, status: 'applying', message: 'Checking the confirmed squash integration.', updatedAt: new Date().toISOString(), commit: null };
    this.store.db.transaction(() => {
      const duplicate = this.store.worktreeIntegrations().find((op) => op.input.requestId === input.requestId);
      if (duplicate) throw new AppError('ID_CONFLICT', 'This integration ID was already claimed while inspecting Git. Inspect its result.', 409);
      if (this.projectHeld(input.projectId)) throw new AppError('PROJECT_SETUP_BUSY', 'Another worktree operation owns this project. Inspect its result first.', 409);
      this.store.saveProject(project); this.store.saveWorktreeIntegration(operation);
    }).immediate();
    let attempted = false;
    try {
      await guard(input.target, input.worktree);
      // Guard awaited host inspection; recheck Git and consent immediately before mutation too.
      if ((await this.previewIntegration({ projectId: input.projectId, worktreeId: input.worktreeId, through: input.through })).consent !== input.consent) throw new AppError('WORKTREE_CHANGED', 'The checkouts changed during integration checks.', 409);
      await guard(input.target, input.worktree);
      attempted = true;
      // Final integration uses the repository's normal hook policy; only handoff commits bypass hooks.
      // Stage the exact previewed three-way result. A normal merge would reuse the original merge base and replay prior batches.
      await stageIntegrationTree(input.target.root, input.targetHead, input.tree);
      if ((await git(['-C', input.target.root, 'write-tree'])).trim() !== input.tree) throw new Error('Staged squash does not match the preview');
      await git(['-C', input.target.root, 'commit', '--quiet', '-m', input.message]);
      const commit = await this.integratedExactly(operation);
      if (!commit) throw new Error('Integration verification failed');
      return this.integrationFinish(operation, 'integrated', `Squashed ${input.branch} through ${input.through.slice(0, 12)} into ${input.targetRef.replace('refs/heads/', '')} as ${commit.slice(0, 12)}. The task branch and worktree are unchanged; ${input.through === input.head ? 'use Check removal when you are done with them' : 'preview another batch to integrate the remaining commits'}.`, commit);
    } catch (error) {
      return this.integrationFinish(operation, attempted ? 'uncertain' : 'failed', attempted
        ? `The squash or its verification is uncertain. Inspect ${input.target.root}: a staged squash without a commit means the commit step failed (for example a rejecting hook); commit or reset it yourself, then Inspect. Nothing is retried.` : messageOf(error));
    }
  }
  /** The exact expected result: the integration checkout clean on its branch at one new commit whose parent and tree match the consent. */
  private async integratedExactly(operation: WorktreeIntegration): Promise<string | null> {
    const { input } = operation; const name = input.targetRef.replace('refs/heads/', '');
    try {
      const state = await branchState(input.target.root);
      if (!state.clean || state.branch !== name || state.head === input.targetHead) return null;
      const lineage = (await git(['-C', input.target.root, 'rev-list', '--parents', '-n', '1', state.head])).trim().split(' ');
      if (lineage.length !== 2 || lineage[1] !== input.targetHead) return null;
      if ((await git(['-C', input.target.root, 'rev-parse', `${state.head}^{tree}`])).trim() !== input.tree) return null;
      return state.head;
    } catch { return null; }
  }
  /** The previewed squash commit (single parent = the pinned target tip, tree = the previewed merge tree) anywhere on the
   * integration branch's first-parent chain since that tip, or null. Later commits on top of it do not hide it. */
  private async integratedEventually(operation: WorktreeIntegration, tip: string): Promise<string | null> {
    const { input } = operation;
    if (tip === input.targetHead) return null;
    const chain = (await git(['-C', input.target.root, 'rev-list', '--first-parent', '--max-count=500', `${input.targetHead}..${tip}`])).trim().split('\n').filter(Boolean);
    for (const sha of chain) {
      const lineage = (await git(['-C', input.target.root, 'rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
      if (lineage.length === 2 && lineage[1] === input.targetHead && (await git(['-C', input.target.root, 'rev-parse', `${sha}^{tree}`])).trim() === input.tree) return sha;
    }
    return null;
  }
  /** Read-only inspection of an uncertain squash. A dirty integration checkout may still hold the staged squash, so ownership is
   * retained. A clean checkout settles it: the previewed commit on the branch (even under later commits) completes the
   * operation; otherwise the human resolved it another way, by leaving the tip untouched or by integrating, resetting or
   * rewriting by hand, and the hold is released as failed. Nothing is retried and no Git state is changed. */
  async reconcileIntegration(requestId: string): Promise<WorktreeIntegration> {
    const operation = this.store.worktreeIntegrations().find((op) => op.input.requestId === requestId);
    if (!operation) throw new AppError('NOT_FOUND', 'Integration operation not found.', 404);
    if (operation.status !== 'uncertain') return operation;
    const { input } = operation; const name = input.targetRef.replace('refs/heads/', '');
    try {
      const state = await branchState(input.target.root);
      if (!state.clean) return operation; // the staged squash (or other work) is still pending for the human
      const tip = (await git(['-C', input.target.root, 'rev-parse', '--verify', `${input.targetRef}^{commit}`])).trim();
      const commit = await this.integratedEventually(operation, tip);
      if (commit) return this.integrationFinish(operation, 'integrated', `Squash verified as ${commit.slice(0, 12)}${commit === tip ? '' : `; ${name} has moved on since`}. No Git changes were made by inspection.`, commit);
      if (tip === input.targetHead) return this.integrationFinish(operation, 'failed', 'The integration checkout is unchanged at its previous commit. Nothing was squashed; preview again if needed.');
      return this.integrationFinish(operation, 'failed', `${name} moved from ${input.targetHead.slice(0, 12)} to ${tip.slice(0, 12)} without the previewed squash commit: it was integrated, reset or rewritten by hand. The hold is released; nothing was retried. Check removal or a new squash preview will judge the current history on its own evidence.`);
    } catch { /* Missing evidence retains ownership. */ }
    return operation;
  }

  /** Compare-and-set on the record `operation` was read as: a result computed from that snapshot, after Git and filesystem reads, never
   * overwrites a record that moved on meanwhile (an inspection overlapping a finish, or a finish overlapping a restart). The current
   * record is returned instead, so the caller reports what actually happened. */
  private discardFinish(operation: WorktreeDiscard, status: WorktreeDiscard['status'], message: string, branchRemains = false): WorktreeDiscard {
    const { branchRemains: _, ...rest } = operation;
    const updated: WorktreeDiscard = { ...rest, status, message, updatedAt: new Date().toISOString(), ...(branchRemains ? { branchRemains } : {}) };
    return this.store.db.transaction(() => {
      const current = this.store.worktreeDiscards().find((op) => op.input.requestId === operation.input.requestId);
      if (current && (current.status !== operation.status || current.updatedAt !== operation.updatedAt)) return current;
      if (status === 'discarded') this.store.retireWorktreeIntegrations(operation.input.projectId, operation.input.worktreeId);
      this.store.saveWorktreeDiscard(updated); return updated;
    })();
  }
  /** Read-only: what a forced discard would lose. Dirty files and unintegrated commits are reported, not refused. */
  async previewDiscard(raw: WorktreeDiscardInput): Promise<WorktreeDiscardPreview> {
    const input = parseDiscardPreview(raw);
    if (this.config.mode === 'mock') throw new AppError('MOCK_WORKTREE', 'Simulated panes cannot discard real Git worktrees.', 409);
    const { tree, primary } = await this.taskWorktree(input.projectId, input.worktreeId, 'discarded');
    const state = await branchState(tree.path);
    if (state.head !== tree.head || state.branch !== tree.branch) throw new AppError('WORKTREE_CHANGED', 'The worktree changed during inspection. Recheck.', 409);
    const { targetRef, targetHead } = await this.integrationRef(tree.path, primary);
    const unmergedCommits = Number((await git(['-C', tree.path, 'rev-list', '--count', `${targetHead}..${tree.head}`])).trim());
    // Consent binds to the exact nonignored content, so editing an already dirty file after the preview is a change too.
    const fingerprint = await worktreeFingerprint(tree.path);
    const after = await branchState(tree.path);
    if (after.head !== tree.head || after.branch !== tree.branch || after.clean !== state.clean || after.changeCount !== state.changeCount) throw new AppError('WORKTREE_CHANGED', 'The worktree changed during inspection. Recheck.', 409);
    return { ...input, requestId: randomUUID(), worktree: tree.identity, branch: tree.branch, head: tree.head, targetRef, targetHead, dirty: !state.clean, changeCount: state.changeCount, fingerprint, unmergedCommits };
  }
  /** One confirmed forced removal plus branch deletion. Guard and archive are supplied by ControlPlane, as for removal. */
  async discard(raw: WorktreeDiscardConfirm, guard: (worktree: WorktreeIdentity) => Promise<void>, archive: (worktree: WorktreeIdentity) => Promise<number>): Promise<WorktreeDiscard> {
    const input = parseDiscard(raw);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled Git setup and terminal input.', 403);
    const existing = this.store.worktreeDiscards().find((op) => op.input.requestId === input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) throw new AppError('ID_CONFLICT', 'This discard ID belongs to a different request.', 409);
      return existing;
    }
    const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    const operation: WorktreeDiscard = { input, status: 'applying', message: 'Checking the confirmed discard.', updatedAt: new Date().toISOString() };
    this.store.db.transaction(() => {
      if (this.projectHeld(input.projectId)) throw new AppError('PROJECT_SETUP_BUSY', 'Another worktree operation owns this project. Inspect its result first.', 409);
      this.store.saveProject(project); this.store.saveWorktreeDiscard(operation);
    }).immediate();
    const same = (checked: WorktreeDiscardPreview) => isDeepStrictEqual({ ...checked, requestId: input.requestId, confirmBranch: input.branch, confirm: true }, input);
    let attempted = false;
    try {
      if (!same(await this.previewDiscard({ projectId: input.projectId, worktreeId: input.worktreeId }))) throw new AppError('WORKTREE_CHANGED', 'The worktree, its files or its branch changed. Preview and confirm again.', 409);
      await guard(input.worktree);
      if (!same(await this.previewDiscard({ projectId: input.projectId, worktreeId: input.worktreeId }))) throw new AppError('WORKTREE_CHANGED', 'The worktree changed during discard checks.', 409);
      await guard(input.worktree);
      const archived = await archive(input.worktree);
      // The archive callback awaited Git too; the content must still be exactly what was confirmed before force applies.
      if (await worktreeFingerprint(input.worktree.root) !== input.fingerprint) throw new AppError('WORKTREE_CHANGED', 'The worktree content changed after the archive step. Preview and confirm again.', 409);
      attempted = true;
      await git(['--git-dir', project.commonDir, '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', '--', input.worktree.root]);
      await git(['--git-dir', project.commonDir, 'branch', '-D', '--', input.branch]);
      if (!await this.discardedExactly(operation)) throw new Error('Discard verification failed');
      this.store.clearRepository(input.worktree.root);
      return this.discardFinish(operation, 'discarded', `Discarded ${input.branch}: its worktree and branch are deleted. Run history is retained${archived ? `; ${archived} handoff commit${archived === 1 ? '' : 's'} archived in the journal` : ''}.`);
    } catch (error) {
      return this.discardFinish(operation, attempted ? 'uncertain' : 'failed', attempted
        ? 'Discard or its verification is uncertain. Inspect whether the directory and branch remain; nothing will be retried.' : messageOf(error));
    }
  }
  /** Read-only: which of the three things a discard deletes are still there. `branch` is the branch tip, or null once deleted. */
  private async discardEvidence(operation: WorktreeDiscard): Promise<{ directory: boolean; entry: boolean; branch: string | null }> {
    const { input } = operation; const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    return { directory: await exists(input.worktree.root), entry: (await worktrees(project)).some((w) => w.path === input.worktree.root || w.id === input.worktreeId),
      branch: (await git(['--git-dir', project.commonDir, 'for-each-ref', '--format=%(objectname)', '--', `refs/heads/${input.branch}`])).trim() || null };
  }
  private async discardedExactly(operation: WorktreeDiscard): Promise<boolean> {
    try { const found = await this.discardEvidence(operation); return !found.directory && !found.entry && !found.branch; } catch { return false; }
  }
  /** Inspection settles complete absence or the unchanged original; every partial state is reported and keeps the owner. When only the
   * branch is left at the confirmed head, the record offers a confirmed finish; nothing is deleted by inspection itself. */
  async reconcileDiscard(requestId: string): Promise<WorktreeDiscard> {
    const operation = this.store.worktreeDiscards().find((op) => op.input.requestId === requestId);
    if (!operation) throw new AppError('NOT_FOUND', 'Discard operation not found.', 404);
    if (operation.status !== 'uncertain') return operation;
    const { input } = operation;
    try {
      const found = await this.discardEvidence(operation);
      if (!found.directory && !found.entry && !found.branch) {
        this.store.clearRepository(input.worktree.root);
        return this.discardFinish(operation, 'discarded', 'Discard verified: the worktree and branch are gone. No Git changes were made by inspection.');
      }
      if (found.directory && found.entry) {
        const checked = await this.previewDiscard({ projectId: input.projectId, worktreeId: input.worktreeId });
        if (isDeepStrictEqual({ ...checked, requestId, confirmBranch: input.branch, confirm: true }, input)) return this.discardFinish(operation, 'failed', 'The original worktree and branch are still present. Nothing was discarded; use a new preview if needed.');
        return this.discardFinish(operation, 'uncertain', `The worktree is still present but its files or branch changed since the confirmed preview${found.branch ? '' : `, and the branch ${input.branch} is gone`}. Inspect the directory by hand; nothing is retried.`);
      }
      const state = `${found.directory ? 'The worktree directory still exists' : 'The worktree directory is gone'}, its Git worktree entry ${found.entry ? 'remains' : 'is gone'} and the branch ${input.branch} ${found.branch ? `still exists at ${found.branch.slice(0, 12)}` : 'is deleted'}.`;
      if (!found.directory && !found.entry && found.branch === input.head) return this.discardFinish(operation, 'uncertain', `${state} Only the branch deletion is left: confirm it below to finish this discard, or delete the branch by hand and inspect again.`, true);
      if (!found.directory && !found.entry) return this.discardFinish(operation, 'uncertain', `${state} The branch moved from the confirmed ${input.head.slice(0, 12)}, so the app will not delete it. Inspect it by hand; the discard settles once the branch is gone.`);
      return this.discardFinish(operation, 'uncertain', `${state} Inspect the host by hand (a stale entry needs \`git worktree prune\`); nothing is retried.`);
    } catch (error) { // Missing evidence retains ownership, but says so.
      return this.discardFinish(operation, 'uncertain', `Inspection could not settle this discard: ${messageOf(error)} Nothing is retried.`);
    }
  }
  /** The confirmed completion of a discard whose worktree is verified gone while its branch still sits at the confirmed head: the same
   * consent, re-verified live, and only `git branch -D` runs. Anything else present or a moved branch refuses without touching Git. */
  async finishDiscard(raw: WorktreeDiscardFinish): Promise<WorktreeDiscard> {
    const { requestId } = parseDiscardFinish(raw);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled Git setup and terminal input.', 403);
    const existing = this.store.worktreeDiscards().find((op) => op.input.requestId === requestId);
    if (!existing) throw new AppError('NOT_FOUND', 'Discard operation not found.', 404);
    if (existing.status !== 'uncertain') return existing;
    const { input } = existing; const project = this.known.get(input.projectId);
    if (!project) throw new AppError('PROJECT_CHANGED', 'Recheck this project.', 409);
    const found = await this.discardEvidence(existing);
    if (found.directory || found.entry || found.branch !== input.head) throw new AppError('WORKTREE_CHANGED', 'This discard is not at the branch-only step. Inspect its result again.', 409);
    // Take the owner before Git so a concurrent finish or a restart cannot record over the outcome.
    const operation = this.store.db.transaction(() => {
      const current = this.store.worktreeDiscards().find((op) => op.input.requestId === requestId);
      if (current?.status !== 'uncertain') throw new AppError('PROJECT_SETUP_BUSY', 'This discard is already being finished. Inspect its result.', 409);
      return this.discardFinish(current, 'applying', `Deleting the remaining branch ${input.branch}.`);
    }).immediate();
    try {
      await git(['--git-dir', project.commonDir, 'branch', '-D', '--', input.branch]);
      if (!await this.discardedExactly(operation)) throw new Error('Discard verification failed');
      this.store.clearRepository(input.worktree.root);
      return this.discardFinish(operation, 'discarded', `Discarded ${input.branch}: its branch is deleted after the worktree. Run history is retained.`);
    } catch {
      return this.discardFinish(operation, 'uncertain', 'Branch deletion or its verification is uncertain. Inspect whether the branch remains; nothing will be retried.');
    }
  }
}
