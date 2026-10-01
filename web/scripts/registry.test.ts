import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/server/store.ts';
import { WorkflowStore } from '../src/server/workflow-store.ts';
import { ProjectCatalog } from '../src/server/projects.ts';
import { loadConfig, type Config } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { idOf } from '../src/server/ids.ts';
import { inspectUpgrade, planRegistry, REGISTRY_SCHEMA, settlementBlockers } from '../src/server/upgrade.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter } from '../src/server/adapters/mock.ts';
import type { LaunchBatch } from '../src/contracts/launches.ts';
import type { ManagedWorkspace, TaskFinish, WorktreeCreation, WorktreeDiscard, WorktreeIntegration, WorktreeRemoval, WorktreeRename, WorktreeUpdate } from '../src/contracts/projects.ts';
import type { Workspace, WorktreeIdentity } from '../src/contracts/workflow.ts';

// ADR-0024 registry: the settled-store upgrade gate, the schema-20 backfill and task-workspace lifecycle. Real SQLite and Git in
// isolated temporary directories; no live store, tmux server or installed agent is used.
let directory: string; let store: Store;
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-registry-'))); store = new Store(join(directory, 'metadata')); });
afterEach(() => { try { store.close(); } catch { /* a refused open already closed it */ } rmSync(directory, { recursive: true, force: true }); });
const metadata = () => join(directory, 'metadata');
const database = () => join(metadata(), 'altcli.sqlite3');
const backups = () => readdirSync(metadata()).filter((name) => name.startsWith('altcli-schema-'));
/** The persisted tables an upgrade must not touch, read through a separate connection. */
function dump(path = database()) {
  const db = new Database(path, { readonly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    return { version: db.pragma('user_version', { simple: true }), rows: Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])) };
  } finally { db.close(); }
}
/** Labels the open store as schema 19 and closes it, as the previous version would leave it. */
function asSchema19() { store.db.pragma('user_version = 19'); store.close(); }

const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 12, minute)).toISOString();
const PROJECT = 'project-fixture';
const MAIN: WorktreeIdentity = { root: '/repo', gitDir: '/repo/.git', indexPath: '/repo/.git/index' };
const tree = (name: string, admin = name): WorktreeIdentity => ({ root: `/tasks/repo/${name}`, gitDir: `/repo/.git/worktrees/${admin}`, indexPath: `/repo/.git/worktrees/${admin}/index` });
const worktreeId = (identity: WorktreeIdentity) => idOf('worktree', [PROJECT, identity.gitDir, identity.indexPath]);
function creation(name: string, minute: number, status: WorktreeCreation['status'] = 'ready'): WorktreeCreation {
  return { input: { projectId: PROJECT, sourceWorktreeId: worktreeId(MAIN), branch: name, requestId: randomUUID(), source: MAIN, sourceBranch: 'main', sourceHead: 'b'.repeat(40),
    path: tree(name).root, confirm: true }, status, message: 'fixture', updatedAt: at(minute) };
}
/** An operation record carrying a worktree identity; only the fields migration and the gate read are filled in. */
const operation = <T>(identity: WorktreeIdentity, minute: number, status: string, more: Record<string, unknown> = {}) =>
  ({ input: { projectId: PROJECT, worktreeId: worktreeId(identity), requestId: randomUUID(), worktree: identity, ...more }, status, message: 'fixture', updatedAt: at(minute), commit: null }) as unknown as T;
