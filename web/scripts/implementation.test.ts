import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { assertWorktreeInput, branchState, taskBaseline } from '../src/server/commit-handoff.ts';
import { parseGroup, parseImplementation, parseStandalone, parseReviewPreview } from '../src/core/implementation-validation.ts';
import { parseActivityReset, parseHook } from '../src/core/workflow-validation.ts';
import { assertIdentity } from '../src/core/policy.ts';
import type { SessionRegistration } from '../src/contracts/api.ts';
import { codexCompletion, codexStartState } from '../../hooks/protocol.mjs';
import type { Group, HandoffEntry, ImplementationStart } from '../src/contracts/implementation.ts';
import type { HookEvent, ManagedSession } from '../src/contracts/workflow.ts';

// Real Git and SQLite in disposable directories; terminal delivery and lifecycle evidence are simulated.
let directory: string; let root: string; let store: Store; let adapter: MockAdapter; let plane: ControlPlane;
let group: Group; let sent: string[];
const config = () => loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: join(directory, 'metadata') });
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codercrew-implementation-'))); root = join(directory, 'repo'); mkdirSync(root);
  git('init', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'baseline\n'); git('add', 'app.txt'); git('commit', '-m', 'baseline');
  git('switch', '-c', 'task/fixture'); // main is the integration branch: a starting point, never the implementation branch
  store = new Store(join(directory, 'metadata')); adapter = new MockAdapter(); sent = [];
  const inspect = adapter.inspect.bind(adapter); adapter.inspect = async (id) => ({ ...await inspect(id), cwd: root });
  const listPanes = adapter.listPanes.bind(adapter); adapter.listPanes = async () => Promise.all((await listPanes()).map(async (pane) => ({ ...pane, ...await adapter.inspect(pane.identity.paneId) })));
  adapter.send = async (_session, text) => { sent.push(text); };
  const worktree = await resolveWorktree(root);
  for (const [i, session] of mockSessions().entries()) {
    const cliPid = String(100 + i); adapter.foregrounds.set(session.id, cliPid);
    store.saveSession({ ...session, repository: root, cwd: root, worktree, cliPid, registrationId: randomUUID() } as ManagedSession);
  }
  plane = new ControlPlane(new Controller(config(), store, adapter));
  group = await plane.createGroup({ name: 'Implementation', members: ['codex', 'claude'] });
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function request(more: Partial<ImplementationStart> = {}): ImplementationStart {
  const selected = store.groups().find((g) => g.id === (more.groupId ?? group.id))!;
  return { requestId: randomUUID(), groupId: group.id, groupRevision: selected.revision,
    registrations: Object.fromEntries(selected.members.map((id) => [id, (store.sessions().find((s) => s.id === id) as ManagedSession).registrationId])), agentId: 'codex', kind: 'work', text: 'Implement the task', handoff: true,
    policy: 'peer', autoContinue: true, turnLimit: 20, logPath: 'RELAY-LOG.jsonl', branch: { branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD') }, confirmReady: true, ...more };
}
function publish(id: string, changes = false, fields: Partial<HandoffEntry> = {}): string {
  const turn = plane.workflow.execution(id)!;
  const entry: HandoffEntry = { ...turn.implementation!.identity, model: 'unknown', decision: turn.implementation!.identity.action === 'work' ? null : 'accept', reason: null, needsHuman: false, summary: 'Fixture result', checks: ['fixture check passed'], ...fields };
  if (changes) appendFileSync(join(root, 'app.txt'), `${id}\n`);
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), `${JSON.stringify(entry)}\n`);
  git('add', '--', 'app.txt', 'RELAY-LOG.jsonl'); git('commit', '-m', `handoff ${id}`); return git('rev-parse', 'HEAD');
}
function event(id: string, more: Partial<HookEvent> = {}): HookEvent {
  const turn = plane.workflow.execution(id)!; const participant = plane.workflow.run(turn.runId)!.participants.find((p) => p.id === turn.agentId)!;
  return { commandId: id, event: 'turn_complete', source: participant.agentType, sourceTurnId: `turn-${id}`, sessionId: `session-${participant.id}`,
    paneId: participant.identity.paneId, socketPath: participant.identity.socketPath, identity: participant.identity, prompt: turn.wireText, backgroundState: 'clear', settled: true, ...more };
}
async function complete(id: string, more: Partial<HookEvent> = {}) {
  const input = event(id, more);
  if (input.source === 'claude') await plane.recordEvent({ ...input, event: 'turn_started' });
  return plane.recordEvent(input);
}
const run = (id: string) => plane.workflow.run(id)!;

test('direct Start binds discovered solo identity without a registration step; stale consent sends nothing', async () => {
  const template = request(); plane.removeGroup(group.id); plane.remove('codex'); plane.remove('claude');
  const list = adapter.listPanes.bind(adapter); adapter.listPanes = async () => (await list()).filter((pane) => pane.identity.paneId === '%0');
  let pid = '500'; adapter.foreground = async () => pid;
  const before = store.db.prepare('SELECT total_changes() AS count').get();
  const view = await plane.state(); const solo = view.groups[0]!; const member = view.sessions[0]!;
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before); assert.deepEqual(store.sessions(), []);
  const input: ImplementationStart = { ...template, groupId: solo.id, groupRevision: solo.revision, agentId: member.id, registrations: { [member.id]: member.registrationId }, policy: 'solo', handoff: false, autoContinue: false };
  pid = '501';
  await assert.rejects(plane.submitImplementation(input), /group or registered instance changed/);
  assert.deepEqual(store.sessions(), []); assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
  const refreshed = (await plane.state()).sessions[0]!;
  const accepted = { ...input, requestId: randomUUID(), registrations: { [member.id]: refreshed.registrationId } };
  assert.equal((await plane.submitImplementation(accepted)).status, 'delivered');
  assert.equal((store.sessions()[0] as ManagedSession).registrationId, refreshed.registrationId);
  assert.equal(run(accepted.requestId).participants.length, 1); assert.equal(sent.length, 1);
  await plane.submitImplementation(accepted); assert.equal(sent.length, 1);
});

