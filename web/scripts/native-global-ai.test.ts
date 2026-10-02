import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { GlobalAIInstance } from '../src/contracts/global-ai.ts';
import type { LaunchProfile } from '../src/contracts/launches.ts';
import { loadConfig } from '../src/server/config.ts';
import { NativeGlobalHost } from '../src/server/global-ai/host.ts';
import { GlobalAIService } from '../src/server/global-ai/service.ts';
import { AppReads } from '../src/server/global-ai/reads.ts';
import { terminalRunner } from '../src/server/terminal-environment.ts';

async function eventually(check: () => Promise<boolean>) { for (let n=0;n<100;n++) { if (await check()) return; await delay(20); } assert.fail('Native condition timed out'); }
let hasTmux = true; try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { hasTmux = false; }
test('private tmux: Git-free Global AI startup is inspectable before agent recognition, without touching workspace sessions', { skip: !hasTmux }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-global-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: directory, ALTCLI_TMUX_SOCKET: join(directory, 't.sock'),
    ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const binary = join(directory, 'codex');
  await writeFile(binary, '#!/bin/sh\nprintf "Fixture startup: resolve login in the native terminal\\n"\nexec /bin/cat\n', { mode: 0o700 });
  const profile: LaunchProfile = { id: 'fixture', revision: 1, label: 'Fixture Codex', executable: binary, args: [], adapterHint: 'codex', enabled: true, purpose: 'helper' };
  const host = new NativeGlobalHost(config, resolve(process.cwd(), '..')), records = new Map<string, GlobalAIInstance>();
  const reads = new AppReads({ kb: { documents: [] }, featureFlags: () => ({}),
    state: async () => { throw new Error('No fixture state read expected.'); }, workspaces: async () => { throw new Error('No fixture discovery expected.'); }, run: () => undefined });
  const service = new GlobalAIService({ repository: { all: () => [...records.values()], save: i => { records.set(i.id, structuredClone(i)); } },
    host, reads, directory: join(config.dataDir, 'global-ai'), profiles: () => [profile], enabled: () => true, launchGuard: work => work() });
  const run = terminalRunner(config);
  try {
    const preview = await service.preview({ profileId: 'fixture' }, 'http://127.0.0.1:8787');
    const result = await service.start({ id: preview.id, digest: preview.digest, requestId: preview.id, confirm: true });
    assert.equal(result.instance!.status, 'started', result.instance!.message);
    const instance = result.instance!, pane = await host.inspect(instance);
    assert.equal(pane.dead, false); assert.equal(pane.identity.paneId, instance.identity!.paneId);
    // The respawned program writes asynchronously; poll the exact pane rather than racing its first output.
    await eventually(async () => /Fixture startup/.test(await host.capture(instance)));
    await run(['send-keys', '-t', pane.identity.paneId, '-l', 'global fixture input']);
    await run(['send-keys', '-t', pane.identity.paneId, 'Enter']);
    await eventually(async () => /global fixture input/.test(await host.capture(instance)));
    service.revoke(); assert.equal((await service.view()).nativeState, 'alive');
    // Retiring tool authority is metadata-only; native inspection still finds the original process.
    await service.retire({ instanceId: instance.id, confirm: true });
    assert.equal((await host.inspect(instance)).dead, false);
    // Restart: a second conversation starts after retirement, and stopping it ends exactly its own session.
    const again = await service.preview({ profileId: 'fixture' }, 'http://127.0.0.1:8787');
    const second = (await service.start({ id: again.id, digest: again.digest, requestId: again.id, confirm: true })).instance!;
    assert.equal(second.status, 'started', second.message);
    const extra = (await run(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', second.sessionId!, '/bin/sleep', '300'])).trim();
    await assert.rejects(service.retire({ instanceId: second.id, confirm: true, stop: true }), { code: 'GLOBAL_IDENTITY', message: /additional panes or windows/ });
    assert.equal(records.get(second.id)!.status, 'started'); assert.equal((await host.inspect(second)).dead, false);
    await run(['kill-window', '-t', extra]);
    await service.retire({ instanceId: second.id, confirm: true, stop: true });
    await assert.rejects(host.inspect(second)); assert.equal((await host.inspect(instance)).dead, false);
  } finally { await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
test('private tmux: a Claude Code Helper receives its exact arguments and CLAUDE.md orientation', { skip: !hasTmux }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-global-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: directory, ALTCLI_TMUX_SOCKET: join(directory, 't.sock'),
    ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // A harmless program named claude, not the provider: it records its argv in its working directory, then echoes input.
  const binary = join(directory, 'claude');
  await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > argv.txt\nprintf "Fixture startup\\n"\nexec /bin/cat\n', { mode: 0o700 });
  const profile: LaunchProfile = { id: 'fixture', revision: 1, label: 'Fixture Claude', executable: binary, args: ['--model', 'sonnet'], adapterHint: 'claude', enabled: true, purpose: 'helper' };
  const host = new NativeGlobalHost(config, resolve(process.cwd(), '..')), records = new Map<string, GlobalAIInstance>();
  const reads = new AppReads({ kb: { documents: [] }, featureFlags: () => ({}),
    state: async () => { throw new Error('No fixture state read expected.'); }, workspaces: async () => { throw new Error('No fixture discovery expected.'); }, run: () => undefined });
  const service = new GlobalAIService({ repository: { all: () => [...records.values()], save: i => { records.set(i.id, structuredClone(i)); } },
    host, reads, directory: join(config.dataDir, 'global-ai'), profiles: () => [profile], enabled: () => true, launchGuard: work => work() });
  const run = terminalRunner(config);
  try {
    const preview = await service.preview({ profileId: 'fixture' }, 'http://127.0.0.1:8787');
    const instance = (await service.start({ id: preview.id, digest: preview.digest, requestId: preview.id, confirm: true })).instance!;
    assert.equal(instance.status, 'started', instance.message);
    await eventually(async () => /Fixture startup/.test(await host.capture(instance)));
    // tmux passes the JSON MCP configuration through unchanged, and the program starts in the private directory it is told about.
    assert.deepEqual((await readFile(join(instance.directory, 'argv.txt'), 'utf8')).split('\n').slice(0, -1), instance.args);
    assert.ok(instance.args.includes('manual'));
    assert.match(await readFile(join(instance.directory, 'CLAUDE.md'), 'utf8'), /^# AltCLI Helper/);
    await assert.rejects(readFile(join(instance.directory, 'AGENTS.md')));
    await service.retire({ instanceId: instance.id, confirm: true, stop: true });
    await assert.rejects(host.inspect(instance));
  } finally { await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
