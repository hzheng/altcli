import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import { resolveWorktree, sameWorktree } from '../src/server/worktree.ts';
import { parseHook, parseStart, parseRunAction } from '../src/core/workflow-validation.ts';
import type { HookEvent, ManagedSession, StartInput } from '../src/contracts/workflow.ts';

let directory: string; let store: Store; let adapter: MockAdapter; let plane: ControlPlane;
let sent: { agent: string; text: string }[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codercrew-workflow-'));
  store = new Store(directory); for (const session of mockSessions()) store.saveSession(session);
  adapter = new MockAdapter(); sent = [];
  adapter.send = async (session, text) => { sent.push({ agent: session.id, text }); };
  plane = new ControlPlane(new Controller(loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: directory }), store, adapter));
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const start = (more: Partial<StartInput> = {}): StartInput => ({ requestId: randomUUID(), agentId: 'codex', kind: 'relay', confirmReady: true, ...more });
function pair() { return plane.createPair({ name: 'Main', sessions: ['codex', 'claude'] }); }
function event(commandId: string, more: Partial<HookEvent> = {}): HookEvent {
  const turn = plane.workflow.execution(commandId)!; const run = plane.workflow.run(turn.runId)!;
  const session = run.participants.find((s) => s.id === turn.agentId)!;
  return { event: 'turn_complete', commandId, source: session.agentType, paneId: session.identity.paneId,
    socketPath: session.identity.socketPath, identity: session.identity, sessionId: `session-${session.id}`, sourceTurnId: `turn-${commandId}`,
    prompt: turn.wireText, settled: true, backgroundState: 'clear', outcome: 'accept_and_improve', ...more };
}
async function complete(commandId: string, more: Partial<HookEvent> = {}) {
  const value = event(commandId, more);
  if (value.source === 'claude') await plane.recordEvent({ ...value, event: 'turn_started', outcome: undefined });
  return plane.recordEvent(value);
}
function stopped(runId: string) { plane.action(parseRunAction({ runId, action: 'takeover', confirmReady: true })); }