test('larger saved groups cannot bypass the Implementation execution limit', async () => {
  const template = request(); plane.removeGroup(group.id);
  await plane.register({ paneId: '%3', label: 'Third' });
  group = await plane.createGroup({ name: 'Larger', members: ['codex', 'claude', 'third'] });
  await assert.rejects(plane.submitImplementation({ ...template, ...request() }), /Collaboration requires two distinct members/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []); assert.equal((await branchState(root)).clean, true);
});
test('uncertain task-worktree creation blocks execution and agent edits on its destination', async () => {
  const action = request(); const worktree = (await resolveWorktree(root))!;
  store.saveWorktreeCreation({ input: { requestId: randomUUID(), projectId: 'fixture-project', sourceWorktreeId: 'fixture-tree',
    source: worktree, sourceHead: action.branch.head, sourceBranch: 'main', branch: 'task', path: root, confirm: true },
    status: 'uncertain', message: 'Fixture setup hold', updatedAt: new Date().toISOString() });
  await assert.rejects(plane.submitImplementation(action), /worktree creation/);
  const member = store.sessions()[0] as ManagedSession;
  await assert.rejects(plane.rename(member.id, { label: 'Changed', expectedLabel: member.label, expectedRegistrationId: member.registrationId }), /worktree creation/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
});

test('commit relay accepts incoming code separately from improvements; duplicates consume one publication', async () => {
  const input = request(); const base = input.branch.head; assert.equal((await plane.submitImplementation(input)).status, 'delivered');
  await plane.submitImplementation(input); assert.equal(sent.length, 1);
  const first = publish(input.requestId, true);
  await Promise.all([complete(input.requestId), complete(input.requestId)]);
  assert.equal(sent.length, 2); const second = run(input.requestId).currentCommandId;
  assert.equal(run(input.requestId).implementation!.acceptedSha, base);
  const assignment = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${second}.json`), 'utf8'));
  assert.equal(assignment.identity.reviewBase, base); assert.equal(assignment.identity.reviewHead, first);
  const improved = publish(second, true); await complete(second);
  assert.equal(run(input.requestId).implementation!.acceptedSha, first);
  assert.equal(run(input.requestId).implementation!.candidateSha, improved);
  const third = run(input.requestId).currentCommandId; publish(third); await complete(third);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(run(input.requestId).implementation!.acceptedSha, improved);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), null);
  assert.equal(sent.length, 3); assert.match(sent[0]!, /commit-handoff/); assert.doesNotMatch(sent[0]!, /^relay:/);
});
test('fixed reviewer objections route to the worker; corrected review retains the accepted baseline', async () => {
  const input = request({ policy: 'worker_reviewer', workerId: 'codex' }); await plane.submitImplementation(input);
  publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId;
  assert.equal(plane.workflow.execution(review)!.implementation!.identity.action, 'review');
  publish(review, false, { decision: 'object', reason: 'Handle empty input.' }); await complete(review);
  const correction = run(input.requestId).currentCommandId;
  assert.equal(plane.workflow.execution(correction)!.agentId, 'codex');
  const revision = publish(correction, true); await complete(correction);
  const next = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(next.implementation!.identity.reviewBase, input.branch.head);
  assert.equal(next.implementation!.identity.reviewHead, revision);
  assert.equal(next.agentId, 'claude');
});
test('solo work publishes a candidate without self-acceptance or a self-relay', async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  const input = request({ groupId: solo.id, policy: 'solo', autoContinue: false, handoff: false }); await plane.submitImplementation(input);
  const candidate = publish(input.requestId, true); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(run(input.requestId).participants.length, 1);
  assert.equal(run(input.requestId).implementation!.candidateSha, candidate); assert.equal(run(input.requestId).implementation!.acceptedSha, input.branch.head);
  assert.equal(sent.length, 1);
  await assert.rejects(plane.submitImplementation(request({ groupId: solo.id, policy: 'solo' })), /Solo implementation/);
});
test('log-only work, including a disputed correction, ends without review and preserves findings', async () => {
  const input = request({ policy: 'worker_reviewer', workerId: 'codex' }); await plane.submitImplementation(input);
  publish(input.requestId, true); await complete(input.requestId);
  const reviewer = run(input.requestId).currentCommandId;
  publish(reviewer, false, { decision: 'object', reason: 'Need a human scope decision.' }); await complete(reviewer);
  const correction = run(input.requestId).currentCommandId; publish(correction); await complete(correction);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(sent.length, 3);
  assert.equal(run(input.requestId).implementation!.acceptedSha, input.branch.head);
  assert.equal(run(input.requestId).implementation!.findings, 'Need a human scope decision.');
});
test('a peer objection routes back to the author automatically unless the agreement pauses it', async () => {
  const input = request(); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId;
  publish(review, false, { decision: 'object', reason: 'Fix the null case.' }); await complete(review);
  assert.equal(run(input.requestId).status, 'running'); assert.equal(sent.length, 3); assert.equal(run(input.requestId).automaticTurns, 2);
  const correction = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(correction.agentId, 'codex'); assert.equal(correction.implementation!.identity.action, 'work');
  assert.equal(run(input.requestId).implementation!.findings, 'Fix the null case.');
  assert.deepEqual(JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${correction.commandId}.json`), 'utf8')).findings, 'Fix the null case.');
  await plane.action({ runId: input.requestId, action: 'takeover', confirmReady: true });
  const paused = request({ pauseOnObjection: true }); await plane.submitImplementation(paused); publish(paused.requestId, true); await complete(paused.requestId);
  assert.equal(run(paused.requestId).pauseOnObjection, true);
  const second = run(paused.requestId).currentCommandId; publish(second, false, { decision: 'object', reason: 'Choose the API shape.' }); await complete(second);
  assert.equal(run(paused.requestId).status, 'waiting'); assert.equal(sent.length, 5);
  assert.match(run(paused.requestId).reason, /Next turn sends these findings to the author/);
  assert.deepEqual(run(paused.requestId).implementation!.next, { agentId: 'codex', action: 'work', text: 'Address the outstanding reviewer findings within the original task scope. Publish a revised proposal or a log-only report explaining what needs human direction.', handoff: true });
  // The agreement can change at the settled boundary; a later objection then routes automatically.
  await plane.changePolicy({ runId: paused.requestId, expectedCommandId: second, expectedRevision: 1, policy: 'peer', autoContinue: true, pauseOnObjection: false });
  assert.equal(run(paused.requestId).pauseOnObjection, false);
  assert.throws(() => parseImplementation({ ...request(), pauseOnObjection: 'yes' }), /objection/);
});
test('manual next turn retains ownership and consumes concurrent clicks once; objections wait without automation', async () => {
  const input = request({ autoContinue: false }); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  // An explicit initial handoff is honored even with later automation off.
  assert.equal(sent.length, 2);
  const second = run(input.requestId).currentCommandId; publish(second, true); await complete(second);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  const clicks = await Promise.allSettled([1, 2].map(async () => plane.action({ runId: input.requestId, action: 'continue', expectedCommandId: second, confirmReady: true })));
  assert.equal(clicks.filter((c) => c.status === 'fulfilled').length, 1); assert.equal(sent.length, 3);
  const third = run(input.requestId).currentCommandId; publish(third, false, { decision: 'object', reason: 'Fix the null case.' }); await complete(third);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(run(input.requestId).implementation!.next!.action, 'work');
});
test('confirmed branch creation is scoped, persisted, idempotent, and leaves the baseline unchanged', async () => {
  const input = request(); input.branch.newBranch = 'task/implementation';
  const results = await Promise.allSettled([plane.submitImplementation(input), plane.submitImplementation(input)]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(git('branch', '--show-current'), 'task/implementation'); assert.equal(git('rev-parse', 'HEAD'), input.branch.head);
  assert.equal(run(input.requestId).implementation!.setup, 'ready'); assert.equal(sent.length, 1);
  await plane.submitImplementation(input); assert.equal(sent.length, 1);
  await assert.rejects(plane.submitImplementation({ ...input, text: 'different instruction' }), /another implementation/);
});
test('an integration branch is a starting point, never the implementation branch, on the server as well as in the picker', async () => {
  git('switch', 'main'); const stay = request(); assert.equal(stay.branch.branch, 'main');
  await assert.rejects(plane.submitImplementation(stay), /main is an integration branch/);
  await assert.rejects(plane.submitImplementation({ ...request(), kind: 'review', reviewBase: stay.branch.head }), /integration branch/);
  const named = request(); named.branch.newBranch = 'master'; await assert.rejects(plane.submitImplementation(named), /integration branch name/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []); assert.equal(git('branch', '--show-current'), 'main');
  // The default branch is a valid creation base: a new task branch from it starts a run and records that commit as the baseline.
  const branched = request(); branched.branch.newBranch = 'task/from-main';
  assert.equal((await plane.submitImplementation(branched)).status, 'delivered');
  assert.equal(git('branch', '--show-current'), 'task/from-main'); assert.equal(run(branched.requestId).implementation!.taskBaseSha, branched.branch.head);
});
test('configured and detected integration branches are refused beyond the literal name main', async () => {
  git('branch', 'develop'); git('switch', '-c', 'release/1.0');
  const configured = new ControlPlane(new Controller(loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: join(directory, 'metadata'), CODERCREW_INTEGRATION_BRANCHES: 'develop, release/1.0' }), store, adapter));
  await assert.rejects(configured.submitImplementation(request()), /release\/1.0 is an integration branch/);
  git('switch', 'develop'); await assert.rejects(configured.submitImplementation(request()), /develop is an integration branch/);
  git('switch', 'task/fixture'); assert.equal((await configured.submitImplementation(request())).status, 'delivered');
  // A remote default branch counts even when it is not configured: origin/HEAD is read locally, without fetching.
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const policy = async () => { const state = await branchState(root); return { primary: state.primary, ...await taskBaseline(root, state, plane.config.integrationBranches) }; };
  assert.deepEqual(await policy(), { primary: 'trunk', integration: false, taskBase: git('rev-parse', 'HEAD') });
  git('switch', '-c', 'trunk'); assert.deepEqual(await policy(), { primary: 'trunk', integration: true, taskBase: null });
  assert.throws(() => loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_INTEGRATION_BRANCHES: 'main,bad name' }), /CODERCREW_INTEGRATION_BRANCHES/);
});
test('an existing task branch keeps its recorded baseline: inferred from the integration tip, confirmed when ambiguous, never guessed', async () => {
  const baseline = git('rev-parse', 'HEAD');
  const policy = async () => taskBaseline(root, await branchState(root), plane.config.integrationBranches);
  assert.deepEqual(await policy(), { integration: false, taskBase: baseline });
  appendFileSync(join(root, 'app.txt'), 'task work\n'); git('commit', '-am', 'task commit 1'); const later = git('rev-parse', 'HEAD');
  assert.deepEqual(await policy(), { integration: false, taskBase: baseline });
  const inferred = request(); assert.equal((await plane.submitImplementation(inferred)).status, 'delivered');
  assert.equal(run(inferred.requestId).implementation!.taskBaseSha, baseline); assert.equal(run(inferred.requestId).implementation!.acceptedSha, later);
  await plane.action({ runId: inferred.requestId, action: 'takeover', confirmReady: true });
  // A confirmed baseline must lie inside the branch; a review round must lie inside the task.
  const wrong = request(); wrong.branch.taskBase = 'b'.repeat(40); await assert.rejects(plane.submitImplementation(wrong), /ancestor/);
  const outside = request(); outside.kind = 'review'; outside.reviewBase = baseline; outside.branch.taskBase = later;
  await assert.rejects(plane.submitImplementation(outside), /precedes the task baseline/);
  assert.throws(() => parseImplementation({ ...request(), branch: { branch: 'task/fixture', head: later, newBranch: 'task/new', taskBase: baseline } }), /task baseline applies only/);
  // Two diverged integration tips give no single nearest base: the user confirms the baseline instead of the server guessing it.
  git('switch', 'main'); appendFileSync(join(root, 'main.txt'), 'main\n'); git('add', 'main.txt'); git('commit', '-m', 'main work');
  git('switch', '-c', 'master', baseline); appendFileSync(join(root, 'master.txt'), 'master\n'); git('add', 'master.txt'); git('commit', '-m', 'master work');
  git('switch', 'task/fixture'); git('merge', '--no-edit', 'main'); git('merge', '--no-edit', 'master');
  assert.deepEqual(await policy(), { integration: false, taskBase: null });
  await assert.rejects(plane.submitImplementation(request()), /Confirm where this task branch began/);
  const confirmed = request(); confirmed.branch.taskBase = baseline;
  assert.equal((await plane.submitImplementation(confirmed)).status, 'delivered'); assert.equal(run(confirmed.requestId).implementation!.taskBaseSha, baseline);
});
test('criss-cross history requires a confirmed baseline instead of choosing one equally valid merge base', async () => {
  const baseline = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');
  const left = git('commit-tree', tree, '-p', baseline, '-m', 'left');
  const right = git('commit-tree', tree, '-p', baseline, '-m', 'right');
  const integration = git('commit-tree', tree, '-p', left, '-p', right, '-m', 'merge right into left');
  const candidate = git('commit-tree', tree, '-p', right, '-p', left, '-m', 'merge left into right');
  git('update-ref', 'refs/heads/main', integration); git('update-ref', 'refs/heads/task/fixture', candidate);
  assert.deepEqual(new Set(git('merge-base', '--all', 'HEAD', 'main').split('\n')), new Set([left, right]));
  assert.deepEqual(await taskBaseline(root, await branchState(root), plane.config.integrationBranches), { integration: false, taskBase: null });
  await assert.rejects(plane.submitImplementation(request()), /Confirm where this task branch began/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
  const confirmed = request(); confirmed.branch.taskBase = baseline;
  assert.equal((await plane.submitImplementation(confirmed)).status, 'delivered');
  assert.equal(run(confirmed.requestId).implementation!.taskBaseSha, baseline);
});
test('dirty existing-candidate review, stale consent, invalid/colliding names, and detached checkout are rejected before dispatch', async () => {
  const input = request(); appendFileSync(join(root, 'app.txt'), 'dirty');
  await assert.rejects(plane.submitImplementation({ ...input, kind: 'review', reviewBase: input.branch.head }), /must be clean/);
  git('add', 'app.txt'); git('commit', '-m', 'user work');
  await assert.rejects(plane.submitImplementation(input), /changed/);
  const invalid = request(); invalid.branch.newBranch = '../bad'; await assert.rejects(plane.submitImplementation(invalid));
  const collision = request(); collision.branch.newBranch = 'main'; await assert.rejects(plane.submitImplementation(collision), /integration branch/);
  const existing = request(); existing.branch.newBranch = 'task/fixture'; await assert.rejects(plane.submitImplementation(existing), /already exists/);
  git('switch', '--detach'); await assert.rejects(plane.submitImplementation({ ...request(), branch: { branch: null, head: git('rev-parse', 'HEAD') } }), /Detached HEAD/);
  assert.equal(sent.length, 0);
});
test('branch inspection reports staged, unstaged, untracked and renamed paths without touching Git state', async () => {
  git('config', 'status.renames', 'true');
  writeFileSync(join(root, 'old name.txt'), 'rename fixture\n'); writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  git('add', '.'); git('commit', '-m', 'fixtures');
  appendFileSync(join(root, 'app.txt'), 'staged\n'); git('add', 'app.txt'); appendFileSync(join(root, 'app.txt'), 'unstaged\n');
  const renamed = 'new name\n雪.txt'; renameSync(join(root, 'old name.txt'), join(root, renamed)); git('add', '--', 'old name.txt', renamed);
  writeFileSync(join(root, 'untracked <file>.txt'), 'new\n'); writeFileSync(join(root, 'ignored.txt'), 'ignored\n');
  const index = readFileSync(join(root, '.git', 'index')); const head = git('rev-parse', 'HEAD');
  const state = await branchState(root);
  assert.equal(state.clean, false); assert.equal(state.changeCount, 3);
  assert.deepEqual(state.changes, [
    { status: 'MM', path: 'app.txt', originalPath: null },
    { status: 'R ', path: renamed, originalPath: 'old name.txt' },
    { status: '??', path: 'untracked <file>.txt', originalPath: null },
  ]);
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index); assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(root, 'app.txt'), 'utf8'), 'baseline\nstaged\nunstaged\n');
});
test('branch inspection bounds the displayed list without calling a large dirty checkout clean', async () => {
  for (let i = 0; i < 105; i++) writeFileSync(join(root, `untracked-${i}.txt`), 'fixture');
  const state = await branchState(root);
  assert.equal(state.clean, false); assert.equal(state.changeCount, 105); assert.equal(state.changes.length, 100);
  assert.ok(state.changes.every((change) => change.status === '??'));
});
for (const kind of ['staged', 'mixed', 'untracked'] as const) test(`Existing-candidate review refuses ${kind} changes before creating a requested branch or dispatching`, async () => {
  const input = request({ kind: 'review', reviewBase: git('rev-parse', 'HEAD') }); input.branch.newBranch = 'task/dirty';
  if (kind === 'untracked') writeFileSync(join(root, 'new.txt'), 'untracked\n');
  else { appendFileSync(join(root, 'app.txt'), 'staged\n'); git('add', 'app.txt'); if (kind === 'mixed') appendFileSync(join(root, 'app.txt'), 'unstaged\n'); }
  const before = git('status', '--porcelain=v1'); const index = readFileSync(join(root, '.git', 'index'));
  await assert.rejects(plane.submitImplementation(input), /must be clean/);
  assert.equal(git('status', '--porcelain=v1'), before); assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.equal(git('branch', '--show-current'), 'task/fixture'); assert.equal(git('branch', '--list', 'task/dirty'), ''); assert.equal(sent.length, 0);
  assert.equal(plane.workflow.run(input.requestId), undefined);
});
test('ignored or symlinked log paths are rejected without modifying ignore rules', async () => {
  writeFileSync(join(root, '.gitignore'), '.codercrew/\n'); git('add', '.gitignore'); git('commit', '-m', 'ignore fixture');
  await assert.rejects(plane.submitImplementation(request({ logPath: '.codercrew/relay-log.md' })), /ignored/);
  symlinkSync(join(directory, 'outside'), join(root, 'log-link')); git('add', 'log-link'); git('commit', '-m', 'symlink fixture');
  await assert.rejects(plane.submitImplementation(request({ logPath: 'log-link' })), /symlinks/);
});
for (const fault of ['missing', 'wrong identity', 'intermediate commit', 'leftovers', 'old log rewrite', 'contradictory outcome', 'reviewer edits', 'objection edits'] as const) {
  test(`invalid publication pauses with ownership: ${fault}`, async () => {
    const input = request({ policy: 'worker_reviewer', workerId: 'codex' }); await plane.submitImplementation(input);
    let command = input.requestId;
    if (['reviewer edits', 'objection edits', 'old log rewrite', 'contradictory outcome'].includes(fault)) {
      publish(command, true); await complete(command); command = run(input.requestId).currentCommandId;
    }
    if (fault === 'intermediate commit') { appendFileSync(join(root, 'app.txt'), 'checkpoint'); git('add', 'app.txt'); git('commit', '-m', 'unexpected checkpoint'); }
    if (fault === 'old log rewrite') writeFileSync(join(root, 'RELAY-LOG.jsonl'), 'rewritten\n');
    if (fault !== 'missing') publish(command, ['reviewer edits', 'objection edits'].includes(fault), fault === 'wrong identity' ? { commandId: randomUUID() } : fault === 'objection edits' ? { decision: 'object', reason: 'Not acceptable.' } : {});
    if (fault === 'leftovers') writeFileSync(join(root, 'untracked.txt'), 'leftover');
    await complete(command, fault === 'contradictory outcome' ? { outcome: 'strong_objection' } : {});
    assert.equal(run(input.requestId).status, 'paused'); assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
    assert.equal(sent.length, command === input.requestId ? 1 : 2);
  });
}
test('unknown background work and restart never automatically transfer ownership', async () => {
  const input = request(); await plane.submitImplementation(input); publish(input.requestId, true);
  await complete(input.requestId, { backgroundState: undefined });
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 1);
  store.close(); store = new Store(join(directory, 'metadata')); plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).implementation!.branch, 'task/fixture');
  assert.equal(sent.length, 1); assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
});
test('budget exhaustion never dispatches another turn', async () => {
  const input = request({ turnLimit: 1 }); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId; publish(review, true); await complete(review);
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /budget/); assert.equal(sent.length, 2);
});
test('group validation rejects aliases, oversized rosters, moved cwd and mismatched roles', async () => {
  assert.throws(() => parseGroup({ name: 'Bad', members: ['codex', 'codex'] }), /distinct/);
  assert.deepEqual(parseGroup({ name: 'Larger', members: ['codex', 'claude', 'third'] }).members, ['codex', 'claude', 'third']);
  await assert.rejects(plane.submitImplementation(request({ policy: 'worker_reviewer', workerId: 'claude' })), /assigned worker/);
  const inspect = adapter.inspect.bind(adapter); adapter.inspect = async (id) => ({ ...await inspect(id), cwd: id === '%1' ? `${root}/subdir` : root });
  await assert.rejects(plane.submitImplementation(request()), /group changed.*canonical current directory/);
});
test('legacy starts are softly disabled while existing protocol remains opt-in', async () => {
  await assert.rejects(plane.submit({ requestId: randomUUID(), agentId: 'codex', kind: 'relay', confirmReady: true }), /deprecated staging relay is disabled/);
  assert.equal((await plane.state()).legacyEnabled, false);
  assert.throws(() => parseImplementation({ ...request(), unexpected: true }), /Unknown implementation field/);
  assert.equal((await branchState(root)).clean, true);
});
test('v4 migration preserves historical pair IDs and creates versioned groups', () => {
  store.db.prepare('DELETE FROM groups').run(); store.db.pragma('user_version = 4'); store.close();
  store = new Store(join(directory, 'metadata'));
  assert.equal(store.groups()[0]!.id, group.id); assert.equal(store.groups()[0]!.legacyPairId, group.id);
  assert.deepEqual(store.groups()[0]!.members, ['codex', 'claude']); assert.equal(store.db.pragma('user_version', { simple: true }), 7);
});
test('committed work without handoff and log-only initial work never create a peer review', async () => {
  const first = request({ handoff: false }); await plane.submitImplementation(first); publish(first.requestId, true); await complete(first.requestId);
  assert.equal(run(first.requestId).status, 'completed'); assert.equal(sent.length, 1);
  const second = request(); await plane.submitImplementation(second); publish(second.requestId); await complete(second.requestId);
  assert.equal(run(second.requestId).status, 'completed'); assert.equal(sent.length, 2);
  const state = await plane.state(); assert.equal(state.commands[0]!.groupId, group.id); assert.equal(state.commands[0]!.pairId, null);
});
test('an explicit existing-candidate review binds its full range and rejects empty or unrelated ranges', async () => {
  const base = git('rev-parse', 'HEAD');
  await assert.rejects(plane.submitImplementation(request({ kind: 'review', reviewBase: base })), /no project proposal/);
  appendFileSync(join(root, 'app.txt'), 'candidate'); git('add', 'app.txt'); git('commit', '-m', 'candidate');
  const head = git('rev-parse', 'HEAD');
  const input = request({ kind: 'review', agentId: 'claude', reviewBase: base }); await plane.submitImplementation(input);
  assert.deepEqual([plane.workflow.execution(input.requestId)!.implementation!.identity.reviewBase, plane.workflow.execution(input.requestId)!.implementation!.identity.reviewHead], [base, head]);
  publish(input.requestId); await complete(input.requestId); assert.equal(run(input.requestId).implementation!.acceptedSha, head);
});
test('human escalation pauses fixed-role automation without treating a scope decision as repair work', async () => {
  const input = request({ policy: 'worker_reviewer', workerId: 'codex' }); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId; publish(review, false, { decision: 'object', reason: 'Choose the product behavior.', needsHuman: true }); await complete(review);
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Human direction/); assert.equal(sent.length, 2);
  assert.equal(run(input.requestId).implementation!.next, null);
});
test('policy changes are boundary-only, versioned, and never reset the budget or self-review the candidate', async () => {
  const input = request({ autoContinue: false }); await plane.submitImplementation(input);
  const change = { runId: input.requestId, expectedCommandId: input.requestId, expectedRevision: 1, policy: 'worker_reviewer' as const, workerId: 'codex', autoContinue: true };
  assert.throws(() => plane.changePolicy(change), /settled manual handoff/);
  publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId; publish(review, true); await complete(review);
  assert.throws(() => plane.changePolicy({ ...change, expectedCommandId: review }), /cannot become its independent reviewer/);
  plane.changePolicy({ ...change, expectedCommandId: review, workerId: 'claude' });
  assert.equal(run(input.requestId).implementation!.revision, 2); assert.equal(run(input.requestId).automaticTurns, 1); assert.equal(sent.length, 2);
  assert.throws(() => plane.changePolicy({ ...change, expectedCommandId: review, workerId: 'claude' }), /current settled/);
  await plane.action({ runId: input.requestId, action: 'continue', expectedCommandId: review, confirmReady: true });
  const next = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(next.implementation!.identity.action, 'review'); assert.equal(next.implementation!.identity.policyRevision, 2); assert.equal(next.agentId, 'codex');
});
test('a manual handoff rechecks cleanliness instead of adopting newly introduced work', async () => {
  const input = request({ autoContinue: false }); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId; publish(review, true); await complete(review);
  writeFileSync(join(root, 'user-note.txt'), 'new user work');
  await plane.action({ runId: input.requestId, action: 'continue', expectedCommandId: review, confirmReady: true });
  assert.equal(sent.length, 2); assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /must be clean/);
  assert.equal(readFileSync(join(root, 'user-note.txt'), 'utf8'), 'new user work');
});
test('pause records a completed publication but does not launch its successor', async () => {
  const input = request(); await plane.submitImplementation(input); plane.action({ runId: input.requestId, action: 'pause' });
  const sha = publish(input.requestId, true); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).implementation!.expectedParentSha, sha); assert.equal(sent.length, 1);
});
test('changed CLI instance at completion prevents handoff even when a valid commit exists', async () => {
  const input = request(); await plane.submitImplementation(input); publish(input.requestId, true); adapter.foregrounds.set('codex', '999'); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 1); assert.match(run(input.requestId).reason, /Re-register/);
});
test('an overlapping group and the staging fallback share the same execution lock', async () => {
  const input = request(); await plane.submitImplementation(input);
  const solo = await assert.rejects(plane.createGroup({ name: 'Concurrent solo', members: ['codex'] }), /run owns/); assert.equal(solo, undefined);
  plane.config.legacyEnabled = true;
  await assert.rejects(plane.submit({ requestId: randomUUID(), agentId: 'claude', kind: 'relay', confirmReady: true, pairId: group.id }), /execution owner/);
  assert.equal(sent.length, 1);
});
test('a branch setup conflict is persisted as uncertain and a repeated request never retries it', async () => {
  const input = request(); input.branch.newBranch = 'task/collision';
  const inspect = adapter.inspect.bind(adapter); let injected = false;
  adapter.inspect = async (id) => { if (!injected && plane.workflow.run(input.requestId)?.implementation?.setup === 'applying') { injected = true; git('branch', 'task/collision'); } return inspect(id); };
  await assert.rejects(plane.submitImplementation(input), /not return a confirmed result/);
  assert.equal(run(input.requestId).implementation!.setup, 'uncertain'); assert.equal(run(input.requestId).status, 'paused');
  await assert.rejects(plane.submitImplementation(input), /already owns setup/);
  assert.equal(git('branch', '--show-current'), 'task/fixture'); assert.equal(sent.length, 0);
});
test('restart of a manual wait preserves candidates, findings, policy and ownership without replay', async () => {
  const input = request({ pauseOnObjection: true }); await plane.submitImplementation(input); publish(input.requestId, true); await complete(input.requestId);
  const review = run(input.requestId).currentCommandId; publish(review, false, { decision: 'object', reason: 'Repair this candidate.' }); await complete(review);
  assert.equal(run(input.requestId).status, 'waiting'); const snapshot = run(input.requestId).implementation;
  store.close(); store = new Store(join(directory, 'metadata')); plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.equal(run(input.requestId).status, 'paused'); assert.deepEqual(run(input.requestId).implementation, snapshot); assert.equal(sent.length, 2);
});
test('late acknowledged starts do not pause the newer correlated implementation turn', async () => {
  const input = request(); await plane.submitImplementation(input);
  const oldStart = event(input.requestId, { event: 'turn_started' }); await plane.recordEvent(oldStart);
  publish(input.requestId, true); await complete(input.requestId);
  const current = run(input.requestId).currentCommandId; await plane.recordEvent(oldStart);
  assert.equal(run(input.requestId).status, 'running'); assert.equal(run(input.requestId).currentCommandId, current); assert.equal(sent.length, 2);
});
test('takeover is blocked during branch setup; pause prevents the branch operation from starting', async () => {
  const input = request(); input.branch.newBranch = 'task/setup';
  let entering!: () => void; const entered = new Promise<void>((resolve) => { entering = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const inspect = adapter.inspect.bind(adapter); let gated = false;
  adapter.inspect = async (id) => { if (!gated && plane.workflow.run(input.requestId)?.implementation?.setup === 'applying') { gated = true; entering(); await gate; } return inspect(id); };
  const attempt = plane.submitImplementation(input).catch((error: Error) => error);
  await entered;
  assert.equal(run(input.requestId).implementation!.setup, 'applying');
  assert.throws(() => plane.action({ runId: input.requestId, action: 'takeover', confirmReady: true }), /in-flight branch setup/);
  plane.action({ runId: input.requestId, action: 'pause' }); release();
  assert.match(String(await attempt), /paused before the branch operation/);
  assert.equal(git('branch', '--show-current'), 'task/fixture'); assert.equal(sent.length, 0);
});
test('registered unselected writers on the same checkout pause an owned implementation run', async () => {
  const extra = { ...store.sessions()[0]!, id: 'extra', label: 'Extra', registrationId: randomUUID(), identity: { ...store.sessions()[0]!.identity, paneId: '%3' } } as ManagedSession;
  store.saveSession(extra);
  const input = request(); await plane.submitImplementation(input);
  await plane.recordEvent({ event: 'turn_started', source: extra.agentType, identity: extra.identity, paneId: '%3', socketPath: extra.identity.socketPath, sourceTurnId: 'desktop', sessionId: 'external', prompt: 'unrelated desktop work' });
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Another prompt started/);
});
test('a large tracked-file inventory still reads as clean and still exposes a hidden index flag', async () => {
  // ~700-byte paths push `git ls-files -v -z` past the 4 MiB buffer that bounded the earlier inspection, within PATH_MAX.
  const deep = join(root, ...Array.from({ length: 3 }, (_, i) => `${'d'.repeat(200)}${i}`)); mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 6500; i++) writeFileSync(join(deep, `${'f'.repeat(100)}${i}`), '');
  git('add', '-A'); git('commit', '-qm', 'many files');
  assert.ok(execFileSync('git', ['-C', root, 'ls-files', '-v', '-z'], { maxBuffer: 64 * 1024 * 1024 }).length > 4 * 1024 * 1024);
  const state = await branchState(root); assert.equal(state.clean, true); assert.equal(state.head, git('rev-parse', 'HEAD'));
  git('update-index', '--skip-worktree', 'app.txt');
  await assert.rejects(branchState(root), /index hides tracked files/);
});
test('hidden index flags cannot disguise dirty user content as a clean entry', async () => {
  const input = request(); git('update-index', '--assume-unchanged', 'app.txt'); appendFileSync(join(root, 'app.txt'), 'hidden work');
  assert.equal(git('status', '--porcelain'), '');
  await assert.rejects(plane.submitImplementation(input), /index hides tracked files/); assert.equal(sent.length, 0);
});
test('a stale displayed registration or roster cannot authorize a new implementation instance', async () => {
  const input = request(); const member = store.sessions()[0] as ManagedSession;
  store.saveSession({ ...member, registrationId: randomUUID() } as ManagedSession);
  await assert.rejects(plane.submitImplementation(input), /changed after confirmation/);
  await assert.rejects(plane.submitImplementation({ ...request(), groupRevision: 999 }), /changed after confirmation/);
  assert.equal(sent.length, 0); assert.equal(plane.workflow.owner(`${root}/.git/index`), null);
});
test('reconciliation rediscovers a restarted peer without writes or reset; fresh Send & relay binds it and preserves history', async () => {
  const first = request(); await plane.submitImplementation(first);
  const original = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  adapter.foregrounds.set('claude', '900');
  plane.workflow.pause(first.requestId, 'Fixture interruption');
  const paused = await plane.state();
  assert.equal(paused.sessions.find((s) => s.id === 'claude')!.registrationId, original.registrationId);
  assert.equal(paused.instances.find((s) => s.agentId === 'claude')!.status, 'replaced');
  plane.action({ runId: first.requestId, action: 'takeover', confirmReady: true });
  const changes = store.db.prepare('SELECT total_changes() AS count').get();
  const fresh = await plane.state(); const peer = fresh.sessions.find((s) => s.id === 'claude')!;
  assert.notEqual(peer.registrationId, original.registrationId); assert.equal(peer.label, original.label);
  assert.equal(fresh.instances.find((s) => s.agentId === 'claude')!.status, 'current');
  assert.equal((await plane.state()).sessions.find((s) => s.id === 'claude')!.registrationId, peer.registrationId);
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), changes);
  assert.deepEqual(store.sessions().find((s) => s.id === 'claude'), original);
  assert.deepEqual(fresh.groups.find((g) => g.id === group.id), group);
  const stale = request(); await assert.rejects(plane.submitImplementation(stale), /registered instance changed/);
  assert.equal(plane.workflow.run(stale.requestId), undefined); assert.equal(sent.length, 1);
  const next = request({ registrations: Object.fromEntries(group.members.map((id) => [id, fresh.sessions.find((s) => s.id === id)!.registrationId])) });
  assert.equal((await plane.submitImplementation(next)).status, 'delivered');
  assert.equal((store.sessions().find((s) => s.id === 'claude') as ManagedSession).registrationId, peer.registrationId);
  assert.equal(run(first.requestId).status, 'stopped');
  assert.equal(run(first.requestId).participants.find((s) => s.id === 'claude')!.registrationId, original.registrationId);
  assert.equal(run(next.requestId).participants.find((s) => s.id === 'claude')!.cliPid, '900');
  assert.deepEqual(store.groups().find((g) => g.id === group.id), group); assert.equal(sent.length, 2);
});
test('a second restart invalidates discovered consent and unknown or moved peers are not rebound', async () => {
  const original = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  adapter.foregrounds.set('claude', '900'); const fresh = await plane.state();
  const stale = request({ registrations: Object.fromEntries(group.members.map((id) => [id, fresh.sessions.find((s) => s.id === id)!.registrationId])) });
  adapter.foregrounds.set('claude', '901');
  await assert.rejects(plane.submitImplementation(stale), /registered instance changed/);
  adapter.foregrounds.delete('claude');
  assert.equal((await plane.state()).sessions.find((s) => s.id === 'claude')!.registrationId, original.registrationId);
  adapter.foregrounds.set('claude', '902');
  const inspect = adapter.inspect.bind(adapter); adapter.inspect = async (id) => ({ ...await inspect(id), cwd: id === '%1' ? `${root}/elsewhere` : root });
  assert.equal((await plane.state()).sessions.find((s) => s.id === 'claude')!.registrationId, original.registrationId);
  assert.deepEqual(store.sessions().find((s) => s.id === 'claude'), original);
  assert.equal(sent.length, 0); assert.deepEqual(plane.workflow.runs(), []);
});

