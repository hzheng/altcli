import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchBatch, LaunchInstance } from '../src/contracts/launches.ts';
import type { TmuxPane } from '../src/server/finish.ts';
import { Store } from '../src/server/store.ts';
import { InputAuthority } from '../src/server/input-authority.ts';
import { ProjectCatalog } from '../src/server/projects.ts';
import { LaunchService } from '../src/server/launches.ts';
import { loadConfig } from '../src/server/config.ts';

// Real SQLite, a fixture tmux host. Native launch tests separately exercise private tmux sockets.
let directory: string, store: Store, authority: InputAuthority, service: LaunchService, item: LaunchInstance;
let panes: TmuxPane[] | null, killed: string[], absent: boolean | null, guard: () => void;
let afterKill: () => void;
const config = () => loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: directory, ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
const host = { sessionPanes: async () => structuredClone(panes), absent: async () => absent,
  kill: async (item: LaunchInstance) => { killed.push(item.sessionId!); afterKill(); } };
const make = () => new LaunchService(config(), store, new ProjectCatalog(store, config()), authority, () => guard(), async () => new Set(), host);
const read = () => service.batches()[0]!.items[0]!;
const confirm = async () => { const p = await service.previewCleanup(item.id); return { requestId: p.requestId, digest: p.digest, confirmInspected: true }; };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'altcli-cleanup-')); store = new Store(directory); authority = new InputAuthority(store);
  killed = []; absent = false; guard = () => {}; afterKill = () => { panes = null; absent = true; };
  const identity = { paneId: '%9', panePid: '211', serverPid: '12', serverStarted: '123', socketPath: '/tmp/fixture' };
  item = { id: randomUUID(), projectId: 'p', worktreeId: 'w', worktree: { root: '/task', gitDir: '/git/worktrees/task', indexPath: '/git/worktrees/task/index' }, commonDir: '/git', branch: 'task', head: 'a'.repeat(40),
    profile: { id: randomUUID(), revision: 1, label: 'CC', executable: 'claude', args: [], adapterHint: 'claude', enabled: true }, executable: '/bin/claude', sessionName: 'CC-task', environmentDigest: 'x',
    status: 'running', phase: 'observed', message: 'Last observed running.', identity, placeholder: null, sessionId: '$9', windowId: '@9', updatedAt: '2026-09-26T00:00:00Z' };
  panes = [{ ...identity, sessionId: '$9', windowId: '@9', sessionName: 'CC-task', marker: item.id, command: 'exited', cwd: '', dead: true, linked: false }];
  const batch: LaunchBatch = { requestId: randomUUID(), previewDigest: 'x', items: [item], createdAt: item.updatedAt };
  store.db.prepare('INSERT INTO launches(id,value) VALUES(?,?)').run(batch.requestId, JSON.stringify(batch)); service = make();
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

