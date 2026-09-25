import { beforeEach, expect, test } from 'vitest';
import { AgentActivityTracker, hasCurrentNativeBinding } from './agent-activity';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextKey } from '../../../hooks/protocol.mjs';
import { MockAdapter, mockSessions } from './adapters/mock';
import type { HookEvent, ManagedSession } from '../contracts/workflow';

let adapter: MockAdapter; let tracker: AgentActivityTracker; let session: ManagedSession;
beforeEach(() => {
  adapter = new MockAdapter(); tracker = new AgentActivityTracker(adapter);
  session = { ...mockSessions()[0]!, registrationId: 'generation', worktree: null, cliPid: '100' };
  adapter.foregrounds.set(session.id, '100');
});
const event = (more: Partial<HookEvent> = {}): HookEvent => ({ source: 'codex', event: 'turn_started', identity: session.identity,
  paneId: session.identity.paneId, socketPath: session.identity.socketPath, cliPid: '100', sessionId: 'native-session', sourceTurnId: 'turn-1',
    startedAt: '2026-09-20T01:00:00.000Z', ...more });

test('human recovery restores quiet Claude after restart; old callbacks cannot undo it and new turns still update', async () => {
  session = { ...mockSessions()[1]!, registrationId: 'generation', worktree: null, cliPid: '100' }; adapter.foregrounds.set(session.id, '100');
  const old = event({ source: 'claude', startedAt: '2020-01-01T00:00:00.000Z' });
  await tracker.record(old, session);
  await tracker.record({ ...old, event: 'turn_complete', settled: true, backgroundState: 'clear' }, session);
  expect(tracker.read(session).state).toBe('idle');
  tracker = new AgentActivityTracker(adapter);
  expect(tracker.read(session).state).toBe('unknown');
  const recovered = tracker.confirmReady(session, null);
  expect(recovered.state).toBe('ready'); expect(recovered.detail).toContain('confirmed by you');
  await tracker.record(old, session);
  await tracker.record({ ...old, event: 'turn_complete', settled: true, backgroundState: 'clear' }, session);
  expect(tracker.read(session)).toEqual(recovered);
  const next = { ...old, sourceTurnId: 'next', startedAt: new Date(Date.parse(recovered.updatedAt!) + 1).toISOString() };
  await tracker.record(next, session); expect(tracker.read(session).state).toBe('working');
  expect(() => tracker.confirmReady(session, null)).toThrow('Activity changed');
  await tracker.record({ ...next, event: 'turn_complete', settled: true, backgroundState: 'clear' }, session);
  expect(tracker.read(session).state).toBe('idle');
  expect(tracker.read({ ...session, cliPid: '101' }).state).toBe('unknown');
});
test('status reset rejects a newer unknown completion and an unverifiable CLI', async () => {
  await tracker.record(event(), session);
  await tracker.record(event({ event: 'turn_complete', settled: false }), session);
  expect(tracker.read(session).state).toBe('unknown');
  expect(() => tracker.confirmReady(session, null)).toThrow('Activity changed');
  expect(() => tracker.confirmReady({ ...session, cliPid: null }, null)).toThrow('Activity changed');
  expect(tracker.confirmReady(session, tracker.read(session).updatedAt).state).toBe('ready');
});