function instruction() {
  const { requestId, groupId, groupRevision, registrations, agentId, policy, confirmReady } = request();
  return parseStandalone({ requestId, groupId, groupRevision, registrations, agentId, policy, confirmReady, text: 'Explain the pending changes.' });
}
test('native startup before discovery is informational and cannot certify a controller command', async () => {
  const session = store.sessions()[0]!;
  plane.removeGroup(group.id);
  for (const saved of store.sessions()) store.removeSession(saved.id);
  plane = new ControlPlane(new Controller(config(), store, adapter));
  adapter.foreground = async () => '100';
  const startup = parseHook({ source: 'codex', event: 'session_started', sessionId: 'fresh-session', identity: session.identity,
    paneId: session.identity.paneId, socketPath: session.identity.socketPath, cliPid: '100', startedAt: '2026-09-20T01:00:00.000Z' });
  assert.equal((await plane.recordEvent(startup)).accepted, false);
  const snapshot = await plane.state(); const discovered = snapshot.sessions.find((s) => s.identity.paneId === session.identity.paneId)!;
  assert.equal(snapshot.activities!.find((a) => a.agentId === discovered.id)!.state, 'ready');
  assert.deepEqual(store.sessions(), []); assert.deepEqual(plane.workflow.runs(), []); assert.deepEqual(sent, []);
  assert.throws(() => parseHook({ ...startup, commandId: randomUUID() }), /cannot certify/);
});
for (const duringDelivery of [false, true]) test(`interruption pauses and retains the relay without accepting a late publication, duringDelivery=${duringDelivery}`, async () => {
  const input = request();
  const native = () => event(input.requestId, { event: 'turn_started', cliPid: '100', startedAt: '2026-09-20T20:00:00.000Z' });
  const interrupted = () => parseHook({ ...native(), event: 'turn_interrupted', settled: false, backgroundState: 'unknown' });
  if (duringDelivery) adapter.send = async (_session, text) => {
    sent.push(text); await plane.recordEvent(native());
    assert.match((await plane.recordEvent(interrupted())).reason, /Buffered/);
  };
  await plane.submitImplementation(input);
  if (!duringDelivery) { await plane.recordEvent(native()); await plane.recordEvent(interrupted()); }
  assert.equal(run(input.requestId).status, 'paused');
  assert.equal(plane.workflow.execution(input.requestId)!.status, 'interrupted');
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'interrupted');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId); assert.equal(sent.length, 1);
  publish(input.requestId, true); // A late publication cannot turn the interruption into success.
  await plane.recordEvent({ ...native(), event: 'turn_complete', settled: true, backgroundState: 'clear' });
  await plane.recordEvent(interrupted());
  assert.equal(plane.workflow.execution(input.requestId)!.status, 'interrupted');
  assert.equal(run(input.requestId).implementation!.latestPublication, null);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId); assert.equal(sent.length, 1);
  plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.equal(plane.workflow.execution(input.requestId)!.status, 'interrupted');
  await plane.recordEvent({ ...native(), event: 'turn_complete', settled: true, backgroundState: 'clear' });
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 1);
  plane.action({ runId: input.requestId, action: 'takeover', confirmReady: true });
  await plane.recordEvent(interrupted());
  assert.equal(run(input.requestId).status, 'stopped'); assert.equal(plane.workflow.owner(`${root}/.git/index`), null);
});
test('stale and replaced-process interruptions cannot pause the current assignment', async () => {
  const input = request(); await plane.submitImplementation(input);
  const native = event(input.requestId, { event: 'turn_started', cliPid: '100', startedAt: '2026-09-20T20:00:00.000Z' });
  await plane.recordEvent(native);
  const interrupted = { ...native, event: 'turn_interrupted' as const, settled: false, backgroundState: 'unknown' as const };
  for (const change of [{ sourceTurnId: 'older' }, { sessionId: 'other' }, { cliPid: '999' }, { prompt: 'different' }]) {
    await plane.recordEvent({ ...interrupted, ...change }); assert.equal(run(input.requestId).status, 'running');
  }
  adapter.foregrounds.set('codex', '999');
  await plane.recordEvent(interrupted); assert.equal(run(input.requestId).status, 'running');
  assert.equal(plane.workflow.execution(input.requestId)!.status, 'delivered'); assert.equal(sent.length, 1);
  for (const field of ['identity', 'cliPid', 'startedAt', 'sourceTurnId', 'sessionId']) {
    assert.throws(() => parseHook({ ...interrupted, [field]: undefined }), /Interruption requires/);
  }
  assert.throws(() => parseHook({ ...interrupted, settled: true }), /cannot certify/);
  assert.throws(() => parseHook({ ...interrupted, source: 'claude' }), /requires exact Codex/);
});
test('status recovery confirms the current Claude without changing configuration, Git, delivery or workflow', async () => {
  const session = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  const input = { agentId: session.id, registrationId: session.registrationId, expectedUpdatedAt: null, confirmReady: true as const };
  assert.throws(() => parseActivityReset({ ...input, confirmReady: false }), /Inspect the terminal/);
  assert.throws(() => parseActivityReset({ ...input, expectedUpdatedAt: undefined }), /timestamp/);
  const sessions = store.sessions(); const groups = store.groups(); const head = git('rev-parse', 'HEAD');
  const activity = await plane.resetActivity(parseActivityReset(input));
  assert.equal(activity.state, 'ready'); assert.match(activity.detail, /confirmed by you/);
  assert.deepEqual(store.sessions(), sessions); assert.deepEqual(store.groups(), groups);
  assert.deepEqual(plane.workflow.runs(), []); assert.deepEqual(sent, []); assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'claude')!.state, 'ready');
  await assert.rejects(plane.resetActivity(input), /Activity changed/);
  plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'claude')!.state, 'unknown');
});
test('status recovery refuses changed registrations, replaced CLIs, and owned runs after restart', async () => {
  const session = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  const input = { agentId: session.id, registrationId: session.registrationId, expectedUpdatedAt: null, confirmReady: true as const };
  await assert.rejects(plane.resetActivity({ ...input, registrationId: randomUUID() }), /changed or is unverified/);
  adapter.foregrounds.set(session.id, '999');
  await assert.rejects(plane.resetActivity(input), /changed or is unverified|current CLI/);
  adapter.foregrounds.set(session.id, session.cliPid!);
  const command = request(); await plane.submitImplementation(command);
  plane = new ControlPlane(new Controller(config(), store, adapter));
  await assert.rejects(plane.resetActivity(input), /run owns this worktree/);
  assert.equal(run(command.requestId).status, 'paused'); assert.equal(sent.length, 1);
});
test('a native start arriving during status validation wins over the human reset', async () => {
  const session = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  const input = { agentId: session.id, registrationId: session.registrationId, expectedUpdatedAt: null, confirmReady: true as const };
  const foreground = adapter.foreground.bind(adapter); let injected = false;
  adapter.foreground = async (target) => {
    if (target.id === session.id && !injected) {
      injected = true;
      await plane.recordEvent({ source: 'claude', event: 'turn_started', sessionId: 'native', sourceTurnId: 'new-turn',
        identity: session.identity, paneId: session.identity.paneId, socketPath: session.identity.socketPath,
        cliPid: session.cliPid!, startedAt: new Date().toISOString() });
    }
    return foreground(target);
  };
  await assert.rejects(plane.resetActivity(input), /Activity changed/);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === session.id)!.state, 'working');
  assert.deepEqual(sent, []);
});
test('status recovery cannot reuse a discovery proposal after concurrent re-registration', async () => {
  adapter.foregrounds.set('claude', '102');
  const session = (await plane.state()).sessions.find((s) => s.id === 'claude')!;
  const input = { agentId: session.id, registrationId: session.registrationId, expectedUpdatedAt: null, confirmReady: true as const };
  const foreground = adapter.foreground.bind(adapter); let reads = 0;
  adapter.foreground = async (target) => {
    // First read is discovery; second is validation, after its registration check.
    if (target.id === session.id && ++reads === 2) store.saveSession({ ...session, registrationId: randomUUID() } as ManagedSession);
    return foreground(target);
  };
  await assert.rejects(plane.resetActivity(input), /registration changed during status recovery/);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === session.id)!.state, 'unknown');
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
});
test('native activity survives pause and takeover; late completion updates activity without resuming a stopped run', async () => {
  const input = instruction(); await plane.submitStandalone(input);
  const native = { ...event(input.requestId), event: 'turn_started' as const, cliPid: '100', startedAt: new Date().toISOString() };
  await plane.recordEvent(native);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  plane.workflow.pause(input.requestId);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  plane.action({ runId: input.requestId, action: 'takeover', confirmReady: true });
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  const late = await plane.recordEvent({ ...native, event: 'turn_complete', settled: true, backgroundState: 'clear' });
  assert.equal(late.accepted, false); assert.equal(run(input.requestId).status, 'stopped');
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'idle');
  const manual = { ...native, commandId: undefined, sourceTurnId: 'manual-turn', startedAt: new Date(Date.parse(native.startedAt) + 1).toISOString() };
  await plane.recordEvent(manual);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  await plane.recordEvent({ ...native, event: 'turn_complete', settled: true, backgroundState: 'clear' });
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  assert.equal(sent.length, 1); assert.equal(plane.workflow.runs().length, 1);
});
test('a steered Codex completion finishes standalone Send exactly once using the original prompt echo', async () => {
  const input = instruction(); await plane.submitStandalone(input);
  const target = run(input.requestId).participants.find((p) => p.id === input.agentId)!;
  const prompt = plane.workflow.execution(input.requestId)!.wireText;
  const payload = { type: 'agent-turn-complete', 'thread-id': 'current-session', 'turn-id': 'current-turn',
    'input-messages': [prompt, 'Finish the current work before handing it off.'], 'last-assistant-message': 'Finished.',
    background_tasks: [], session_crons: [] };
  const binding = codexStartState({ hook_event_name: 'UserPromptSubmit', session_id: 'current-session', turn_id: 'current-turn', prompt }, target.identity);
  await plane.recordEvent(parseHook({ ...binding.context, event: 'turn_started' }));
  const completion = parseHook(codexCompletion(payload, target.identity, binding));
  const first = await plane.recordEvent(completion);
  assert.equal(first.accepted, true); assert.equal(run(input.requestId).status, 'completed');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), null);
  assert.deepEqual(await plane.recordEvent(completion), first); assert.equal(sent.length, 1);
  const next = instruction(); await plane.submitStandalone(next);
  await plane.recordEvent(completion); // An older completed event cannot complete the newer run.
  assert.equal(run(next.requestId).status, 'running'); assert.equal(sent.length, 2);
  const wrongBinding = codexStartState({ hook_event_name: 'UserPromptSubmit', session_id: 'current-session', turn_id: 'next-turn',
    prompt: `Wrong instruction [codercrew-command:${next.requestId}]` }, target.identity);
  const wrongEcho = parseHook(codexCompletion({ ...payload, 'turn-id': 'next-turn' }, target.identity, wrongBinding));
  assert.equal((await plane.recordEvent(wrongEcho)).accepted, false);
  assert.equal(run(next.requestId).status, 'paused'); assert.equal(plane.workflow.owner(`${root}/.git/index`), next.requestId);
});
test('a native-bound Codex handoff schedules peer review despite older commands in notify history', async () => {
  const input = request(); await plane.submitImplementation(input);
  const target = run(input.requestId).participants.find((p) => p.id === input.agentId)!;
  const prompt = plane.workflow.execution(input.requestId)!.wireText;
  const binding = codexStartState({ hook_event_name: 'UserPromptSubmit', session_id: 'native-session', turn_id: 'native-turn', prompt }, target.identity);
  await plane.recordEvent(parseHook({ ...binding.context, event: 'turn_started' }));
  const candidate = publish(input.requestId, true);
  const event = parseHook(codexCompletion({ type: 'agent-turn-complete', 'thread-id': 'native-session', 'turn-id': 'native-turn',
    'input-messages': ['Old command [codercrew-command:12345678-1234-4234-8234-123456789abc]', prompt, 'Unmarked clarification.'],
    'last-assistant-message': 'Committed.', background_tasks: [], session_crons: [] }, target.identity, binding));
  await plane.recordEvent(event);
  assert.equal(sent.length, 2); assert.equal(run(input.requestId).status, 'running');
  const next = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.notEqual(next.agentId, input.agentId); assert.equal(next.implementation!.identity.reviewHead, candidate);
  await plane.recordEvent(event); assert.equal(sent.length, 2);
});
test('plain Send works without legacy mode, leaves Git untouched, and completes without a commit or review', async () => {
  git('switch', 'main'); appendFileSync(join(root, 'app.txt'), 'uncommitted');
  const before = git('rev-parse', 'HEAD'); const status = git('status', '--porcelain');
  const input = instruction();
  assert.equal((await plane.submitStandalone(input)).status, 'delivered');
  assert.equal(run(input.requestId).implementation, undefined); assert.equal(run(input.requestId).autoContinue, false);
  assert.equal(sent[0], `${input.text} [codercrew-command:${input.requestId}]`);
  await plane.submitStandalone(input); assert.equal(sent.length, 1);
  await assert.rejects(plane.submitStandalone({ ...input, text: 'Changed' }), /another instruction/);
  await assert.rejects(plane.submitStandalone(instruction()), /execution owner/);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(sent.length, 1);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), null);
  assert.equal(git('rev-parse', 'HEAD'), before); assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), status);
  assert.equal((await plane.state()).commands[0]!.groupId, group.id);
});
test('plain Send validates roles, stale instances, readiness, and refuses commit/relay options', async () => {
  const input = instruction();
  assert.throws(() => parseStandalone({ ...input, handoff: true }), /Unknown standalone/);
  assert.throws(() => parseStandalone({ ...input, confirmReady: false }), /readiness/);
  await assert.rejects(plane.submitStandalone({ ...input, registrations: { ...input.registrations, codex: randomUUID() } }), /registered instance changed/);
  await assert.rejects(plane.submitStandalone({ ...input, policy: 'worker_reviewer', workerId: 'claude' }), /assigned worker/);
  assert.equal(sent.length, 0);
});
test('plain Send retains ownership for active background work and survives restart without replay', async () => {
  const input = instruction(); await plane.submitStandalone(input);
  await complete(input.requestId, { backgroundState: 'active' });
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.deepEqual(run(input.requestId).standalone, input);
  await plane.submitStandalone(input); assert.equal(sent.length, 1);
});
for (const backgroundState of ['active', 'unknown'] as const) test(`a finished native turn is idle while ${backgroundState} background work still blocks committed relay`, async () => {
  const input = request(); await plane.submitImplementation(input);
  const native = { ...event(input.requestId), event: 'turn_started' as const, cliPid: '100', startedAt: new Date().toISOString() };
  await plane.recordEvent(native);
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'working');
  publish(input.requestId, true);
  adapter.trees.set('codex', [{ pid: '300', command: 'npm run dev' }, { pid: '301', command: 'next-server' }]);
  await plane.recordEvent({ ...native, event: 'turn_complete', settled: true, backgroundState });
  assert.equal((await plane.state()).activities!.find((a) => a.agentId === 'codex')!.state, 'idle');
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /background work/i);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId); assert.equal(sent.length, 1);
  // Activity is observational: neither a second state read nor a duplicate finish releases ownership or relays.
  await plane.state(); await plane.recordEvent({ ...native, event: 'turn_complete', settled: true, backgroundState });
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId); assert.equal(sent.length, 1);
});

