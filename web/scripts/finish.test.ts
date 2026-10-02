import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectCatalog } from '../src/server/projects.ts';
import { Store } from '../src/server/store.ts';
import { InputAuthority } from '../src/server/input-authority.ts';
import { LaunchService } from '../src/server/launches.ts';
import { loadConfig, type Config } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { FinishCoordinator, type FinishDeps, type FinishHost, type TmuxPane } from '../src/server/finish.ts';
import type { FinishProcess, TaskFinish, WorktreeDiscard } from '../src/contracts/projects.ts';
import type { LaunchBatch, LaunchInstance } from '../src/contracts/launches.ts';
import type { WorktreeIdentity } from '../src/contracts/workflow.ts';

// Real Git and SQLite; tmux and the process table are a fixture host, so no real session is ever touched here.
// The private-tmux test in native-launch.test.ts covers the real host.
let directory: string, root: string, store: Store, catalog: ProjectCatalog, config: Config, launches: LaunchService, authority: InputAuthority;
let host: FakeHost, owner: ReturnType<FinishDeps['owner']>, finish: FinishCoordinator, removals: string[];
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SERVER = { serverPid: '4242', serverStarted: '1700000000', socketPath: '/tmp/altcli-finish-fixture' };
const proc = (pid: string, command: string, extra: Partial<FinishProcess> = {}): FinishProcess => ({ pid, command, started: `start-${pid}`, infrastructure: false, ...extra });

