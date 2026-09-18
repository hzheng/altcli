import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import { resolveWorktree, sameWorktree, worktreeFingerprint } from '../src/server/worktree.ts';
import { parseHook, parseStart, parseRunAction } from '../src/core/workflow-validation.ts';
import type { HookEvent, ManagedSession, StartInput } from '../src/contracts/workflow.ts';

let directory: string; let store: Store; let adapter: MockAdapter; let plane: ControlPlane;
let sent: { agent: string; text: string }[];
/** Simulated worktree digest; a test that models an agent editing files changes it between delivery and completion. */
let worktree: () => Promise<string>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codercrew-workflow-'));
  store = new Store(directory); for (const session of mockSessions()) store.saveSession(session);
  adapter = new MockAdapter(); sent = []; worktree = async () => 'unchanged';
  adapter.send = async (session, text) => { sent.push({ agent: session.id, text }); };
  plane = new ControlPlane(new Controller(loadConfig({ CODERCREW_ADAPTER: 'mock', CODERCREW_TOKEN: 'a'.repeat(64), CODERCREW_DATA_DIR: directory }), store, adapter), () => worktree());
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
test('an actionable objection automatically returns to the author for correction and then to the reviewer', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await complete(command.requestId);
  const review = plane.workflow.run(command.requestId)!.currentCommandId;
  await complete(review, { outcome: 'strong_objection', reason: 'The delete path can remove records outside the selected project.' });
  const run = plane.workflow.run(command.requestId)!;
  const correction = plane.workflow.execution(run.currentCommandId)!;
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude', 'codex']);
  assert.equal(run.status, 'running'); assert.equal(run.automaticTurns, 2);
  assert.equal(correction.input.kind, 'instruction'); assert.equal(correction.input.handoff, true);
  assert.equal(correction.input.text, 'Address objection: The delete path can remove records outside the selected project.\n\nMake the required changes, leave them unstaged, and then return the work for relay review.');
  assert.match(correction.wireText, /\[codercrew-command:[0-9a-f-]+\]$/);
  worktree = async () => 'corrected';
  await complete(correction.commandId, { outcome: undefined });
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude', 'codex', 'claude']);
  assert.equal(plane.workflow.execution(plane.workflow.run(command.requestId)!.currentCommandId)!.input.kind, 'relay');
});
test('an objection reason with a line separator still schedules a deliverable correction', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await complete(command.requestId);
  const review = plane.workflow.run(command.requestId)!.currentCommandId;
  const receipt = await complete(review, { outcome: 'strong_objection', reason: 'The delete path is unscoped.\u2028Scope it to the project.' });
  assert.equal(receipt.accepted, true); assert.equal(plane.workflow.execution(review)!.status, 'finished');
  const run = plane.workflow.run(command.requestId)!; assert.equal(run.status, 'running');
  assert.match(plane.workflow.execution(run.currentCommandId)!.input.text!, /^Address objection: The delete path is unscoped\. Scope it to the project\.\n/);
});
test('an objection without automatic continuation or an actionable reason remains paused', async () => {
  for (const [autoContinue, reason] of [[false, 'The change drops required data.'], [true, undefined]] as const) {
    const command = start({ pairId: store.pairs()[0]?.id ?? pair().id, autoContinue }); await plane.submit(command);
    await complete(command.requestId, { outcome: 'strong_objection', reason });
    const run = plane.workflow.run(command.requestId)!;
    assert.equal(run.status, 'paused'); assert.match(run.reason, /Reviewer objected/); stopped(run.id);
  }
  assert.equal(sent.length, 2);
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
  const pairId = pair().id;
  for (const mismatch of [{ sourceTurnId: 'unrelated-turn' }, { sessionId: 'unrelated-session' }]) {
    const command = start({ agentId: 'claude', pairId, autoContinue: true }); await plane.submit(command);
    await plane.recordEvent(event(command.requestId, { event: 'turn_started' }));
    await plane.recordEvent(event(command.requestId, mismatch));
    const run = plane.workflow.run(command.requestId)!;
    assert.equal(run.status, 'paused'); assert.match(run.reason, /did not match the acknowledged source turn/); stopped(command.requestId);
  }
  assert.equal(sent.length, 2);
});
test('a new CLI chat between commands (Codex /new, Claude /clear) completes the next command without re-registration', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await complete(command.requestId); const review = plane.workflow.run(command.requestId)!.currentCommandId; await complete(review);
  const second = plane.workflow.run(command.requestId)!.currentCommandId;
  assert.equal((await complete(second, { sessionId: 'session-codex-after-new' })).accepted, true);
  assert.equal(plane.workflow.execution(second)!.sessionId, 'session-codex-after-new');
  const secondReview = plane.workflow.run(command.requestId)!.currentCommandId;
  assert.equal((await complete(secondReview, { sessionId: 'session-claude-after-clear' })).accepted, true);
  assert.equal(plane.workflow.execution(secondReview)!.sessionId, 'session-claude-after-clear');
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'running'); assert.equal(run.automaticTurns, 4);
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude', 'codex', 'claude', 'codex']);
});
test('unknown or active background work retains ownership', async () => {
  // Unknown from a Claude payload has no server-side substitute; see the Codex process-evidence tests for the one case that does.
  for (const [backgroundState, agentId] of [['unknown', 'claude'], ['active', 'codex']] as const) {
    const command = start({ agentId, pairId: store.pairs()[0]?.id ?? pair().id, autoContinue: true }); await plane.submit(command);
    await complete(command.requestId, { backgroundState });
    assert.equal(plane.workflow.run(command.requestId)!.status, 'paused');
    assert.equal(plane.workflow.owner('/demo/project/.git/index'), command.requestId); stopped(command.requestId);
  }
  assert.equal(sent.length, 2);
});
test('a Codex completion without payload evidence continues only when nothing started during the turn survives', async () => {
  const helpers = [{ pid: '101', command: '/opt/codex/codex-code-mode-host' }, { pid: '102', command: '/app/node_repl' }];
  adapter.trees.set('codex', helpers);
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  assert.deepEqual(plane.workflow.execution(command.requestId)!.baselineProcesses, helpers);
  // Long-lived helpers that predate the turn are not background work; a helper that exited is not either; the notify hook posting this is not.
  adapter.trees.set('codex', [helpers[0]!, { pid: '303', command: 'node' }]);
  await complete(command.requestId, { backgroundState: 'unknown', reporterPid: '303' });
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
  assert.equal(plane.workflow.run(command.requestId)!.status, 'running');
});
test('a process started during a Codex turn that is still alive is active background work; the reporting hook and Codex helpers are not', async () => {
  adapter.trees.set('codex', []);
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  adapter.trees.set('codex', [{ pid: '101', command: '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex-code-mode-host' },
    { pid: '102', command: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl' }, { pid: '303', command: 'node' }, { pid: '202', command: '/usr/bin/tail' }]);
  await complete(command.requestId, { backgroundState: 'unknown', reporterPid: '303' });
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'paused'); assert.match(run.reason, /remains active \(tail pid 202\)/);
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), command.requestId); assert.equal(sent.length, 1);
});
test('process evidence never substitutes for a missing Claude payload, a missing baseline, or an unreadable tree', async () => {
  const command = start({ agentId: 'claude', pairId: pair().id, autoContinue: true }); await plane.submit(command);
  assert.equal(plane.workflow.execution(command.requestId)!.baselineProcesses, null);
  await complete(command.requestId, { backgroundState: 'unknown' });
  assert.equal(plane.workflow.run(command.requestId)!.status, 'paused'); stopped(command.requestId);
  adapter.processes = async () => { throw new Error('ps unavailable'); };
  const codex = start({ pairId: store.pairs()[0]!.id, autoContinue: true }); await plane.submit(codex);
  assert.equal(plane.workflow.execution(codex.requestId)!.baselineProcesses, null);
  await complete(codex.requestId, { backgroundState: 'unknown' });
  assert.match(plane.workflow.run(codex.requestId)!.reason, /unknown; inspect the workers/); assert.equal(sent.length, 2);
});
test('a Codex completion buffered during dispatch is judged with evidence gathered after delivery', async () => {
  adapter.trees.set('codex', []);
  const command = start({ pairId: pair().id, autoContinue: true });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  adapter.send = async (session, text) => { sent.push({ agent: session.id, text }); if (session.id === 'codex') await gate; };
  const submitting = plane.submit(command);
  while (plane.workflow.execution(command.requestId)?.status !== 'dispatching') await new Promise((r) => setTimeout(r, 5));
  const receipt = await plane.recordEvent(event(command.requestId, { backgroundState: 'unknown', reporterPid: '303' }));
  assert.equal(receipt.accepted, false); assert.match(receipt.reason, /Buffered/);
  adapter.trees.set('codex', [{ pid: '303', command: 'node' }]);
  release(); await submitting;
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
});
test('a duplicate Codex event from a new hook process stays idempotent', async () => {
  adapter.trees.set('codex', []);
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  const done = event(command.requestId, { backgroundState: 'unknown', reporterPid: '301' });
  await plane.recordEvent(done); await plane.recordEvent({ ...done, reporterPid: '302' });
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'running'); assert.equal(run.automaticTurns, 1); assert.equal(sent.length, 2);
});
test('the automatic turn limit is chosen at start, frozen into the run, and enforced by the server', async () => {
  const command = start({ pairId: pair().id, autoContinue: true, turnLimit: 1 }); await plane.submit(command);
  assert.equal(plane.workflow.run(command.requestId)!.turnLimit, 1);
  await assert.rejects(plane.submit({ ...command, turnLimit: 2 }), /different work or policy/);
  await complete(command.requestId);
  const run = plane.workflow.run(command.requestId)!; assert.equal(run.automaticTurns, 1); assert.equal(run.status, 'running');
  await complete(run.currentCommandId);
  assert.equal(plane.workflow.run(command.requestId)!.reason, 'Automatic turn budget reached.'); assert.equal(sent.length, 2);
  stopped(command.requestId);
  assert.equal(plane.workflow.run((await plane.submit(start())).id)!.turnLimit, 20);
});
test('a multi-line instruction correlates with the flattened echo the hooks produce', async () => {
  const command = start({ kind: 'instruction', text: 'check these:\n- one\n- two', handoff: true, pairId: pair().id }); await plane.submit(command);
  const wire = plane.workflow.execution(command.requestId)!.wireText;
  assert.equal(wire, `check these:\n- one\n- two [codercrew-command:${command.requestId}]`);
  assert.equal(sent[0]!.text, wire);
  // hooks/protocol.mjs `plain` turns every control character into a space; a CLI that stored CR instead of LF flattens the same way.
  worktree = async () => 'edited';
  await complete(command.requestId, { prompt: wire.replace(/\n/g, '\r').replace(/[\u0000-\u001f]/g, ' ') });
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
  await assert.rejects(plane.submit(start({ kind: 'instruction', text: 'a\tb' })), /control characters/);
});
test('a CLI that exited or restarted in its pane is reported and refused delivery until re-registered', async () => {
  const codex = store.sessions().find((s) => s.id === 'codex') as ManagedSession;
  store.saveSession({ ...codex, cliPid: '500' } as ManagedSession); adapter.foregrounds.set('codex', '500');
  assert.deepEqual((await plane.state()).instances, [{ agentId: 'codex', status: 'current' }, { agentId: 'claude', status: 'unknown' }]);
  const first = start(); assert.equal((await plane.submit(first)).status, 'delivered'); stopped(first.requestId);
  adapter.foregrounds.set('codex', '501'); // the shell spawned a new CLI, or is itself in the foreground again
  assert.equal((await plane.state()).instances[0]!.status, 'replaced');
  const second = start(); const record = await plane.submit(second);
  assert.equal(record.status, 'rejected'); assert.match(record.error!, /exited or restarted/);
  assert.equal(plane.workflow.run(second.requestId)!.status, 'paused'); assert.equal(sent.length, 1);
});
test('a real-mode registration without a pinned CLI pid must be renewed', async () => {
  plane.transport.config.mode = 'tmux';
  await assert.rejects(plane.submit(start()), /current CLI process can be pinned/);
  assert.equal(sent.length, 0);
});
test('an auxiliary Codex turn that quotes the command is ignored; the exact completion still advances', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  const wire = plane.workflow.execution(command.requestId)!.wireText;
  const title = await plane.recordEvent(event(command.requestId, { sourceTurnId: 'title-turn', outcome: undefined, prompt: `Generate a concise task title. Do not answer the request.\n\nUser prompt: ${wire}` }));
  assert.equal(title.accepted, false); assert.match(title.reason, /not its completion/);
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'running'); assert.match(run.reason, /still waiting for the exact completion/); assert.equal(sent.length, 1);
  assert.equal(plane.workflow.execution(command.requestId)!.sessionId, null);
  await complete(command.requestId);
  assert.deepEqual(sent.map((s) => s.agent), ['codex', 'claude']);
  const other = start({ requestId: randomUUID(), agentId: 'claude' });
  await assert.rejects(plane.submit(other), /execution owner/);
});
test('a prompt that does not contain the delivered command still pauses the run', async () => {
  const command = start({ pairId: pair().id, autoContinue: true }); await plane.submit(command);
  await plane.recordEvent(event(command.requestId, { prompt: `something else [codercrew-command:${command.requestId}]` }));
  assert.equal(plane.workflow.run(command.requestId)!.status, 'paused'); assert.equal(sent.length, 1);
});
test('history commands carry the run and pair they belonged to, including server continuations', async () => {
  const paired = start({ pairId: pair().id, autoContinue: true }); await plane.submit(paired); await complete(paired.requestId);
  const run = plane.workflow.run(paired.requestId)!; stopped(run.id);
  const single = start(); await plane.submit(single);
  const commands = (await plane.state()).commands;
  assert.deepEqual(commands.filter((c) => c.runId === run.id).map((c) => [c.agentId, c.pairId]), [['claude', 'main'], ['codex', 'main']]);
  assert.deepEqual(commands.find((c) => c.id === single.requestId)!.pairId, null);
  assert.equal(commands.find((c) => c.id === single.requestId)!.runId, single.requestId);
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
  await plane.submit(handoff); worktree = async () => 'edited';
  await complete(handoff.requestId, { outcome: undefined }); assert.equal(sent.length, 3);
  const review = plane.workflow.run(handoff.requestId)!.currentCommandId; await complete(review); assert.equal(sent.length, 3);
  assert.equal(plane.workflow.run(handoff.requestId)!.status, 'paused');
});
test('Send and relay does not review a worker that changed nothing, such as one that asked a question instead', async () => {
  const command = start({ kind: 'instruction', text: 'do work', pairId: pair().id, handoff: true, autoContinue: true }); await plane.submit(command);
  assert.equal(plane.workflow.execution(command.requestId)!.baselineWorktree, 'unchanged');
  await complete(command.requestId, { outcome: undefined });
  assert.equal(sent.length, 1);
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'completed'); assert.match(run.reason, /without changing the worktree/);
  // The turn finished cleanly, so the human can answer the worker at once with a plain Send.
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), null);
  assert.equal((await plane.submit(start({ kind: 'instruction', text: 'the answer' }))).status, 'delivered');
  assert.equal(sent.length, 2);
});
test('an unreadable worktree before delivery or at completion pauses a Send and relay instead of reviewing', async () => {
  const p = pair();
  const before = start({ kind: 'instruction', text: 'do work', pairId: p.id, handoff: true }); worktree = async () => { throw new Error('git unavailable'); };
  await plane.submit(before); assert.equal(plane.workflow.execution(before.requestId)!.baselineWorktree, null);
  worktree = async () => 'edited'; await complete(before.requestId, { outcome: undefined });
  assert.equal(plane.workflow.run(before.requestId)!.status, 'paused'); assert.match(plane.workflow.run(before.requestId)!.reason, /could not be read/);
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), before.requestId); stopped(before.requestId);
  const after = start({ kind: 'instruction', text: 'do work', pairId: p.id, handoff: true }); await plane.submit(after);
  worktree = async () => { throw new Error('git unavailable'); }; await complete(after.requestId, { outcome: undefined });
  assert.equal(plane.workflow.run(after.requestId)!.status, 'paused'); assert.equal(sent.length, 2);
  // Plain Send and Relay never read the worktree; only a handoff instruction is judged by it.
  stopped(after.requestId); const relay = start({ pairId: p.id, autoContinue: true }); await plane.submit(relay);
  assert.equal(plane.workflow.execution(relay.requestId)!.baselineWorktree, null);
  await complete(relay.requestId); assert.equal(sent.length, 4);
});
test('the worktree digest changes on edits, staging, untracked files and commits, but not on a touch or an ignored file', async () => {
  const repo = join(directory, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
  writeFileSync(join(repo, '.gitignore'), 'ignored\n'); writeFileSync(join(repo, 'example'), 'one\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const digests = [await worktreeFingerprint(repo)];
  const next = async () => { const digest = await worktreeFingerprint(repo); assert.ok(!digests.includes(digest)); digests.push(digest); return digest; };
  const same = async () => assert.equal(await worktreeFingerprint(repo), digests.at(-1));
  await same();
  const later = new Date(Date.now() + 5000); utimesSync(join(repo, 'example'), later, later); await same();
  writeFileSync(join(repo, 'ignored'), 'scratch'); await same();
  writeFileSync(join(repo, 'example'), 'two\n'); await next();
  git('add', 'example'); await next();
  writeFileSync(join(repo, 'new-file'), 'x'); await next();
  writeFileSync(join(repo, 'new-file'), 'y'); await next();
  git('commit', '-qm', 'second'); await next();
  rmSync(join(repo, 'new-file')); await next();
  await assert.rejects(worktreeFingerprint(directory), /worktree state/);
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
  for (const turnLimit of ['20', 0, 201, 2.5]) assert.throws(() => parseStart({ ...start(), turnLimit }), /1 to 200/);
  assert.equal(parseStart({ ...start(), turnLimit: 7 }).turnLimit, 7);
  assert.throws(() => parseHook({ source: 'codex', event: 'turn_complete', paneId: '%0', sourceTurnId: 'bad\nturn' }), /identity/);
  assert.throws(() => parseHook({ source: 'codex', event: 'turn_complete', paneId: '%0', reporterPid: 12 }), /reporter/);
  assert.equal(parseHook({ source: 'codex', event: 'turn_complete', paneId: '%0', reporterPid: '12' }).reporterPid, '12');
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
  // Not credited: no continuation, nothing bound. The run keeps ownership and tells the human why it is still waiting.
  assert.equal(sent.length, 1); assert.equal(plane.workflow.execution(command.requestId)!.status, 'delivered');
  const run = plane.workflow.run(command.requestId)!;
  assert.equal(run.status, 'running'); assert.match(run.reason, /leftover input/);
  assert.equal(plane.workflow.owner('/demo/project/.git/index'), command.requestId);
});