test('the documented local handoff command bypasses a rejecting commit-msg hook without changing its configuration', () => {
  const hooks = join(directory, 'hooks'); mkdirSync(hooks);
  const hook = join(hooks, 'commit-msg'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  git('config', 'core.hooksPath', hooks);
  appendFileSync(join(root, 'app.txt'), 'candidate'); git('add', 'app.txt');
  const args = ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
  assert.throws(() => execFileSync('git', [...args, 'commit', '-m', 'handoff'], { stdio: 'pipe' }));
  const skill = readFileSync(join(process.cwd(), '../skills/commit-handoff/SKILL.md'), 'utf8');
  assert.ok(skill.includes('git -c core.hooksPath=/dev/null commit'));
  execFileSync('git', [...args, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'handoff'], { stdio: 'pipe' });
  assert.equal(execFileSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(), hooks);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 1\n');
});

for (const newBranch of [false, true]) test(`Commit snapshots staged, unstaged and untracked work${newBranch ? ' on a confirmed new branch' : ''}`, async () => {
  appendFileSync(join(root, 'app.txt'), 'staged\n'); git('add', 'app.txt'); appendFileSync(join(root, 'app.txt'), 'unstaged\n');
  writeFileSync(join(root, 'new.txt'), 'unfinished\n');
  const input = parseImplementation(request({ kind: 'commit', text: undefined, handoff: false, autoContinue: false })); if (newBranch) input.branch.newBranch = 'task/snapshot';
  const before = git('status', '--porcelain=v1'); const index = readFileSync(join(root, '.git', 'index'));
  assert.equal((await plane.submitImplementation(input)).status, 'delivered');
  assert.equal(git('status', '--porcelain=v1'), before); assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.equal(git('rev-parse', 'HEAD'), input.branch.head);
  const path = join(plane.workflow.assignmentDirectory, `${input.requestId}.json`);
  const assignment = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(assignment.commitOnly, true);
  assert.match(assignment.instruction, /Do not implement pending requests/);
  assert.match(assignment.initialWorktreeFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(assignment.initialWorktreeFingerprint, run(input.requestId).implementation!.initialWorktreeFingerprint);
  const verify = () => execFileSync(process.execPath, ['--experimental-strip-types', join(process.cwd(), '../skills/commit-handoff/scripts/verify-input.ts'), path], { stdio: 'pipe' });
  assert.match(verify().toString(), /verified/);
  await plane.submitImplementation(input); assert.equal(sent.length, 1);
  appendFileSync(join(root, 'new.txt'), 'finished\n');
  assert.throws(verify); // Same path/status, different bytes: the captured input is no longer current.
  writeFileSync(join(root, 'new.txt'), 'unfinished\n');
  git('add', 'new.txt'); const candidate = publish(input.requestId);
  await complete(input.requestId);
  assert.equal(sent.length, 1); assert.equal(run(input.requestId).status, 'completed');
  assert.equal(run(input.requestId).implementation!.candidateSha, candidate);
  await complete(input.requestId); assert.equal(sent.length, 1);
  const reviewInput = request({ kind: 'review', agentId: 'claude', reviewBase: input.branch.head });
  await plane.submitImplementation(reviewInput); assert.equal(sent.length, 2);
  const review = reviewInput.requestId;
  const next = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${review}.json`), 'utf8'));
  assert.equal(next.commitOnly, undefined); assert.equal(next.initialWorktreeFingerprint, undefined); assert.equal(next.identity.reviewHead, candidate);
  assert.equal(next.identity.reviewBase, input.branch.head);
  assert.equal(git('show', `${candidate}:new.txt`), 'unfinished');
  assert.equal(git('show', `${candidate}:app.txt`), 'baseline\nstaged\nunstaged');
  assert.equal(git('rev-list', '--count', `${input.branch.head}..${candidate}`), '1');
  publish(review); await complete(review); assert.equal(run(reviewInput.requestId).status, 'completed');
});
test('unfinished work changing during setup retains ownership and never dispatches', async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished\n'); const input = request();
  const claim = plane.workflow.claimSetup.bind(plane.workflow);
  plane.workflow.claimSetup = (id) => { const claimed = claim(id); if (claimed) appendFileSync(join(root, 'app.txt'), 'external writer\n'); return claimed; };
  await assert.rejects(plane.submitImplementation(input), /unfinished work changed/);
  assert.equal(sent.length, 0); assert.equal(run(input.requestId).implementation!.setup, 'uncertain');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  await assert.rejects(plane.submitImplementation(input)); assert.equal(sent.length, 0);
});
test('captured unfinished work cannot authorize a changed branch, tip, or a dirty later turn', async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished\n'); const input = request();
  await plane.submitImplementation(input); const fingerprint = run(input.requestId).implementation!.initialWorktreeFingerprint;
  await assert.rejects(assertWorktreeInput(root, 'task/other', input.branch.head, fingerprint), /branch or commit changed/);
  await assert.rejects(assertWorktreeInput(root, input.branch.branch, 'f'.repeat(40), fingerprint), /branch or commit changed/);
  await assert.rejects(assertWorktreeInput(root, input.branch.branch, input.branch.head), /must be clean/);
});
test('Send & relay rejects an already modified relay log without committing or discarding it', async () => {
  writeFileSync(join(root, 'RELAY-LOG.jsonl'), 'unfinished journal');
  await assert.rejects(plane.submitImplementation(request()), /relay log has uncommitted changes/);
  assert.equal(readFileSync(join(root, 'RELAY-LOG.jsonl'), 'utf8'), 'unfinished journal'); assert.equal(sent.length, 0);
});

test('unfinished work changing after setup is rejected at dispatch without refreshing the captured input', async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished\n'); const input = request();
  adapter.preflight = async () => { if (plane.workflow.run(input.requestId)?.implementation?.setup === 'ready') appendFileSync(join(root, 'app.txt'), 'external writer\n'); };
  const result = await plane.submitImplementation(input);
  assert.equal(result.status, 'rejected'); assert.match(result.error!, /unfinished work changed/);
  assert.equal(sent.length, 0); assert.equal(run(input.requestId).status, 'paused');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  await plane.submitImplementation(input); assert.equal(sent.length, 0);
});
test('restart preserves the captured unfinished input without redelivery', async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished\n'); const input = request(); await plane.submitImplementation(input);
  const fingerprint = run(input.requestId).implementation!.initialWorktreeFingerprint;
  plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.equal(run(input.requestId).implementation!.initialWorktreeFingerprint, fingerprint);
  assert.equal(run(input.requestId).status, 'paused');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  await plane.submitImplementation(input); assert.equal(sent.length, 1);
});

for (const policy of ['peer', 'worker_reviewer'] as const) for (const autoContinue of [false, true]) test(`Commit and relay snapshots before review with ${policy}, automatic=${autoContinue}`, async () => {
  const reviewBase = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'earlier committed work\n'); git('add', 'app.txt'); git('commit', '-m', 'earlier candidate');
  appendFileSync(join(root, 'app.txt'), 'staged\n'); git('add', 'app.txt'); appendFileSync(join(root, 'app.txt'), 'unstaged\n');
  writeFileSync(join(root, 'new.txt'), 'unfinished\n');
  const input = parseImplementation(request({ kind: 'commit', text: undefined, handoff: true, reviewBase, autoContinue, policy, ...(policy === 'worker_reviewer' ? { workerId: 'codex' } : {}) }));
  const before = git('status', '--porcelain'); const index = readFileSync(join(root, '.git', 'index'));
  await plane.submitImplementation(input); await plane.submitImplementation(input);
  assert.equal(sent.length, 1); assert.equal(git('rev-parse', 'HEAD'), input.branch.head);
  assert.equal(git('status', '--porcelain'), before); assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  const assignment = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${input.requestId}.json`), 'utf8'));
  assert.equal(assignment.commitOnly, true); assert.ok(assignment.initialWorktreeFingerprint);
  assert.match(assignment.instruction, /Do not implement pending requests/); assert.match(assignment.instruction, /controller will relay/);
  git('add', 'new.txt'); const candidate = publish(input.requestId);
  assert.equal(sent.length, 1); // A commit by itself is not settled completion.
  await Promise.all([complete(input.requestId), complete(input.requestId)]);
  assert.equal(sent.length, 2);
  const reviewer = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(reviewer.agentId, 'claude'); assert.equal(reviewer.implementation!.identity.action, policy === 'peer' ? 'review_and_improve' : 'review');
  assert.equal(reviewer.implementation!.identity.reviewBase, reviewBase); assert.equal(reviewer.implementation!.identity.reviewHead, candidate);
  const next = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${reviewer.commandId}.json`), 'utf8'));
  assert.equal(next.commitOnly, undefined); assert.equal(next.initialWorktreeFingerprint, undefined);
  assert.equal(git('show', `${candidate}:new.txt`), 'unfinished'); assert.equal(git('show', `${candidate}:app.txt`), 'baseline\nearlier committed work\nstaged\nunstaged');
  publish(reviewer.commandId); await complete(reviewer.commandId);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(sent.length, 2);
});
test('pending snapshot previews preserve baseline choices, include HEAD, and never change dirty input', async () => {
  const base = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'committed\n'); git('add', 'app.txt'); git('commit', '-m', 'Earlier work');
  const head = git('rev-parse', 'HEAD'); appendFileSync(join(root, 'app.txt'), 'staged\n'); git('add', 'app.txt');
  appendFileSync(join(root, 'app.txt'), 'unstaged\n'); writeFileSync(join(root, 'new.txt'), 'untracked\n');
  const input = parseReviewPreview({ groupId: group.id, head, logPath: 'RELAY-LOG.jsonl', recipient: 'claude', taskBase: base, commitPending: true });
  const index = readFileSync(join(root, '.git', 'index')); const status = git('status', '--porcelain');
  const preview = await plane.previewReview(input);
  assert.deepEqual(preview.candidates.map((c) => c.sha), [base, head]); assert.equal(preview.commits.length, 1);
  const current = await plane.previewReview({ groupId: group.id, head, logPath: input.logPath, base: head, commitPending: true });
  assert.deepEqual(current.commits, []); assert.deepEqual(current.candidates, [{ sha: head, subject: 'Earlier work' }]);
  const derived = await plane.previewReview({ ...input, taskBase: head });
  assert.equal(derived.base, head); assert.deepEqual(derived.commits, []);
  await assert.rejects(plane.previewReview({ ...input, head: base }), /HEAD changed/);
  await assert.rejects(plane.previewReview({ groupId: group.id, head, logPath: input.logPath, base: head }), /no project proposal/);
  assert.throws(() => parseReviewPreview({ ...input, commitPending: 'yes' }), /boolean/);
  assert.equal(git('status', '--porcelain'), status); assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
});
test('commit and relay validates the selected baseline inside the task and permits HEAD for current changes only', async () => {
  const beforeTask = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'integration\n'); git('add', 'app.txt'); git('commit', '-m', 'Integration baseline');
  const taskBase = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'unfinished\n');
  const input = request({ kind: 'commit', handoff: true, reviewBase: taskBase, autoContinue: false,
    branch: { branch: 'task/fixture', head: taskBase, taskBase } });
  await assert.rejects(plane.submitImplementation({ ...input, reviewBase: beforeTask }), /precedes the task baseline/);
  await assert.rejects(plane.submitImplementation({ ...input, reviewBase: 'f'.repeat(40) }), /Git inspection failed|ancestor/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
  await plane.submitImplementation(input); const candidate = publish(input.requestId); await complete(input.requestId);
  const review = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(review.implementation!.identity.reviewBase, taskBase); assert.equal(review.implementation!.identity.reviewHead, candidate);
});
test('commit and relay keeps earlier selected changes when the snapshot has no net project change', async () => {
  const reviewBase = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'earlier work\n'); git('add', 'app.txt'); git('commit', '-m', 'Earlier proposal');
  const contents = readFileSync(join(root, 'app.txt'), 'utf8');
  appendFileSync(join(root, 'app.txt'), 'staged only\n'); git('add', 'app.txt'); writeFileSync(join(root, 'app.txt'), contents);
  const input = request({ kind: 'commit', handoff: true, reviewBase, autoContinue: false });
  await plane.submitImplementation(input); const candidate = publish(input.requestId); await complete(input.requestId);
  assert.equal(sent.length, 2);
  const review = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(review.implementation!.identity.reviewBase, reviewBase); assert.equal(review.implementation!.identity.reviewHead, candidate);
});
for (const fault of ['missing publication', 'leftovers', 'human decision'] as const) test(`Commit and relay never dispatches a peer with ${fault}`, async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished\n');
  const input = request({ kind: 'commit', text: undefined, handoff: true, autoContinue: true }); await plane.submitImplementation(input);
  if (fault !== 'missing publication') publish(input.requestId, false, fault === 'human decision' ? { needsHuman: true, summary: 'A scope decision is needed.' } : {});
  if (fault === 'leftovers') appendFileSync(join(root, 'app.txt'), 'external writer\n');
  await complete(input.requestId); assert.equal(sent.length, 1); assert.equal(run(input.requestId).status, 'paused');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
});
test('commit snapshot rejects clean input and automatic continuation without a handoff', async () => {
  const input = request({ kind: 'commit', text: undefined, handoff: false, autoContinue: false });
  assert.equal(parseImplementation(input).text, undefined);
  assert.equal(parseImplementation({ ...input, handoff: true }).handoff, true);
  assert.throws(() => parseImplementation({ ...input, autoContinue: true }), /without relay/);
  await assert.rejects(plane.submitImplementation({ ...input, autoContinue: true }), /without relay/);
  assert.equal(parseImplementation({ ...input, handoff: true, reviewBase: input.branch.head }).reviewBase, input.branch.head);
  assert.throws(() => parseImplementation({ ...input, reviewBase: input.branch.head }), /requires relay/);
  await assert.rejects(plane.submitImplementation({ ...input, reviewBase: input.branch.head }), /requires relay/);
  await assert.rejects(plane.submitImplementation({ ...input, handoff: true }), /no uncommitted changes/);
  await assert.rejects(plane.submitImplementation(input), /no uncommitted changes/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
});
test('commit snapshot targets the fixed worker and treats text as context, not an implementation instruction', async () => {
  appendFileSync(join(root, 'app.txt'), 'unfinished work\n');
  const input = request({ kind: 'commit', handoff: false, autoContinue: false, policy: 'worker_reviewer', workerId: 'codex', text: 'Still pending: add retry support.' });
  await assert.rejects(plane.submitImplementation({ ...input, agentId: 'claude' }), /Work targets the assigned worker/);
  await plane.submitImplementation(input);
  const assignment = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${input.requestId}.json`), 'utf8'));
  assert.equal(assignment.commitOnly, true); assert.equal(assignment.task, input.text);
  assert.match(assignment.instruction, /Do not implement pending requests/);
  assert.equal(assignment.identity.action, 'work');
  const candidate = publish(input.requestId, false, { summary: 'Snapshot; retry support remains unfinished.' });
  await complete(input.requestId);
  assert.equal(sent.length, 1); assert.equal(run(input.requestId).status, 'completed');
  const review = request({ kind: 'review', agentId: 'claude', policy: 'worker_reviewer', workerId: 'codex', reviewBase: input.branch.head });
  await plane.submitImplementation(review);
  const next = plane.workflow.execution(review.requestId)!;
  assert.equal(next.agentId, 'claude'); assert.equal(next.implementation!.identity.action, 'review');
  assert.equal(next.implementation!.identity.reviewHead, candidate);
});