class FakeHost implements FinishHost {
  sessions = new Map<string, TmuxPane[]>();
  trees = new Map<string, { root: FinishProcess | null; processes: FinishProcess[] }>();
  live = new Map<string, string>(); // pid → start
  extra: { paneId: string; location: string; command: string; cwd: string }[] = [];
  killed: string[] = [];
  survive = new Set<string>();
  afterKill?: (sessionId: string) => void;
  absence: (sessionId: string) => boolean | null = (id) => !this.sessions.has(id);
  // Every read returns fresh objects, as tmux and ps do: later fixture changes must never alter what a preview captured.
  async sessionPanes(sessionId: string) { return structuredClone(this.sessions.get(sessionId) ?? null); }
  async clients() { return 1; }
  async allPanes() { return [...[...this.sessions.values()].flat().map((p) => ({ paneId: p.paneId, location: `${p.sessionName}:0.0`, command: p.command, cwd: p.cwd })), ...this.extra]; }
  async kill(sessionId: string) {
    this.killed.push(sessionId);
    for (const pane of this.sessions.get(sessionId) ?? []) for (const p of [this.trees.get(pane.panePid)?.root, ...this.trees.get(pane.panePid)?.processes ?? []]) if (p && !this.survive.has(p.pid)) this.live.delete(p.pid);
    this.sessions.delete(sessionId); this.afterKill?.(sessionId);
  }
  async absent(session: { sessionId: string }) { return this.absence(session.sessionId); }
  async processes(rootPid: string) { return structuredClone(this.trees.get(rootPid) ?? { root: null, processes: [] }); }
  async starts() { return new Map(this.live); }
  /** A launched session with one pane running `root` and `children`, in `cwd`, marked with `marker`. */
  add(sessionId: string, launchId: string, cwd: string, root: FinishProcess, children: FinishProcess[] = [], more: Partial<TmuxPane> = {}) {
    const n = this.sessions.size;
    const pane: TmuxPane = { sessionId, sessionName: `CX-task-${n}`, windowId: `@${n}`, paneId: `%${10 + n}`, panePid: root.pid, ...SERVER, command: root.command, cwd, dead: false, linked: false, marker: launchId, ...more };
    this.sessions.set(sessionId, [...this.sessions.get(sessionId) ?? [], pane]);
    this.trees.set(root.pid, { root, processes: [root, ...children] });
    for (const p of [root, ...children]) this.live.set(p.pid, p.started!);
    return pane;
  }
}
function recordLaunch(worktree: WorktreeIdentity, pane: TmuxPane, id = pane.marker): LaunchInstance {
  const item = { id, projectId: 'p', worktreeId: 'w', worktree, commonDir: `${root}/.git`, branch: 'feature/finished', head: 'a'.repeat(40),
    profile: { id: 'profile', revision: 1, label: 'CX', executable: 'codex', args: [], adapterHint: 'codex', enabled: true }, executable: '/usr/bin/codex', sessionName: pane.sessionName,
    environmentDigest: 'x', status: 'running', phase: 'observed', message: 'fixture', identity: { paneId: pane.paneId, panePid: pane.panePid, ...SERVER },
    sessionId: pane.sessionId, windowId: pane.windowId, placeholder: null, updatedAt: new Date().toISOString() } satisfies LaunchInstance;
  const batch: LaunchBatch = { requestId: randomUUID(), previewDigest: 'x', items: [item], createdAt: new Date().toISOString() };
  store.db.prepare('INSERT INTO launches(id,value) VALUES(?,?)').run(batch.requestId, JSON.stringify(batch));
  return item;
}
function coordinator(overrides: Partial<FinishDeps> = {}) {
  return new FinishCoordinator({ config, store, projects: catalog, launches, authority, host, owner: () => owner, delivery: () => false,
    agents: async () => [], closeTerminals: async () => {}, wait: async () => {},
    remove: async (input, parent) => { removals.push(input.requestId); return catalog.remove(input, async () => { if (owner) throw new Error('A run owns this worktree.'); }, async () => 0, parent); },
    discard: async (input, parent) => catalog.discard(input, async () => { if (owner) throw new Error('A run owns this worktree.'); }, async () => 0, parent),
    reconcileChild: async (kind, id) => kind === 'removal' ? catalog.reconcileRemoval(id) : catalog.reconcileDiscard(id), ...overrides });
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-finish-'))); root = join(directory, 'repo'); mkdirSync(root);
  git(root, 'init', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'baseline\n'); git(root, 'add', 'app.txt'); git(root, 'commit', '-m', 'baseline');
  config = { ...loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(directory, 'metadata'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), CODEX_HOME: join(directory, 'codex') }), worktreeDir: join(directory, 'tasks') };
  store = new Store(config.dataDir); catalog = new ProjectCatalog(store, config); authority = new InputAuthority(store);
  launches = new LaunchService(config, store, catalog, authority, () => {}, async () => new Set());
  host = new FakeHost(); owner = null; removals = []; finish = coordinator();
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
/** A linked task worktree with two commits, one launched session in it (a CLI running `npm test`), and its project IDs. */
async function fixture(children: FinishProcess[] = [proc('101', 'npm')]) {
  const [project0] = await catalog.discover([{ cwd: root, socketPath: SERVER.socketPath, worktree: (await resolveWorktree(root))!, branch: 'main', agents: [], group: null, sharesIndexWith: [] }], []);
  const preview = await catalog.preview({ projectId: project0!.id, sourceWorktreeId: project0!.worktrees[0]!.id, branch: 'feature/finished' });
  await catalog.create({ ...preview, confirm: true });
  writeFileSync(join(preview.path, 'app.txt'), 'one\n'); git(preview.path, 'commit', '-am', 'first');
  writeFileSync(join(preview.path, 'app.txt'), 'two\n'); git(preview.path, 'commit', '-am', 'second');
  const project = (await catalog.discover([], []))[0]!; const tree = project.worktrees.find((w) => w.path === preview.path)!;
  const pane = host.add('$3', randomUUID(), preview.path, proc('100', 'codex'), children);
  const item = recordLaunch(tree.identity!, pane);
  return { path: preview.path, tree, item, pane, target: { projectId: project.id, worktreeId: tree.id }, mainId: project.worktrees.find((w) => w.main)!.id };
}
const confirmOf = (preview: { requestId: string; digest: string }, outcome: 'close' | 'remove' | 'discard', stopActive = true) => ({ requestId: preview.requestId, digest: preview.digest, outcome, stopActive, confirm: true as const });

