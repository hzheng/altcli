import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectCatalog } from '../src/server/projects.ts';
import { Store } from '../src/server/store.ts';
import { loadConfig, type Config } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { WorkflowStore } from '../src/server/workflow-store.ts';
import { mockSessions } from '../src/server/adapters/mock.ts';
import { parseWorktreeCreate, parseWorktreePreview } from '../src/core/project-validation.ts';
import type { ManagedSession, Workspace } from '../src/contracts/workflow.ts';
import type { WorktreeCreateInput } from '../src/contracts/projects.ts';

// Real Git / SQLite, isolated task-worktree root. No installed agents, actual home or live controller is used.
let directory: string; let root: string; let store: Store; let catalog: ProjectCatalog; let config: Config;
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function workspace(path: string): Promise<Workspace> {
  return { cwd: realpathSync(path), socketPath: '/mock/socket', worktree: (await resolveWorktree(path))!, branch: git(path, 'branch', '--show-current') || null, agents: [], group: null, sharesIndexWith: [] };
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codercrew-projects-'))); root = join(directory, 'repo'); mkdirSync(root);
  git(root, 'init', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'baseline\n'); git(root, 'add', 'app.txt'); git(root, 'commit', '-m', 'baseline');
  config = { ...loadConfig({ CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: join(directory, 'metadata') }), worktreeDir: join(directory, 'tasks') };
  store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
async function input(branch = 'feature/login'): Promise<WorktreeCreateInput> {
  const [project] = await catalog.discover([await workspace(root)], []);
  return { ...await catalog.preview({ projectId: project!.id, sourceWorktreeId: project!.worktrees.find((w) => w.path === root)!.id, branch }), confirm: true };
}

test('linked worktrees share one project; separate clones with the same origin stay separate', async () => {
  const linked = join(directory, 'elsewhere'); git(root, 'worktree', 'add', '-b', 'linked', linked);
  const clone = join(directory, 'clone', 'repo'); mkdirSync(join(directory, 'clone')); git(directory, 'clone', root, clone);
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/team/repo.git'); git(clone, 'remote', 'set-url', 'origin', 'https://example.invalid/team/repo.git');
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  const projects = await catalog.discover([await workspace(root), await workspace(linked), await workspace(clone)], []);
  assert.equal(projects.length, 2); assert.notEqual(projects[0]!.id, projects[1]!.id);
  assert.equal(new Set(projects.map((p) => p.directoryName)).size, 2);
  assert.deepEqual(projects.find((p) => p.worktrees.some((w) => w.path === root))!.worktrees.map((w) => w.path), [root, linked]);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before); assert.deepEqual(store.projects(), []);
});
test('worktree identity survives branch changes and detached HEAD; empty and missing worktrees stay visible', async () => {
  const linked = join(directory, 'empty worktree'); git(root, 'worktree', 'add', '-b', 'linked', linked);
  const [initial] = await catalog.discover([await workspace(root)], []);
  const id = initial!.worktrees.find((w) => w.path === linked)!.id;
  git(linked, 'switch', '-c', 'renamed-task');
  assert.equal((await catalog.discover([await workspace(root)], []))[0]!.worktrees.find((w) => w.path === linked)!.id, id);
  git(linked, 'checkout', '--detach');
  const detached = (await catalog.discover([], []))[0]!.worktrees.find((w) => w.path === linked)!;
  assert.equal(detached.id, id); assert.equal(detached.branch, null);
  rmSync(linked, { recursive: true });
  assert.match((await catalog.discover([], []))[0]!.worktrees.find((w) => w.path === linked)!.error!, /missing/);
});
test('confirmed creation uses the chosen commit without moving a dirty source; survives restart with no panes', async () => {
  writeFileSync(join(root, 'app.txt'), 'staged\n'); git(root, 'add', 'app.txt'); writeFileSync(join(root, 'app.txt'), 'unstaged\n'); writeFileSync(join(root, 'untracked.txt'), 'local\n');
  const status = git(root, 'status', '--porcelain'); const index = readFileSync(join(root, '.git', 'index'));
  const request = await input(); assert.equal(request.path, join(directory, 'tasks', 'repo', 'feature', 'login'));
  assert.equal(existsSync(config.worktreeDir!), false); // preview never creates directories
  const result = await catalog.create(request); assert.equal(result.status, 'ready', result.message);
  assert.equal(git(request.path, 'rev-parse', 'HEAD'), request.sourceHead); assert.equal(git(request.path, 'branch', '--show-current'), request.branch);
  assert.equal(git(request.path, 'status', '--porcelain'), ''); assert.equal(readFileSync(join(request.path, 'app.txt'), 'utf8'), 'baseline\n');
  assert.equal(existsSync(join(request.path, 'untracked.txt')), false); assert.equal(git(root, 'status', '--porcelain'), status);
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index); assert.equal(git(root, 'branch', '--show-current'), 'main');
  assert.equal((await catalog.create(request)).status, 'ready'); assert.equal(store.worktreeCreations().length, 1);
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  const [project] = await catalog.discover([], []); assert.equal(project!.worktrees.length, 2); assert.equal(project!.creations[0]!.status, 'ready');
});
test('remembering an explicitly used project retains all its worktrees after sessions disappear', async () => {
  await catalog.discover([await workspace(root)], []); catalog.remember(root);
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  assert.equal((await catalog.discover([], []))[0]!.worktrees[0]!.path, root);
});
test('same worktree across subdirectories shares its lock; a linked worktree can run concurrently', async () => {
  mkdirSync(join(root, 'sub')); const linked = join(directory, 'linked'); git(root, 'worktree', 'add', '-b', 'linked', linked);
  const main = await resolveWorktree(root); const sub = await resolveWorktree(join(root, 'sub')); const other = await resolveWorktree(linked);
  assert.deepEqual(main, sub); assert.notEqual(main!.indexPath, other!.indexPath);
  const scheduler = new WorkflowStore(store, join(config.dataDir, 'assignments'));
  const member = { ...mockSessions()[0]!, repository: root, worktree: main, registrationId: randomUUID() } as ManagedSession;
  const start = () => ({ requestId: randomUUID(), agentId: member.id, kind: 'instruction' as const, text: 'Fixture', confirmReady: true as const });
  scheduler.start(start(), [member], null);
  assert.throws(() => scheduler.start(start(), [{ ...member, cwd: join(root, 'sub'), worktree: sub }], null), /execution owner/);
  scheduler.start({ ...start(), agentId: 'second' }, [{ ...member, id: 'second', repository: linked, worktree: other }], null);
  assert.equal(scheduler.runs().length, 2);
});
test('stale source commit and branch require a new preview before any creation', async () => {
  const request = await input(); git(root, 'commit', '--allow-empty', '-m', 'new baseline');
  await assert.rejects(catalog.create(request), /changed/); assert.equal(existsSync(request.path), false); assert.deepEqual(store.worktreeCreations(), []);
  const next = await input(); git(root, 'switch', '-c', 'changed'); await assert.rejects(catalog.create(next), /changed/);
});
test('a source that changes after the setup owner is claimed records the specific reason and releases the hold', async () => {
  const request = await input();
  // The only path to a post-claim failure is a change between the pre-claim preview and the recheck: advance HEAD on that second inspection.
  const source = catalog['source'].bind(catalog); let inspections = 0;
  catalog['source'] = async (candidate) => { if (++inspections === 2) git(root, 'commit', '--allow-empty', '-m', 'raced in'); return source(candidate); };
  const result = await catalog.create(request);
  assert.equal(result.status, 'failed'); assert.match(result.message, /^Setup changed before creation\. .*Nothing was checked out/);
  assert.equal(existsSync(request.path), false); assert.equal(git(root, 'branch', '--list', request.branch), '');
  assert.deepEqual(await catalog.create(request), result); // the consumed request never re-runs Git
  catalog.assertWorktreeReady(request.path);
  assert.equal((await catalog.create(await input())).status, 'ready'); // a fresh preview is not blocked by the failed operation
});
test('existing branches and paths are never overwritten; names cannot escape the destination', async () => {
  await assert.rejects(input('main'), /integration branch/); await assert.rejects(input('master'), /integration branch/); git(root, 'branch', 'task/taken'); await assert.rejects(input('task/taken'), /already exists/);
  for (const name of ['../escape', 'feature/../../escape', '-B', 'a//b', 'a.lock', 'a..b', '@{-1}']) await assert.rejects(input(name));
  const request = await input(); mkdirSync(request.path, { recursive: true }); writeFileSync(join(request.path, 'keep'), 'user file');
  await assert.rejects(catalog.create(request), /already exists/); assert.equal(readFileSync(join(request.path, 'keep'), 'utf8'), 'user file');
});
test('symlink parents, stale destination and read-only host refuse creation', async () => {
  const request = await input(); const outside = join(directory, 'outside'); mkdirSync(outside); mkdirSync(config.worktreeDir!);
  symlinkSync(outside, join(config.worktreeDir!, 'repo'));
  await assert.rejects(catalog.create(request), /symlink/); assert.deepEqual(git(root, 'branch', '--list', 'feature/login'), '');
  const readOnly = new ProjectCatalog(store, { ...config, inputEnabled: false });
  await assert.rejects(readOnly.create(request), /disabled/);
});
test('concurrent project creation has one owner and request IDs cannot change meaning', async () => {
  const first = await input('first'); const second = await input('second');
  const results = await Promise.allSettled([catalog.create(first), catalog.create(second)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = store.worktreeCreations()[0]!; assert.equal(winner.status, 'ready');
  await assert.rejects(catalog.create({ ...winner.input, branch: 'third' }), /different/);
  assert.equal(store.worktreeCreations().length, 1);
});
test('restart retains uncertain ownership; explicit inspection resolves exact success or verified absence', async () => {
  const request = await input(); catalog.remember(root);
  store.saveWorktreeCreation({ input: request, status: 'applying', updatedAt: new Date().toISOString(), message: 'interrupted' });
  catalog = new ProjectCatalog(store, config); assert.equal(store.worktreeCreations()[0]!.status, 'uncertain');
  assert.throws(() => catalog.assertWorktreeReady(request.path), /worktree creation/); catalog.assertWorktreeReady(root);
  await assert.rejects(catalog.create({ ...request, requestId: randomUUID() }), /owns this project/);
  assert.equal((await catalog.reconcile(request.requestId)).status, 'failed');
  catalog.assertWorktreeReady(request.path);
  const second = { ...request, requestId: randomUUID() };
  store.saveWorktreeCreation({ input: second, status: 'uncertain', updatedAt: new Date().toISOString(), message: 'lost response' });
  mkdirSync(join(directory, 'tasks', 'repo', 'feature'), { recursive: true }); git(root, 'worktree', 'add', '-b', second.branch, second.path, second.sourceHead);
  assert.equal((await catalog.reconcile(second.requestId)).status, 'ready');
});
test('simultaneous identical confirmations create one operation and never replay Git', async () => {
  const request = await input(); const results = await Promise.all([catalog.create(request), catalog.create(request)]);
  assert.ok(results.every((result) => ['ready', 'applying'].includes(result.status)));
  assert.equal(store.worktreeCreations().length, 1); assert.equal(store.worktreeCreations()[0]!.status, 'ready');
  assert.equal((await catalog.discover([], []))[0]!.worktrees.length, 2);
});
test('a Git checkout failure is uncertain, retained across restart, and not automatically replayed', async () => {
  writeFileSync(join(root, '.gitattributes'), 'app.txt filter=fixture\n'); git(root, 'add', '.gitattributes'); git(root, 'commit', '-m', 'filter fixture');
  git(root, 'config', 'filter.fixture.smudge', 'false'); git(root, 'config', 'filter.fixture.required', 'true');
  const request = await input(); const result = await catalog.create(request);
  assert.equal(result.status, 'uncertain'); assert.equal((await catalog.create(request)).status, 'uncertain');
  catalog = new ProjectCatalog(store, config); assert.equal((await catalog.reconcile(request.requestId)).status, 'uncertain');
  assert.equal(git(root, 'rev-parse', `refs/heads/${request.branch}`), request.sourceHead);
});
test('partial or changed results remain uncertain; reconciliation never deletes user files or branches', async () => {
  const request = await input(); catalog.remember(root); git(root, 'branch', request.branch);
  store.saveWorktreeCreation({ input: request, status: 'uncertain', updatedAt: new Date().toISOString(), message: 'partial' });
  assert.equal((await catalog.reconcile(request.requestId)).status, 'uncertain');
  assert.equal(git(root, 'rev-parse', `refs/heads/${request.branch}`), request.sourceHead); assert.equal(existsSync(request.path), false);
});
test('worktree creation requires exact confirmation fields, not arbitrary Git arguments', async () => {
  const request = await input(); assert.deepEqual(parseWorktreeCreate(request), request);
  assert.throws(() => parseWorktreeCreate({ ...request, confirm: false }), /Confirm/);
  assert.throws(() => parseWorktreeCreate({ ...request, force: true }), /Unknown/);
  assert.throws(() => parseWorktreePreview({ projectId: request.projectId, sourceWorktreeId: request.sourceWorktreeId, branch: 'task;touch file' }));
});
