import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import type { WorkflowState, RelayRun, WorkspaceDiscovery } from '../src/contracts/workflow.ts';
import type { LaunchProfile } from '../src/contracts/launches.ts';
import type { GlobalAIInstance } from '../src/contracts/global-ai.ts';
import { AppReads, APP_TOOLS, GlobalAIError } from '../src/server/global-ai/reads.ts';
import { GlobalAIService, toolEndpoint, type GlobalHost } from '../src/server/global-ai/service.ts';
import { codexProfileArgs } from '../src/server/global-ai/codex.ts';
// JS stdio boundary is intentionally dependency-free; it never owns the application store.
import { createProtocol, connectionFile, main as bridgeMain } from './global-ai-mcp.mjs';

const profile: LaunchProfile = { id: 'codex', revision: 1, label: 'My Codex', executable: 'codex', args: ['--no-daemon', '--model', 'test-model'], adapterHint: 'codex', enabled: true };
function readFixture(docsRoot = '/missing') {
  const run = { id: 'run-a', repository: '/work/a', status: 'paused', reason: 'Manual input requires checkpoint review.',
    currentCommandId: 'command-a', updatedAt: '2026-09-30T00:00:00Z', participants: [{ id: 'coder-a', label: 'Coder A' }],
    autoContinue: true, automaticTurns: 2, turnLimit: 20,
    blockedHandoff: { commandId: 'command-a', revision: 'one', backgroundState: 'unknown', gate: 'background', publishedSha: null, publicationError: null } } as RelayRun;
  const state = { runs: [run, { ...run, id: 'secret-run', repository: '/secret' }], executions: [{ commandId: 'command-a', runId: 'run-a', agentId: 'coder-a', status: 'finished', wireText: 'PRIVATE_RAW_PROMPT' }],
    commands: [{ id: 'command-a', runId: 'run-a', agentId: 'coder-a', createdAt: run.updatedAt, text: 'PRIVATE_RAW_PROMPT' }], instances: [], activities: [],
    manualSessions: [{ live: false, reconciliationRequired: true, runs: [{ id: 'run-a' }] }], checkpoints: [{ runId: 'run-a', commandId: 'command-a', kind: 'interaction', revision: 3, fault: false }] } as unknown as WorkflowState;
  const discovery = { workspaces: [{ cwd: '/work/a', worktree: { root: '/work/a' }, branch: 'feature/a', agents: [] },
    { cwd: '/secret', worktree: { root: '/secret' }, branch: 'private', agents: [] }], discoveredAt: run.updatedAt, error: null } as unknown as WorkspaceDiscovery;
  const services = { state: async () => state, workspaces: async () => discovery, run: (id: string) => state.runs.find(r => r.id === id),
    featureFlags: () => ({ input: true }), docsRoot };
  return { reads: new AppReads(services), services, state, run };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function serviceFixture() {
  const records = new Map<string, GlobalAIInstance>(); let launches = 0, enabled = true, guarded = false, fail = false;
  let descriptor = { endpoint: '', token: '' };
  const profiles = [structuredClone(profile)], fixture = readFixture();
  const host: GlobalHost = {
    executable: async p => { codexProfileArgs(p); return '/usr/bin/codex'; }, environmentHash: () => 'environment', args: p => codexProfileArgs(p),
    prepare: async (i, d) => { assert.ok(records.has(i.id), 'record precedes file writes'); descriptor = d; },
    descriptor: async (_i, d) => { descriptor = d; },
    launch: async (i, save) => {
      assert.equal(guarded, true, 'launch uses shared admission'); launches++;
      save({ phase: 'executing' }); if (fail) throw new Error('lost spawn response');
      save({ identity: { paneId: '%1', panePid: '2', serverPid: '3', serverStarted: '4', socketPath: '/socket' }, sessionId: '$1', windowId: '@1' });
    },
    inspect: async i => ({ identity: i.identity!, sessionId: i.sessionId!, label: 'Global AI', dead: false }), capture: async () => 'native output',
  };
  const services = { repository: { all: () => [...records.values()].reverse().map(i => structuredClone(i)), save: (i: GlobalAIInstance) => { records.set(i.id, structuredClone(i)); } },
    host, reads: fixture.reads, profiles: () => profiles, directory: '/data/global-ai', roots: async () => ['/work/a'], enabled: () => enabled,
    launchGuard: async <T>(work: () => Promise<T>) => { guarded = true; try { return await work(); } finally { guarded = false; } } };
  const service = new GlobalAIService(services);
  async function start() {
    const preview = await service.preview({ profileId: profile.id, roots: ['/work/a'] }, 'http://127.0.0.1:8787');
    const input = { id: preview.id, digest: preview.digest, requestId: randomUUID(), confirm: true };
    return { preview, input, view: await service.start(input) };
  }
  return { service, services, host, records, profiles, fixture, start, descriptor: () => descriptor, launches: () => launches,
    disable: () => { enabled = false; }, failLaunch: () => { fail = true; } };
}

test('all advertised tools are read-only and unknown methods/arguments are rejected', async () => {
  const { reads } = readFixture();
  assert.ok(APP_TOOLS.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  await assert.rejects(reads.call('execute_action', {}, ['/work/a']), { code: 'TOOL_UNKNOWN' });
  await assert.rejects(reads.call('get_capabilities', { approved: true }, []), { code: 'INVALID_INPUT' });
});
test('workspace/run scope is explicit and a model cannot supply a broader scope', async () => {
  const { reads } = readFixture();
  assert.equal(JSON.stringify((await reads.call('list_runs', {}, ['/work/a'])).data).includes('secret-run'), false);
  assert.equal(JSON.stringify((await reads.call('list_workspaces', {}, [])).data).includes('/work/a'), false);
  await assert.rejects(reads.call('get_run', { runId: 'secret-run' }, ['/work/a']), { code: 'SCOPE_DENIED' });
  await assert.rejects(reads.call('get_run', { runId: 'run-a', roots: ['/secret'] }, []), { code: 'INVALID_INPUT' });
});
test('blocked-run evidence preserves unknown activity, exact checkpoint and unresolved manual input', async () => {
  const result = await readFixture().reads.call('get_run', { runId: 'run-a' }, ['/work/a']);
  const data = result.data as { blockedHandoff: { backgroundState: string }; checkpoint: { revision: number }; participants: { activity: { state: string } }[]; manualInput: { heldAcrossServer: boolean } };
  assert.equal(data.blockedHandoff.backgroundState, 'unknown'); assert.equal(data.checkpoint.revision, 3);
  assert.equal(data.participants[0]!.activity.state, 'unknown'); assert.equal(data.manualInput.heldAcrossServer, true);
  assert.match(result.revision, /^[a-f0-9]{64}$/); assert.equal(result.source, 'altcli:get_run');
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_PROMPT'), false);
});
test('event projections do not disclose wire text or command prompts', async () => {
  const result = await readFixture().reads.call('get_recent_events', { runId: 'run-a' }, ['/work/a']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_PROMPT'), false);
});
test('docs are allowlisted, hashed and line-addressed; traversal, symlinks and oversized content fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'global-docs-'));
  try {
    await mkdir(join(root, 'docs')); await writeFile(join(root, 'README.md'), 'one\nblocked example\nthree\n');
    const { reads } = readFixture(root);
    const result = await reads.call('read_doc', { document: 'README.md', startLine: 2, maxLines: 1 }, []);
    const data = result.data as { lines: { line: number; text: string }[]; nextLine: number; documentHash: string };
    assert.deepEqual(data.lines, [{ line: 2, text: 'blocked example', truncated: false }]); assert.equal(data.nextLine, 3);
    assert.match(data.documentHash, /^[a-f0-9]{64}$/);
    await assert.rejects(reads.call('read_doc', { document: '../secrets' }, []), { code: 'DOCUMENT_UNKNOWN' });
    await symlink('/etc/passwd', join(root, 'docs/SETUP.md'));
    await assert.rejects(reads.call('read_doc', { document: 'docs/SETUP.md' }, []), { code: 'DOCUMENT_UNAVAILABLE' });
    await writeFile(join(root, 'README.md'), 'x'.repeat(300000));
    await assert.rejects(reads.call('read_doc', { document: 'README.md' }, []), { code: 'DOCUMENT_UNAVAILABLE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('preview does not launch, and simultaneous duplicate confirmations execute once', async () => {
  const f = serviceFixture(), p = await f.service.preview({ profileId: 'codex', roots: ['/work/a'] }, 'http://127.0.0.1:8787');
  assert.equal(f.launches(), 0); assert.equal(f.records.size, 0);
  const input = { id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true };
  const [a, b] = await Promise.all([f.service.start(input), f.service.start(input)]);
  assert.equal(a.instance!.id, b.instance!.id); assert.equal(f.launches(), 1);
});
test('changed profile and foreign roots refuse before any launch', async () => {
  const f = serviceFixture();
  await assert.rejects(f.service.preview({ profileId: 'codex', roots: ['/secret'] }, 'http://127.0.0.1:8787'), { code: 'SCOPE_CHANGED' });
  const p = await f.service.preview({ profileId: 'codex', roots: [] }, 'http://127.0.0.1:8787'); f.profiles[0]!.revision++;
  await assert.rejects(f.service.start({ id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true }), { code: 'PROFILE_CHANGED' });
  assert.equal(f.launches(), 0);
});
test('uncertain startup is durable and repeated requests never replay', async () => {
  const f = serviceFixture(); f.failLaunch(); const { input, view } = await f.start();
  assert.equal(view.instance!.status, 'uncertain'); assert.equal(view.toolsEnabled, false);
  await f.service.start(input); assert.equal(f.launches(), 1);
  await assert.rejects(f.service.start({ ...input, digest: 'different' }), { code: 'ID_CONFLICT' });
});
test('capability cannot perform mutations, forge an actor or read unshared state', async () => {
  const f = serviceFixture(); await f.start(); const key = f.descriptor().token;
  const result = await f.service.tools(key, { method: 'call', name: 'get_run', arguments: { runId: 'run-a' } }); assert.ok(result);
  await assert.rejects(f.service.tools(key, { method: 'execute', name: 'get_run' }), { code: 'TOOL_METHOD' });
  await assert.rejects(f.service.tools(key, { method: 'list', actor: 'owner' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.tools(key, { method: 'call', name: 'get_run', arguments: { runId: 'secret-run' } }), { code: 'SCOPE_DENIED' });
  assert.throws(() => f.service.authenticate('a'.repeat(64)), { code: 'APP_ACCESS_REVOKED' });
});
test('revocation while a scoped read is waiting prevents its result being returned', async () => {
  const f = serviceFixture(); await f.start(); const gate = deferred<WorkflowState>();
  f.fixture.services.state = () => gate.promise;
  const result = f.service.tools(f.descriptor().token, { method: 'call', name: 'list_runs', arguments: {} });
  f.service.revoke(); gate.resolve(f.fixture.state);
  await assert.rejects(result, { code: 'APP_ACCESS_REVOKED' });
});
test('restart keeps instance history, invalidates credentials and never creates a runner', async () => {
  const f = serviceFixture(); const { view } = await f.start(); const old = f.descriptor().token;
  const restarted = new GlobalAIService(f.services);
  assert.throws(() => restarted.authenticate(old), { code: 'APP_ACCESS_REVOKED' });
  assert.equal((await restarted.view()).instance!.id, view.instance!.id); assert.equal(f.launches(), 1);
});
test('restart of an in-flight record becomes uncertain, not an automatic retry', async () => {
  const f = serviceFixture(); const { view } = await f.start();
  const record = f.records.get(view.instance!.id)!; record.status = 'launching';
  const restarted = new GlobalAIService(f.services);
  assert.equal((await restarted.view()).instance!.status, 'uncertain'); assert.equal(f.launches(), 1);
});
test('retiring app access preserves tmux/history and does not authorize new effects', async () => {
  const f = serviceFixture(); const { view } = await f.start(); const key = f.descriptor().token;
  await f.service.retire({ instanceId: view.instance!.id, confirm: true });
  assert.throws(() => f.service.authenticate(key), { code: 'APP_ACCESS_REVOKED' });
  assert.equal(f.records.get(view.instance!.id)!.status, 'retired'); assert.equal(f.launches(), 1);
});
test('a revocation during credential renewal wins instead of re-enabling access', async () => {
  const f = serviceFixture(); const { view } = await f.start(), gate = deferred<void>(), entered = deferred<void>();
  f.host.descriptor = async () => { entered.resolve(); await gate.promise; };
  const renewal = f.service.refreshTools({ instanceId: view.instance!.id, confirm: true }, 'http://127.0.0.1:8787');
  await entered.promise; f.service.revoke(); gate.resolve();
  await assert.rejects(renewal, { code: 'APP_ACCESS_REVOKED' }); assert.equal((await f.service.view()).toolsEnabled, false);
});
test('disabling the host refuses further reads and launches', async () => {
  const f = serviceFixture(); await f.start(); f.disable();
  assert.throws(() => f.service.authenticate(f.descriptor().token), { code: 'APP_ACCESS_REVOKED' });
  await assert.rejects(f.service.preview({ profileId: 'codex', roots: [] }, 'http://127.0.0.1:8787'), { code: 'GLOBAL_AI_DISABLED' });
});
test('loopback endpoint and supported Codex profile validation reject arbitrary commands/config', () => {
  assert.equal(toolEndpoint('http://127.0.0.1:9911'), 'http://127.0.0.1:9911/api/v1/global-ai/tools');
  assert.throws(() => toolEndpoint('https://other.example')); assert.throws(() => toolEndpoint('http://user@127.0.0.1'));
  assert.deepEqual(codexProfileArgs(profile), profile.args);
  for (const args of [['--dangerously-bypass-approvals-and-sandbox'], ['--cd', '/secret'], ['resume', '--last'], ['-c', 'mcp_servers.other.url="https://x"'], ['--model']])
    assert.throws(() => codexProfileArgs({ ...profile, args }), GlobalAIError);
  assert.throws(() => codexProfileArgs({ ...profile, executable: '/bin/sh' }), { code: 'PROFILE_UNSUPPORTED' });
});
test('MCP initialization, read listing, structured replies and forbidden operations are explicit', async () => {
  const calls: unknown[] = [];
  const protocol: (request: unknown) => Promise<any> = createProtocol(async (body: unknown) => { calls.push(body); return { source: 'fixture', data: {} }; });
  const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });
  assert.equal((await protocol(request(1, 'tools/list'))).error.code, -32002);
  assert.equal((await protocol(request(2, 'initialize', { protocolVersion: '2025-11-25' }))).result.protocolVersion, '2025-11-25');
  assert.equal(await protocol({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await protocol(request(3, 'tools/call', { name: 'get_capabilities', arguments: {} }))).result.isError, false);
  assert.equal((await protocol(request(4, 'execute'))).error.code, -32601); assert.equal(calls.length, 1);
});
test('private MCP descriptor rejects public files, symlinks and remote endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'global-key-')), file = join(root, 'connection.json');
  try {
    await writeFile(file, JSON.stringify({ schema: 1, endpoint: 'http://127.0.0.1:8787/api/v1/global-ai/tools', token: 'a'.repeat(64) }), { mode: 0o600 });
    assert.ok(await connectionFile(file)); await chmod(file, 0o644); await assert.rejects(connectionFile(file)); await chmod(file, 0o600);
    await symlink(file, join(root, 'link')); await assert.rejects(connectionFile(join(root, 'link')));
    await writeFile(file, JSON.stringify({ schema: 1, endpoint: 'https://example.com/api/v1/global-ai/tools', token: 'a'.repeat(64) })); await assert.rejects(connectionFile(file));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('stdio bridge reaches bounded authenticated HTTP and preserves split Unicode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'global-mcp-')), file = join(root, 'connection.json');
  let seen = '';
  const server = createServer((req, res) => { assert.equal(req.headers.authorization, `Bearer ${'b'.repeat(64)}`);
    req.setEncoding('utf8'); req.on('data', s => { seen += s; }); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ source: 'fixture', data: { ok: true } })); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port; let output = '';
  try {
    await writeFile(file, JSON.stringify({ schema: 1, endpoint: `http://127.0.0.1:${port}/api/v1/global-ai/tools`, token: 'b'.repeat(64) }), { mode: 0o600 });
    const wire = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_docs', arguments: { query: '中文' } } }) + '\n');
    const index = wire.indexOf(Buffer.from('中文')) + 1;
    await bridgeMain(file, Readable.from([wire.subarray(0, index), wire.subarray(index)]), new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb(); } }));
    assert.match(seen, /中文/); assert.equal(output.trim().split('\n').length, 2); assert.equal(output.includes('b'.repeat(64)), false);
  } finally { await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});


test('revoking while renewal inspects the native identity cancels the entire renewal', async () => {
  const f = serviceFixture(); const { view } = await f.start(), gate = deferred<void>(), entered = deferred<void>();
  const inspect = f.host.inspect;
  f.host.inspect = async i => { entered.resolve(); await gate.promise; return inspect(i); };
  const renewal = f.service.refreshTools({ instanceId: view.instance!.id, confirm: true }, 'http://127.0.0.1:8787');
  await entered.promise; f.service.revoke(); gate.resolve();
  await assert.rejects(renewal, { code: 'APP_ACCESS_REVOKED' });
  assert.equal((await f.service.view()).toolsEnabled, false);
});
test('a stale failed view inspection cannot revoke a newly renewed capability', async () => {
  const f = serviceFixture(); const { view } = await f.start(), gate = deferred<void>(), entered = deferred<void>();
  const inspect = f.host.inspect; let first = true;
  f.host.inspect = async i => { if (first) { first = false; entered.resolve(); await gate.promise; throw new Error('old observation failed'); } return inspect(i); };
  const oldView = f.service.view(); await entered.promise;
  await f.service.refreshTools({ instanceId: view.instance!.id, confirm: true }, 'http://127.0.0.1:8787');
  const token = f.descriptor().token; gate.resolve(); await oldView;
  assert.equal(f.service.authenticate(token).instance.id, view.instance!.id);
});