function launch(identity: WorktreeIdentity, minute: number, more: Record<string, unknown> = {}): LaunchBatch {
  const requestId = randomUUID();
  return { requestId, previewDigest: 'fixture', createdAt: at(minute), items: [{ id: randomUUID(), projectId: PROJECT, worktreeId: worktreeId(identity), worktree: identity, commonDir: '/repo/.git',
    branch: 'task', head: 'c'.repeat(40), profile: { id: 'profile', revision: 1, label: 'CC', executable: 'claude', args: [], adapterHint: 'claude', enabled: true }, executable: '/bin/claude',
    sessionName: 'CC-task', environmentDigest: 'fixture', status: 'running', phase: 'observed', message: 'fixture', identity: null, placeholder: null, sessionId: null, windowId: null, updatedAt: at(minute), ...more }] };
}
const saveLaunch = (batch: LaunchBatch) => store.db.prepare('INSERT INTO launches(id,value) VALUES (?,?)').run(batch.requestId, JSON.stringify(batch));
const saveSession = (identity: WorktreeIdentity, minute: number) => store.db.prepare('INSERT INTO sessions(id,value) VALUES (?,?)').run(randomUUID(), JSON.stringify({ id: randomUUID(),
  label: 'hand-started', agentType: 'claude', repository: identity.root, expectedCommand: 'claude', identity: { paneId: '%1', panePid: '1', serverPid: '2', serverStarted: '3', socketPath: '/tmp/t' },
  relayPrompt: 'relay', registeredAt: at(minute), registrationId: randomUUID(), worktree: identity, cwd: identity.root }));

test('a fresh store starts at the registry schema with no upgrade backup; a newer store is refused', () => {
  assert.equal(store.db.pragma('user_version', { simple: true }), REGISTRY_SCHEMA);
  assert.deepEqual(store.managedWorkspaces(), []); assert.deepEqual(backups(), []);
  store.db.pragma(`user_version = ${REGISTRY_SCHEMA + 1}`); store.close();
  assert.throws(() => new Store(metadata()), /Unsupported database version/);
  assert.equal(dump().version, REGISTRY_SCHEMA + 1);
});

test('the upgrade gate names every kind of unresolved work and ignores settled history', () => {
  new WorkflowStore(store, join(directory, 'assignments'));
  store.db.exec('CREATE TABLE IF NOT EXISTS global_ai_instances (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)');
  const insert = (sql: string, ...values: unknown[]) => store.db.prepare(sql).run(...values);
  insert('INSERT INTO workflow_owners(lock_key,run_id) VALUES (?,?)', '/repo/.git/index', 'run-owned');
  for (const [id, status, repository] of [['cmd-uncertain', 'uncertain', '/a'], ['cmd-delivered', 'delivered', '/b']]) {
    insert('INSERT INTO commands(id,value) VALUES (?,?)', id, JSON.stringify({ id, status })); insert('INSERT INTO reservations(repository,active_id) VALUES (?,?)', repository, id);
  }
  insert('INSERT INTO reservations(repository,active_id) VALUES (?,?)', '/c', 'cmd-missing');
  for (const [id, status] of [['input-uncertain', 'uncertain'], ['input-delivered', 'delivered']]) insert('INSERT INTO interactions(id,repository,value) VALUES (?,?,?)', id, '/a', JSON.stringify({ input: { requestId: id }, repository: '/a', status }));
  for (const [id, live, reconciliationRequired] of [['manual-live', true, false], ['manual-unreconciled', false, true], ['manual-settled', false, false]] as const)
    insert('INSERT INTO keyboard_sessions(id,value) VALUES (?,?)', id, JSON.stringify({ id, live, reconciliationRequired }));
  insert('INSERT INTO launch_reservations(index_path,launch_id) VALUES (?,?)', '/tasks/repo/a/.git', 'launch-held');
  const open = creation('open', 1, 'uncertain'); store.saveWorktreeCreation(open); store.saveWorktreeCreation(creation('done', 1));
  const held: Record<string, string> = {};
  for (const [kind, save] of [['worktree-removal', (op: never) => store.saveWorktreeRemoval(op)], ['squash', (op: never) => store.saveWorktreeIntegration(op)],
    ['worktree-discard', (op: never) => store.saveWorktreeDiscard(op)], ['worktree-update', (op: never) => store.saveWorktreeUpdate(op)], ['branch-rename', (op: never) => store.saveWorktreeRename(op)]] as const) {
    const pending = operation<never>(tree('a'), 2, kind === 'squash' ? 'applying' : 'uncertain'); save(pending); save(operation<never>(tree('a'), 3, 'failed'));
    held[kind] = (pending as { input: { requestId: string } }).input.requestId;
  }
  for (const [id, status] of [['finish-attention', 'attention'], ['finish-done', 'done']]) store.saveTaskFinish({ requestId: id, status } as unknown as TaskFinish, 0);
  for (const [id, status] of [['helper-launching', 'launching'], ['helper-started', 'started']]) insert('INSERT INTO global_ai_instances(id,request_id,value) VALUES (?,?,?)', id, randomUUID(), JSON.stringify({ id, status }));
  assert.deepEqual(settlementBlockers(store.db).map((b) => [b.kind, b.id]), [['run', 'run-owned'], ['delivery', 'cmd-uncertain'], ['interaction', 'input-uncertain'],
    ['manual-input', 'manual-live'], ['manual-input', 'manual-unreconciled'], ['launch', 'launch-held'], ['worktree-creation', open.input.requestId],
    ['worktree-removal', held['worktree-removal']], ['squash', held.squash], ['worktree-discard', held['worktree-discard']], ['worktree-update', held['worktree-update']],
    ['branch-rename', held['branch-rename']], ['finish-branch', 'finish-attention'], ['helper', 'helper-launching']]);
});