test('confirmed dead-session cleanup retains history, releases its reservation and never repeats a kill', async () => {
  const input = await confirm();
  await assert.rejects(service.confirmCleanup(item.id, { ...input, confirmInspected: false }), /Confirm/);
  assert.deepEqual(killed, []);
  const result = await service.confirmCleanup(item.id, input);
  assert.equal(result.cleanup?.status, 'done'); assert.ok(result.closed); assert.deepEqual(killed, ['$9']);
  assert.equal(store.db.prepare('SELECT 1 FROM launch_reservations').get(), undefined);
  assert.deepEqual(await service.confirmCleanup(item.id, input), result); assert.deepEqual(killed, ['$9']);
  await assert.rejects(service.target(item.id), /closed/);
});
test('a missing, already reconciled launch can be cleaned without touching a reused session name', async () => {
  await service.reconcile(item.id, { requestId: randomUUID(), confirmInspected: true, note: 'killed' });
  panes = null; absent = true;
  const p = await service.previewCleanup(item.id); assert.equal(p.state, 'missing');
  const result = await service.confirmCleanup(item.id, { requestId: p.requestId, digest: p.digest, confirmInspected: true });
  assert.ok(result.closed); assert.equal(result.humanDecision?.note, 'killed'); assert.deepEqual(killed, []);
});
for (const change of ['live', 'marker', 'server', 'shared', 'extra pane'] as const) test(`cleanup refuses ${change} evidence`, async () => {
  if (change === 'live') panes![0]!.dead = false;
  if (change === 'marker') panes![0]!.marker = randomUUID();
  if (change === 'server') panes![0]!.serverStarted = '456';
  if (change === 'shared') panes![0]!.linked = true;
  if (change === 'extra pane') panes!.push({ ...panes![0]!, paneId: '%10' });
  const p = await service.previewCleanup(item.id); assert.ok(p.blockers.length);
  await assert.rejects(service.confirmCleanup(item.id, { requestId: p.requestId, digest: p.digest, confirmInspected: true }));
  assert.deepEqual(killed, []); assert.equal(read().closed, undefined);
});
test('a pane revived after preview is not killed or archived', async () => {
  const input = await confirm(); panes![0]!.dead = false;
  await assert.rejects(service.confirmCleanup(item.id, input), /changed|running/i);
  assert.deepEqual(killed, []); assert.equal(read().closed, undefined);
});
test('unavailable absence evidence cannot clean a missing launch', async () => {
  panes = null; absent = null;
  assert.ok((await service.previewCleanup(item.id)).blockers.length); assert.equal(read().closed, undefined);
});
test('a lost kill result retains ownership across restart; inspection never retries', async () => {
  afterKill = () => { absent = null; throw Error('lost result'); };
  const input = await confirm(), result = await service.confirmCleanup(item.id, input);
  assert.equal(result.cleanup?.status, 'uncertain'); assert.ok(store.db.prepare('SELECT 1 FROM launch_reservations').get());
  store.close(); store = new Store(directory); authority = new InputAuthority(store); service = make();
  await service.inspect(item.id); assert.deepEqual(killed, ['$9']);
  await assert.rejects(service.reconcile(item.id, { requestId: randomUUID(), confirmInspected: true, note: 'ignore' }), /cleanup/i);
  panes = null; absent = true;
  assert.ok((await service.inspect(item.id)).closed); assert.deepEqual(killed, ['$9']);
  assert.equal(store.db.prepare('SELECT 1 FROM launch_reservations').get(), undefined);
});
test('a run owner and a keyboard record involving this pane block cleanup', async () => {
  guard = () => { throw Error('A run owns this checkout.'); };
  assert.match((await service.previewCleanup(item.id)).blockers.join(' '), /run owns/); guard = () => {};
  store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES(?,?)').run('keyboard', JSON.stringify({ id: 'keyboard', live: true, target: {launchId:item.id}, panes: [{ identity: item.identity }] }));
  assert.match((await service.previewCleanup(item.id)).blockers.join(' '), /keyboard|manual/i);
  assert.deepEqual(killed, []);
});
test('another keyboard can stay active: its inventory and reconciliation barrier are preserved', async () => {
  const manual = { id: 'other', live: true, reconciliationRequired: true, target: {launchId:randomUUID()}, panes: [{identity:item.identity}] };
  store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES(?,?)').run(manual.id, JSON.stringify(manual));
  assert.ok((await service.confirmCleanup(item.id, await confirm())).closed);
  assert.deepEqual(authority.pending(), [manual]);
});
test('concurrent confirmation claims the launch only once', async () => {
  const input = await confirm();
  await Promise.all([service.confirmCleanup(item.id,input),service.confirmCleanup(item.id,input)]);
  assert.deepEqual(killed, ['$9']); assert.ok(read().closed);
});
test('input being disabled after preview refuses cleanup without claiming it', async () => {
  const input = await confirm(); service.config.inputEnabled = false;
  await assert.rejects(service.confirmCleanup(item.id,input));
  assert.equal(read().cleanup, undefined); assert.deepEqual(killed, []);
});
test('a second launch reservation is preserved and blocks cleanup', async () => {
  store.db.prepare('INSERT INTO launch_reservations(index_path,launch_id) VALUES(?,?)').run(item.worktree.indexPath,'other');
  assert.match((await service.previewCleanup(item.id)).blockers.join(' '),/Another launch/);
  assert.equal((store.db.prepare('SELECT launch_id FROM launch_reservations').get() as {launch_id:string}).launch_id,'other');
});