for (const mode of ['inMode', 'synchronized'] as const) test(`publication in ${mode} records the commit and relays to the other pane`, async () => {
  const input = request(); await plane.submitImplementation(input);
  const candidate = publish(input.requestId, true);
  const inspect = adapter.inspect.bind(adapter);
  adapter.inspect = async (id) => ({ ...await inspect(id), ...(id === '%0' ? { [mode]: true } : {}) });
  adapter.preflight = async (session?: SessionRegistration) => { assert.ok(session); assertIdentity(session, await adapter.inspect(session.identity.paneId)); };
  await complete(input.requestId);
  assert.equal(run(input.requestId).implementation!.latestPublication!.sha, candidate);
  assert.equal(sent.length, 2); assert.equal(run(input.requestId).status, 'running');
  const next = plane.workflow.execution(run(input.requestId).currentCommandId)!;
  assert.equal(next.agentId, 'claude'); assert.equal(next.status, 'delivered');
  assert.equal(next.implementation!.identity.reviewHead, candidate);
  await complete(input.requestId); assert.equal(sent.length, 2);
});
for (const mode of ['inMode', 'synchronized'] as const) test(`publication survives a peer in ${mode} but delivery to that pane stays blocked`, async () => {
  const input = request(); await plane.submitImplementation(input);
  const candidate = publish(input.requestId, true);
  const inspect = adapter.inspect.bind(adapter);
  adapter.inspect = async (id) => ({ ...await inspect(id), ...(id === '%1' ? { [mode]: true } : {}) });
  adapter.preflight = async (session?: SessionRegistration) => { assert.ok(session); assertIdentity(session, await adapter.inspect(session.identity.paneId)); };
  await complete(input.requestId);
  assert.equal(run(input.requestId).implementation!.latestPublication!.sha, candidate);
  assert.equal(sent.length, 1); assert.equal(run(input.requestId).status, 'paused');
  assert.equal(plane.workflow.execution(run(input.requestId).currentCommandId)!.status, 'rejected');
  assert.match(run(input.requestId).reason, /copy mode|synchronized/);
});