test('the upgrade gate retains inspected launch uncertainty after its reservation has cleared', async () => {
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: metadata(), ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  const plane = new ControlPlane(new Controller(config, store, new MockAdapter()));
  const batch = launch(tree('a'), 1);
  batch.items = ['starting', 'exited', 'uncertain'].map((status) => ({ ...batch.items[0]!, id: randomUUID(), sessionName: status }));
  saveLaunch(batch); // All three were observed running, which released the original launch reservation.
  Object.defineProperty(plane.launches, 'verify', { value: async (item: LaunchBatch['items'][number]) => {
    if (item.sessionName === 'uncertain') throw new Error('The recorded launch identity changed.');
    return { identity: { paneId: '%1', panePid: '1', serverPid: '2', serverStarted: '3', socketPath: '/mock/socket' },
      command: 'sh', cwd: item.worktree.root, dead: item.sessionName === 'exited', inMode: false, synchronized: false };
  } });
  try {
    for (const item of batch.items) assert.equal((await plane.launches.inspect(item.id)).status, item.sessionName);
    assert.deepEqual(store.db.prepare('SELECT COUNT(*) AS n FROM launch_reservations').get(), { n: 0 });
    assert.deepEqual(settlementBlockers(store.db).map((b) => [b.kind, b.id]), batch.items.map((item) => ['launch', item.id]));
  } finally { await plane.terminals.shutdown(); }
  asSchema19(); const before = dump();
  assert.equal(inspectUpgrade(database()).blockers.length, 3);
  assert.throws(() => new Store(metadata()), (error: Error & { code?: string }) => error.code === 'UPGRADE_BLOCKED');
  assert.deepEqual(dump(), before); assert.deepEqual(backups(), []);
  // The prior backend can settle each item explicitly; terminal launch history then stops blocking migration.
  const prior = new Database(database());
  prior.prepare('UPDATE launches SET value=? WHERE id=?').run(JSON.stringify({ ...batch,
    items: batch.items.map((item) => ({ ...item, status: 'reconciled' })) }), batch.requestId);
  prior.close(); store = new Store(metadata());
  assert.equal(store.db.pragma('user_version', { simple: true }), REGISTRY_SCHEMA);
});

