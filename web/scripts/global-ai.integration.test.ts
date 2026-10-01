import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/server/config.ts';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { GlobalControlPlane } from '../src/server/global-ai/plane.ts';

test('Global AI shares the existing SQLite/controller/terminal authority without enabling model effects', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-global-state-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_ADAPTER: 'mock', ALTCLI_DATA_DIR: directory,
    ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  const store = new Store(config.dataDir);
  for (const session of mockSessions()) store.saveSession(session);
  const plane = new GlobalControlPlane(new Controller(config, store, new MockAdapter()));
  try {
    assert.equal(plane.store, store);
    assert.equal(plane.terminals.services.authority, plane.authority);
    assert.equal(store.db.prepare('PRAGMA user_version').get() && (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 19);
    const result = await plane.globalAI.ownerRead({ name: 'get_capabilities', arguments: {} });
    assert.equal((result.data as { effects: boolean }).effects, false);
    assert.equal(JSON.stringify(result).includes(config.token), false);
    assert.equal((await plane.globalAI.view()).instance, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM global_ai_instances').get() && (store.db.prepare('SELECT COUNT(*) AS n FROM global_ai_instances').get() as { n: number }).n, 0);
    // Creating the service never starts a native CLI or another scheduler, even when host flags are enabled.
    const discovery = await plane.workspaces(); assert.ok(discovery.workspaces.length > 0);
    const scoped = await plane.globalAI.ownerRead({ name: 'list_runs', arguments: {} });
    assert.deepEqual((scoped.data as { runs: unknown[] }).runs, []);
  } finally { await plane.terminals.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
