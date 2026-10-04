/** Actual Git/tmux/ps subprocess counts, using shells on a disposable socket, never installed coding agents. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/server/config.ts';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { createRunner, TmuxAdapter } from '../src/server/adapters/tmux.ts';
import { foregroundPid } from '../src/server/processes.ts';
import { observe, OBSERVATION_PROCESSES } from '../src/server/observation.ts';

test('private tmux: display traffic shares discovery and bounds actual child creation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-observation-')));
  const root = join(directory, 'repo'); await mkdir(root);
  const git = (args: string[]) => childProcess.execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture']);
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(directory, 'data'), ALTCLI_TMUX_SOCKET: join(directory, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket), adapter = new TmuxAdapter(run), store = new Store(config.dataDir);
  const plane = new ControlPlane(new Controller(config, store, adapter));
  const execFile = childProcess.execFile, spawn = childProcess.spawn;
  let measuring = false;
  const starts: number[] = [];
  // execFile uses Node's internal spawn; the exported spawn counts the streaming ls-files probe separately.
  childProcess.execFile = function (...args: Parameters<typeof execFile>) { if (measuring) starts.push(performance.now()); return execFile(...args); } as typeof execFile;
  childProcess.spawn = function (...args: Parameters<typeof spawn>) { if (measuring) starts.push(performance.now()); return spawn(...args); } as typeof spawn;
  syncBuiltinESMExports();
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-c', root, '/bin/sh']);
    const pane = (await adapter.listPanes())[0]!;
    const measure = async (read: () => Promise<unknown>) => {
      starts.length = 0; measuring = true;
      try { await read(); } finally { measuring = false; }
      return [...starts];
    };
    // This is the old endpoint call graph; keep the reproduction small to avoid repeating the incident.
    const baseline = await measure(() => Promise.all(Array.from({ length: 3 }, () => Promise.all([plane.state(), plane.workspaces()]))));
    const shared = await measure(() => Promise.all(Array.from({ length: 100 }, () => Promise.all([plane.observedState(), plane.observedWorkspaces()]))));
    assert.ok(shared.length > 0 && shared.length < baseline.length / 3, `${baseline.length} baseline starts vs ${shared.length} shared starts`);
    const discovery = await plane.observedWorkspaces();
    assert.equal(discovery.error, null); assert.equal(discovery.workspaces.length, 1);
    assert.equal(discovery.projects?.[0]?.worktrees.length, 1);
    assert.ok(discovery.workspaces[0]?.git?.clean);
    assert.equal((await measure(() => plane.observedState())).length, 0);
    const probes = await measure(() => observe(() => Promise.all(Array.from({ length: 80 }, () => foregroundPid(pane.identity.panePid)))));
    assert.equal(probes.length, 80);
    for (const start of probes) assert.ok(probes.filter(time => time >= start && time < start + 1000).length <= 41, 'No more than 40 starts/second plus a boundary start');
    assert.ok(probes.at(-1)! - probes[0]! >= 79 * OBSERVATION_PROCESSES.spacingMs - 1);
    t.diagnostic(`Real subprocesses: 3 uncached state/workspace pairs = ${baseline.length}; 100 shared pairs = ${shared.length}; 80 ps probes over ${(probes.at(-1)! - probes[0]!).toFixed(0)} ms.`);
    // Failure after cached success must become unavailable on the fresh execution path.
    await run(['kill-server']);
    assert.equal((await plane.workspaces()).workspaces.length, 0);
  } finally {
    measuring = false; childProcess.execFile = execFile; childProcess.spawn = spawn; syncBuiltinESMExports();
    await plane.terminals.shutdown(); await run(['kill-server']).catch(() => {});
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