test('an unsettled store refuses the upgrade before anything changes; once settled it upgrades once with a private backup', () => {
  const pending = creation('open', 1, 'uncertain'); store.saveWorktreeCreation(pending);
  store.saveProject({ id: PROJECT, name: 'repo', commonDir: '/repo/.git', directoryName: 'repo' });
  asSchema19(); const before = dump();
  assert.throws(() => new Store(metadata()), (error: Error & { code?: string; status?: number }) => error.code === 'UPGRADE_BLOCKED' && error.status === 503
    && error.message.includes(`worktree-creation ${pending.input.requestId} (uncertain)`) && error.message.includes('upgrade:check') && error.message.includes('Nothing was changed'));
  assert.deepEqual(dump(), before); assert.deepEqual(backups(), []);
  const report = inspectUpgrade(database());
  assert.deepEqual([report.version, report.target, report.blockers.map((b) => b.id), report.repositories], [19, REGISTRY_SCHEMA, [pending.input.requestId], 1]);
  assert.deepEqual(dump(), before); // the preview opens read-only
  // The previous version settles it; then this version upgrades.
  const raw = new Database(database()); raw.prepare('UPDATE worktree_creations SET status=?, value=? WHERE id=?').run('failed', JSON.stringify({ ...pending, status: 'failed' }), pending.input.requestId); raw.close();
  store = new Store(metadata());
  assert.equal(store.db.pragma('user_version', { simple: true }), REGISTRY_SCHEMA);
  assert.deepEqual(store.projects()[0]!.settings, { revision: 1, confirmation: 'pending', base: null, integrationBranch: null, launchDefaults: [], confirmedAt: null });
  const [backup] = backups(); assert.ok(backup?.startsWith('altcli-schema-19-')); assert.equal(statSync(join(metadata(), backup!)).mode & 0o777, 0o600);
  const saved = dump(join(metadata(), backup!)); assert.equal(saved.version, 19); assert.deepEqual(saved.rows.worktree_creations, dump().rows.worktree_creations);
  const upgraded = dump(); store.close(); store = new Store(metadata());
  assert.deepEqual(dump(), upgraded); assert.equal(backups().length, 1); // reopening never migrates or backs up again
});