test('solo Commit snapshots unfinished input and completes without a successor', async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  appendFileSync(join(root, 'app.txt'), 'unfinished\n');
  const input = request({ groupId: solo.id, kind: 'commit', policy: 'solo', handoff: false, autoContinue: false });
  await plane.submitImplementation(parseImplementation(input));
  const candidate = publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'completed'); assert.equal(sent.length, 1);
  assert.equal(run(input.requestId).implementation!.candidateSha, candidate);
  assert.equal(git('show', `${candidate}:app.txt`), 'baseline\nunfinished');
});
// A handoff entry as an agent would commit it; only the fields the journal validator and provenance need to be realistic.
function journalEntry(agentId: string, parent: string): string {
  return `${JSON.stringify({ schema: 1, phase: 'implementation', runId: randomUUID(), commandId: randomUUID(), turn: 1, policyRevision: 1, action: 'work', agentId, registrationId: randomUUID(), parent, base: parent, reviewBase: null, reviewHead: null, model: 'fixture', decision: null, reason: null, needsHuman: false, summary: 'Fixture handoff', checks: [] })}\n`;
}
test('preview derives the range from the recipient\'s last handoff commit, else the task baseline, without changing Git, ownership or delivery', async () => {
  const base = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'first\n'); git('add', 'app.txt'); git('commit', '-m', 'First change'); const first = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'second\n'); git('add', 'app.txt'); git('commit', '-m', 'Second change'); const second = git('rev-parse', 'HEAD');
  const input = parseReviewPreview({ groupId: group.id, head: second, logPath: 'RELAY-LOG.jsonl', recipient: 'claude', taskBase: base });
  const before = store.db.prepare('SELECT total_changes() AS count').get(); const index = readFileSync(join(root, '.git', 'index'));
  // Claude has published nothing here: everything since the task baseline is new to it.
  assert.deepEqual(await plane.previewReview(input), { base, baseSubject: 'baseline', head: second, since: 'task', commits: [{ sha: second, subject: 'Second change' }, { sha: first, subject: 'First change' }], candidates: [{ sha: base, subject: 'baseline' }, { sha: first, subject: 'First change' }] });
  assert.deepEqual(await plane.previewReview({ groupId: group.id, head: second, logPath: 'RELAY-LOG.jsonl', base: first }), { base: first, baseSubject: 'First change', head: second, since: 'explicit', commits: [{ sha: second, subject: 'Second change' }], candidates: [{ sha: first, subject: 'First change' }] });
  assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), before);
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index); assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', 'HEAD'), second); assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
  // Once Claude publishes (a log-only review counts), only the commits after its handoff are new to it; Codex's are not.
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('codex', first)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Codex handoff');
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', git('rev-parse', 'HEAD'))); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Claude review'); const reviewed = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'third\n'); appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('codex', reviewed)); git('add', 'app.txt', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Third change'); const head = git('rev-parse', 'HEAD');
  assert.deepEqual(await plane.previewReview({ ...input, head }), { base: reviewed, baseSubject: 'Claude review', head, since: 'recipient', commits: [{ sha: head, subject: 'Third change' }], candidates: [{ sha: reviewed, subject: 'Claude review' }] });
  await assert.rejects(plane.previewReview({ ...input, head, recipient: 'codex' }), /no project proposal/); // Codex published HEAD: nothing new to it.
  const review = request({ kind: 'review', agentId: 'claude', reviewBase: reviewed });
  await plane.submitImplementation(review);
  assert.equal(plane.workflow.execution(review.requestId)!.implementation!.identity.reviewBase, reviewed);
  assert.equal(plane.workflow.execution(review.requestId)!.implementation!.identity.reviewHead, head);
});
test('preview refuses stale HEAD, log-only proposals, invalid groups or recipients, foreign baselines and unbounded ranges', async () => {
  const base = git('rev-parse', 'HEAD'); const input = { groupId: group.id, head: base, logPath: 'RELAY-LOG.jsonl', recipient: 'claude', taskBase: base };
  await assert.rejects(plane.previewReview(input), /no project proposal/);
  appendFileSync(join(root, 'app.txt'), 'proposal\n'); git('add', 'app.txt'); git('commit', '-m', 'Proposal'); const proposal = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', proposal)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Report only'); const head = git('rev-parse', 'HEAD');
  await assert.rejects(plane.previewReview({ ...input, head: proposal }), /HEAD changed/);
  await assert.rejects(plane.previewReview({ ...input, head }), /no project proposal/); // Claude's own log-only commit is HEAD.
  assert.equal((await plane.previewReview({ ...input, head, recipient: 'codex' })).commits.length, 2);
  await assert.rejects(plane.previewReview({ ...input, head, groupId: 'missing' }), /Recheck/);
  await assert.rejects(plane.previewReview({ ...input, head, recipient: 'other' }), /recipient/);
  await assert.rejects(plane.previewReview({ ...input, head, taskBase: 'f'.repeat(40) }), /Git inspection failed|ancestor/);
  assert.throws(() => parseReviewPreview({ ...input, repository: root }), /Unknown/);
  assert.throws(() => parseReviewPreview({ groupId: group.id, head, logPath: 'RELAY-LOG.jsonl', base: 'HEAD~2' }), /full Git object ID/);
  for (const fields of [{}, { recipient: 'claude' }, { taskBase: base }, { base, recipient: 'claude' }, { base, taskBase: base }]) assert.throws(() => parseReviewPreview({ groupId: group.id, head, logPath: 'RELAY-LOG.jsonl', ...fields }), /explicit baseline, or the recipient/);
  // Build bounded objects without moving the checkout during preview.
  for (let i = 0; i < 99; i++) git('commit', '--allow-empty', '-m', `Checkpoint ${i}`);
  await assert.rejects(plane.previewReview({ ...input, head: git('rev-parse', 'HEAD'), recipient: 'codex' }), /exceeds 100 commits/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []);
});