test('the preview offers only provable app sessions and reports Git facts without treating different tips as unmerged', async () => {
  const { path, target, mainId } = await fixture();
  // Same worktree but a foreign marker, a pane elsewhere, a window shared with another session, and a pane the user opened.
  const foreign = host.add('$7', randomUUID(), path, proc('200', 'codex'), [], { marker: 'someone-else' }); recordLaunch((await resolveWorktree(path))!, foreign, randomUUID());
  const elsewhere = host.add('$8', randomUUID(), directory, proc('300', 'codex')); recordLaunch((await resolveWorktree(path))!, elsewhere);
  const shared = host.add('$9', randomUUID(), path, proc('400', 'codex'), [], { linked: true }); recordLaunch((await resolveWorktree(path))!, shared);
  host.extra.push({ paneId: '%99', location: 'mine:0.0', command: 'zsh', cwd: join(path, 'sub') });
  const preview = await finish.preview(target);
  assert.deepEqual(preview.sessions.map((s) => [s.sessionId, s.closable]), [['$3', true], ['$7', false], ['$8', false], ['$9', false]]);
  assert.match(preview.sessions[1]!.reason!, /marker changed/); assert.match(preview.sessions[2]!.reason!, /another directory/); assert.match(preview.sessions[3]!.reason!, /shared with another session/);
  assert.deepEqual(preview.others, [{ paneId: '%99', location: 'mine:0.0', command: 'zsh' }]);
  assert.equal(preview.active, true, 'a task process beyond the CLI needs acknowledgement');
  assert.deepEqual(preview.blockers, []); assert.equal(preview.run, null);
  assert.deepEqual({ integration: preview.git.integration, ahead: preview.git.ahead, behind: preview.git.behind, dirty: preview.git.dirty }, { integration: 'not_proven', ahead: 2, behind: 0, dirty: false });
  // A squash merge leaves the tips different, yet integration is proven by the exact patch.
  git(root, 'merge', '--squash', 'feature/finished'); git(root, 'commit', '-m', 'squash');
  const squashed = await finish.preview(target);
  assert.deepEqual({ integration: squashed.git.integration, by: squashed.git.integratedBy, ahead: squashed.git.ahead, behind: squashed.git.behind }, { integration: 'integrated', by: 'squash', ahead: 2, behind: 1 });
  await assert.rejects(finish.preview({ ...target, worktreeId: mainId }), /linked worktree on a task branch/);
  assert.equal(host.killed.length, 0, 'previewing never closes anything');
});
test('confirmation requires the acknowledgement and the unchanged evidence; a change stops before any kill and releases ownership', async () => {
  const { target } = await fixture();
  const preview = await finish.preview(target);
  await assert.rejects(finish.confirm(confirmOf(preview, 'close', false)), /stopping them anyway/);
  await assert.rejects(finish.confirm({ ...confirmOf(preview, 'close'), digest: 'f'.repeat(64) }), /Preview again/);
  await assert.rejects(finish.confirm(confirmOf(preview, 'remove')), /proven integration/);
  host.trees.get('100')!.processes.push(proc('102', 'node')); host.live.set('102', 'start-102');
  const changed = await finish.confirm(confirmOf(preview, 'close'));
  assert.equal(changed.status, 'failed'); assert.match(changed.message, /changed since the preview/); assert.deepEqual(host.killed, []);
  assert.equal(catalog.projectHeld(target.projectId), false, 'a verified no-effect failure releases the owner');
});
test('close stops only the consented session by ID, retires its launch and releases ownership; duplicates return the record', async () => {
  const { target, item, path } = await fixture();
  const foreign = host.add('$7', randomUUID(), path, proc('200', 'codex'), [], { marker: 'someone-else' }); recordLaunch((await resolveWorktree(path))!, foreign, randomUUID());
  const preview = await finish.preview(target);
  const done = await finish.confirm(confirmOf(preview, 'close'));
  assert.equal(done.status, 'done', done.message); assert.deepEqual(host.killed, ['$3'], 'never the session whose marker does not match');
  assert.deepEqual(done.sessions.map((s) => [s.sessionId, s.status, s.evidence]), [['$3', 'closed', 'clear']]);
  assert.deepEqual(done.sessions[0]!.retained.map((p) => p.pid).sort(), ['100', '101']);
  assert.ok(launches.batches().flatMap((b) => b.items).find((i) => i.id === item.id)!.closed);
  await assert.rejects(launches.target(item.id), /closed by Finish branch/);
  assert.equal(catalog.projectHeld(target.projectId), false); assert.doesNotThrow(() => catalog.assertWorktreeReady(path));
  assert.deepEqual(await finish.confirm(confirmOf(preview, 'close')), done);
  await assert.rejects(finish.confirm(confirmOf(preview, 'discard')), /different request/);
  assert.deepEqual(host.killed, ['$3'], 'a duplicate never kills again');
});
test('survivors keep the owner and block the Git step until inspection clears them or a recorded decision settles them', async () => {
  const { target, path } = await fixture();
  git(root, 'merge', '--ff-only', 'feature/finished');
  host.survive.add('101');
  const preview = await finish.preview(target);
  const held = await finish.confirm(confirmOf(preview, 'remove'));
  assert.equal(held.status, 'attention'); assert.match(held.message, /npm 101/); assert.deepEqual(held.sessions[0]!.survivors.map((p) => p.pid), ['101']);
  assert.throws(() => catalog.assertWorktreeReady(path), /Finish branch owns this worktree/); assert.equal(catalog.projectHeld(target.projectId), true);
  const removal = { ...await catalog.previewRemoval(target), confirm: true as const };
  await assert.rejects(finish.continue({ requestId: held.requestId, revision: held.revision, removal }), /not waiting for its Git step/);
  // A reused PID with another start time is not the survivor.
  const still = await finish.reconcile({ requestId: held.requestId, revision: held.revision, action: 'inspect' });
  assert.equal(still.status, 'attention');
  host.live.set('101', 'a-new-process'); const cleared = await finish.reconcile({ requestId: still.requestId, revision: still.revision, action: 'inspect' });
  assert.equal(cleared.status, 'awaiting_git', cleared.message);
  await assert.rejects(finish.reconcile({ requestId: still.requestId, revision: still.revision, action: 'inspect' }), /changed meanwhile/);
  // The recorded-decision path: survivors remain, and the user's inspection note settles the session step without claiming success.
  host.live.set('101', 'start-101');
  const second = await coordinatorWith(target, path);
  const decided = await finish.reconcile({ requestId: second.requestId, revision: second.revision, action: 'decide', note: 'Stopped npm by hand after checking it was only a watcher.' });
  assert.equal(decided.status, 'done'); assert.match(decided.message, /recorded inspection/); assert.equal(decided.decision?.note.startsWith('Stopped npm'), true);
});
/** A second finish on a fresh session in the same worktree, left in attention by a surviving process. */
async function coordinatorWith(target: { projectId: string; worktreeId: string }, path: string): Promise<TaskFinish> {
  const first = store.taskFinishes()[0]!;
  await finish.reconcile({ requestId: first.requestId, revision: first.revision, action: 'abandon' });
  const pane = host.add('$5', randomUUID(), path, proc('500', 'codex'), [proc('501', 'watcher')]); recordLaunch((await resolveWorktree(path))!, pane);
  host.survive.add('501');
  const preview = await finish.preview(target);
  const op = await finish.confirm(confirmOf(preview, 'close'));
  assert.equal(op.status, 'attention'); return op;
}
test('hard refusals: a running or waiting run, an uncertain delivery, manual input and another project owner', async () => {
  const { target, path } = await fixture();
  owner = { id: 'run-1', status: 'running', execution: 'delivered' };
  const running = await finish.preview(target);
  assert.match(running.blockers.join(' '), /Pause it in Console first/);
  await assert.rejects(finish.confirm(confirmOf(running, 'close')), /Pause it in Console first/);
  owner = { id: 'run-1', status: 'paused', execution: 'dispatching' };
  assert.match((await finish.preview(target)).blockers.join(' '), /being sent or is uncertain/);
  owner = null;
  store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES (?,?)').run('manual', JSON.stringify({ id: 'manual', revision: 1, live: false, reconciliationRequired: true }));
  assert.match((await finish.preview(target)).blockers.join(' '), /Manual terminal input/);
  store.db.prepare('UPDATE keyboard_sessions SET value=? WHERE id=?').run(JSON.stringify({id:'manual',revision:1,live:false,reconciliationRequired:true,scope:{root:'/other',gitDir:'/other/.git',indexPath:'/other/.git/index'}}),'manual');
  assert.ok(!(await finish.preview(target)).blockers.some(b=>b.includes('Manual terminal input')));
  const other = await finish.preview(target); const first = await finish.confirm(confirmOf(other, 'discard'));
  assert.equal(first.status, 'awaiting_git');
  assert.equal(authority.pending().length,1); // This unrelated period survives the close.
  const pane = host.add('$6', randomUUID(), path, proc('600', 'codex')); recordLaunch((await resolveWorktree(path))!, pane);
  assert.match((await finish.preview(target)).blockers.join(' '), /owns this project/);
  assert.deepEqual(host.killed, ['$3']);
});
test('a paused run keeps ownership: sessions close, the Git step waits for takeover, and the child removal is the only admitted one', async () => {
  const { target, path } = await fixture();
  git(root, 'merge', '--ff-only', 'feature/finished');
  owner = { id: 'run-1', status: 'paused', execution: 'delivered' };
  const preview = await finish.preview(target);
  const closed = await finish.confirm(confirmOf(preview, 'remove'));
  assert.equal(closed.status, 'awaiting_git'); assert.match(closed.message, /paused run still owns this worktree/);
  const removal = { ...await catalog.previewRemoval(target), confirm: true as const };
  // Public removal stays refused while Finish owns the project; the finish's own child is refused by the run owner, harmlessly.
  await assert.rejects(catalog.remove(removal, async () => {}, async () => 0), /owns this project/);
  const refused = await finish.continue({ requestId: closed.requestId, revision: closed.revision, removal });
  assert.equal(refused.status, 'awaiting_git'); assert.match(refused.message, /A run owns this worktree/); assert.ok(existsSync(path));
  owner = null; // the user took the run over after checking its writers stopped
  const again = { ...await catalog.previewRemoval(target), confirm: true as const };
  const finished = await finish.continue({ requestId: refused.requestId, revision: refused.revision, removal: again });
  assert.equal(finished.status, 'done', finished.message); assert.ok(!existsSync(path)); assert.equal(git(root, 'branch', '--list', 'feature/finished').length > 0, true, 'removal keeps the branch');
  assert.deepEqual(finished.child, { kind: 'removal', requestId: again.requestId }); assert.deepEqual(removals, [removal.requestId, again.requestId]);
  await assert.rejects(finish.continue({ requestId: finished.requestId, revision: refused.revision, removal: again }), /not waiting for its Git step/);
  assert.equal(catalog.projectHeld(target.projectId), false);
});
test('an uncertain child keeps the parent owner and is inspected by its stored ID, never reissued; stopping early keeps the worktree', async () => {
  const { target, path } = await fixture();
  let reconciled = 0; const calls: string[] = [];
  finish = coordinator({
    discard: async (input) => { calls.push(input.requestId); const child = { input, status: 'uncertain', message: 'Discard or its verification is uncertain.', updatedAt: new Date().toISOString() } as WorktreeDiscard;
      store.saveWorktreeDiscard(child); return child; },
    reconcileChild: async (kind, id) => { reconciled++; assert.equal(kind, 'discard'); assert.equal(id, calls[0]);
      const child: WorktreeDiscard = { ...store.worktreeDiscards()[0]!, ...(reconciled < 2 ? { status: 'uncertain', message: 'Still present.' } : { status: 'discarded', message: 'Discard verified.' }) };
      store.saveWorktreeDiscard(child); return child; },
  });
  const preview = await finish.preview(target);
  const closed = await finish.confirm(confirmOf(preview, 'discard'));
  const discard = { ...await catalog.previewDiscard(target), confirmBranch: 'feature/finished', confirm: true as const };
  const uncertain = await finish.continue({ requestId: closed.requestId, revision: closed.revision, discard });
  assert.equal(uncertain.status, 'git_uncertain'); assert.equal(finish.holding()[0]!.requestId, closed.requestId);
  assert.throws(() => catalog.assertWorktreeReady(path), /worktree discard is applying or uncertain/);
  const still = await finish.reconcile({ requestId: uncertain.requestId, revision: uncertain.revision, action: 'inspect' });
  assert.equal(still.status, 'git_uncertain');
  const done = await finish.reconcile({ requestId: still.requestId, revision: still.revision, action: 'inspect' });
  assert.equal(done.status, 'done'); assert.deepEqual(calls, [discard.requestId], 'the child is never reissued');
  // Another finish that stops before its Git step keeps everything.
  const pane = host.add('$4', randomUUID(), path, proc('700', 'codex')); recordLaunch((await resolveWorktree(path))!, pane);
  finish = coordinator(); const next = await finish.confirm(confirmOf(await finish.preview(target), 'discard'));
  const stopped = await finish.reconcile({ requestId: next.requestId, revision: next.revision, action: 'abandon' });
  assert.equal(stopped.status, 'done'); assert.match(stopped.message, /worktree and branch are kept/); assert.ok(existsSync(path));
});
test('a session that changes between kills stops further mutation; restart makes in-flight steps uncertain and inspection never kills again', async () => {
  const { target, path } = await fixture([]);
  const second = host.add('$4', randomUUID(), path, proc('800', 'codex')); recordLaunch((await resolveWorktree(path))!, second);
  host.afterKill = (id) => { if (id === '$3') { host.trees.get('800')!.processes.push(proc('801', 'make')); host.live.set('801', 'start-801'); } };
  const preview = await finish.preview(target);
  assert.equal(preview.active, false);
  const partial = await finish.confirm(confirmOf(preview, 'close'));
  assert.equal(partial.status, 'attention'); assert.deepEqual(host.killed, ['$3']);
  assert.deepEqual(partial.sessions.map((s) => [s.sessionId, s.status]), [['$3', 'closed'], ['$4', 'skipped']]);
  // A restart while a kill may have run: the step becomes uncertain and inspection settles it from absence alone.
  store.saveTaskFinish({ ...partial, requestId: randomUUID(), status: 'applying', revision: 1, sessions: [{ ...partial.sessions[1]!, status: 'attempted', retained: [proc('800', 'codex')] }], preview: { ...partial.preview, projectId: 'other-project' } }, 0);
  finish = coordinator();
  const restarted = store.taskFinishes().find((op) => op.preview.projectId === 'other-project')!;
  assert.equal(restarted.status, 'uncertain'); assert.equal(finish.busy(), true);
  host.absence = () => null;
  const unknown = await finish.reconcile({ requestId: restarted.requestId, revision: restarted.revision, action: 'inspect' });
  assert.equal(unknown.status, 'uncertain');
  host.absence = () => true; host.live.delete('800');
  const settled = await finish.reconcile({ requestId: unknown.requestId, revision: unknown.revision, action: 'inspect' });
  assert.equal(settled.status, 'done', settled.message); assert.deepEqual(host.killed, ['$3'], 'inspection never repeats a kill');
});
test('a reused session name is never adopted: the recorded ID is gone, and the new same-named session is only occupancy', async () => {
  const { target, pane, path } = await fixture([]);
  host.sessions.delete('$3');
  host.add('$12', 'not-a-launch', path, proc('900', 'zsh'), [], { sessionName: pane.sessionName, marker: '' });
  const preview = await finish.preview(target);
  assert.deepEqual(preview.sessions, []); assert.deepEqual(preview.others.map((o) => o.command), ['zsh']);
  const op = await finish.confirm(confirmOf(preview, 'close'));
  assert.equal(op.status, 'done'); assert.deepEqual(host.killed, []);
});
test('an unexpected error before any kill settles as a no-effect failure instead of staying in progress', async () => {
  const { target } = await fixture();
  finish = coordinator({ closeTerminals: async () => { throw new Error('Terminal broker unavailable.'); } });
  const op = await finish.confirm(confirmOf(await finish.preview(target), 'close'));
  assert.equal(op.status, 'failed'); assert.match(op.message, /Terminal broker unavailable\. Nothing was closed/);
  assert.deepEqual(host.killed, []); assert.equal(catalog.projectHeld(target.projectId), false);
});