test('migration records task workspaces only where saved records prove their identity', () => {
  store.saveProject({ id: PROJECT, name: 'repo', commonDir: '/repo/.git', directoryName: 'repo' });
  // A: launched, renamed and updated: active, with its current expected branch and alignment.
  const a = creation('a', 1); store.saveWorktreeCreation(a); const aLaunch = launch(tree('a'), 2); saveLaunch(aLaunch);
  store.saveWorktreeRename(operation<WorktreeRename>(tree('a'), 3, 'renamed', { branch: 'a', newBranch: 'a-renamed' }));
  const aligned = operation<WorktreeUpdate>(tree('a'), 4, 'updated', { mode: 'rebase' }); (aligned as { commit: string | null }).commit = 'd'.repeat(40); store.saveWorktreeUpdate(aligned);
  // B: no record of its identity. C: two records that disagree. Both stay pending; nothing adopts them.
  const b = creation('b', 1); store.saveWorktreeCreation(b);
  const c = creation('c', 1); store.saveWorktreeCreation(c); saveLaunch(launch(tree('c'), 2)); saveSession(tree('c', 'c1'), 3);
  // D: removed, then created again at the same path with new Git metadata: two incarnations, each with its own launches.
  const d1 = creation('d', 1); store.saveWorktreeCreation(d1); const d1Launch = launch(tree('d'), 2); saveLaunch(d1Launch);
  const removal = operation<WorktreeRemoval>(tree('d'), 5, 'removed'); store.saveWorktreeRemoval(removal);
  const d2 = creation('d', 6); store.saveWorktreeCreation(d2); const d2Launch = launch(tree('d', 'd1'), 7); saveLaunch(d2Launch);
  // E: recreated without a recorded removal: the earlier record is retired as superseded. F: discarded.
  const e1 = creation('e', 1); store.saveWorktreeCreation(e1); const e2 = creation('e', 3); store.saveWorktreeCreation(e2);
  const f = creation('f', 1); store.saveWorktreeCreation(f); const discard = operation<WorktreeDiscard>(tree('f'), 2, 'discarded'); store.saveWorktreeDiscard(discard);
  // Failed creations, base-checkout launches and an integration source anchor.
  store.saveWorktreeCreation(creation('g', 1, 'failed')); const base = launch(MAIN, 2); saveLaunch(base);
  const h = creation('h', 1); store.saveWorktreeCreation(h); store.saveWorktreeIntegration(operation<WorktreeIntegration>(tree('h'), 2, 'integrated'));
  const planned = planRegistry(store.db);
  asSchema19(); store = new Store(metadata());
  const workspaces = store.managedWorkspaces(); assert.deepEqual(workspaces, planned.workspaces);
  const byId = (id: string) => workspaces.find((w) => w.id === id)!;
  assert.equal(workspaces.some((w) => w.branch === 'g'), false);
  assert.deepEqual(byId(a.input.requestId), { id: a.input.requestId, projectId: PROJECT, worktreeId: worktreeId(tree('a')), path: tree('a').root, identity: tree('a'), branch: 'a', baseline: 'b'.repeat(40),
    expectedBranch: 'a-renamed', status: 'active', retiredBy: null, aligned: { requestId: (aligned as { input: { requestId: string } }).input.requestId, mode: 'rebase', commit: 'd'.repeat(40), at: at(4) },
    createdAt: at(1), updatedAt: at(1), migrated: true } satisfies ManagedWorkspace);
  for (const pending of [b, c]) assert.deepEqual([byId(pending.input.requestId).status, byId(pending.input.requestId).identity, byId(pending.input.requestId).worktreeId], ['pending', null, null]);
  assert.deepEqual([byId(d1.input.requestId).status, byId(d1.input.requestId).identity, byId(d1.input.requestId).retiredBy], ['retired', tree('d'), { kind: 'removal', requestId: removal.input.requestId, at: at(5) }]);
  assert.deepEqual([byId(d2.input.requestId).status, byId(d2.input.requestId).identity], ['active', tree('d', 'd1')]);
  assert.deepEqual([byId(e1.input.requestId).status, byId(e1.input.requestId).retiredBy], ['retired', { kind: 'superseded', requestId: e2.input.requestId, at: at(3) }]);
  assert.equal(byId(e2.input.requestId).status, 'pending');
  assert.deepEqual([byId(f.input.requestId).status, byId(f.input.requestId).retiredBy?.kind, byId(f.input.requestId).identity], ['retired', 'discard', tree('f')]);
  assert.deepEqual([byId(h.input.requestId).status, byId(h.input.requestId).identity], ['active', tree('h')]);
  const linked = new Map(store.db.prepare('SELECT value FROM launches').all().map((row) => JSON.parse((row as { value: string }).value) as LaunchBatch).map((batch) => [batch.requestId, batch.items[0]!]));
  assert.deepEqual([linked.get(aLaunch.requestId)!.role, linked.get(aLaunch.requestId)!.workspaceId], ['workspace-agent', a.input.requestId]);
  assert.equal(linked.get(d1Launch.requestId)!.workspaceId, d1.input.requestId); assert.equal(linked.get(d2Launch.requestId)!.workspaceId, d2.input.requestId);
  assert.deepEqual([linked.get(base.requestId)!.role, linked.get(base.requestId)!.workspaceId], ['workspace-agent', null]);
  assert.equal([...linked.values()].filter((item) => item.worktree.root === tree('c').root)[0]!.workspaceId, null);
});