test('a clean transport delivery does not release execution ownership', async () => {
  const command = start(); assert.equal((await plane.submit(command)).status, 'delivered');
  assert.equal(store.activeFor('/demo/project'), null);
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), command.requestId);
  await assert.rejects(plane.submit(start({ agentId: 'claude' })), /execution owner/);
  assert.equal(sent.length, 1);
});
test('same request is idempotent; changed handoff policy conflicts', async () => {
  const command = start({ pairId: pair().id }); await plane.submit(command); await plane.submit(command);
  assert.equal(sent.length, 1);
  await assert.rejects(plane.submit({ ...command, autoContinue: true }), /different work or policy/);
  await assert.rejects(plane.submit({ ...command, handoff: true }), /different work or policy/);
});
test('two observers and a repeated completion schedule one server-owned continuation', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  const done = event(command.requestId);
  await Promise.all([plane.recordEvent(done), plane.recordEvent(done)]);
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
  assert.equal(plane.workflow.run(command.requestId)!.automaticTurns, 1);
  await plane.recordEvent(done); assert.equal(sent.length, 2);
});
test('explicit pair wins when two pairs share a participant', async () => {
  pair(); const third = { ...(store.sessions()[1] as ManagedSession), id: 'claude-c', label: 'Claude C', registrationId: randomUUID(), identity: { ...store.sessions()[1]!.identity, paneId: '%9' } };
  store.saveSession(third); const second = plane.createPair({ name: 'Second', sessions: ['codex', 'claude-c'] });
  const command = start({ pairId: second.id, autoContinue: true }); await plane.submit(command);
  await complete(command.requestId); assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude-c']);
  assert.equal(plane.workflow.run(command.requestId)!.pairId, second.id);
});
test('late completion of an identical old relay cannot close a newer command', async () => {
  const old = start(); await plane.submit(old); await complete(old.requestId, { outcome: 'accept_without_improvement' });
  const newer = start(); await plane.submit(newer);
  const late = await plane.recordEvent(event(old.requestId, { sourceTurnId: 'late-distinct-delivery' }));
  assert.equal(late.accepted, false); assert.equal(plane.workflow.execution(newer.requestId)!.status, 'delivered');
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), newer.requestId);
});
test('legacy follow-ups and missing identity never advance the current turn', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  assert.equal((await plane.recordEvent({ source: 'claude', event: 'outcome', paneId: '%0', outcome: 'accept_and_improve' })).accepted, false);
  assert.equal((await plane.recordEvent({ ...event(command.requestId), identity: undefined })).accepted, false);
  assert.equal(sent.length, 1); assert.equal(plane.workflow.execution(command.requestId)!.status, 'delivered');
});
test('Claude must acknowledge the specific prompt before completion can advance', async () => {
  const command = start({ agentId: 'claude', pairId: pair().id, autoContinue: true }); await plane.submit(command);
  const receipt = await plane.recordEvent(event(command.requestId));
  assert.equal(receipt.accepted, false); assert.match(plane.workflow.run(command.requestId)!.reason, /UserPromptSubmit/); assert.equal(sent.length, 1);
});
test('changed source turn or CLI session pauses instead of borrowing another completion', async () => {
  const command = start({ agentId: 'claude', pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await plane.recordEvent(event(command.requestId, { event: 'turn_started' }));
  await plane.recordEvent(event(command.requestId, { sourceTurnId: 'unrelated-turn' }));
  assert.equal(plane.workflow.run(command.requestId)!.status, 'paused'); assert.equal(sent.length, 1);
});
test('unknown or active background work retains ownership', async () => {
  for (const backgroundState of ['unknown', 'active'] as const) {
    const command = start({ pairId: store.pairs()[0]?.id ?? pair().id, autoContinue: true }); await plane.submit(command);
    await complete(command.requestId, { backgroundState });
    assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
    assert.equal(plane.workflow.owner('/demo/project/.git/index'), command.requestId); stopped(command.requestId);
  }
  assert.equal(sent.length, 2);
});
test('contradictory duplicate payload pauses, rather than scheduling twice', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  const done = event(command.requestId); await plane.recordEvent(done);
  await plane.recordEvent({ ...done, outcome: 'strong_objection' });
  assert.equal(plane.workflow.run(command.requestId)!.status, 'paused'); assert.equal(sent.length, 2);
});
test('completion during dispatch is buffered and consumed only after delivery', async () => {
  const command = start({ pairId: pair().id, autoContinue: true });
  adapter.send = async (session, text) => {
    sent.push({ agent: session.id, text });
    if (session.id === 'codex') assert.equal((await plane.recordEvent(event(command.requestId))).reason, 'Buffered until delivery is established.');
  };
  await plane.submit(command); assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
});
test('an uncertain delivery cannot be completed or automatically retried', async () => {
  adapter.send = async () => { throw new Error('after typing'); };
  const command = start(); const record = await plane.submit(command); assert.equal(record.status, 'uncertain');
  await complete(command.requestId); assert.equal(plane.workflow.execution(command.requestId)!.status, 'uncertain');
  assert.equal((await plane.submit(command)).status, 'uncertain'); stopped(command.requestId);
  assert.equal(store.activeFor('/demo/project'), null);
});
test('pausing is durable and human takeover is explicit', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  plane.action({ runId: command.requestId, action: 'pause' }); await complete(command.requestId);
  assert.equal(sent.length, 1); assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
  assert.throws(() => parseRunAction({ runId: command.requestId, action: 'takeover' }), /Inspect every participant/);
  stopped(command.requestId); assert.equal(plane.workflow.owner('/demo/project/.git/index'), null);
});
test('restart pauses durable runs and never replays a delivery', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  store.close(); store = new Store(directory);
  plane = new ControlPlane(new Controller(loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: directory }), store, adapter));
  await complete(command.requestId); assert.equal(sent.length, 1); assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
  assert.match(plane.workflow.run(command.requestId)!.reason, /paused/);
});
test('active execution survives more than thirty commands in another project', async () => {
  const long = start(); await plane.submit(long);
  await plane.register({ paneId: '%3', label: 'Other Codex' });
  for (let i = 0; i < 35; i++) {
    const command = start({ agentId: 'other-codex', kind: 'instruction', text: `task ${i}` });
    await plane.submit(command); await complete(command.requestId, { outcome: undefined });
  }
  const state = await plane.state(); assert.equal(state.commands.some((c) => c.id === long.requestId), false);
  assert.ok(state.executions.some((e) => e.commandId === long.requestId));
  assert.ok(state.runs.some((r) => r.id === long.requestId && r.status === 'running'));
  await complete(long.requestId, { outcome: 'accept_without_improvement' });
  assert.equal(plane.workflow.run(long.requestId)!.status, 'completed');
});
test('budget and immutable participants do not depend on any browser', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  for (let i = 0; i < 21; i++) await complete(plane.workflow.run(command.requestId)!.currentCommandId);
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.automaticTurns, 20); assert.equal(run.status, 'paused'); assert.equal(sent.length, 21);
  assert.match(run.reason, /budget/);
});
test('a plain Send never relays; Send and relay requests one review with preference off', async () => {
  const p = pair(); const plain = start({ kind: 'instruction', text: 'do work', pairId: p.id, autoContinue: true });
  await plane.submit(plain); await complete(plain.requestId, { outcome: undefined }); assert.equal(sent.length, 1);
  const handoff = start({ kind: 'instruction', text: 'do work', pairId: p.id, handoff: true, autoContinue: false });
  await plane.submit(handoff); await complete(handoff.requestId, { outcome: undefined }); assert.equal(sent.length, 3);
  const review = plane.workflow.run(handoff.requestId)!.currentCommandId; await complete(review); assert.equal(sent.length, 3);
  assert.equal(plane.workflow.run(handoff.requestId)!.status, 'paused');
});
test('a desktop start pauses a run; registration mutations cannot change its participants', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  assert.throws(() => plane.remove('claude'), /run owns/i);
  assert.throws(() => plane.removePair('main'), /run owns/i);
  const input = event(command.requestId, { event: 'turn_started', commandId: undefined });
  await plane.recordEvent(input); assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
  assert.match(plane.workflow.run(command.requestId)!.reason, /without controller correlation/);
});
test('protocol parsing refuses ambiguous inputs and retains exact identities', () => {
  assert.throws(() => parseStart({ ...start(), pairId: 'Not a slug' }), /slug/);
  assert.throws(() => parseStart({ ...start(), autoContinue: 'true' }), /boolean/);
  assert.throws(() => parseHook({ source: 'codex', event: 'turn_complete', paneId: '%0', sourceTurnId: 'bad\nturn' }), /identity/);
});
test('text that only fits without the correlation marker is refused before any durable write', async () => {
  const command = start({ kind: 'instruction', text: 'x'.repeat(1950) });
  await assert.rejects(plane.submit(command), /correlation marker/);
  assert.equal(plane.workflow.execution(command.requestId), undefined); assert.equal(sent.length, 0);
});
test('canonical Git identity handles subdirectories, separate repositories, and worktrees', async () => {
  const repo = join(directory, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(repo, 'web')); const first = await resolveWorktree(repo);
  assert.ok(first); assert.ok(sameWorktree(first, await resolveWorktree(join(repo, 'web'))));
  assert.equal(await resolveWorktree(directory), null);
  const other = join(directory, 'other'); mkdirSync(other); execFileSync('git', ['init', '-q', other]);
  assert.equal(sameWorktree(first, await resolveWorktree(other)), false);
  writeFileSync(join(repo, 'example'), 'test'); execFileSync('git', ['-C', repo, 'add', 'example']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const linked = join(directory, 'linked'); execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', linked]);
  const second = await resolveWorktree(linked); assert.ok(second); assert.notEqual(first.indexPath, second.indexPath); assert.equal(sameWorktree(first, second), false);
});
test('a copied nonce cannot credit a prompt altered by leftover terminal text', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await complete(command.requestId, { prompt: `leftover${plane.workflow.execution(command.requestId)!.wireText}` });
  assert.equal(sent.length, 1); assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
  assert.match(plane.workflow.run(command.requestId)!.reason, /differs/);
});
