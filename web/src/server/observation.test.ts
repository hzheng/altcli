import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { Controller } from './controller';
import { ControlPlane } from './control-plane';
import { MockAdapter, mockSessions } from './adapters/mock';
import { loadConfig } from './config';

describe('observation admission', () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  test('coalesces slow reads, cools down after completion, and isolates returned snapshots', async () => {
    const { ObservedRead } = await import('./observation');
    const read = new ObservedRead<{ version: number }>(2000);
    let finish!: (value: { version: number }) => void;
    const load = vi.fn(() => new Promise<{ version: number }>(resolve => { finish = resolve; }));
    const first = read.read(load);
    await vi.advanceTimersByTimeAsync(10_000);
    const others = Array.from({ length: 100 }, () => read.read(load));
    expect(load).toHaveBeenCalledTimes(1);
    finish({ version: 1 });
    (await first).version = 9;
    expect((await Promise.all(others)).every(value => value.version === 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(await read.read(load)).toEqual({ version: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = read.read(load); finish({ version: 2 });
    expect(await next).toEqual({ version: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a failed refresh replaces success and cannot cause a retry storm', async () => {
    const { ObservedRead } = await import('./observation');
    const read = new ObservedRead<number>(2000);
    const load = vi.fn(async () => 1);
    expect(await read.read(load)).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    load.mockRejectedValue(new Error('unavailable'));
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => read.read(load)));
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    load.mockResolvedValue(2);
    expect(await read.read(load)).toBe(2);
  });

  test('a changed revision waits for an older in-flight scan, then shares one fresh scan', async () => {
    const { ObservedRead } = await import('./observation');
    const read = new ObservedRead<number>(5000);
    let revision = 1, finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = read.read(load, () => revision);
    revision++;
    const waiting = Array.from({ length: 100 }, () => read.read(load, () => revision));
    expect(load).toHaveBeenCalledTimes(1);
    finish(1); await first; await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    finish(2); expect(await Promise.all(waiting)).toEqual(Array(100).fill(2));
  });

  test('paces fast subprocess starts, rather than merely limiting their overlap', async () => {
    const { observe, observationProcess, OBSERVATION_PROCESSES: limit } = await import('./observation');
    const starts: number[] = [];
    const jobs = observe(() => Promise.all(Array.from({ length: 100 }, () => observationProcess(async () => { starts.push(performance.now()); }))));
    await vi.runAllTimersAsync(); await jobs;
    expect(starts).toHaveLength(100);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(limit.spacingMs);
  });

  test('bounds slow children and waiting work, releases failures, and leaves action checks independent', async () => {
    const { observe, observationProcess, OBSERVATION_PROCESSES: limit } = await import('./observation');
    const finish: (() => void)[] = [];
    let active = 0, peak = 0, spawned = 0;
    const child = () => observationProcess(() => new Promise<void>((resolve, reject) => {
      spawned++; peak = Math.max(peak, ++active);
      const fail = spawned === 1;
      finish.push(() => { active--; if (fail) reject(new Error('probe failed')); else resolve(); });
    }));
    // Attach rejection handlers immediately, including to refused queue admissions.
    const jobs = observe(() => Promise.allSettled(Array.from({ length: limit.queued + 20 }, child)));
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned).toBe(limit.concurrent);
    expect(peak).toBe(limit.concurrent);
    const action = vi.fn(async () => 'fresh');
    expect(await observationProcess(action)).toBe('fresh');
    expect(action).toHaveBeenCalledTimes(1);
    while (finish.length) { finish.splice(0).forEach(done => done()); await vi.advanceTimersByTimeAsync(1000); }
    const results = await jobs;
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(20);
    expect(peak).toBe(limit.concurrent);
    expect(await observe(() => observationProcess(async () => 'recovered'))).toBe('recovered');
  });
});

describe('shared ControlPlane display reads', () => {
  let directory: string, store: Store, adapter: MockAdapter, plane: ControlPlane;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'altcli-observation-'));
    store = new Store(directory); for (const session of mockSessions()) store.saveSession(session);
    adapter = new MockAdapter();
    plane = new ControlPlane(new Controller(loadConfig({ ALTCLI_ADAPTER: 'mock', ALTCLI_ENABLE_LEGACY_RELAY: 'true', ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: directory }), store, adapter));
  });
  afterEach(async () => { await plane.terminals.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  test('many state and workspace clients share one inventory and one capture per agent', async () => {
    const inventory = vi.spyOn(plane.projects, 'discover'), capture = vi.spyOn(adapter, 'capture');
    const results = await Promise.all(Array.from({ length: 100 }, () => Promise.all([plane.observedState(), plane.observedWorkspaces()])));
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(results[0]![0].sessions.length);
    expect(store.db.prepare('SELECT count(*) AS count FROM workflow_runs').get()).toEqual({ count: 0 });
    expect(await plane.observedState()).toEqual(results[0]![0]);
  });

  test('a warm display snapshot cannot authorize a missing pane or suppress fresh discovery', async () => {
    const state = await plane.observedState();
    const group = state.groups.find(group => group.cwd === '/demo/project')!;
    adapter.listPanes = async () => [];
    const send = vi.spyOn(adapter, 'send');
    await expect(plane.submit({ requestId: randomUUID(), agentId: 'codex', kind: 'relay', confirmReady: true,
      pairId: group.id, stage: { branch: 'main', head: 'a'.repeat(40) } })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const list = vi.spyOn(adapter, 'listPanes');
    await plane.workspaces(); await plane.workspaces();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test('recorded changes appear immediately after a write despite a warm display cache', async () => {
    const before = await plane.observedState();
    const group = before.groups.find(group => group.cwd === '/demo/project')!;
    const id = randomUUID();
    await plane.submit({ requestId: id, agentId: 'codex', kind: 'relay', confirmReady: true,
      pairId: group.id, stage: { branch: 'main', head: 'a'.repeat(40) } });
    expect((await plane.observedState()).runs.some(run => run.id === id)).toBe(true);
    plane.action({ runId: id, action: 'pause' });
    expect((await plane.observedState()).runs.find(run => run.id === id)?.status).toBe('paused');
    plane.action({ runId: id, action: 'takeover', confirmReady: true });
    plane.remove('codex');
    expect((await plane.observedWorkspaces()).workspaces.flatMap(workspace => workspace.agents).some(agent => agent.registeredAs === 'codex')).toBe(false);
  });
});