test('lifecycle facts update only a workspace record whose identity matches; retirement follows the path', () => {
  const workspace: ManagedWorkspace = { id: randomUUID(), projectId: PROJECT, worktreeId: worktreeId(tree('a')), path: tree('a').root, identity: tree('a'), branch: 'a', baseline: 'b'.repeat(40),
    expectedBranch: 'a', status: 'active', retiredBy: null, aligned: null, createdAt: at(1), updatedAt: at(1) };
  store.recordWorkspace(workspace);
  store.updateWorkspace(PROJECT, tree('a').root, { expectedBranch: 'other' }, tree('a', 'recreated-by-hand'));
  assert.equal(store.managedWorkspaces()[0]!.expectedBranch, 'a');
  store.updateWorkspace(PROJECT, tree('a').root, { expectedBranch: 'renamed' }, tree('a'));
  assert.equal(store.managedWorkspaces()[0]!.expectedBranch, 'renamed');
  store.updateWorkspace(PROJECT, tree('a').root, { status: 'retired', retiredBy: { kind: 'removal', requestId: null, at: at(2) } });
  assert.equal(store.managedWorkspaces()[0]!.status, 'retired');
  store.updateWorkspace(PROJECT, tree('a').root, { expectedBranch: 'after' }, tree('a')); // a retired record never changes again
  assert.equal(store.managedWorkspaces()[0]!.expectedBranch, 'renamed');
});

