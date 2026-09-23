import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import { resolveWorktree } from '../src/server/worktree.ts';
import { planHash, validatePlanPaths } from '../src/server/planning-documents.ts';
import { assertIdentity } from '../src/core/policy.ts';
import type { SessionRegistration } from '../src/contracts/api.ts';
import { consumePlan, newPlanning, planAgreed } from '../src/server/planning-state.ts';
import { parsePlan, parsePlanDecision } from '../src/core/planning-validation.ts';
import type { Group } from '../src/contracts/implementation.ts';
import type { PlanDecision, PlanResult, PlanStart, PlanningAssignment } from '../src/contracts/planning.ts';
import type { HookEvent, ManagedSession } from '../src/contracts/workflow.ts';

// Real disposable Git/SQLite/files, fake terminal delivery and correlated lifecycle evidence.
let directory: string; let root: string; let store: Store; let adapter: MockAdapter; let plane: ControlPlane; let group: Group; let sent: string[];
const config = () => loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: join(directory, 'metadata') });
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'codercrew-planning-'))); root = join(directory, 'repo'); mkdirSync(root);
  git('init', '-b', 'main'); writeFileSync(join(root, 'app.txt'), 'baseline\n'); git('add', 'app.txt'); git('commit', '-m', 'baseline'); // no ignore rule: plans stay out of the checkout
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
  plane = new ControlPlane(new Controller(config(), store, adapter)); group = await plane.createGroup({ name: 'Planners', members: ['codex', 'claude'] });
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const run = (id: string) => plane.workflow.run(id)!;
const registrations = (selected: Group) => Object.fromEntries(selected.members.map((id) => [id, (store.sessions().find((s) => s.id === id) as ManagedSession).registrationId]));
function request(more: Partial<PlanStart> = {}): PlanStart {
  const selected = store.groups().find((g) => g.id === (more.groupId ?? group.id))!;
  const baseline = { branch: git('branch', '--show-current') || null, head: git('rev-parse', 'HEAD') };
  return { requestId: randomUUID(), groupId: selected.id, groupRevision: selected.revision, registrations: registrations(selected), text: 'Plan the requested feature', baseline,
    autoContinue: true, requireApproval: true, turnLimit: 20, implementation: { groupId: selected.id, groupRevision: selected.revision, registrations: registrations(selected), agentId: selected.members[0]!,
      policy: selected.members.length === 1 ? 'solo' : 'peer', handoff: selected.members.length > 1, branch: baseline }, confirmReady: true, ...more };
}
function assignment(commandId: string): PlanningAssignment { return JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${commandId}.json`), 'utf8')); }
function publish(commandId: string, text = '# Plan\nImplement and verify the task.\n', fields: Partial<PlanResult> = {}) {
  const turn = plane.workflow.execution(commandId)!.planning!;
  const path = turn.identity.outputPath; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
  const result: PlanResult = { identity: turn.identity, outcome: turn.identity.action === 'review' ? 'accept' : 'complete', outputHash: planHash(text), model: 'unknown', summary: 'Fixture planning result', reason: null, ...fields };
  writeFileSync(turn.resultPath, JSON.stringify(result)); return result;
}
function event(commandId: string, more: Partial<HookEvent> = {}): HookEvent {
  const turn = plane.workflow.execution(commandId)!; const member = run(turn.runId).participants.find((p) => p.id === turn.agentId)!;
  return { commandId, event: 'turn_complete', source: member.agentType, sourceTurnId: `turn-${commandId}`, sessionId: `session-${member.id}`, paneId: member.identity.paneId,
    socketPath: member.identity.socketPath, identity: member.identity, prompt: turn.wireText, backgroundState: 'clear', settled: true, ...more };
}
async function complete(commandId: string, more: Partial<HookEvent> = {}) {
  const input = event(commandId, more); if (input.source === 'claude') await plane.recordEvent({ ...input, event: 'turn_started' }); return plane.recordEvent(input);
}
function decision(id: string, more: Partial<PlanDecision> = {}): PlanDecision {
  const r = run(id); const p = r.planning!;
  return { runId: id, expectedCommandId: r.currentCommandId, expectedRevision: p.current!.revision, expectedHash: p.current!.hash,
    expectedBriefRevision: p.briefRevision, expectedPolicyRevision: p.policyRevision, action: 'approve', confirmReady: true, ...more };
}
async function finishPlan(id: string) {
  while (run(id).status === 'running' && !run(id).implementation) { const command = run(id).currentCommandId; publish(command); await complete(command); }
}
test('Plan binds discovered solo identity at Start and keeps the frozen binding into Implementation', async () => {
  const template = request(); plane.removeGroup(group.id); plane.remove('codex'); plane.remove('claude');
  const list = adapter.listPanes.bind(adapter); adapter.listPanes = async () => (await list()).filter((pane) => pane.identity.paneId === '%0');
  adapter.foreground = async () => '500';
  const view = await plane.state(); const solo = view.groups[0]!; const member = view.sessions[0]!;
  assert.deepEqual(store.sessions(), []); assert.deepEqual(sent, []);
  const selection = { groupId: solo.id, groupRevision: solo.revision, registrations: { [member.id]: member.registrationId } };
  const input = parsePlan({ ...template, ...selection, implementation: { ...template.implementation, ...selection, agentId: member.id, policy: 'solo', handoff: false } });
  assert.equal((await plane.submitPlan(input)).status, 'delivered');
  assert.equal((store.sessions()[0] as ManagedSession).registrationId, member.registrationId);
  await finishPlan(input.requestId); assert.equal(run(input.requestId).status, 'waiting');
  await plane.decidePlan(decision(input.requestId));
  assert.equal(run(input.requestId).implementation!.policy, 'solo');
  assert.equal(run(input.requestId).participants[0]!.registrationId, member.registrationId);
});
test('larger saved groups cannot bypass the Plan execution limit', async () => {
  plane.removeGroup(group.id); await plane.register({ paneId: '%3', label: 'Third' });
  group = await plane.createGroup({ name: 'Larger', members: ['codex', 'claude', 'third'] });
  await assert.rejects(plane.submitPlan(request()), /one or two distinct planners/);
  assert.deepEqual(sent, []); assert.deepEqual(plane.workflow.runs(), []); assert.equal(git('status', '--porcelain'), '');
});
for (const kind of ['unstaged', 'staged', 'mixed', 'untracked'] as const) test(`Plan refuses ${kind} changes without adopting user work or creating its implementation branch`, async () => {
  const input = request(); input.implementation.branch!.newBranch = 'task/after-dirty-plan';
  if (kind === 'untracked') writeFileSync(join(root, 'new.txt'), 'untracked\n');
  else { appendFileSync(join(root, 'app.txt'), 'changed\n'); if (kind !== 'unstaged') git('add', 'app.txt'); if (kind === 'mixed') appendFileSync(join(root, 'app.txt'), 'unstaged\n'); }
  const before = git('status', '--porcelain=v1'); const index = readFileSync(join(root, '.git', 'index'));
  await assert.rejects(plane.submitPlan(input), /clean/);
  assert.equal(git('status', '--porcelain=v1'), before); assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.equal(git('branch', '--show-current'), 'task/fixture'); assert.equal(git('branch', '--list', 'task/after-dirty-plan'), ''); assert.equal(sent.length, 0);
  assert.equal(plane.workflow.run(input.requestId), undefined);
});
test('sequential independent drafts open one complete-roster barrier, then exact-version agreement waits for approval', async () => {
  const input = parsePlan(request()); await plane.submitPlan(input); await plane.submitPlan(input); assert.equal(sent.length, 1);
  const first = assignment(input.requestId); assert.equal(first.drafts, undefined); assert.equal(first.plan, undefined);
  publish(input.requestId, '\uFEFF# Codex draft\n'); await Promise.all([complete(input.requestId), complete(input.requestId)]);
  assert.equal(run(input.requestId).planning!.drafts.codex!.document!.text, '\uFEFF# Codex draft\n');
  assert.equal(sent.length, 2); const second = run(input.requestId).currentCommandId;
  assert.equal(assignment(second).drafts, undefined); assert.doesNotMatch(JSON.stringify(assignment(second)), /Codex draft/);
  assert.equal(run(input.requestId).planning!.drafts.claude!.status, 'running');
  publish(second, '# Claude draft\n'); await complete(second);
  assert.equal(sent.length, 3); const synthesis = run(input.requestId).currentCommandId;
  assert.equal(assignment(synthesis).drafts!.length, 2); assert.equal(assignment(synthesis).identity.action, 'synthesize');
  publish(synthesis); await complete(synthesis); const review = run(input.requestId).currentCommandId;
  assert.equal(assignment(review).identity.inputRevision, 1); assert.equal(run(input.requestId).planning!.endorsements.codex, 1);
  publish(review); await complete(review);
  assert.equal(run(input.requestId).status, 'waiting'); assert.ok(planAgreed(run(input.requestId).planning!)); assert.equal(sent.length, 4);
  assert.equal(git('status', '--porcelain'), ''); assert.equal(git('rev-parse', 'HEAD'), input.baseline.head);
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
  const approval = decision(input.requestId); await Promise.allSettled([plane.decidePlan(approval), plane.decidePlan(approval)]);
  assert.equal(sent.length, 5); assert.equal(run(input.requestId).implementation!.turn, 1);
  await plane.decidePlan(approval); assert.equal(sent.length, 5);
  const frozen = run(input.requestId).planning!.frozen!; assert.equal(frozen.authority, 'human'); assert.equal(frozen.plan.text, '# Plan\nImplement and verify the task.\n');
  const implementation = JSON.parse(readFileSync(join(plane.workflow.assignmentDirectory, `${run(input.requestId).currentCommandId}.json`), 'utf8'));
  assert.deepEqual(implementation.frozenPlan, frozen); assert.equal(run(input.requestId).automaticTurns, 3);
});
test('edited plan invalidates every old endorsement and reviews the captured new version', async () => {
  const input = request(); await plane.submitPlan(input);
  for (let i = 0; i < 3; i++) { const id = run(input.requestId).currentCommandId; publish(id); await complete(id); }
  const reviewer = run(input.requestId).currentCommandId; publish(reviewer, '# Improved plan\n'); await complete(reviewer);
  const p = run(input.requestId).planning!; assert.equal(p.current!.revision, 2); assert.deepEqual(p.endorsements, { claude: 2 });
  assert.equal(p.endorsementHistory[0]!.revision, 1); assert.equal(assignment(run(input.requestId).currentCommandId).identity.inputHash, planHash('# Improved plan\n'));
  const final = run(input.requestId).currentCommandId; publish(final, '# Improved plan\n'); await complete(final);
  assert.ok(planAgreed(run(input.requestId).planning!)); assert.equal(run(input.requestId).status, 'waiting');
});
for (const automatic of [false, true]) for (const requireApproval of [false, true]) test(`solo Plan honors automatic=${automatic}, approval=${requireApproval} without fake consensus`, async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  const input = request({ groupId: solo.id, autoContinue: automatic, requireApproval }); await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).planning!.required.length, 1); assert.equal(run(input.requestId).planning!.current!.revision, 1);
  if (automatic && !requireApproval) { assert.equal(sent.length, 2); assert.equal(run(input.requestId).planning!.frozen!.authority, 'automatic'); assert.equal(run(input.requestId).automaticTurns, 1); }
  else { assert.equal(sent.length, 1); assert.match(run(input.requestId).reason, /Plan ready \(solo/); await plane.decidePlan(decision(input.requestId)); assert.equal(sent.length, 2); }
  assert.equal(run(input.requestId).implementation!.policy, 'solo'); assert.equal(run(input.requestId).autoContinue, false);
});
test('manual drafting and refinement preserve ownership and schedule once per explicit Next', async () => {
  const input = request({ autoContinue: false }); await plane.submitPlan(input);
  for (let i = 0; i < 4; i++) {
    const id = run(input.requestId).currentCommandId; publish(id); await complete(id); assert.equal(run(input.requestId).status, 'waiting');
    if (i < 3) { const results = await Promise.allSettled([1,2].map(async () => plane.action({ runId: input.requestId, action: 'continue', expectedCommandId: id, confirmReady: true })));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); }
  }
  assert.equal(sent.length, 4); assert.equal(run(input.requestId).automaticTurns, 0); assert.ok(planAgreed(run(input.requestId).planning!));
});
test('Plan may run on the integration branch, but its checkpoint consent must leave it', async () => {
  git('switch', 'main'); plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  // Up-front consent to stay on main is refused at Start, before any document work.
  const upfront = request({ groupId: solo.id, requireApproval: false }); upfront.implementation.branch = { ...upfront.baseline };
  await assert.rejects(plane.submitPlan(upfront), /main is an integration branch/); assert.equal(sent.length, 0);
  const input = request({ groupId: solo.id, requireApproval: false }); input.implementation.branch = null;
  await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(git('branch', '--show-current'), 'main');
  await assert.rejects(plane.decidePlan(decision(input.requestId, { branch: { ...input.baseline } })), /main is an integration branch/);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(run(input.requestId).implementation, undefined);
  await plane.decidePlan(decision(input.requestId, { branch: { ...input.baseline, newBranch: 'task/planned-from-main' } }));
  assert.equal(git('branch', '--show-current'), 'task/planned-from-main'); assert.equal(run(input.requestId).implementation!.taskBaseSha, input.baseline.head);
});
test('branch creation is deferred until planning approval; independent branch consent can wait until checkpoint', async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] }); const input = request({ groupId: solo.id, requireApproval: false });
  input.implementation.branch = null; await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(sent.length, 1); assert.equal(git('branch', '--show-current'), 'task/fixture');
  await assert.rejects(plane.decidePlan(decision(input.requestId)), /Confirm the Implementation branch/);
  await plane.decidePlan(decision(input.requestId, { branch: { ...input.baseline, newBranch: 'task/planned' } }));
  assert.equal(git('branch', '--show-current'), 'task/planned'); assert.equal(run(input.requestId).planning!.frozen!.implementation.branch!.newBranch, 'task/planned');
});
test('upfront new-branch consent applies only after all planners settle', async () => {
  const input = request({ requireApproval: false }); input.implementation.branch = { ...input.baseline, newBranch: 'task/automatic' };
  await plane.submitPlan(input); assert.equal(git('branch', '--show-current'), 'task/fixture'); await finishPlan(input.requestId);
  assert.equal(git('branch', '--show-current'), 'task/automatic'); assert.equal(sent.length, 5); assert.equal(run(input.requestId).automaticTurns, 4);
});
test('request changes creates a shared brief revision; stale approval is refused and solo does not loop', async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] }); const input = request({ groupId: solo.id }); await plane.submitPlan(input); await finishPlan(input.requestId);
  const old = decision(input.requestId); await plane.decidePlan({ ...old, action: 'changes', agentId: 'codex', text: 'Include failure recovery.' });
  assert.equal(run(input.requestId).planning!.briefRevision, 2); assert.deepEqual(run(input.requestId).planning!.endorsements, {});
  await assert.rejects(plane.decidePlan(old), /settled/); const revise = run(input.requestId).currentCommandId;
  assert.equal(assignment(revise).identity.action, 'revise'); assert.match(assignment(revise).brief, /failure recovery/);
  publish(revise, '# Plan v2\nRecovery included.\n'); await complete(revise);
  await assert.rejects(plane.decidePlan(old), /changed/); assert.equal(run(input.requestId).planning!.current!.revision, 2); assert.equal(sent.length, 2);
  await plane.decidePlan(decision(input.requestId)); assert.equal(sent.length, 3);
});
test('objection waits for human direction; explicit override records risk, not agreement', async () => {
  const input = request({ requireApproval: false }); await plane.submitPlan(input);
  for (let i = 0; i < 3; i++) { const id = run(input.requestId).currentCommandId; publish(id); await complete(id); }
  const id = run(input.requestId).currentCommandId; publish(id, run(input.requestId).planning!.current!.text, { outcome: 'object', reason: 'Needs a scope decision.' }); await complete(id);
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(sent.length, 4);
  await assert.rejects(plane.decidePlan(decision(input.requestId)), /acknowledge/);
  await plane.decidePlan(decision(input.requestId, { overrideReason: 'Proceed with the limited scope; follow up separately.' }));
  assert.equal(run(input.requestId).planning!.frozen!.objections.claude, 'Needs a scope decision.'); assert.ok(run(input.requestId).planning!.frozen!.overrideReason);
});
test('one workspace group is frozen across planning and implementation; a second group is refused', async () => {
  await assert.rejects(plane.createGroup({ name: 'Solo', members: ['codex'] }), /already has a group/);
  const input = request();
  await plane.submitPlan(input); await finishPlan(input.requestId); await plane.decidePlan(decision(input.requestId));
  assert.equal(run(input.requestId).planning!.participants.length, 2); assert.equal(run(input.requestId).participants.length, 2);
  assert.deepEqual(run(input.requestId).implementation!.group, run(input.requestId).planning!.group);
});
for (const fault of ['missing result','wrong identity','wrong hash','project edit','staged file','commit','new file','peer draft','extra document','symlink','oversize','legacy outcome']) test(`invalid Plan result retains ownership: ${fault}`, async () => {
  const input = request(); await plane.submitPlan(input); const result = publish(input.requestId); const turn = plane.workflow.execution(input.requestId)!.planning!;
  if (fault === 'missing result') rmSync(turn.resultPath);
  if (fault === 'wrong identity') { result.identity.epoch++; writeFileSync(turn.resultPath, JSON.stringify(result)); }
  if (fault === 'wrong hash') { result.outputHash = '0'.repeat(64); writeFileSync(turn.resultPath, JSON.stringify(result)); }
  if (fault === 'project edit') appendFileSync(join(root, 'app.txt'), 'unauthorized');
  if (fault === 'staged file') { appendFileSync(join(root, 'app.txt'), 'unauthorized'); git('add', 'app.txt'); }
  if (fault === 'commit') { appendFileSync(join(root, 'app.txt'), 'unauthorized'); git('add', 'app.txt'); git('commit', '-m', 'not a plan'); }
  if (fault === 'new file') writeFileSync(join(root, 'unexpected.txt'), 'not planning');
  if (fault === 'peer draft') writeFileSync(run(input.requestId).planning!.drafts.claude!.path, 'stolen slot');
  if (fault === 'extra document') writeFileSync(join(run(input.requestId).planning!.directory, 'report.md'), 'unexpected');
  if (fault === 'symlink') { rmSync(turn.identity.outputPath); symlinkSync(join(root, 'app.txt'), turn.identity.outputPath); }
  if (fault === 'oversize') writeFileSync(turn.identity.outputPath, 'x'.repeat(128 * 1024 + 1));
  await complete(input.requestId, fault === 'legacy outcome' ? { outcome: 'accept_without_improvement' } : {});
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 1); assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'running');
  assert.equal(plane.workflow.owner(`${root}/.git/index`), input.requestId);
});
test('plan documents live in the data directory, not the checkout; collisions and the old in-checkout layout are refused', async () => {
  const input = request(); const path = join(config().dataDir, 'plans', input.requestId, 'draft-codex.md'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'existing');
  await assert.rejects(plane.submitPlan(input), /Protected planning artifact/); assert.equal(sent.length, 0);
  const fresh = request(); await plane.submitPlan(fresh); const plan = run(fresh.requestId).planning!;
  assert.equal(plan.directory, join(config().dataDir, 'plans', fresh.requestId)); assert.equal(plan.drafts.codex!.path, join(plan.directory, 'draft-codex.md'));
  publish(fresh.requestId); assert.equal(git('status', '--porcelain=v1', '--untracked-files=all', '--ignored'), ''); // nothing, not even an ignored file
  await complete(fresh.requestId); assert.equal(run(fresh.requestId).planning!.drafts.codex!.status, 'finalized');
  // A run stored before the move kept checkout-relative paths; it is refused instead of being resolved against a guess.
  const legacy = `.codercrew/plans/${fresh.requestId}`;
  await assert.rejects(validatePlanPaths({ ...plan, directory: legacy, planPath: `${legacy}/plan.md` }), /earlier layout/);
});
test('a plans root that is a link or lies inside the checkout is refused before delivery and at capture', async () => {
  // An ignored in-checkout directory keeps the clean-baseline check passing, so only the plan-root check can stop it.
  const plans = join(config().dataDir, 'plans'); const inside = join(root, '.plans');
  appendFileSync(join(root, '.git', 'info', 'exclude'), '.plans/\n'); mkdirSync(inside); mkdirSync(config().dataDir, { recursive: true }); symlinkSync(inside, plans);
  await assert.rejects(plane.submitPlan(request()), /Unsafe plan directory/); assert.equal(sent.length, 0); assert.equal(plane.workflow.runs().length, 0);
  // A link swapped in after Start redirects the draft into the checkout; capture refuses it and keeps ownership.
  unlinkSync(plans); const input = request(); await plane.submitPlan(input); assert.equal(sent.length, 1);
  const planning = run(input.requestId).planning!; renameSync(plans, join(directory, 'moved-plans')); symlinkSync(inside, plans);
  publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Unsafe plan directory/); assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'running');
  // An ordinary directory inside the checkout is refused too, whatever its path.
  const nested = join(inside, 'real'); mkdirSync(nested);
  await assert.rejects(validatePlanPaths({ ...planning, directory: join(nested, input.requestId) }), /inside the checkout/);
});
test('unknown background and restart never fill a draft slot or replay assignments', async () => {
  const input = request(); await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId, { backgroundState: 'unknown', settled: false });
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'running');
  const saved = run(input.requestId).planning!; plane = new ControlPlane(new Controller(config(), store, adapter));
  assert.deepEqual(run(input.requestId).planning, saved); assert.equal(sent.length, 1); assert.equal(run(input.requestId).status, 'paused');
});
test('automatic budget spans both phases and cannot be reset at agreement', async () => {
  const input = request({ requireApproval: false, turnLimit: 3 }); await plane.submitPlan(input); await finishPlan(input.requestId);
  assert.equal(run(input.requestId).automaticTurns, 3); assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).implementation, undefined); assert.equal(sent.length, 4);
});
test('manual checkpoint rechecks plan text and code baseline before granting Implementation writes', async () => {
  const input = request(); await plane.submitPlan(input); await finishPlan(input.requestId); const approval = decision(input.requestId);
  appendFileSync(run(input.requestId).planning!.planPath, 'external changes');
  await assert.rejects(plane.decidePlan(approval), /Protected planning artifact/); assert.equal(sent.length, 4); assert.equal(run(input.requestId).implementation, undefined);
});
test('planning locks exclude overlapping groups and standalone implementation runs', async () => {
  const input = request(); await plane.submitPlan(input);
  await assert.rejects(plane.submitPlan(request()), /execution owner/);
  await assert.rejects(plane.submitImplementation({ ...input.implementation, branch: input.baseline, requestId: randomUUID(), text: 'Do work', kind: 'work', autoContinue: true, turnLimit: 20, confirmReady: true }), /execution owner/);
});
test('planning request validation rejects stale roster, oversized groups and implicit branch authorization', async () => {
  assert.throws(() => parsePlan({ ...request(), requireApproval: undefined }));
  const input = request(); assert.throws(() => parsePlan({ ...input, implementation: { ...input.implementation, branch: undefined } }));
  await assert.rejects(plane.submitPlan({ ...input, registrations: { ...input.registrations, codex: randomUUID() } }), /generation changed/);
  assert.throws(() => parsePlanDecision({ runId: input.requestId, action: 'approve', confirmReady: true }));
  store.saveGroup({ ...group, id: 'oversized', members: ['codex', 'claude', 'third'] }); await assert.rejects(plane.submitPlan({ ...input, groupId: 'oversized' }), /one or two distinct planners/);
});
test('a planner that objects and edits cannot transfer ownership', async () => {
  const input = request(); await plane.submitPlan(input);
  for (let i = 0; i < 3; i++) { const id = run(input.requestId).currentCommandId; publish(id); await complete(id); }
  const id = run(input.requestId).currentCommandId; publish(id, 'unapproved edits', { outcome: 'object', reason: 'Reject this approach' }); await complete(id);
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /must not edit/); assert.equal(sent.length, 4);
});
test('blocked result without a draft and a changed live CLI remain incomplete', async () => {
  const input = request(); await plane.submitPlan(input); const turn = plane.workflow.execution(input.requestId)!.planning!;
  writeFileSync(turn.resultPath, JSON.stringify({ identity: turn.identity, outcome: 'blocked', outputHash: null, model: 'unknown', summary: 'Cannot write the draft', reason: 'Permission is unavailable.' }));
  await complete(input.requestId); assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Permission is unavailable/);
  assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'running');
  await plane.action({ runId: input.requestId, action: 'takeover', confirmReady: true });
  const next = request(); await plane.submitPlan(next); publish(next.requestId); adapter.foregrounds.set('codex', '99999'); await complete(next.requestId);
  assert.equal(run(next.requestId).status, 'paused'); assert.equal(run(next.requestId).planning!.drafts.codex!.status, 'running'); assert.equal(sent.length, 2);
});
test('pause records a settled planning result without scheduling another planner', async () => {
  const input = request(); await plane.submitPlan(input); plane.workflow.pause(input.requestId); publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'finalized'); assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 1);
});
test('completion before transport return is buffered and consumed once with the captured draft', async () => {
  const input = request(); const send = adapter.send.bind(adapter);
  adapter.send = async (session, text) => {
    await send(session, text);
    if (sent.length === 1) { publish(input.requestId); const receipt = await complete(input.requestId); assert.match(receipt.reason, /Buffered/); assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'running'); }
  };
  await plane.submitPlan(input); assert.equal(run(input.requestId).planning!.drafts.codex!.status, 'finalized'); assert.equal(sent.length, 2);
});
test('registered unselected prompts pause planning instead of allowing a conflicting writer', async () => {
  plane.removeGroup(group.id);
  const solo = await plane.createGroup({ name: 'Solo', members: ['codex'] }); const input = request({ groupId: solo.id }); await plane.submitPlan(input);
  const other = store.sessions().find((s) => s.id === 'claude') as ManagedSession;
  await plane.recordEvent({ event: 'turn_started', source: 'claude', paneId: other.identity.paneId, socketPath: other.identity.socketPath, identity: other.identity, prompt: 'desktop work' });
  assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Another prompt started/); assert.equal(sent.length, 1);
});
test('a changed code baseline or branch never inherits approval of a clean plan', async () => {
  const input = request(); await plane.submitPlan(input); await finishPlan(input.requestId);
  appendFileSync(join(root, 'app.txt'), 'desktop edit'); await assert.rejects(plane.decidePlan(decision(input.requestId)), /app.txt/);
  git('add', 'app.txt'); git('commit', '-m', 'desktop edit'); await assert.rejects(plane.decidePlan(decision(input.requestId)), /baseline/);
  assert.equal(run(input.requestId).implementation, undefined); assert.equal(sent.length, 4);
});
test('finalized peer drafts and unassigned plan.md are protected before the draft barrier', async () => {
  const input = request(); await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId);
  const next = run(input.requestId).currentCommandId; publish(next);
  appendFileSync(run(input.requestId).planning!.drafts.codex!.path, 'external interference'); await complete(next);
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).planning!.drafts.claude!.status, 'running'); assert.equal(sent.length, 2);
});
test('checkpoint restart preserves captured text, roster, endorsements and ownership without dispatch', async () => {
  const input = request(); await plane.submitPlan(input); await finishPlan(input.requestId); const saved = run(input.requestId).planning;
  plane = new ControlPlane(new Controller(config(), store, adapter)); assert.deepEqual(run(input.requestId).planning, saved);
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(sent.length, 4); await assert.rejects(plane.decidePlan(decision(input.requestId)), /settled/);
});
test('v5 upgrade preserves stored runs and groups and marks phase-aware data as incompatible with older schedulers', async () => {
  const input = request(); await plane.submitPlan(input); const saved = run(input.requestId); const groups = store.groups();
  store.db.pragma('user_version = 5'); store.close(); store = new Store(join(directory, 'metadata'));
  assert.equal(store.db.pragma('user_version', { simple: true }), 13); assert.deepEqual(store.groups(), groups);
  const record = store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(input.requestId) as { value: string };
  assert.deepEqual(JSON.parse(record.value), saved);
});
test('manual plan-to-code transition retains initial review intent and protects the frozen planning artifacts', async () => {
  const input = request({ autoContinue: false }); await plane.submitPlan(input);
  for (let i = 0; i < 4; i++) {
    const id = run(input.requestId).currentCommandId; publish(id); await complete(id);
    if (i < 3) await plane.action({ runId: input.requestId, action: 'continue', expectedCommandId: id, confirmReady: true });
  }
  await plane.decidePlan(decision(input.requestId)); const worker = run(input.requestId).currentCommandId;
  const { identity, resultPath } = plane.workflow.execution(worker)!.implementation!;
  appendFileSync(join(root, 'app.txt'), 'implementation');
  writeFileSync(resultPath, JSON.stringify({ ...identity, model: 'unknown', decision: null, reason: null, needsHuman: false, summary: 'Code proposal', checks: [] }));
  git('add', 'app.txt'); git('commit', '-m', 'implementation proposal'); await complete(worker);
  assert.equal(sent.length, 6); assert.equal(plane.workflow.execution(run(input.requestId).currentCommandId)!.implementation!.identity.action, 'review_and_improve');
  const frozen = run(input.requestId).planning!.frozen!; appendFileSync(run(input.requestId).planning!.planPath, 'attempted approval bypass');
  await complete(run(input.requestId).currentCommandId); assert.equal(run(input.requestId).status, 'paused'); assert.match(run(input.requestId).reason, /Protected planning artifact/);
  assert.deepEqual(run(input.requestId).planning!.frozen, frozen);
});
for (const count of [3, 5]) test(`N-shaped model requires all ${count} drafts and current-version endorsements without enabling larger UI groups`, () => {
  const members = Array.from({ length: count }, (_, i) => `agent-${i}`); const base = store.sessions()[0] as ManagedSession;
  const participants = members.map((id) => ({ ...base, id, registrationId: randomUUID() })); const p = newPlanning(request(), { ...group, members }, participants, participants.slice(0, 2), root, join(directory, 'plans'));
  function result(id: string, action: 'draft' | 'synthesize' | 'review', text = 'version one') {
    const identity = { schema: 1 as const, phase: 'plan' as const, runId: p.request.requestId, commandId: p.drafts[id]!.commandId, epoch: 1, briefRevision: 1, rosterRevision: 1, policyRevision: 1,
      agentId: id, registrationId: participants.find((m) => m.id === id)!.registrationId, action, baseline: p.request.baseline.head, outputPath: action === 'draft' ? p.drafts[id]!.path : p.planPath, inputRevision: p.current?.revision ?? null, inputHash: p.current?.hash ?? null };
    const document = { text, hash: planHash(text) }; consumePlan(p, { document, result: { identity, outcome: action === 'review' ? 'accept' : 'complete', outputHash: document.hash, summary: 'model fixture', model: 'unknown', reason: null } });
  }
  for (const id of members.slice(0, -1)) { result(id, 'draft'); assert.equal(p.step, 'drafts'); }
  result(members.at(-1)!, 'draft'); assert.equal(p.step, 'synthesis'); result(members[0]!, 'synthesize');
  for (const id of members.slice(1, -1)) { result(id, 'review'); assert.equal(planAgreed(p), false); }
  result(members.at(-1)!, 'review', 'version two'); assert.deepEqual(p.endorsements, { [members.at(-1)!]: 2 });
  for (const id of members.slice(0, -1)) result(id, 'review', 'version two'); assert.ok(planAgreed(p));
});

test('copy mode in the completed planner does not discard its document or block the other planner', async () => {
  const input = request(); await plane.submitPlan(input); publish(input.requestId);
  const inspect = adapter.inspect.bind(adapter);
  adapter.inspect = async (id) => ({ ...await inspect(id), ...(id === '%0' ? { inMode: true } : {}) });
  adapter.preflight = async (session?: SessionRegistration) => { assert.ok(session); assertIdentity(session, await adapter.inspect(session.identity.paneId)); };
  await complete(input.requestId);
  assert.ok(run(input.requestId).planning!.drafts.codex!.document);
  assert.equal(sent.length, 2); assert.equal(run(input.requestId).status, 'running');
  assert.equal(plane.workflow.execution(run(input.requestId).currentCommandId)!.agentId, 'claude');
});

test('input at final Plan turn holds preauthorized Implementation until checkpoint review', async () => {
  plane.removeGroup(group.id); group = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  const list = adapter.listPanes.bind(adapter); adapter.listPanes = async () => (await list()).filter((p) => p.identity.paneId === '%0');
  const input = request({ requireApproval: false }); await plane.submitPlan(input);
  const commandId = run(input.requestId).currentCommandId; const p = run(input.requestId).participants[0]!;
  await plane.recordEvent(event(commandId, { event: 'turn_started' }));
  await plane.submitInteraction({ requestId: randomUUID(), runId: input.requestId, commandId, agentId: p.id, registrationId: p.registrationId,
    sessionId: `session-${p.id}`, sourceTurnId: `turn-${commandId}`, expectedRevision: 0, confirmPresent: true, purpose: 'detail', text: 'Include the validation steps.' });
  publish(commandId); await complete(commandId);
  assert.equal(run(input.requestId).status, 'paused'); assert.equal(run(input.requestId).implementation, undefined); assert.equal(sent.length, 2);
  await assert.rejects(plane.decidePlan(decision(input.requestId)), /settled planning boundary/i);
  const cp = plane.interactions.checkpoint(input.requestId)!; assert.ok(cp);
  await plane.reconcileCheckpoint({ requestId: randomUUID(), runId: input.requestId, commandId, expectedRevision: cp.revision, action: 'review_input', confirmReady: true });
  assert.ok(run(input.requestId).implementation); assert.equal(sent.length, 3);
});

test('restoring a waiting Plan sends nothing and blocks even an already pending automatic approval', async () => {
  plane.removeGroup(group.id); group = await plane.createGroup({ name: 'Solo', members: ['codex'] });
  const list = adapter.listPanes.bind(adapter); adapter.listPanes = async () => (await list()).filter((p) => p.identity.paneId === '%0');
  const input = request({ requireApproval: false }); input.implementation.branch = null;
  await plane.submitPlan(input); publish(input.requestId); await complete(input.requestId);
  assert.equal(run(input.requestId).status, 'waiting'); const cp = plane.interactions.checkpoint(input.requestId)!; assert.ok(cp);
  const external = event(input.requestId, { commandId: undefined, sourceTurnId: 'outside', prompt: 'Read the plan', cliPid: '100', startedAt: new Date(Date.parse(cp.capturedAt) + 1).toISOString(), event: 'turn_started' });
  await plane.recordEvent(external); await plane.recordEvent({ ...external, event: 'turn_complete' });
  const settled = plane.interactions.checkpoint(input.requestId)!;
  await plane.reconcileCheckpoint({ requestId: randomUUID(), runId: input.requestId, commandId: input.requestId, expectedRevision: settled.revision, action: 'restore', confirmReady: true });
  assert.equal(run(input.requestId).status, 'waiting'); assert.equal(sent.length, 1); assert.equal(run(input.requestId).automaticTurns, 0);
  const approve = decision(input.requestId, { branch: { branch: 'task/fixture', head: input.baseline.head } });
  await assert.rejects(plane.decidePlan(approve, 'automatic'), /not preauthorized/); assert.equal(sent.length, 1);
  await plane.decidePlan(approve); assert.ok(run(input.requestId).implementation); assert.equal(sent.length, 2);
});