test('manual native activity needs no command or run; matching finish makes it idle', async () => {
  expect(tracker.read(session).state).toBe('unknown');
  await tracker.record(event(), session); expect(tracker.read(session).state).toBe('working');
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'unknown', reporterPid: '200' }), session);
  expect(tracker.read(session).state).toBe('idle');
  await tracker.record(event(), session); expect(tracker.read(session).state).toBe('idle');
});
test('an exact interruption ends activity without certifying completion and cannot replace a newer turn', async () => {
  await tracker.record(event(), session);
  const interrupted = event({ event: 'turn_interrupted', settled: false, backgroundState: 'unknown' });
  await tracker.record({ ...interrupted, sourceTurnId: 'older' }, session);
  expect(tracker.read(session).state).toBe('working');
  await tracker.record(interrupted, session); expect(tracker.read(session).state).toBe('interrupted');
  await tracker.record(event(), session);
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }), session);
  expect(tracker.read(session).state).toBe('interrupted');
  await tracker.record(event({ sourceTurnId: 'newer', startedAt: '2026-09-20T02:00:00.000Z' }), session);
  await tracker.record(interrupted, session); expect(tracker.read(session).state).toBe('working');
  adapter.foregrounds.set(session.id, '101');
  await tracker.record({ ...interrupted, sourceTurnId: 'newer', startedAt: '2026-09-20T02:00:00.000Z' }, session);
  expect(tracker.read(session).state).toBe('working');
});
test('fresh interruption after backend restart requires the exact interrupted native binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'altcli-interrupt-binding-'));
  const input = event({ event: 'turn_interrupted', settled: false, backgroundState: 'unknown' });
  const path = join(directory, `${contextKey(session.identity, input.sessionId)}.codex.json`);
  try {
    tracker = new AgentActivityTracker(adapter, (e) => hasCurrentNativeBinding(e, directory));
    writeFileSync(path, JSON.stringify({ phase: 'active', context: input }));
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('unknown');
    writeFileSync(path, JSON.stringify({ phase: 'interrupted', context: input }));
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('interrupted');
    const lateFinish = event({ event: 'turn_complete', settled: true, backgroundState: 'clear' });
    expect(await hasCurrentNativeBinding(lateFinish, directory)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('older starts, wrong turns and duplicate finishes cannot close or replace newer work', async () => {
  await tracker.record(event(), session);
  const newer = event({ sourceTurnId: 'turn-2', startedAt: '2026-09-20T01:00:01.000Z' });
  await tracker.record(newer, session);
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }), session);
  await tracker.record(event(), session); expect(tracker.read(session).state).toBe('working');
  await tracker.record({ ...newer, event: 'turn_complete', settled: true, backgroundState: 'clear' }, session);
  expect(tracker.read(session).state).toBe('idle');
});
test('CLI replacement, pane replacement and backend restart invalidate prior activity', async () => {
  await tracker.record(event(), session);
  adapter.foregrounds.set(session.id, '101');
  const replacement = { ...session, cliPid: '101' };
  expect(tracker.read(replacement).state).toBe('unknown');
  await tracker.record(event({ cliPid: '101', sourceTurnId: 'new-cli' }), replacement);
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }), replacement);
  expect(tracker.read(replacement).state).toBe('working');
  expect(tracker.read({ ...replacement, identity: { ...replacement.identity, serverStarted: '999' } }).state).toBe('unknown');
  expect(new AgentActivityTracker(adapter).read(replacement).state).toBe('unknown');
});
test('missing identity, start or settled-turn evidence never implies idle', async () => {
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }), session);
  await tracker.record(event({ cliPid: undefined }), session);
  await tracker.record(event({ identity: { ...session.identity, panePid: '999' } }), session);
  expect(tracker.read(session).state).toBe('unknown');
  adapter.processes = async () => { throw new Error('unavailable'); };
  await tracker.record(event(), session);
  await tracker.record(event({ event: 'turn_complete', settled: false, backgroundState: 'clear' }), session);
  expect(tracker.read(session).state).toBe('unknown');
});
for (const backgroundState of ['active', 'unknown', 'clear'] as const) test(`Codex settled completion ends native activity with ${backgroundState} background evidence`, async () => {
  const source = 'codex';
  // A service started during the turn persists, just like the live development server.
  await tracker.record(event({ source }), session);
  adapter.trees.set(session.id, [{ pid: '200', command: 'node' }, { pid: '300', command: 'npm run dev' }]);
  await tracker.record(event({ source, event: 'turn_complete', settled: true, backgroundState, reporterPid: '200' }), session);
  expect(tracker.read(session).state).toBe('idle');
  await tracker.record(event({ source }), session); // Duplicate starts cannot resurrect the completed turn.
  expect(tracker.read(session).state).toBe('idle');
  await tracker.record(event({ source, sourceTurnId: 'next', startedAt: '2026-09-20T01:00:01.000Z' }), session);
  expect(tracker.read(session).state).toBe('working');
});
for (const backgroundState of ['active', 'unknown', 'clear'] as const) test(`Claude Stop retains its ${backgroundState} source-specific guard`, async () => {
  session = { ...mockSessions()[1]!, registrationId: 'generation', worktree: null, cliPid: '100' }; adapter.foregrounds.set(session.id, '100');
  await tracker.record(event({ source: 'claude' }), session);
  await tracker.record(event({ source: 'claude', event: 'turn_complete', settled: true, backgroundState }), session);
  expect(tracker.read(session).state).toBe(backgroundState === 'clear' ? 'idle' : backgroundState === 'active' ? 'working' : 'unknown');
});
test('a matching settled completion does not depend on process inspection being available', async () => {
  adapter.processes = async () => { throw new Error('unavailable'); };
  await tracker.record(event(), session);
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'unknown' }), session);
  expect(tracker.read(session).state).toBe('idle');
});
test('ordered Claude Stops keep activity pending until the exact clear observation', async () => {
  session = { ...mockSessions()[1]!, registrationId: 'generation', worktree: null, cliPid: '100' }; adapter.foregrounds.set(session.id, '100');
  await tracker.record(event({ source: 'claude' }), session);
  const complete = event({ source: 'claude', event: 'turn_complete', settled: true, completionSequence: 2, backgroundState: 'active' });
  await tracker.record(complete, session); expect(tracker.read(session).state).toBe('working');
  await tracker.record({ ...complete, completionSequence: 1, backgroundState: 'clear' }, session);
  expect(tracker.read(session).state).toBe('working');
  await tracker.record({ ...complete, completionSequence: 3, backgroundState: 'clear' }, session);
  expect(tracker.read(session).state).toBe('idle');
});
test('Claude restart display recovery rejects a Stop older than the saved pending observation', async () => {
  session = { ...mockSessions()[1]!, registrationId: 'generation', worktree: null, cliPid: '100' }; adapter.foregrounds.set(session.id, '100');
  const directory = mkdtempSync(join(tmpdir(), 'altcli-claude-pending-'));
  const input = event({ source: 'claude', event: 'turn_complete', settled: true, backgroundState: 'clear', completionSequence: 2 });
  const path = join(directory, `${contextKey(session.identity, input.sessionId)}.json`);
  try {
    tracker = new AgentActivityTracker(adapter, e => hasCurrentNativeBinding(e, directory));
    writeFileSync(path, JSON.stringify({ phase: 'active', context: input, completionSequence: 3 }));
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('unknown');
    writeFileSync(path, JSON.stringify({ phase: 'active', context: input, completionSequence: 2 }));
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('idle');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('startup before discovery reports ready without inventing a completed turn', async () => {
  adapter.foreground = async () => '100';
  await tracker.record(event({ event: 'session_started', sourceTurnId: undefined }));
  expect(tracker.read(session).state).toBe('ready');
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }));
  expect(tracker.read(session).state).toBe('ready');
  await tracker.record(event()); // Same millisecond as session startup is still a real prompt.
  expect(tracker.read(session).state).toBe('working');
  await tracker.record(event({ event: 'session_started', sourceTurnId: undefined, startedAt: '2026-09-20T01:00:02.000Z' }));
  expect(tracker.read(session).state).toBe('working');
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }));
  expect(tracker.read(session).state).toBe('idle');
});
test('copy mode and synchronized input cannot discard a matching lifecycle finish', async () => {
  await tracker.record(event(), session);
  const pane = await adapter.inspect(session.identity.paneId);
  adapter.inspect = async () => ({ ...pane, inMode: true, synchronized: true });
  await tracker.record(event({ event: 'turn_complete', settled: true, backgroundState: 'clear' }), session);
  expect(tracker.read(session).state).toBe('idle');
});
test('restart recovery requires the current exact native binding and does not mistake services for a live turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'altcli-activity-binding-'));
  const input = event({ event: 'turn_complete', settled: true, backgroundState: 'unknown', reporterPid: '200' });
  const path = join(directory, `${contextKey(session.identity, input.sessionId)}.codex.json`);
  const context = { source: 'codex', identity: session.identity, sessionId: input.sessionId, sourceTurnId: input.sourceTurnId,
    cliPid: input.cliPid, startedAt: input.startedAt };
  try {
    tracker = new AgentActivityTracker(adapter, (e) => hasCurrentNativeBinding(e, directory));
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('unknown');
    for (const changed of [{ cliPid: '101' }, { sourceTurnId: 'newer-turn' }, { startedAt: '2026-09-20T01:00:01.000Z' }]) {
      writeFileSync(path, JSON.stringify({ phase: 'active', context: { ...context, ...changed } }));
      await tracker.record(input, session); expect(tracker.read(session).state).toBe('unknown');
    }
    writeFileSync(path, JSON.stringify({ phase: 'active', context }));
    const resumed = new AgentActivityTracker(adapter, (e) => hasCurrentNativeBinding(e, directory));
    await resumed.record(event({ event: 'session_started', sourceTurnId: undefined, sessionId: 'resumed-session' }), session);
    await resumed.record(input, session); expect(resumed.read(session).state).toBe('ready');
    adapter.trees.set(session.id, [{ pid: '100', command: 'codex' }, { pid: '200', command: 'node' }]);
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('idle');
    tracker = new AgentActivityTracker(adapter, (e) => hasCurrentNativeBinding(e, directory));
    adapter.trees.set(session.id, [{ pid: '300', command: 'npm run dev' }]);
    await tracker.record(input, session); expect(tracker.read(session).state).toBe('idle');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