// Lifecycle on real Git: the catalog records and updates workspaces only from verified results.
let root: string; let config: Config; let catalog: ProjectCatalog;
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function live(path: string): Promise<Workspace> {
  return { cwd: realpathSync(path), socketPath: '/mock/socket', worktree: (await resolveWorktree(path))!, branch: git(path, 'branch', '--show-current') || null, agents: [], group: null, sharesIndexWith: [] };
}
function repository() {
  root = join(directory, 'repo'); mkdirSync(root);
  git(root, 'init', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'baseline\n'); git(root, 'add', 'app.txt'); git(root, 'commit', '-m', 'baseline');
  config = { ...loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: metadata(), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') }), worktreeDir: join(directory, 'tasks') };
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
}
async function created(branch: string) {
  const [project] = await catalog.discover([await live(root)], []);
  const request = { ...await catalog.preview({ projectId: project!.id, sourceWorktreeId: project!.worktrees.find((w) => w.path === root)!.id, branch }), confirm: true as const };
  assert.equal((await catalog.create(request)).status, 'ready');
  const tree = (await catalog.discover([], []))[0]!.worktrees.find((w) => w.path === request.path)!;
  return { request, target: { projectId: project!.id, worktreeId: tree.id }, tree };
}
const noGuard = async () => {}; const noArchive = async () => 0;
const record = (id: string) => store.managedWorkspaces().find((w) => w.id === id)!;

test('verified creation, rename, update, removal and discard maintain workspace records; a recreated path is a new incarnation', async () => {
  repository();
  const first = await created('feature/a');
  assert.deepEqual(record(first.request.requestId), { id: first.request.requestId, projectId: first.target.projectId, worktreeId: first.tree.id, path: first.request.path,
    identity: await resolveWorktree(first.request.path), branch: 'feature/a', baseline: first.request.sourceHead, expectedBranch: 'feature/a', status: 'active', retiredBy: null, aligned: null,
    createdAt: record(first.request.requestId).createdAt, updatedAt: record(first.request.requestId).createdAt } satisfies ManagedWorkspace);
  assert.deepEqual((await catalog.discover([], []))[0]!.workspaces, store.managedWorkspaces());
  const rename = await catalog.previewRename({ ...first.target, newBranch: 'feature/renamed' });
  assert.equal((await catalog.rename({ ...rename, confirm: true }, noGuard)).status, 'renamed');
  assert.equal(record(first.request.requestId).expectedBranch, 'feature/renamed'); assert.equal(record(first.request.requestId).branch, 'feature/a');
  writeFileSync(join(root, 'later.txt'), 'later\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'later'); const main = git(root, 'rev-parse', 'HEAD');
  const update = await catalog.previewUpdate(first.target);
  const updated = await catalog.update({ projectId: update.projectId, worktreeId: update.worktreeId, requestId: update.requestId, consent: update.consent, confirm: true }, noGuard, noArchive);
  assert.equal(updated.status, 'updated', updated.message);
  assert.deepEqual(record(first.request.requestId).aligned, { requestId: update.requestId, mode: 'update', commit: main, at: updated.updatedAt });
  const removal = await catalog.previewRemoval(first.target);
  const removed = await catalog.remove({ ...removal, confirm: true }, noGuard, noArchive); assert.equal(removed.status, 'removed', removed.message);
  assert.deepEqual([record(first.request.requestId).status, record(first.request.requestId).retiredBy], ['retired', { kind: 'removal', requestId: removal.requestId, at: removed.updatedAt }]);
  // The branch name feature/a is free again after the rename, so a new creation reuses the same directory: a different workspace.
  const second = await created('feature/a'); assert.equal(second.request.path, first.request.path);
  assert.equal(record(second.request.requestId).status, 'active'); assert.equal(record(first.request.requestId).status, 'retired');
  assert.equal(store.managedWorkspaces().length, 2);
  const discard = await catalog.previewDiscard(second.target);
  const discarded = await catalog.discard({ ...discard, confirmBranch: discard.branch, confirm: true }, noGuard, noArchive); assert.equal(discarded.status, 'discarded', discarded.message);
  assert.deepEqual(record(second.request.requestId).retiredBy, { kind: 'discard', requestId: discard.requestId, at: discarded.updatedAt });
});

test('reconciling an uncertain creation records its workspace only once the exact worktree is verified', async () => {
  repository();
  const [project] = await catalog.discover([await live(root)], []);
  const request = { ...await catalog.preview({ projectId: project!.id, sourceWorktreeId: project!.worktrees.find((w) => w.path === root)!.id, branch: 'feature/lost' }), confirm: true as const };
  catalog.remember(root); store.saveWorktreeCreation({ input: request, status: 'uncertain', updatedAt: new Date().toISOString(), message: 'lost response' });
  mkdirSync(request.path, { recursive: true }); // a partial result: neither verified success nor verified absence
  assert.equal((await catalog.reconcile(request.requestId)).status, 'uncertain'); assert.deepEqual(store.managedWorkspaces(), []);
  rmSync(request.path, { recursive: true }); git(root, 'worktree', 'add', '-b', request.branch, request.path, request.sourceHead);
  assert.equal((await catalog.reconcile(request.requestId)).status, 'ready');
  assert.deepEqual([record(request.requestId).status, record(request.requestId).identity], ['active', await resolveWorktree(request.path)]);
});

test('repository settings are explicit, revisioned metadata: any checkout of the repository on any branch, an existing local integration branch', async () => {
  repository();
  const added = await catalog.add({ path: root });
  assert.deepEqual(added.settings, { revision: 1, confirmation: 'pending', base: null, integrationBranch: null, launchDefaults: [], confirmedAt: null });
  const linked = join(directory, 'linked base'); git(root, 'worktree', 'add', '-b', 'other', linked);
  const refs = git(root, 'for-each-ref'); const before = [git(linked, 'rev-parse', 'HEAD'), git(linked, 'branch', '--show-current')];
  const input = { projectId: added.id, expectedRevision: 1, basePath: linked, integrationBranch: 'main', launchDefaults: [] };
  await assert.rejects(catalog.configure({ ...input, integrationBranch: 'missing' }), /not a local branch/);
  await assert.rejects(catalog.configure({ ...input, expected: { root: linked, commonDir: realpathSync(join(root, '.git')), branch: 'main' } }), /changed since you selected it/);
  const other = join(directory, 'other'); mkdirSync(other); git(other, 'init', '-b', 'main'); writeFileSync(join(other, 'x'), 'x'); git(other, 'add', 'x'); git(other, 'commit', '-m', 'x');
  await assert.rejects(catalog.configure({ ...input, basePath: other }), /checkout of this repository/);
  await assert.rejects(catalog.configure({ ...input, launchDefaults: [{ profileId: 'unknown', count: 1 }] }), /profile is missing or disabled/);
  await assert.rejects(catalog.configure({ ...input, launchDefaults: [{ profileId: 'a', count: 4 }, { profileId: 'b', count: 3 }] }), /at most six/);
  await assert.rejects(catalog.configure({ ...input, launchDefaults: [{ profileId: 'a', count: 1 }, { profileId: 'a', count: 1 }] }), /once/);
  store.db.prepare('INSERT INTO launch_profiles(id,value) VALUES (?,?)').run('profile-cc', JSON.stringify({ id: 'profile-cc', enabled: true }));
  const confirmed = await catalog.configure({ ...input, launchDefaults: [{ profileId: 'profile-cc', count: 2 }] });
  assert.deepEqual({ ...confirmed.settings, confirmedAt: null }, { revision: 2, confirmation: 'confirmed', base: { path: linked, identity: await resolveWorktree(linked) }, integrationBranch: 'main',
    launchDefaults: [{ profileId: 'profile-cc', count: 2 }], confirmedAt: null });
  await assert.rejects(catalog.configure(input), /changed meanwhile/);
  assert.deepEqual([git(linked, 'rev-parse', 'HEAD'), git(linked, 'branch', '--show-current'), git(root, 'for-each-ref')], [...before, refs]); // metadata only
  // A refreshed listing is read-only and keeps the saved choices; so does a restart.
  const changes = store.db.prepare('SELECT total_changes() AS count').get();
  assert.deepEqual((await catalog.discover([await live(root), await live(linked)], []))[0]!.settings, confirmed.settings);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), changes);
  store.close(); store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config);
  assert.deepEqual(store.projects()[0]!.settings, confirmed.settings);
  // A held repository and a read-only host refuse.
  store.saveWorktreeCreation({ ...creation('held', 1, 'uncertain'), input: { ...creation('held', 1).input, projectId: added.id } });
  await assert.rejects(catalog.configure({ ...input, expectedRevision: 2 }), /owns this repository/);
  config.inputEnabled = false; await assert.rejects(catalog.configure({ ...input, expectedRevision: 2 }), /disabled/);
});