test('provenance requires a real handoff commit: merged, imported or rewritten journal entries never advance the baseline', async () => {
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'task/side'); writeFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', base)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Side handoff');
  const side = git('rev-parse', 'HEAD');
  git('switch', 'task/fixture'); writeFileSync(join(root, 'unreviewed-main.txt'), 'main\n'); git('add', 'unreviewed-main.txt'); git('commit', '-m', 'Main change'); const main = git('rev-parse', 'HEAD');
  await assert.rejects(plane.previewReview({ groupId: group.id, head: main, base: side, logPath: 'RELAY-LOG.jsonl' }), /must be an ancestor/);
  const input = { groupId: group.id, head: main, logPath: 'RELAY-LOG.jsonl', recipient: 'claude', taskBase: base };
  assert.deepEqual(await plane.previewReview(input), { base, baseSubject: 'baseline', head: main, since: 'task', commits: [{ sha: main, subject: 'Main change' }], candidates: [{ sha: base, subject: 'baseline' }] });
  // Claude's side handoff never saw the main-branch change; merging its entry in is not a receipt for this checkout.
  git('merge', '--no-ff', 'task/side', '-m', 'Merge side'); const merge = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'after\n'); git('add', 'app.txt'); git('commit', '-m', 'After merge'); const head = git('rev-parse', 'HEAD');
  const preview = await plane.previewReview({ ...input, head });
  assert.equal(preview.since, 'task'); assert.equal(preview.base, base);
  assert.deepEqual(preview.commits.map((c) => c.subject), ['After merge', 'Merge side', 'Main change', 'Side handoff']);
  assert.deepEqual(git('diff', '--name-only', `${preview.base}..${head}`).split('\n').sort(), ['RELAY-LOG.jsonl', 'app.txt', 'unreviewed-main.txt']);
  // Later baselines follow HEAD's first parents only, so "the last commit only" is HEAD against its first parent, never a side tip.
  assert.deepEqual(preview.candidates, [{ sha: base, subject: 'baseline' }, { sha: main, subject: 'Main change' }, { sha: merge, subject: 'Merge side' }]);
  assert.deepEqual((await plane.previewReview({ groupId: group.id, head, base: merge, logPath: 'RELAY-LOG.jsonl' })).commits, [{ sha: head, subject: 'After merge' }]);
  // A rewritten journal, or one commit appending two entries, is not a handoff by anyone.
  writeFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', head)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Rewritten journal'); const rewritten = git('rev-parse', 'HEAD');
  assert.equal((await plane.previewReview({ ...input, head: rewritten })).since, 'task');
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', rewritten) + journalEntry('claude', rewritten)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Imported entries'); const imported = git('rev-parse', 'HEAD');
  assert.equal((await plane.previewReview({ ...input, head: imported })).since, 'task');
  // An entry naming the wrong parent is not this commit's handoff either; the exact shape readPublication accepts is.
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', base)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Wrong parent'); const wrong = git('rev-parse', 'HEAD');
  assert.equal((await plane.previewReview({ ...input, head: wrong })).since, 'task');
  appendFileSync(join(root, 'RELAY-LOG.jsonl'), journalEntry('claude', wrong)); git('add', 'RELAY-LOG.jsonl'); git('commit', '-m', 'Claude handoff'); const handoff = git('rev-parse', 'HEAD');
  appendFileSync(join(root, 'app.txt'), 'later\n'); git('add', 'app.txt'); git('commit', '-m', 'Later'); const later = git('rev-parse', 'HEAD');
  assert.deepEqual(await plane.previewReview({ ...input, head: later }), { base: handoff, baseSubject: 'Claude handoff', head: later, since: 'recipient', commits: [{ sha: later, subject: 'Later' }], candidates: [{ sha: handoff, subject: 'Claude handoff' }] });
  assert.equal(sent.length, 0);
});
