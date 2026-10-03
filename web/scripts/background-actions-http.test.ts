import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { controller } from '../src/server/runtime.ts';
import { terminalHost } from '../src/server/terminal-gateway.ts';
import { POST as profiles } from '../src/app/api/v1/launch-profiles/route.ts';
import { DELETE as removeGroup } from '../src/app/api/v1/groups/[id]/route.ts';
import { GET as log, POST as decide } from '../src/app/api/v1/background/actions/route.ts';
import type { BackgroundAttempt } from '../src/contracts/background.ts';
import type { BackgroundAction } from '../src/contracts/background-actions.ts';

test('confirmed Background app request passes through real owner auth, a single-use grant and the existing profile operation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-action-http-'))), token = 'b'.repeat(64), saved = { ...process.env };
  Object.assign(process.env, { ALTCLI_ADAPTER: 'mock', ALTCLI_TOKEN: token, ALTCLI_DATA_DIR: directory, ALTCLI_ENABLE_INPUT: 'true', ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  let calls = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(`${terminalHost().loopbackOrigin}${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>,
        ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks).toString() }) });
      const isProfile = incoming.url === '/api/v1/launch-profiles';
      if (isProfile) calls++;
      const response = await (incoming.method === 'DELETE' ? removeGroup(request, { params: Promise.resolve({ id: 'fixture-group' }) })
        : isProfile ? profiles(request) : incoming.method === 'GET' ? log(request) : decide(request));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500).end(); }
  });
  let plane: ReturnType<typeof controller> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`; process.env.ALTCLI_ALLOWED_ORIGINS = origin; terminalHost().loopbackOrigin = origin;
    plane = controller();
    const actions = plane.background.actions;
    // Fixture an already admitted Background identity; native launch and scoped job auth have separate real-tmux coverage.
    actions.services.enabled = () => true;
    const settings = { revision: 1, enabled: true, paused: false, needsInspection: false, failures: 0, instance: { id: 'fixture-instance' }, message: 'Fixture' };
    plane.store.db.prepare('INSERT INTO background_state(id,value) VALUES(1,?)').run(JSON.stringify(settings));
    const item = { id: 'fixture-issue', key: 'fixture-issue', status: 'open', stale: false, revision: 1, sourceVersion: 1 };
    plane.store.db.prepare('INSERT INTO attention_items(id,key,status,fingerprint,updated_at,value) VALUES(?,?,?,?,?,?)').run(item.id, item.key, item.status, 'fixture', new Date().toISOString(), JSON.stringify(item));
    const attempt = { id: 'fixture-job', instanceId: settings.instance.id, enablement: 1, itemId: item.id, itemRevision: 1, sourceVersion: 1 } as BackgroundAttempt;
    const body = { label: 'Confirmed fixture profile', executable: 'codex', args: [], adapterHint: 'codex', enabled: true, purpose: 'agent' };
    const result = await actions.tool('request_action', { requestKey: randomUUID(), reason: 'Create the fixture profile requested by its owner.', operation: { kind: 'app', method: 'POST', path: '/api/v1/launch-profiles', body } }, attempt) as { action: { id: string } };
    const a = JSON.parse((plane.store.db.prepare('SELECT value FROM background_actions WHERE id=?').get(result.action.id) as { value: string }).value) as BackgroundAction;
    const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
    const before = await fetch(`${origin}/api/v1/background/actions`, { headers }); assert.equal(before.status, 200); assert.equal(calls, 0);
    const approval = { action: 'approve', id: a.id, digest: a.digest, confirm: true };
    const accepted = await fetch(`${origin}/api/v1/background/actions`, { method: 'POST', headers, body: JSON.stringify(approval) }); assert.equal(accepted.status, 200);
    await actions.drain(); assert.equal(calls, 1);
    assert.ok(plane.launches.profiles().some(p => p.label === body.label));
    const history = await (await fetch(`${origin}/api/v1/background/actions`, { headers })).json();
    assert.ok(history.entries.some((e: { kind: string }) => e.kind === 'completed'));
    assert.equal(JSON.stringify(history).includes(token), false);
    await fetch(`${origin}/api/v1/background/actions`, { method: 'POST', headers, body: JSON.stringify(approval) }); await actions.drain(); assert.equal(calls, 1);
    const forged = await fetch(`${origin}/api/v1/launch-profiles`, { method: 'POST', headers: { ...headers, 'X-AltCLI-Background-Action': 'forged' }, body: JSON.stringify({ ...body, label: 'Must not exist' }) });
    assert.equal(forged.status, 403); assert.equal(plane.launches.profiles().some(p => p.label === 'Must not exist'), false);
    const unauthenticated = await fetch(`${origin}/api/v1/background/actions`); assert.equal(unauthenticated.status, 401);
    // A private-HTTPS-only browser configuration must not require opening an extra origin just for internal delivery.
    process.env.ALTCLI_ALLOWED_ORIGINS = 'https://console.example.test'; plane.config.allowedOrigins = [process.env.ALTCLI_ALLOWED_ORIGINS];
    const second = await actions.tool('request_action', { requestKey: randomUUID(), reason: 'Exercise configured HTTPS owner gates over fixed loopback transport.',
      operation: { kind: 'app', method: 'POST', path: '/api/v1/launch-profiles', body: { ...body, label: 'HTTPS origin fixture' } } }, attempt) as { action: { id: string } };
    const next = actions.view().actions.find(a => a.id === second.action.id)!;
    actions.decide({ action: 'approve', id: next.id, digest: next.digest, confirm: true }); await actions.drain();
    assert.ok(plane.launches.profiles().some(p => p.label === 'HTTPS origin fixture'));
    // Existing bodyless DELETE operations still bind an exact empty body and reach their normal handler.
    plane.store.db.prepare('INSERT INTO groups(id,value) VALUES(?,?)').run('fixture-group', JSON.stringify({ id: 'fixture-group', members: [] }));
    const deletion = await actions.tool('request_action', { requestKey: randomUUID(), reason: 'Remove the empty fixture group.',
      operation: { kind: 'app', method: 'DELETE', path: '/api/v1/groups/fixture-group' } }, attempt) as { action: { id: string } };
    const pending = actions.view().actions.find(a => a.id === deletion.action.id)!;
    actions.decide({ action: 'approve', id: pending.id, digest: pending.digest, confirm: true }); await actions.drain();
    assert.equal(plane.store.groups().some(g => g.id === 'fixture-group'), false);
  } finally {
    if (plane) { plane.attention.stop(); await plane.background.shutdown(); plane.store.close(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
});
