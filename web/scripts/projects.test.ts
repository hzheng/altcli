import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectCatalog } from '../src/server/projects.ts';
import { Store } from '../src/server/store.ts';
import { loadConfig, type Config } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { WorkflowStore } from '../src/server/workflow-store.ts';
import { mockSessions } from '../src/server/adapters/mock.ts';
import { parseDiscard, parseIntegrate, parseWorktreeCreate, parseWorktreePreview } from '../src/core/project-validation.ts';
import { jsonBody } from '../src/server/http.ts';
import { MAX_MESSAGE_JSON_BYTES, messageJsonBytes } from '../src/core/squash-message.ts';
import type { ManagedSession, Workspace } from '../src/contracts/workflow.ts';
import type { WorktreeCreateInput, WorktreeIntegrationPreview } from '../src/contracts/projects.ts';

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

const noArchive = async () => 0; // ControlPlane supplies the journal archive step; these tests exercise the Git removal alone
async function removalFixture(squash = true) {
  const request = await input('feature/finished'); await catalog.create(request);
  writeFileSync(join(request.path, 'app.txt'), 'one\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', 'first');
  writeFileSync(join(request.path, 'app.txt'), 'two\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', 'second');
  if (squash) { git(root, 'merge', '--squash', request.branch); git(root, 'commit', '-m', 'squashed'); }
  else git(root, 'merge', '--no-ff', request.branch, '-m', 'merged');
  const project = (await catalog.discover([await workspace(root)], []))[0]!;
  const tree = project.worktrees.find((w) => w.path === request.path)!;
  return { request, tree, target: { projectId: project.id, worktreeId: tree.id } };
}
for (const squash of [false, true]) test(`confirmed removal verifies ${squash ? 'squash changes' : 'ancestry'}, retains branch and is idempotent`, async () => {
  const { request, target } = await removalFixture(squash);
  const preview = await catalog.previewRemoval(target); assert.equal(preview.integratedBy, squash ? 'squash' : 'ancestry');
  const branchHead = git(request.path, 'rev-parse', 'HEAD'); const input = { ...preview, confirm: true as const };
  let checks = 0; let archived = 0;
  // The journal archive runs after every guard and before anything is deleted, while the commits are still reachable here.
  const removed = await catalog.remove(input, async () => { checks++; }, async (worktree) => { assert.equal(checks, 2); assert.equal(worktree.root, request.path); assert.ok(existsSync(request.path)); archived++; return 2; });
  assert.equal(removed.status, 'removed', removed.message); assert.equal(checks, 2); assert.equal(archived, 1);
  assert.match(removed.message, /2 handoff commits archived in the journal/);
  assert.equal(existsSync(request.path), false); assert.equal(git(root, 'rev-parse', request.branch), branchHead);
  assert.deepEqual(await catalog.remove(input, async () => { throw new Error('must not retry'); }, noArchive), removed);
  assert.equal((await catalog.discover([], []))[0]!.worktrees.length, 1);
  await assert.rejects(catalog.remove({ ...input, head: 'b'.repeat(40) }, async () => {}, noArchive), /different request/);
});
test('squash detection tolerates unrelated later main commits, but rejects later task changes', async () => {
  const { request, target } = await removalFixture();
  writeFileSync(join(root, 'other.txt'), 'later main work\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'later');
  assert.equal((await catalog.previewRemoval(target)).integratedBy, 'squash');
  writeFileSync(join(request.path, 'new.txt'), 'not integrated\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', 'new');
  await assert.rejects(catalog.previewRemoval(target), /not an ancestor/);
});
for (const dirty of ['tracked', 'untracked']) test(`removal blocks ${dirty} local data`, async () => {
  const { request, target } = await removalFixture();
  const preview = await catalog.previewRemoval(target);
  writeFileSync(join(request.path, dirty === 'tracked' ? 'app.txt' : 'local.txt'), 'keep me\n');
  await assert.rejects(catalog.previewRemoval(target), /modified or untracked/);
  const result = await catalog.remove({ ...preview, confirm: true }, async () => {}, noArchive);
  assert.equal(result.status, 'failed'); assert.match(result.message, /modified or untracked/);
  assert.equal(existsSync(request.path), true);
});
test('confirmed non-force removal permits ignored environment files and generated directories', async () => {
  const { request, target } = await removalFixture();
  git(request.path, 'config', 'core.excludesFile', join(directory, 'ignore'));
  writeFileSync(join(directory, 'ignore'), '.env.local\nnode_modules/\n');
  writeFileSync(join(request.path, '.env.local'), 'FIXTURE=true\n');
  mkdirSync(join(request.path, 'node_modules'));
  writeFileSync(join(request.path, 'node_modules', 'fixture.txt'), 'generated\n');
  const preview = await catalog.previewRemoval(target);
  assert.equal(readFileSync(join(request.path, '.env.local'), 'utf8'), 'FIXTURE=true\n');
  const result = await catalog.remove({ ...preview, confirm: true }, async () => {}, noArchive);
  assert.equal(result.status, 'removed', result.message);
  assert.equal(existsSync(request.path), false);
  assert.equal(git(root, 'rev-parse', request.branch), preview.head);
});
test('stale removal consent, busy guard, read-only host and main checkout never remove files', async () => {
  const { request, target } = await removalFixture(); const preview = await catalog.previewRemoval(target);
  git(root, 'commit', '--allow-empty', '-m', 'advanced main');
  const stale = await catalog.remove({ ...preview, confirm: true }, async () => {}, noArchive);
  assert.equal(stale.status, 'failed'); assert.match(stale.message, /changed/);
  const fresh = { ...await catalog.previewRemoval(target), confirm: true as const };
  const busy = await catalog.remove(fresh, async () => { throw new Error('run owns checkout'); }, noArchive);
  assert.equal(busy.status, 'failed'); assert.match(busy.message, /run owns/);
  await assert.rejects(new ProjectCatalog(store, { ...config, inputEnabled: false }).remove(fresh, async () => {}, noArchive), /disabled/);
  const project = (await catalog.discover([], []))[0]!;
  await assert.rejects(catalog.previewRemoval({ projectId: project.id, worktreeId: project.worktrees.find((w) => w.main)!.id }), /Only an accessible linked/);
  assert.equal(existsSync(request.path), true);
});
test('duplicate concurrent removal dispatches once; project setup holds block creation and binding', async () => {
  const { target } = await removalFixture(); const preview = { ...await catalog.previewRemoval(target), confirm: true as const };
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; }); const wait = new Promise<void>((resolve) => { release = resolve; });
  const removing = catalog.remove(preview, async () => { entered(); await wait; }, noArchive); await ready;
  assert.equal((await catalog.remove(preview, async () => { throw new Error('duplicate'); }, noArchive)).status, 'applying');
  assert.throws(() => catalog.assertWorktreeReady(preview.worktree.root), /removal is applying/);
  await assert.rejects(catalog.create(await input('another')), /owns this project/);
  release(); assert.equal((await removing).status, 'removed');
});
test('uncertain removal survives restart and reconciliation never repeats Git mutation', async () => {
  const { request, target } = await removalFixture(); const preview = { ...await catalog.previewRemoval(target), confirm: true as const };
  catalog['removedExactly'] = async () => false;
  assert.equal((await catalog.remove(preview, async () => {}, noArchive)).status, 'uncertain');
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  assert.throws(() => catalog.assertWorktreeReady(request.path), /uncertain/);
  assert.equal((await catalog.reconcileRemoval(preview.requestId)).status, 'removed');
  assert.equal(existsSync(request.path), false); assert.ok(git(root, 'rev-parse', request.branch));
});
test('restart during removal retains ownership until original result is inspected', async () => {
  const { target } = await removalFixture(); const input = { ...await catalog.previewRemoval(target), confirm: true as const };
  store.saveWorktreeRemoval({ input, status: 'applying', message: 'interrupted', updatedAt: new Date().toISOString() });
  catalog = new ProjectCatalog(store, config);
  assert.equal(store.worktreeRemovals()[0]!.status, 'uncertain');
  assert.equal((await catalog.reconcileRemoval(input.requestId)).status, 'failed');
  assert.equal(existsSync(input.worktree.root), true);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`removal refuses hidden index files (${flag})`, async () => {
  const { request, target } = await removalFixture();
  git(request.path, 'update-index', flag, 'app.txt'); writeFileSync(join(request.path, 'app.txt'), 'hidden local work\n');
  await assert.rejects(catalog.previewRemoval(target), /index hides/);
  assert.equal(readFileSync(join(request.path, 'app.txt'), 'utf8'), 'hidden local work\n');
});
test('removal rechecks pane occupancy and retained run ownership at the HTTP control boundary', async () => {
  const { Controller } = await import('../src/server/controller.ts');
  const { ControlPlane } = await import('../src/server/control-plane.ts');
  const { MockAdapter } = await import('../src/server/adapters/mock.ts');
  const { request, target } = await removalFixture();
  const adapter = new MockAdapter(); const list = adapter.listPanes.bind(adapter);
  adapter.listPanes = async () => (await list()).map((pane) => ({ ...pane, cwd: request.path }));
  const plane = new ControlPlane(new Controller(config, store, adapter));
  const preview = { ...await catalog.previewRemoval(target), confirm: true as const };
  await assert.rejects(plane.previewRemoval(target), /tmux pane/);
  const result = await plane.removeWorktree(preview); assert.equal(result.status, 'failed'); assert.match(result.message, /tmux pane/);
  adapter.listPanes = async () => [];
  const member = { ...mockSessions()[0]!, repository: request.path, cwd: request.path, worktree: await resolveWorktree(request.path), registrationId: randomUUID() } as ManagedSession;
  plane.workflow.start({ requestId: randomUUID(), agentId: member.id, kind: 'instruction', text: 'fixture', confirmReady: true }, [member], null);
  await assert.rejects(plane.previewRemoval(target), /run or unresolved delivery/);
  assert.equal(existsSync(request.path), true);
  adapter.listPanes = async () => { throw new Error('inventory unavailable'); };
  await assert.rejects(plane.previewRemoval(target), /inventory unavailable/);
});
test('a pane in a deleted directory elsewhere never blocks removal; a deleted subdirectory of the checkout still fails closed', async () => {
  const { Controller } = await import('../src/server/controller.ts');
  const { ControlPlane } = await import('../src/server/control-plane.ts');
  const { MockAdapter } = await import('../src/server/adapters/mock.ts');
  const { request, target } = await removalFixture();
  const adapter = new MockAdapter(); const list = adapter.listPanes.bind(adapter);
  let cwd = join(directory, 'gone'); adapter.listPanes = async () => (await list()).map((pane) => ({ ...pane, cwd }));
  const plane = new ControlPlane(new Controller(config, store, adapter));
  assert.equal((await plane.previewRemoval(target)).worktree.root, request.path);
  cwd = join(request.path, 'deleted-subdirectory');
  await assert.rejects(plane.previewRemoval(target), /tmux pane/);
  assert.equal(existsSync(request.path), true);
});
test('removal refuses a checkout whose ignored files hold the controller data directory through a symlink', async () => {
  const { request, target } = await removalFixture();
  git(request.path, 'config', 'core.excludesFile', join(directory, 'ignore')); writeFileSync(join(directory, 'ignore'), '.data/\n');
  mkdirSync(join(request.path, '.data')); symlinkSync(join(request.path, '.data'), join(directory, 'data-link'));
  const linked = new ProjectCatalog(store, { ...config, dataDir: join(directory, 'data-link', 'metadata') });
  await assert.rejects(linked.previewRemoval(target), /overlaps controller data/);
  assert.equal(existsSync(request.path), true);
});

// A task worktree with two commits that main does not contain yet: the input for squash integration and discard.
async function taskFixture() {
  const request = await input('feature/finished'); await catalog.create(request);
  writeFileSync(join(request.path, 'app.txt'), 'one\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', 'first');
  writeFileSync(join(request.path, 'app.txt'), 'two\n'); writeFileSync(join(request.path, 'new.txt'), 'added\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', 'second');
  const project = (await catalog.discover([await workspace(root)], []))[0]!;
  const tree = project.worktrees.find((w) => w.path === request.path)!;
  return { request, tree, target: { projectId: project.id, worktreeId: tree.id }, mainId: project.worktrees.find((w) => w.main)!.id, projectId: project.id };
}
const noGuard = async () => {};
/** The compact confirmation the browser sends: consent digest plus the (possibly edited) message, never the preview itself. */
const confirmSquash = (preview: WorktreeIntegrationPreview, message = preview.message) => ({ projectId: preview.projectId, worktreeId: preview.worktreeId, requestId: preview.requestId, consent: preview.consent, message, confirm: true as const });
test('squash integration previews the exact merge result, commits once on the main checkout with normal hooks, and is idempotent', async () => {
  const { request, target } = await taskFixture(); const mainHead = git(root, 'rev-parse', 'HEAD'); const base = mainHead;
  const preview = await catalog.previewIntegration(target);
  assert.equal(preview.targetRef, 'refs/heads/main'); assert.equal(preview.targetHead, mainHead); assert.equal(preview.target.root, root);
  assert.equal(preview.branch, 'feature/finished'); assert.equal(preview.head, git(request.path, 'rev-parse', 'HEAD')); assert.equal(preview.dirty, false);
  assert.equal(preview.mergeBase, base); assert.equal(preview.commitCount, 2); assert.deepEqual(preview.commits.map((c) => c.subject), ['second', 'first']);
  assert.notEqual(preview.tree, git(root, 'rev-parse', 'HEAD^{tree}'));
  assert.match(preview.message, /^Squash feature\/finished\n\nSquash of feature\/finished \([0-9a-f]{7}\.\.[0-9a-f]{7}, 2 commits\)\.\n\n- first\n- second\n$/);
  assert.deepEqual(preview.commands, [`git -C ${root} merge --squash ${preview.head}`, `git -C ${root} commit -m <message>`]);
  assert.equal(git(root, 'status', '--porcelain'), ''); assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead); // preview touched nothing
  let guards = 0;
  assert.match(preview.consent, /^[0-9a-f]{64}$/); assert.equal((await catalog.previewIntegration(target)).consent, preview.consent); // consent is stable for an unchanged operation
  const confirmed = confirmSquash(preview, 'feat: finished\n\nSquash of feature/finished.\n');
  const result = await catalog.integrate(confirmed, async (t, s) => { guards++; assert.equal(t.root, root); assert.equal(s.root, request.path); });
  assert.equal(result.status, 'integrated', result.message); assert.equal(guards, 2);
  assert.deepEqual({ ...result.input, requestId: preview.requestId, message: preview.message }, { ...preview, confirm: true }); // the record is the re-derived preview with the confirmed message
  const commit = git(root, 'rev-parse', 'HEAD'); assert.equal(result.commit, commit); assert.match(result.message, /use Check removal/);
  assert.equal(git(root, 'rev-parse', 'HEAD^'), mainHead); assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), preview.tree);
  assert.equal(git(root, 'log', '-1', '--format=%B'), 'feat: finished\n\nSquash of feature/finished.'); assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(root, 'app.txt'), 'utf8'), 'two\n'); assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'added\n');
  assert.equal(git(request.path, 'rev-parse', 'HEAD'), preview.head); assert.equal(git(request.path, 'status', '--porcelain'), ''); // the task worktree is untouched
  const removal = await catalog.previewRemoval(target); assert.equal(removal.integratedBy, 'squash'); assert.equal(removal.integratedCommit, commit);
  assert.deepEqual(await catalog.integrate(confirmed, async () => { throw new Error('must not retry'); }), result); assert.equal(git(root, 'rev-parse', 'HEAD'), commit);
  await assert.rejects(catalog.integrate({ ...confirmed, message: 'other' }, noGuard), /different request/);
  await assert.rejects(catalog.previewIntegration(target), /changes nothing in main.*Check removal/);
});
test('squash integration refuses conflicts, dirty or missing integration checkouts, the main worktree, stale consent, busy guards and read-only hosts', async () => {
  const { request, target, mainId } = await taskFixture();
  writeFileSync(join(root, 'app.txt'), 'main edit\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'conflicting main change');
  await assert.rejects(catalog.previewIntegration(target), /would conflict in app\.txt/);
  git(root, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(root, 'dirty.txt'), 'dirty\n'); // not a name any host-global ignore rule is likely to hide
  await assert.rejects(catalog.previewIntegration(target), /modified or untracked files/);
  rmSync(join(root, 'dirty.txt'));
  git(root, 'checkout', '-q', '--detach');
  await assert.rejects(catalog.previewIntegration(target), /No checkout has main checked out/);
  git(root, 'switch', '-q', 'main');
  await assert.rejects(catalog.previewIntegration({ ...target, worktreeId: mainId }), /Only an accessible linked/);
  writeFileSync(join(request.path, 'wip.txt'), 'unfinished\n');
  const preview = await catalog.previewIntegration(target); assert.equal(preview.dirty, true); // reported, not part of the squash
  git(root, 'commit', '--allow-empty', '-m', 'advanced main');
  await assert.rejects(catalog.integrate(confirmSquash(preview), noGuard), /changed/); // a stale consent digest never claims the project
  assert.deepEqual(store.worktreeIntegrations(), []);
  const fresh = confirmSquash(await catalog.previewIntegration(target));
  const busy = await catalog.integrate(fresh, async () => { throw new Error('run owns checkout'); });
  assert.equal(busy.status, 'failed'); assert.match(busy.message, /run owns/);
  await assert.rejects(new ProjectCatalog(store, { ...config, inputEnabled: false }).integrate(fresh, noGuard), /disabled/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), busy.input.targetHead); assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(request.path, 'wip.txt'), 'utf8'), 'unfinished\n');
});
test('a rejecting repository hook leaves the squash uncertain; inspection releases it only after the checkout is restored', async () => {
  const { target } = await taskFixture(); const mainHead = git(root, 'rev-parse', 'HEAD');
  const hooks = join(directory, 'hooks'); mkdirSync(hooks); writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nexit 1\n'); chmodSync(join(hooks, 'commit-msg'), 0o755);
  git(root, 'config', 'core.hooksPath', hooks); // final integration honours the repository's hook policy, unlike handoff commits
  const preview = await catalog.previewIntegration(target);
  const result = await catalog.integrate(confirmSquash(preview), noGuard);
  assert.equal(result.status, 'uncertain'); assert.match(result.message, /rejecting hook/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead); assert.notEqual(git(root, 'status', '--porcelain'), ''); // the staged squash is left for the human
  assert.throws(() => catalog.assertWorktreeReady(root), /squash integration/);
  assert.equal((await catalog.reconcileIntegration(preview.requestId)).status, 'uncertain');
  git(root, 'reset', '-q', '--hard', mainHead);
  assert.equal((await catalog.reconcileIntegration(preview.requestId)).status, 'failed');
  git(root, 'config', '--unset', 'core.hooksPath');
  const retry = await catalog.integrate(confirmSquash(await catalog.previewIntegration(target)), noGuard);
  assert.equal(retry.status, 'integrated', retry.message);
});
test('restart or a failed verification keeps a squash uncertain; read-only inspection recognises the actual commit', async () => {
  const { target, projectId } = await taskFixture();
  const interrupted = { ...await catalog.previewIntegration(target), confirm: true as const };
  store.saveWorktreeIntegration({ input: interrupted, status: 'applying', message: 'interrupted', updatedAt: new Date().toISOString(), commit: null });
  catalog = new ProjectCatalog(store, config);
  assert.equal(store.worktreeIntegrations()[0]!.status, 'uncertain');
  await assert.rejects(catalog.create(await input('another')), /owns this project/);
  assert.equal((await catalog.reconcileIntegration(interrupted.requestId)).status, 'failed');
  const preview = await catalog.previewIntegration(target);
  const verify = catalog['integratedExactly'].bind(catalog); catalog['integratedExactly'] = async () => null;
  assert.equal((await catalog.integrate(confirmSquash(preview), noGuard)).status, 'uncertain');
  catalog['integratedExactly'] = verify;
  const reconciled = await catalog.reconcileIntegration(preview.requestId);
  assert.equal(reconciled.status, 'integrated'); assert.equal(reconciled.commit, git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'rev-parse', 'HEAD^'), preview.targetHead);
  assert.equal((await catalog.discover([], []))[0]!.integrations!.length, 2); assert.equal(projectId, (await catalog.discover([], []))[0]!.id);
});
test('discard previews the work that would be lost, requires the typed branch, archives first, then deletes the worktree and its branch', async () => {
  const { request, target } = await taskFixture(); writeFileSync(join(request.path, 'wip.txt'), 'unfinished\n');
  const preview = await catalog.previewDiscard(target);
  assert.equal(preview.dirty, true); assert.equal(preview.changeCount, 1); assert.equal(preview.unmergedCommits, 2); assert.equal(preview.targetRef, 'refs/heads/main');
  assert.throws(() => parseDiscard({ ...preview, confirmBranch: 'feature/other', confirm: true }), /exact branch name/);
  assert.throws(() => parseDiscard({ ...preview, confirmBranch: preview.branch }), /Confirm/);
  const confirmed = { ...preview, confirmBranch: preview.branch, confirm: true as const };
  let guards = 0; let archived = 0;
  const result = await catalog.discard(confirmed, async () => { guards++; }, async (worktree) => { assert.equal(guards, 2); assert.ok(existsSync(worktree.root)); archived++; return 1; });
  assert.equal(result.status, 'discarded', result.message); assert.equal(archived, 1); assert.match(result.message, /1 handoff commit archived/);
  assert.equal(existsSync(request.path), false); assert.equal(git(root, 'branch', '--list', 'feature/finished'), '');
  assert.equal((await catalog.discover([], []))[0]!.worktrees.length, 1);
  assert.deepEqual(await catalog.discard(confirmed, async () => { throw new Error('must not retry'); }, noArchive), result);
  await assert.rejects(catalog.discard({ ...confirmed, dirty: false }, noGuard, noArchive), /different request/);
});
test('discard refuses stale consent, busy guards, read-only hosts and the main checkout; uncertain results are inspected without retry', async () => {
  const { request, target, mainId } = await taskFixture();
  const preview = await catalog.previewDiscard(target); writeFileSync(join(request.path, 'late.txt'), 'appeared after preview\n');
  const stale = await catalog.discard({ ...preview, confirmBranch: preview.branch, confirm: true }, noGuard, noArchive);
  assert.equal(stale.status, 'failed'); assert.match(stale.message, /changed/); assert.equal(existsSync(request.path), true);
  const fresh = { ...await catalog.previewDiscard(target), confirmBranch: preview.branch, confirm: true as const };
  const busy = await catalog.discard(fresh, async () => { throw new Error('run owns checkout'); }, noArchive);
  assert.equal(busy.status, 'failed'); assert.match(busy.message, /run owns/);
  await assert.rejects(new ProjectCatalog(store, { ...config, inputEnabled: false }).discard(fresh, noGuard, noArchive), /disabled/);
  await assert.rejects(catalog.previewDiscard({ ...target, worktreeId: mainId }), /Only an accessible linked/);
  store.saveWorktreeDiscard({ input: fresh, status: 'applying', message: 'interrupted', updatedAt: new Date().toISOString() });
  catalog = new ProjectCatalog(store, config);
  assert.equal(store.worktreeDiscards().find((op) => op.input.requestId === fresh.requestId)!.status, 'uncertain'); assert.throws(() => catalog.assertWorktreeReady(request.path), /discard/);
  assert.equal((await catalog.reconcileDiscard(fresh.requestId)).status, 'failed'); assert.equal(existsSync(request.path), true);
  const again = { ...await catalog.previewDiscard(target), confirmBranch: preview.branch, confirm: true as const };
  catalog['discardedExactly'] = async () => false;
  const unverified = await catalog.discard(again, noGuard, noArchive); assert.equal(unverified.status, 'uncertain', unverified.message);
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  assert.equal((await catalog.reconcileDiscard(again.requestId)).status, 'discarded');
  assert.equal(existsSync(request.path), false); assert.equal(git(root, 'branch', '--list', 'feature/finished'), '');
});
test('integration and discard recheck run ownership at the HTTP control boundary; discard also requires no pane in the checkout', async () => {
  const { Controller } = await import('../src/server/controller.ts');
  const { ControlPlane } = await import('../src/server/control-plane.ts');
  const { MockAdapter } = await import('../src/server/adapters/mock.ts');
  const { request, target } = await taskFixture();
  const adapter = new MockAdapter(); const list = adapter.listPanes.bind(adapter);
  adapter.listPanes = async () => (await list()).map((pane) => ({ ...pane, cwd: root }));
  const plane = new ControlPlane(new Controller(config, store, adapter));
  assert.equal((await plane.previewIntegration(target)).target.root, root); // panes in the integration checkout are allowed; ownership is what blocks
  const member = { ...mockSessions()[0]!, repository: root, cwd: root, worktree: await resolveWorktree(root), registrationId: randomUUID() } as ManagedSession;
  const run = plane.workflow.start({ requestId: randomUUID(), agentId: member.id, kind: 'instruction', text: 'fixture', confirmReady: true }, [member], null);
  await assert.rejects(plane.previewIntegration(target), /owns the integration checkout/);
  plane.workflow.takeover(run.runId);
  const preview = await plane.previewIntegration(target);
  const other = { ...mockSessions()[1]!, repository: request.path, cwd: request.path, worktree: await resolveWorktree(request.path), registrationId: randomUUID() } as ManagedSession;
  const owning = plane.workflow.start({ requestId: randomUUID(), agentId: other.id, kind: 'instruction', text: 'fixture', confirmReady: true }, [other], null);
  const blocked = await plane.integrateWorktree(confirmSquash(preview)); assert.equal(blocked.status, 'failed'); assert.match(blocked.message, /owns the task worktree/);
  await assert.rejects(plane.previewDiscard(target), /run or unresolved delivery/);
  plane.workflow.takeover(owning.runId);
  adapter.listPanes = async () => (await list()).map((pane) => ({ ...pane, cwd: request.path }));
  await assert.rejects(plane.previewDiscard(target), /tmux pane/);
  adapter.listPanes = async () => [];
  const integrated = await plane.integrateWorktree(confirmSquash(await plane.previewIntegration(target))); assert.equal(integrated.status, 'integrated', integrated.message);
  const discard = await plane.previewDiscard(target); assert.equal(discard.unmergedCommits, 2); // squash does not make the task commits ancestors of main
  const discarded = await plane.discardWorktree({ ...discard, confirmBranch: discard.branch, confirm: true });
  assert.equal(discarded.status, 'discarded', discarded.message); assert.equal(existsSync(request.path), false);
});
test('discard consent binds to the exact dirty content: editing an already dirty file after the preview, even inside the archive step, refuses deletion', async () => {
  const { request, target } = await taskFixture(); writeFileSync(join(request.path, 'wip.txt'), 'unfinished\n');
  const preview = await catalog.previewDiscard(target); assert.equal(preview.changeCount, 1); assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
  writeFileSync(join(request.path, 'wip.txt'), 'edited after preview\n'); // same file count, different content
  const stale = await catalog.discard({ ...preview, confirmBranch: preview.branch, confirm: true }, noGuard, noArchive);
  assert.equal(stale.status, 'failed'); assert.match(stale.message, /changed/); assert.equal(existsSync(request.path), true);
  const fresh = await catalog.previewDiscard(target); assert.notEqual(fresh.fingerprint, preview.fingerprint); assert.equal(fresh.changeCount, 1);
  const raced = await catalog.discard({ ...fresh, confirmBranch: fresh.branch, confirm: true }, noGuard, async () => { writeFileSync(join(request.path, 'wip.txt'), 'edited during archive\n'); return 0; });
  assert.equal(raced.status, 'failed'); assert.match(raced.message, /after the archive step/);
  assert.equal(existsSync(request.path), true); assert.equal(readFileSync(join(request.path, 'wip.txt'), 'utf8'), 'edited during archive\n'); assert.ok(git(root, 'branch', '--list', 'feature/finished'));
  const current = await catalog.previewDiscard(target);
  assert.equal((await catalog.discard({ ...current, confirmBranch: current.branch, confirm: true }, noGuard, noArchive)).status, 'discarded');
});
test('the store version advances for the new operation owners: unresolved integrations and discards survive reopen, and newer databases are refused', async () => {
  const { target, request } = await taskFixture();
  const integration = { ...await catalog.previewIntegration(target), confirm: true as const };
  store.saveWorktreeIntegration({ input: integration, status: 'uncertain', message: 'fixture', updatedAt: new Date().toISOString(), commit: null });
  const discard = { ...await catalog.previewDiscard(target), confirmBranch: 'feature/finished', confirm: true as const };
  store.saveWorktreeDiscard({ input: discard, status: 'uncertain', message: 'fixture', updatedAt: new Date().toISOString() });
  assert.equal(store.db.pragma('user_version', { simple: true }), 10);
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  assert.equal(store.db.pragma('user_version', { simple: true }), 10);
  assert.deepEqual(store.worktreeIntegrations().map((op) => [op.input.requestId, op.status]), [[integration.requestId, 'uncertain']]);
  assert.deepEqual(store.worktreeDiscards().map((op) => [op.input.requestId, op.status]), [[discard.requestId, 'uncertain']]);
  assert.throws(() => catalog.assertWorktreeReady(root), /squash integration/); assert.throws(() => catalog.assertWorktreeReady(request.path), /discard/);
  await assert.rejects(catalog.create(await input('another')), /owns this project/);
  store.db.pragma('user_version = 11'); store.close();
  assert.throws(() => new Store(config.dataDir), /Unsupported database version/);
  store = new Store(join(directory, 'fresh-metadata')); // afterEach closes this one
});
test('a long-history preview confirms unedited within the HTTP body limit, and the worst-case accepted message round-trips too', async () => {
  const request = await input('feature/long'); await catalog.create(request);
  for (let i = 0; i < 100; i++) { writeFileSync(join(request.path, 'app.txt'), `${i}\n`); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', `commit ${i}: ${'a fairly ordinary subject line that describes the change'.repeat(2)}`); }
  writeFileSync(join(request.path, 'app.txt'), 'newest\n'); git(request.path, 'add', '.'); git(request.path, 'commit', '-m', `newest: ${'s'.repeat(500)}`);
  const project = (await catalog.discover([await workspace(root)], []))[0]!; const tree = project.worktrees.find((w) => w.path === request.path)!;
  const preview = await catalog.previewIntegration({ projectId: project.id, worktreeId: tree.id });
  assert.equal(preview.commitCount, 101); assert.equal(preview.commits.length, 100); assert.ok(JSON.stringify(preview).length > 16384); // the preview itself is far over the limit
  // The generated default obeys the confirmation budget: the oldest listed subjects first (the list holds the newest 100), cut with a count of what was left out, long subjects shortened.
  assert.ok(messageJsonBytes(preview.message) <= MAX_MESSAGE_JSON_BYTES); assert.match(preview.message, /^Squash feature\/long\n\nSquash of feature\/long \([0-9a-f]{7}\.\.[0-9a-f]{7}, 101 commits\)\.\n\n- commit 1: /);
  assert.match(preview.message, /\n- … and \d+ more commits\n$/); assert.doesNotMatch(preview.message, /s{200}/);
  const body = JSON.stringify(confirmSquash(preview)); assert.ok(Buffer.byteLength(body, 'utf8') <= 16384);
  const parse = (json: string) => jsonBody(new Request('http://127.0.0.1:8787/api/v1/projects/worktrees/integration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }));
  const parsed = parseIntegrate(await parse(body)); assert.equal(parsed.message, preview.message);
  const result = await catalog.integrate(parsed, noGuard); assert.equal(result.status, 'integrated', result.message);
  assert.equal(git(root, 'log', '-1', '--format=%B'), preview.message.trimEnd()); assert.equal(result.input.commits.length, 100);
  // Worst case for the serialized form: a message of double quotes doubles when JSON-encoded, and still fits the request bound.
  const other = await input('feature/other'); await catalog.create(other);
  writeFileSync(join(other.path, 'other.txt'), 'x\n'); git(other.path, 'add', '.'); git(other.path, 'commit', '-m', 'other');
  const second = (await catalog.discover([await workspace(root)], []))[0]!; const otherTree = second.worktrees.find((w) => w.path === other.path)!;
  const quotes = '"'.repeat(4095); assert.equal(messageJsonBytes(quotes), MAX_MESSAGE_JSON_BYTES);
  const quoted = await catalog.previewIntegration({ projectId: second.id, worktreeId: otherTree.id });
  const worst = JSON.stringify(confirmSquash(quoted, quotes)); assert.ok(Buffer.byteLength(worst, 'utf8') <= 16384);
  const integrated = await catalog.integrate(parseIntegrate(await parse(worst)), noGuard); assert.equal(integrated.status, 'integrated', integrated.message);
  assert.equal(git(root, 'log', '-1', '--format=%B'), quotes);
  // One more escaped byte, or an oversized plain message, is refused by the same rule the browser shows.
  assert.throws(() => parseIntegrate(confirmSquash(quoted, `${quotes}"`)), /8 KiB/);
  assert.throws(() => parseIntegrate(confirmSquash(quoted, 'x'.repeat(8191))), /8 KiB/); assert.equal(parseIntegrate(confirmSquash(quoted, 'x'.repeat(8190))).message.length, 8190);
  assert.throws(() => parseIntegrate({ ...confirmSquash(quoted), consent: 'nope' }), /consent digest/);
  assert.throws(() => parseIntegrate({ ...confirmSquash(quoted), projectId: 'p'.repeat(201) }), /identifiers/);
  assert.throws(() => parseIntegrate({ ...quoted, message: quoted.message, confirm: true }), /Unknown worktree field/); // the preview echo is no longer a request
});
