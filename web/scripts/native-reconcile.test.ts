import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/server/config.ts';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { createRunner, TmuxAdapter, type Runner } from '../src/server/adapters/tmux.ts';
import { paneProcesses } from '../src/server/processes.ts';
import type { ManualSession } from '../src/contracts/terminals.ts';

let directory: string, store: Store, plane: ControlPlane, run: Runner;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-reconcile-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(directory, 'data'), ALTCLI_TMUX_SOCKET: join(directory, 't.sock') });
  run = createRunner('tmux', config.tmuxSocket); store = new Store(config.dataDir);
  plane = new ControlPlane(new Controller(config, store, new TmuxAdapter(run)));
  await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-c', directory, '/bin/sh']);
  // new-session can return before the launcher execs the shell. Observe the shell itself before recording its command.
  await run(['send-keys', '-t', 'fixture', "printf 'fixture-%s\\n' ready", 'Enter']);
  for (let n = 0; n < 100; n++) {
    if (/^fixture-ready$/m.test(await run(['capture-pane', '-p', '-t', 'fixture']))) return;
    await wait(20);
  }
  assert.fail('Fixture shell did not reach its prompt.');
});
afterEach(async () => { await plane.terminals.shutdown(); await run(['kill-server']).catch(() => {}); store.close(); await rm(directory, { recursive: true, force: true }); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Seed a released durable recovery record; inventory and settlement below use real tmux and ps, not a mock adapter.
// Panes are recorded by the same snapshot a keyboard grant takes, so grant-time pane states are exercised too.
const grantSnapshot = () => (plane as unknown as { manualSnapshot(): Promise<ManualSession['panes']> }).manualSnapshot();
async function barrier(): Promise<ManualSession> {
  const panes = await grantSnapshot();
  const now = new Date().toISOString();
  return plane.authority.save({ id: randomUUID(), revision: 0, bootId: plane.authority.bootId, clientInstanceId: randomUUID(), connectionId: randomUUID(),
    generation: randomUUID(), target: { launchId: randomUUID() }, live: false, reconciliationRequired: true, inputMayHaveOccurred: true, bytes: 1,
    createdAt: now, updatedAt: now, reason: 'Released recovery fixture', runs: [], panes });
}
const strict = (m: ManualSession) => ({ requestId: randomUUID(), manualSessionId: m.id, expectedRevision: m.revision, confirmReady: true as const });
const human = (m: ManualSession) => ({ requestId: randomUUID(), manualSessionId: m.id, expectedRevision: m.revision, confirmInspected: true as const, note: 'Inspected private fixture server and possible prior/background effects.' });
function held() { assert.throws(() => plane.authority.assertAutomated(), /Manual terminal input/); }

test('private tmux: an idle non-agent shell can settle; cwd changes retain the barrier until an explicit check', async () => {
  let m = await barrier(); held();
  await plane.reconcileManual(strict(m)); assert.equal(plane.authority.blocked, false);
  m = await barrier(); await run(['send-keys', '-t', m.panes[0]!.identity.paneId, 'cd /', 'Enter']);
  for (let n = 0; n < 100 && (await plane.adapter.listPanes())[0]!.cwd !== '/'; n++) await wait(20);
  assert.equal((await plane.adapter.listPanes())[0]!.cwd, '/'); held();
  const result = await plane.reconcileManual(strict(m)); assert.equal(result.reconciliationRequired, false);
});
test('private tmux: a disappearing pane survives restart and flags-off until an idempotent human decision', async () => {
  const m = await barrier(); await run(['kill-pane', '-t', m.panes[0]!.identity.paneId]);
  await assert.rejects(plane.reconcileManual(strict(m)), /Pane identities changed/); held();
  await plane.terminals.shutdown(); plane = new ControlPlane(new Controller(plane.config, store, new TmuxAdapter(run)));
  assert.equal(plane.config.terminalEnabled, false); held();
  const input = human(m), result = await plane.reconcileManual(input);
  assert.deepEqual(result.humanDecision?.note, input.note); assert.match(result.reason, /possible prior and background effects/);
  assert.deepEqual(await plane.reconcileManual(input), result); assert.equal(plane.authority.blocked, false);
  await assert.rejects(plane.reconcileManual({ ...input, note: 'Changed decision' }), /another terminal decision/);
});
test('private tmux: an exited remain-on-exit pane is recoverable only by a recorded inspection decision', async () => {
  const m = await barrier(), pane = m.panes[0]!.identity.paneId;
  await run(['set-window-option', '-t', pane, 'remain-on-exit', 'on']); await run(['send-keys', '-t', pane, 'exit', 'Enter']);
  for (let n = 0; n < 100 && !(await plane.adapter.inspect(pane)).dead; n++) await wait(20);
  assert.equal((await plane.adapter.inspect(pane)).dead, true);
  await assert.rejects(plane.reconcileManual(strict(m)), /A pane exited during manual input/); held();
  await plane.reconcileManual(human(m)); assert.equal(plane.authority.blocked, false);
});
test('private tmux: a pane already exited at the grant neither breaks its snapshot nor strict settlement', async () => {
  // Launches deliberately keep exited programs visible with remain-on-exit; that must not disable keyboard grants.
  await run(['new-session', '-d', '-s', 'exited', '-c', directory, '/usr/bin/env', '/bin/sleep', '30']);
  await run(['set-window-option', '-t', 'exited', 'remain-on-exit', 'on']); await run(['respawn-pane', '-k', '-t', 'exited', '/usr/bin/true']);
  for (let n = 0; n < 100 && !(await plane.adapter.listPanes()).some(p => p.dead); n++) await wait(20);
  const m = await barrier(); held();
  assert.deepEqual(m.panes.filter(p => p.dead).map(p => [p.command, p.processes]), [['exited', []]]);
  await plane.reconcileManual(strict(m)); assert.equal(plane.authority.blocked, false);
});
test('private tmux: a surviving process in a non-agent pane blocks strict settlement', async () => {
  const m = await barrier(), pane = m.panes[0]!.identity.paneId;
  await run(['send-keys', '-t', pane, 'sleep 300 &', 'Enter']);
  for (let n = 0; n < 100 && !(await paneProcesses(m.panes[0]!.identity.panePid)).length; n++) await wait(20);
  const children = await paneProcesses(m.panes[0]!.identity.panePid);
  try { await assert.rejects(plane.reconcileManual(strict(m)), /background processes/); held(); }
  finally { for (const child of children) try { process.kill(Number(child.pid), 'SIGKILL'); } catch { /* already exited */ } }
});
test('private tmux: replacing the shell with exec preserves its PID but cannot pass strict settlement', async () => {
  const m = await barrier(), pane = m.panes[0]!.identity.paneId;
  await run(['send-keys', '-t', pane, 'exec sleep 300', 'Enter']);
  for (let n = 0; n < 100 && (await plane.adapter.inspect(pane)).command !== 'sleep'; n++) await wait(20);
  const current = await plane.adapter.inspect(pane);
  assert.equal(current.command, 'sleep'); assert.deepEqual(current.identity, m.panes[0]!.identity);
  assert.deepEqual(await paneProcesses(current.identity.panePid), []);
  await assert.rejects(plane.reconcileManual(strict(m)), /non-agent command changed/); held();
  await plane.reconcileManual(human(m)); assert.equal(plane.authority.blocked, false);
});
