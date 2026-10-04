import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundOwner } from '../src/server/background/http.ts';
import { controller } from '../src/server/runtime.ts';
import { terminalHost } from '../src/server/terminal-gateway.ts';

test('Background owner HTTP preserves asynchronous refusals and previews only verified versions without enabling', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-background-http-'))), saved = { ...process.env };
  const token = 'a'.repeat(64), origin = 'http://127.0.0.1:8787', executable = join(directory, 'claude');
  Object.assign(process.env, { ALTCLI_ADAPTER: 'mock', ALTCLI_TOKEN: token, ALTCLI_DATA_DIR: directory, ALTCLI_ALLOWED_ORIGINS: origin });
  const bridge = terminalHost(), previousOrigin = bridge.loopbackOrigin; bridge.loopbackOrigin = origin;
  let plane: ReturnType<typeof controller> | undefined;
  const request = (body: unknown, authenticated = true) => backgroundOwner(new Request(`${origin}/api/v1/background`, {
    method: 'POST', headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const binary = (version: string) => writeFile(executable, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o700 });
  try {
    plane = controller(); const service = plane.background;
    const profile = { id: randomUUID(), label: 'Fixture', executable, args: [], adapterHint: 'claude' as const, revision: 1, enabled: true, purpose: 'background' as const };
    service.services.profiles = () => [profile]; service.services.enabled = () => true;
    await binary('0.0.0 (Claude Code)');
    await t.test('version refusal reaches the owner with its actionable code and message', async () => {
      const response = await request({ action: 'preview', profileId: profile.id });
      assert.equal(response.status, 409);
      const { error } = await response.json(); assert.equal(error.code, 'ADAPTER_VERSION');
      assert.match(error.message, /0\.0\.0/); assert.match(error.message, /native capability probe/);
    });
    for (const version of ['2.1.288 (Claude Code)', '2.1.289 (Claude Code)']) await t.test(`preview accepts ${version}`, async () => {
      await binary(version);
      const response = await request({ action: 'preview', profileId: profile.id });
      assert.equal(response.status, 200); const preview = await response.json();
      assert.equal(preview.providerVersion, version); assert.equal(preview.executable, executable);
      assert.equal(service.settings().enabled, false); assert.equal(service.settings().instance, null);
    });
    await t.test('missing executable is reported without a generic controller error', async () => {
      await rm(executable);
      const response = await request({ action: 'preview', profileId: profile.id });
      assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'CLI_MISSING');
    });
    await t.test('enable and control refusals retain their status and code', async () => {
      service.services.enabled = () => false;
      for (const body of [
        { action: 'enable', id: randomUUID(), requestId: randomUUID(), digest: 'b'.repeat(64), confirm: true },
        { action: 'inspect', instanceId: randomUUID() },
      ]) {
        const response = await request(body); assert.equal(response.status, body.action === 'enable' ? 403 : 409);
        assert.equal((await response.json()).error.code, body.action === 'enable' ? 'BACKGROUND_DISABLED' : 'INSTANCE_CHANGED');
      }
    });
    await t.test('owner authentication is still required', async () => {
      assert.equal((await request({ action: 'preview', profileId: profile.id }, false)).status, 401);
    });
  } finally {
    if (plane) { plane.attention.stop(); await plane.background.shutdown(); plane.store.close(); }
    bridge.loopbackOrigin = previousOrigin;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  }
});