test('missing process evidence never makes a live session safe to close', async () => {
  const { target } = await fixture([]);
  for (const read of [
    async () => { throw new Error('ps unavailable'); },
    async () => ({ root: null, processes: [] }),
    async () => ({ root: proc('100', 'codex', { started: null }), processes: [] }),
    async () => ({ root: proc('100', 'codex'), processes: [proc('101', 'helper', { started: null, infrastructure: true })] }),
  ]) {
    host.processes = read;
    const preview = await finish.preview(target);
    assert.equal(preview.sessions[0]!.closable, false);
    assert.match(preview.sessions[0]!.reason!, /process evidence/i);
    await finish.confirm(confirmOf(preview, 'close'));
    assert.deepEqual(host.killed, []);
  }
});
test('closing an exited pane cannot certify that its former background processes stopped', async () => {
  const { target } = await fixture();
  host.sessions.get('$3')![0]!.dead = true;
  host.trees.delete('100'); // The exited root no longer connects ps evidence to the still-live child.
  const preview = await finish.preview(target);
  const closed = await finish.confirm(confirmOf(preview, 'discard'));
  assert.equal(closed.status, 'attention'); assert.equal(closed.sessions[0]!.evidence, 'unknown');
  assert.equal(preview.active, true);
  assert.ok(host.live.has('101')); assert.equal(store.worktreeDiscards().length, 0);
  const inspected = await finish.reconcile({ requestId: closed.requestId, revision: closed.revision, action: 'inspect' });
  assert.equal(inspected.status, 'attention'); assert.equal(inspected.sessions[0]!.evidence, 'unknown');
  assert.equal(catalog.projectHeld(target.projectId), true);
});
test('a branch change after preview refuses the session stop, but task commits and dirty files do not', async () => {
  const { target, path } = await fixture([]);
  const preview = await finish.preview(target);
  git(path, 'switch', '-c', 'feature/other');
  const refused = await finish.confirm(confirmOf(preview, 'close', false));
  assert.equal(refused.status, 'failed'); assert.deepEqual(host.killed, []);
  git(path, 'switch', 'feature/finished');
  const again = await finish.preview(target);
  writeFileSync(join(path, 'app.txt'), 'new commit\n'); git(path, 'commit', '-am', 'task progress');
  writeFileSync(join(path, 'app.txt'), 'unfinished task progress\n');
  assert.equal((await finish.confirm(confirmOf(again, 'close', false))).status, 'done');
  assert.deepEqual(host.killed, ['$3']);
});
test('a branch change between session kills leaves the remaining sessions open', async () => {
  const { target, path } = await fixture([]);
  const second = host.add('$4', randomUUID(), path, proc('800', 'codex')); recordLaunch((await resolveWorktree(path))!, second);
  host.afterKill = () => { git(path, 'switch', '-c', 'feature/other'); };
  const partial = await finish.confirm(confirmOf(await finish.preview(target), 'close', false));
  assert.equal(partial.status, 'attention'); assert.deepEqual(host.killed, ['$3']);
  assert.equal(partial.sessions[1]!.status, 'skipped');
});
test('activity is inspected again before each kill and an inspection error stops further kills', async () => {
  const { target, path } = await fixture([]);
  const second = host.add('$4', randomUUID(), path, proc('800', 'codex')); recordLaunch((await resolveWorktree(path))!, second);
  let state: 'idle' | 'working' = 'idle';
  finish = coordinator({ agents: async () => [{ paneId: second.paneId, socketPath: SERVER.socketPath, label: 'Second', state }] });
  host.afterKill = () => { state = 'working'; };
  const partial = await finish.confirm(confirmOf(await finish.preview(target), 'close', false));
  assert.equal(partial.status, 'attention'); assert.deepEqual(host.killed, ['$3']);
  assert.equal(partial.sessions[1]!.status, 'skipped');
  await finish.reconcile({ requestId: partial.requestId, revision: partial.revision, action: 'decide', note: 'Left the second session running.' });
  // Lose activity inspection after the digest check, immediately before the kill.
  let unavailable = false;
  finish = coordinator({ agents: async () => { if (unavailable) throw new Error('activity unavailable'); return []; }, closeTerminals: async () => { unavailable = true; } });
  const refused = await finish.confirm(confirmOf(await finish.preview(target), 'close', false));
  assert.equal(refused.status, 'failed'); assert.deepEqual(host.killed, ['$3']);
});
test('a thrown child response keeps its durable identity and is inspected without repeating deletion', async () => {
  const { target, path } = await fixture([]);
  finish = coordinator({ discard: async (input, parent) => {
    await catalog.discard(input, async () => {}, async () => 0, parent);
    throw new Error('Child response unavailable');
  } });
  const closed = await finish.confirm(confirmOf(await finish.preview(target), 'discard'));
  const discard = { ...await catalog.previewDiscard(target), confirmBranch: 'feature/finished', confirm: true as const };
  const uncertain = await finish.continue({ requestId: closed.requestId, revision: closed.revision, discard });
  assert.ok(!existsSync(path)); assert.equal(uncertain.status, 'git_uncertain');
  assert.deepEqual(uncertain.child, { kind: 'discard', requestId: discard.requestId });
  assert.doesNotMatch(uncertain.message, /Nothing was removed/);
  const done = await finish.reconcile({ requestId: uncertain.requestId, revision: uncertain.revision, action: 'inspect' });
  assert.equal(done.status, 'done'); assert.equal(store.worktreeDiscards().length, 1);
});
test('restart before a child was recorded releases only the Git step for a fresh confirmation', async () => {
  const { target, path } = await fixture([]);
  const closed = await finish.confirm(confirmOf(await finish.preview(target), 'discard'));
  store.saveTaskFinish({ ...closed, status: 'git_applying', step: 'git', child: { kind: 'discard', requestId: randomUUID() }, revision: closed.revision + 1 }, closed.revision);
  finish = coordinator();
  const restarted = store.taskFinishes()[0]!;
  assert.equal(restarted.status, 'git_uncertain');
  const inspected = await finish.reconcile({ requestId: restarted.requestId, revision: restarted.revision, action: 'inspect' });
  assert.equal(inspected.status, 'awaiting_git'); assert.equal(inspected.child, null);
  assert.ok(existsSync(path)); assert.equal(store.worktreeDiscards().length, 0);
  assert.equal(catalog.projectHeld(target.projectId), true);
});
