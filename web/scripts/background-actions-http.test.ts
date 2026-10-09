import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { controller } from '../src/server/runtime.ts';
import { terminalHost } from '../src/server/terminal-gateway.ts';
import { GET as readProfiles, POST as profiles } from '../src/app/api/v1/launch-profiles/route.ts';
import { GET as readLaunches } from '../src/app/api/v1/launches/route.ts';
import { DELETE as removeGroup } from '../src/app/api/v1/groups/[id]/route.ts';
import { GET as log, POST as decide } from '../src/app/api/v1/background/actions/route.ts';
import type { BackgroundAttempt } from '../src/contracts/background.ts';
import type { BackgroundAction } from '../src/contracts/background-actions.ts';
import type { BackgroundSettings } from '../src/contracts/background.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import { BackgroundActions, operation } from '../src/server/background/actions.ts';
import { executeApp } from '../src/server/background/action-executor.ts';
import { endpoint } from '../src/server/http.ts';
import { Store } from '../src/server/store.ts';
import { AppError } from '../src/core/errors.ts';
import { READ_APP_OPERATIONS } from '../src/server/background/app-operations.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
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
        : isProfile ? (incoming.method === 'GET' ? readProfiles(request) : profiles(request))
        : incoming.url === '/api/v1/launches' ? readLaunches(request) : incoming.method === 'GET' ? log(request) : decide(request));
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
    assert.ok(history.entries.some((e: { kind: string }) => e.kind === 'accepted'));
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
    for (const path of ['/api/v1/launch-profiles', '/api/v1/launches']) {
      const job = { ...attempt, id: randomUUID() };
      const result = await actions.tool('request_action', { requestKey: randomUUID(), reason: 'Read stored launch state.', operation: { kind: 'app', method: 'GET', path } }, job) as { action: { id: string } };
      const pending = actions.view().actions.find(a => a.id === result.action.id)!;
      actions.decide({ action: 'approve', id: pending.id, digest: pending.digest, confirm: true }); await actions.drain();
      const { action } = await actions.tool('get_actions', { actionId: pending.id }, job) as { action: BackgroundAction };
      assert.equal(action.status, 'completed');
    }
  } finally {
    if (plane) { plane.attention.stop(); await plane.background.shutdown(); plane.store.close(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
});

// This inventory is deliberately explicit: adding a reachable route requires auditing its guard.
const ownerRoutes: Record<string, string[]> = {
  'activities/reset': ['POST'],
  'attention': ['GET', 'POST'],
  'checkpoints': ['POST'],
  'commands': ['POST'],
  'config': ['GET'],
  'control/release': ['POST'],
  'directories': ['POST'],
  'global-ai': ['GET', 'POST'],
  'groups/[id]': ['DELETE', 'PATCH'],
  'groups': ['POST'],
  'history/export': ['GET'],
  'implementation/policy': ['POST'],
  'implementation/preview': ['POST'],
  'implementation': ['POST'],
  'instructions': ['POST'],
  'interactions': ['POST'],
  'launch-profiles/[id]': ['DELETE', 'PATCH'],
  'launch-profiles': ['GET', 'POST'],
  'launches/[id]/capture': ['GET'],
  'launches/[id]/cleanup/preview': ['POST'],
  'launches/[id]/cleanup': ['POST'],
  'launches/[id]/inspect': ['POST'],
  'launches/[id]/reconcile': ['POST'],
  'launches/missing': ['GET'],
  'launches/preview': ['POST'],
  'launches': ['GET', 'POST'],
  'pairs/[id]': ['DELETE'],
  'pairs': ['POST'],
  'panes/preview': ['GET'],
  'planning/decision': ['POST'],
  'planning': ['POST'],
  'projects': ['POST'],
  'projects/settings': ['POST'],
  'projects/worktrees/discard/finish': ['POST'],
  'projects/worktrees/discard/preview': ['POST'],
  'projects/worktrees/discard/reconcile': ['POST'],
  'projects/worktrees/discard': ['POST'],
  'projects/worktrees/finish/continue': ['POST'],
  'projects/worktrees/finish/preview': ['POST'],
  'projects/worktrees/finish/reconcile': ['POST'],
  'projects/worktrees/finish': ['POST'],
  'projects/worktrees/integration/preview': ['POST'],
  'projects/worktrees/integration/reconcile': ['POST'],
  'projects/worktrees/integration/release': ['POST'],
  'projects/worktrees/integration': ['POST'],
  'projects/worktrees/preview': ['POST'],
  'projects/worktrees/reconcile': ['POST'],
  'projects/worktrees/removal/preview': ['POST'],
  'projects/worktrees/removal/reconcile': ['POST'],
  'projects/worktrees/removal': ['POST'],
  'projects/worktrees/rename/preview': ['POST'],
  'projects/worktrees/rename/reconcile': ['POST'],
  'projects/worktrees/rename': ['POST'],
  'projects/worktrees': ['POST'],
  'projects/worktrees/update/preview': ['POST'],
  'projects/worktrees/update/reconcile': ['POST'],
  'projects/worktrees/update': ['POST'],
  'runs': ['POST'],
  'sessions/[id]': ['DELETE', 'PATCH'],
  'sessions/clear-context': ['POST'],
  'sessions': ['POST'],
  'state': ['GET'],
  'terminals/[id]/close': ['POST'],
  'terminals/[id]/input': ['POST'],
  'terminals/[id]/keyboard': ['POST'],
  'terminals/[id]/resize': ['POST'],
  'terminals/reconcile': ['POST'],
  'terminals/revoke': ['POST'],
  'terminals': ['POST'],
  'terminals/stop': ['POST'],
  'workspaces/reset': ['POST'],
  'workspaces': ['GET'],
};

test('every inventoried reachable owner handler consumes a grant before its operation, including globalOwner', async () => {
  const previous = { ...process.env }, host = terminalHost(), consume = host.consumeBackgroundAction;
  const token = 'c'.repeat(64), origin = 'http://127.0.0.1:43210', seen: Record<string, string[]> = {};
  // Match the project's TypeScript alias while importing the actual Next route exports in Node.
  const aliases = registerHooks({ resolve(specifier, context, next) {
    return next(specifier.startsWith('@/') ? new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context);
  } });
  Object.assign(process.env, { ALTCLI_TOKEN: token, ALTCLI_ALLOWED_ORIGINS: origin });
  let guarded = 0;
  host.consumeBackgroundAction = () => { guarded++; throw new Error('Refuse before the handler.'); };
  try {
    const root = new URL('../src/app/api/v1/', import.meta.url);
    for (const file of readdirSync(root, { recursive: true }).map(String).filter(p => p.endsWith('/route.ts')).sort()) {
      const route = file.slice(0, -'/route.ts'.length), path = '/api/v1/' + route.replace(/\[id\]/g, 'fixture');
      try { operation({ kind: 'app', method: 'GET', path }); } catch { continue; }
      const exports = await import(new URL(file, root).href);
      const methods = Object.keys(exports).filter(k => /^(GET|POST|PATCH|DELETE|PUT|HEAD|OPTIONS)$/.test(k)).sort();
      seen[route] = methods;
      for (const method of methods) {
        const before = guarded;
        const response: Response = await exports[method](new Request(origin + path, { method,
          headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json', 'X-AltCLI-Background-Action': 'invalid' },
          ...(method === 'GET' ? {} : { body: '{}' }) }), { params: Promise.resolve({ id: 'fixture' }) });
        assert.equal(response.status, 403, `${method} ${route}`);
        assert.equal(guarded, before + 1, `${method} ${route} must invoke the grant boundary`);
      }
    }
    assert.deepEqual(seen, ownerRoutes);
    for (const entry of READ_APP_OPERATIONS) {
      const [method, path] = entry.split(' '); assert.ok(seen[path!.slice('/api/v1/'.length)]?.includes(method!));
    }
  } finally { aliases.deregister(); host.consumeBackgroundAction = consume; process.env = previous; }
});

test('HTTP outcome evidence distinguishes unused grants, audited reads, accepted effects and uncertain delivery', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-action-outcomes-'))), store = new Store(directory);
  const saved = { ...process.env }, host = terminalHost(), previousOrigin = host.loopbackOrigin, previousConsume = host.consumeBackgroundAction;
  const token = 'd'.repeat(64), settings = { enabled: true, revision: 1, instance: { id: 'instance' } } as BackgroundSettings;
  const item = { id: 'item', revision: 1, sourceVersion: 1, status: 'open', stale: false } as AttentionItem;
  let mode = 'ok', entered = 0, delayedStatus = 0, missingEvidence = false;
  let delivered = gate(), release = gate();
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(host.loopbackOrigin + incoming.url!, { method: incoming.method, headers: incoming.headers as Record<string, string>,
      ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks).toString() }) });
    if (mode === 'before') { outgoing.writeHead(401).end('{"error":"auth"}'); return; }
    if (mode === 'missing-route') { outgoing.writeHead(404).end('Not found'); return; }
    if (mode === 'late') { delivered.resolve(); await release.promise; }
    const response = await endpoint(request, () => {
      entered++; if (mode === 'error') throw new Error('Consumed failure');
      if (mode === 'refused') throw new AppError('FIXTURE_REFUSAL', 'Handler refusal after consumption.', 409);
      return { accepted: true };
    });
    if (mode === 'late') delayedStatus = response.status;
    if (mode === 'abort' || mode === 'disconnect') { delivered.resolve(); if (mode === 'disconnect') outgoing.destroy(); return; }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(mode === 'malformed' ? 'not json' : mode === 'oversized' ? JSON.stringify('x'.repeat(66000)) : await response.text());
  });
  const actions = new BackgroundActions({ db: store.db, settings: () => settings, item: () => item, enabled: () => true, settled: () => {},
    execute: (action, signal, _pid, admitted, grant) => executeApp(action, signal, admitted, () => {
      const handle = grant(); return missingEvidence ? { token: handle.token, settle: () => { handle.settle(); return 'unknown'; } } : handle;
    }, token) });
  host.consumeBackgroundAction = (...args) => actions.consume(...args);
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`; host.loopbackOrigin = origin;
    Object.assign(process.env, { ALTCLI_TOKEN: token, ALTCLI_ALLOWED_ORIGINS: origin });
    const cases = [
      ['before', 'POST', '/api/v1/runs', 'failed'], ['missing-route', 'GET', '/api/v1/runs/absent', 'failed'],
      ...['/api/v1/launch-profiles', '/api/v1/launches'].flatMap(path => [
        ['ok', 'GET', path, 'completed'], ...['error', 'malformed', 'oversized', 'disconnect', 'abort'].map(m => [m, 'GET', path, 'failed']),
      ]),
      ['ok', 'POST', '/api/v1/runs', 'accepted'], ['ok', 'GET', '/api/v1/attention', 'accepted'],
      ['error', 'GET', '/api/v1/global-ai', 'uncertain'], ['error', 'POST', '/api/v1/runs', 'uncertain'],
      ['refused', 'POST', '/api/v1/runs', 'uncertain'], ['error', 'GET', '/api/v1/launches?unclassified=true', 'uncertain'],
      ...['malformed', 'oversized', 'disconnect', 'abort'].map(m => [m, 'POST', '/api/v1/runs', 'uncertain']),
      ['late', 'POST', '/api/v1/runs', 'failed'], ['unknown', 'GET', '/api/v1/launches', 'uncertain'],
    ];
    for (const [fault, method, path, expected] of cases) {
      mode = fault!; missingEvidence = fault === 'unknown'; delivered = gate(); release = gate();
      item.revision++; item.sourceVersion++; const before = entered;
      const attempt = { id: randomUUID(), itemId: item.id, itemRevision: item.revision, sourceVersion: item.sourceVersion, instanceId: 'instance', enablement: 1 } as BackgroundAttempt;
      const proposed = await actions.tool('request_action', { requestKey: randomUUID(), reason: 'Exercise exact HTTP evidence.',
        operation: { kind: 'app', method, path } }, attempt) as { action: { id: string } };
      const action = actions.view().actions.find(a => a.id === proposed.action.id)!;
      actions.decide({ action: 'approve', id: action.id, digest: action.digest, confirm: true });
      if (mode === 'late' || mode === 'abort') { await delivered.promise; actions.cancel(); }
      await actions.drain();
      if (mode === 'late') { release.resolve(); for (let i = 0; i < 100 && !delayedStatus; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(delayedStatus, 403); }
      const { action: result } = await actions.tool('get_actions', { actionId: action.id }, attempt) as { action: BackgroundAction };
      assert.equal(result.status, expected, `${fault} ${method} ${path}`);
      assert.equal(entered - before, ['late', 'before', 'missing-route'].includes(mode) ? 0 : 1);
      assert.equal(actions.unsettled(), expected === 'uncertain');
      assert.equal(actions.view().entries[0]!.kind, expected);
      if (expected === 'uncertain') actions.decide({ action: 'reconcile', id: action.id, digest: action.digest, confirm: true, note: 'Inspected this synthetic handler.' });
    }
  } finally {
    release.resolve(); await actions.shutdown(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    host.consumeBackgroundAction = previousConsume; host.loopbackOrigin = previousOrigin; process.env = saved;
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