test('a launch joins only the active recorded workspace of its checkout, and a change after preview refuses confirmation', async () => {
  const mock = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_ADAPTER: 'mock', ALTCLI_DATA_DIR: join(directory, 'mock'), ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  store.close(); store = new Store(mock.dataDir);
  const plane = new ControlPlane(new Controller(mock, store, new MockAdapter()));
  try {
    const project = await plane.projects.add({ path: '/demo/task' }); const tree = (await plane.projects.discover([], [])).find((p) => p.id === project.id)!.worktrees[0]!;
    const profile = (await plane.launches.profile({ label: 'CC', executable: 'claude', args: [], adapterHint: 'claude', enabled: true }))!;
    const input = { projectId: project.id, items: [{ worktreeId: tree.id, profileId: profile.id, count: 1 }] };
    assert.deepEqual((await plane.launches.preview(input)).items.map((i) => [i.role, i.workspaceId]), [['workspace-agent', null]]);
    const workspace: ManagedWorkspace = { id: randomUUID(), projectId: project.id, worktreeId: tree.id, path: tree.path, identity: tree.identity, branch: 'main', baseline: 'a'.repeat(40),
      expectedBranch: 'main', status: 'active', retiredBy: null, aligned: null, createdAt: at(1), updatedAt: at(1) };
    store.recordWorkspace(workspace);
    const preview = await plane.launches.preview(input); assert.equal(preview.items[0]!.workspaceId, workspace.id);
    const batch = await plane.launches.confirm({ requestId: preview.requestId, previewDigest: preview.digest, confirm: true });
    assert.deepEqual(batch.items.map((i) => [i.role, i.workspaceId]), [['workspace-agent', workspace.id]]);
    const later = await plane.launches.preview(input);
    store.updateWorkspace(project.id, tree.path, { status: 'retired', retiredBy: { kind: 'removal', requestId: null, at: at(2) } });
    await assert.rejects(plane.launches.confirm({ requestId: later.requestId, previewDigest: later.digest, confirm: true }), /recorded task workspace changed/);
    assert.equal(plane.launches.batches().length, 1);
  } finally { await plane.terminals.shutdown(); }
});
