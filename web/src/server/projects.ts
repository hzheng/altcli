import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionRegistration } from '../contracts/api.ts';
import type { Project, ProjectRecord, ProjectWorktree, WorktreeCreateInput, WorktreeCreation, WorktreePreview, WorktreePreviewInput } from '../contracts/projects.ts';
import type { Workspace } from '../contracts/workflow.ts';
import { AppError, messageOf } from '../core/errors.ts';
import { parseWorktreeCreate, parseWorktreePreview } from '../core/project-validation.ts';
import { branchState, defaultBranch, integrationNames, validateNewBranch } from './commit-handoff.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { gitEnvironment, resolveWorktree, sameWorktree } from './worktree.ts';

const idOf = (kind: string, value: unknown) => `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
const contains = (parent: string, path: string) => { const part = relative(parent, path); return !part || (!part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && part !== '..' && !isAbsolute(part)); };
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Bounded Git calls, with no inherited custom index or worktree. Never expose raw stderr (which may contain remote credentials). */
function git(args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', args, { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment() },
    (error, stdout) => error ? fail(new AppError('PROJECT_GIT', 'Git could not complete the project operation. Inspect the host; nothing will be retried automatically.', 409)) : done(stdout)));
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

/** Read-only inventory plus one explicit, durable setup operation. Never changes run ownership or terminal state. */
export class ProjectCatalog {
  private readonly known = new Map<string, ProjectRecord>();
  private views: Project[] = [];
  private readonly store: Store;
  private readonly config: Config;
  constructor(store: Store, config: Config) {
    this.store = store; this.config = config;
    for (const project of store.projects()) this.known.set(project.id, project);
    for (const operation of store.worktreeCreations().filter((op) => op.status === 'applying')) this.finish(operation, 'uncertain', 'Backend restarted during worktree creation. Inspect and reconcile; do not retry.');
  }
  async discover(live: Workspace[], sessions: SessionRegistration[]): Promise<Project[]> {
    const roots = [...new Set([...live.map((w) => w.worktree.root), ...sessions.map((s) => s.repository)])].sort();
    for (const root of roots) {
      try {
        const commonDir = this.config.mode === 'mock' ? `${root}/.git` : await commonGitDir(root);
        const id = idOf('project', commonDir);
        if (!this.known.has(id)) {
          const name = basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/, '');
          const slug = name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
          const collision = [...this.known.values()].some((p) => p.directoryName.toLowerCase() === slug.toLowerCase());
          this.known.set(id, { id, commonDir, name, directoryName: collision ? `${slug}-${id.slice(-8)}` : slug });
        }
      } catch { /* Live discovery already carries diagnostics. Saved projects below remain visible when unavailable. */ }
    }
    this.views = await Promise.all([...this.known.values()].map(async (project) => {
      let trees: ProjectWorktree[] = []; let error: string | null = null;
      try {
        trees = this.config.mode === 'mock' ? live.filter((w) => `${w.worktree.root}/.git` === project.commonDir)
          .filter((w, index, all) => all.findIndex((candidate) => candidate.worktree.root === w.worktree.root) === index)
          .map((w) => ({ id: idOf('worktree', [project.id, w.worktree.gitDir, w.worktree.indexPath]), path: w.worktree.root,
            identity: w.worktree, branch: w.branch, head: w.git?.head ?? 'a'.repeat(40), main: true, error: null })) : await worktrees(project);
      } catch { error = 'Project Git metadata is unavailable. Its saved identity has been kept; inspect the host and Recheck.'; }
      return { ...project, worktrees: trees, error, creations: this.store.worktreeCreations().filter((op) => op.input.projectId === project.id) };
    }));
    return this.views;
  }
  /** Called only by deliberate configuration edits / Start. Merely opening a page writes nothing. */
  remember(root: string): void {
    const project = this.views.find((p) => p.worktrees.some((w) => w.path === root));
    if (project) this.store.saveProject(this.known.get(project.id)!);
  }
  assertWorktreeReady(root: string): void {
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
  private async destination(project: ProjectRecord, branch: string): Promise<string> {
    const configured = this.config.worktreeDir ?? join(homedir(), '.codercrew');
    if (!isAbsolute(configured)) throw new AppError('WORKTREE_PATH', 'The host task-worktree root must be absolute.', 409);
    const base = await futurePath(configured);
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
      if (this.store.worktreeCreations().some((op) => op.input.projectId === input.projectId && ['applying', 'uncertain'].includes(op.status))) throw new AppError('PROJECT_SETUP_BUSY', 'Another worktree creation owns this project. Inspect and reconcile it before creating another.', 409);
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
}
