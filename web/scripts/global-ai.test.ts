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
import { AppReads, APP_TOOLS, GlobalAIError, toolsFor, type ReadPrincipal } from '../src/server/global-ai/reads.ts';
import { violation, type Schema } from '../src/server/global-ai/schema.ts';
import { backgroundProfileArgs, GlobalAIService, helperProfileArgs, toolEndpoint, type GlobalHost } from '../src/server/global-ai/service.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import { codexProfileArgs } from '../src/server/global-ai/codex.ts';
import { claudeProfileArgs } from '../src/server/global-ai/claude.ts';
import { NativeGlobalHost } from '../src/server/global-ai/host.ts';
import { loadConfig } from '../src/server/config.ts';
import { AppError } from '../src/core/errors.ts';
import { buildKnowledgeBase, DOCUMENTS } from './build-kb.mjs';
// JS stdio boundary is intentionally dependency-free; it never owns the application store.
import { createProtocol, connectionFile, main as bridgeMain } from './global-ai-mcp.mjs';

const profile: LaunchProfile = { id: 'codex', revision: 1, label: 'My Codex', executable: 'codex', args: ['--no-daemon', '--model', 'test-model'], adapterHint: 'codex', enabled: true, purpose: 'helper' };
const claude: LaunchProfile = { id: 'claude', revision: 1, label: 'My Claude', executable: 'claude', args: ['--model', 'sonnet', '--effort', 'max'], adapterHint: 'claude', enabled: true, purpose: 'helper' };
const kb = { documents: [{ name: 'README.md', description: 'overview', content: 'one\nblocked example\nthree\n' }] };
function readFixture() {
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
    featureFlags: () => ({ input: true }), kb, attention: { item: () => undefined, open: () => ({ items: [], total: 0 }) }, launch: () => undefined };
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
    inspect: async i => ({ identity: i.identity!, sessionId: i.sessionId!, label: 'Helper', dead: false }), capture: async () => 'native output', stop: async () => {},
  };
  const services = { repository: { all: () => [...records.values()].reverse().map(i => structuredClone(i)), save: (i: GlobalAIInstance) => { records.set(i.id, structuredClone(i)); } },
    host, reads: fixture.reads, profiles: () => profiles, directory: '/data/global-ai', enabled: () => enabled,
    launchGuard: async <T>(work: () => Promise<T>) => { guarded = true; try { return await work(); } finally { guarded = false; } } };
  const service = new GlobalAIService(services);
  async function start() {
    const preview = await service.preview({ profileId: profile.id }, 'http://127.0.0.1:8787');
    const input = { id: preview.id, digest: preview.digest, requestId: randomUUID(), confirm: true };
    return { preview, input, view: await service.start(input) };
  }
  return { service, services, host, records, profiles, fixture, start, descriptor: () => descriptor, launches: () => launches,
    disable: () => { enabled = false; }, failLaunch: () => { fail = true; } };
}

test('all advertised tools are read-only and unknown methods/arguments are rejected', async () => {
  const { reads } = readFixture();
  assert.ok(APP_TOOLS.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  await assert.rejects(reads.call('execute_action', {}), { code: 'TOOL_UNKNOWN' });
  await assert.rejects(reads.call('get_capabilities', { approved: true }), { code: 'INVALID_INPUT' });
});
test('every project on the host is readable; unknown runs and extra arguments are refused', async () => {
  const { reads } = readFixture();
  const runs = JSON.stringify((await reads.call('list_runs', {})).data), workspaces = JSON.stringify((await reads.call('list_workspaces', {})).data);
  assert.ok(runs.includes('run-a') && runs.includes('secret-run')); assert.ok(workspaces.includes('/work/a') && workspaces.includes('/secret'));
  assert.equal((await reads.call('get_run', { runId: 'secret-run' })).source, 'altcli:get_run');
  await assert.rejects(reads.call('get_run', { runId: 'missing-run' }), { code: 'RUN_UNKNOWN' });
  await assert.rejects(reads.call('get_run', { runId: 'run-a', roots: ['/secret'] }), { code: 'INVALID_INPUT' });
});
test('blocked-run evidence preserves unknown activity, exact checkpoint and unresolved manual input', async () => {
  const result = await readFixture().reads.call('get_run', { runId: 'run-a' });
  const data = result.data as { blockedHandoff: { backgroundState: string }; checkpoint: { revision: number }; participants: { activity: { state: string } }[]; manualInput: { heldAcrossServer: boolean } };
  assert.equal(data.blockedHandoff.backgroundState, 'unknown'); assert.equal(data.checkpoint.revision, 3);
  assert.equal(data.participants[0]!.activity.state, 'unknown'); assert.equal(data.manualInput.heldAcrossServer, true);
  assert.match(result.revision, /^[a-f0-9]{64}$/); assert.equal(result.source, 'altcli:get_run');
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_PROMPT'), false);
});
test('event projections do not disclose wire text or command prompts', async () => {
  const result = await readFixture().reads.call('get_recent_events', { runId: 'run-a' });
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_PROMPT'), false);
});
test('docs come from the packed knowledge base, hashed and line-addressed; other IDs and paths fail', async () => {
  const { reads } = readFixture();
  const result = await reads.call('read_doc', { document: 'README.md', startLine: 2, maxLines: 1 });
  const data = result.data as { lines: { line: number; text: string }[]; nextLine: number; documentHash: string };
  assert.deepEqual(data.lines, [{ line: 2, text: 'blocked example', truncated: false }]); assert.equal(data.nextLine, 3);
  assert.match(data.documentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(((await reads.call('get_capabilities', {})).data as { documents: unknown }).documents, { 'README.md': 'overview' });
  assert.equal(((await reads.call('search_docs', { query: 'BLOCKED' })).data as { results: { line: number }[] }).results[0]!.line, 2);
  await assert.rejects(reads.call('read_doc', { document: '../secrets' }), { code: 'DOCUMENT_UNKNOWN' });
  await assert.rejects(reads.call('read_doc', { document: 'docs/SETUP.md' }), { code: 'DOCUMENT_UNKNOWN' });
});
test('the build packs every allowlisted document and refuses symlinked or oversized ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'global-docs-'));
  try {
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'shared'));
    for (const name of Object.keys(DOCUMENTS)) await writeFile(join(root, name), `${name} body\n`);
    const packed = await buildKnowledgeBase(root);
    assert.deepEqual(packed.documents.map(d => [d.name, d.content]), Object.keys(DOCUMENTS).map(name => [name, `${name} body\n`]));
    await rm(join(root, 'docs/SETUP.md')); await symlink('/etc/passwd', join(root, 'docs/SETUP.md'));
    await assert.rejects(buildKnowledgeBase(root), /docs\/SETUP\.md/);
    await rm(join(root, 'docs/SETUP.md')); await writeFile(join(root, 'docs/SETUP.md'), 'x'.repeat(300000));
    await assert.rejects(buildKnowledgeBase(root), /docs\/SETUP\.md/);
    // The repository's own documents pack within the bound.
    assert.equal((await buildKnowledgeBase(join(process.cwd(), '..'))).documents.length, Object.keys(DOCUMENTS).length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('preview does not launch, and simultaneous duplicate confirmations execute once', async () => {
  const f = serviceFixture(), p = await f.service.preview({ profileId: 'codex' }, 'http://127.0.0.1:8787');
  assert.equal(f.launches(), 0); assert.equal(f.records.size, 0);
  const input = { id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true };
  const [a, b] = await Promise.all([f.service.start(input), f.service.start(input)]);
  assert.equal(a.instance!.id, b.instance!.id); assert.equal(f.launches(), 1);
});
test('a changed profile or a scope argument refuses before any launch', async () => {
  const f = serviceFixture();
  await assert.rejects(f.service.preview({ profileId: 'codex', roots: ['/secret'] }, 'http://127.0.0.1:8787'), { code: 'INVALID_INPUT' });
  const p = await f.service.preview({ profileId: 'codex' }, 'http://127.0.0.1:8787'); f.profiles[0]!.revision++;
  await assert.rejects(f.service.start({ id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true }), { code: 'PROFILE_CHANGED' });
  assert.equal(f.launches(), 0);
});
test('uncertain startup is durable and repeated requests never replay', async () => {
  const f = serviceFixture(); f.failLaunch(); const { input, view } = await f.start();
  assert.equal(view.instance!.status, 'uncertain'); assert.equal(view.toolsEnabled, false);
  await f.service.start(input); assert.equal(f.launches(), 1);
  await assert.rejects(f.service.start({ ...input, digest: 'different' }), { code: 'ID_CONFLICT' });
});
test('capability cannot perform mutations or forge an actor', async () => {
  const f = serviceFixture(); await f.start(); const key = f.descriptor().token;
  const result = await f.service.tools(key, { method: 'call', name: 'get_run', arguments: { runId: 'run-a' } }); assert.ok(result);
  await assert.rejects(f.service.tools(key, { method: 'execute', name: 'get_run' }), { code: 'TOOL_METHOD' });
  await assert.rejects(f.service.tools(key, { method: 'list', actor: 'owner' }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service.tools(key, { method: 'call', name: 'get_run', arguments: { runId: 'missing-run' } }), { code: 'RUN_UNKNOWN' });
  assert.throws(() => f.service.authenticate('a'.repeat(64)), { code: 'APP_ACCESS_REVOKED' });
});
test('revocation while a read is waiting prevents its result being returned', async () => {
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
test('restart stops only a verified session before retiring it; a failed check stops and retires nothing', async () => {
  const f = serviceFixture(); const { view } = await f.start(), id = view.instance!.id, key = f.descriptor().token;
  f.host.stop = async () => { throw new Error('marker changed'); };
  await assert.rejects(f.service.retire({ instanceId: id, confirm: true, stop: true }), { code: 'GLOBAL_IDENTITY', message: /could not be verified/ });
  assert.equal(f.records.get(id)!.status, 'started'); assert.throws(() => f.service.authenticate(key), { code: 'APP_ACCESS_REVOKED' });
  // A refusal before any effect names its reason; nothing was stopped.
  f.host.stop = async () => { throw new GlobalAIError('GLOBAL_IDENTITY', 'Helper has additional panes or windows.'); };
  await assert.rejects(f.service.retire({ instanceId: id, confirm: true, stop: true }), { code: 'GLOBAL_IDENTITY', message: /^Helper has additional panes or windows\. Nothing was stopped or retired/ });
  assert.equal(f.records.get(id)!.status, 'started');
  await assert.rejects(f.service.retire({ instanceId: id, confirm: true, stop: 'yes' }), { code: 'INVALID_INPUT' });
  let stopped = 0; f.host.stop = async () => { stopped++; };
  await f.service.retire({ instanceId: id, confirm: true, stop: true });
  assert.equal(stopped, 1); assert.equal(f.records.get(id)!.status, 'retired');
  // The saved profile then starts a new conversation.
  const second = await f.start(); assert.notEqual(second.view.instance!.id, id); assert.equal(f.launches(), 2);
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
  let stopped = false; f.host.stop = async () => { stopped = true; };
  const instance = [...f.records.values()][0]!;
  await assert.rejects(f.service.retire({ instanceId: instance.id, confirm: true, stop: true }), { code: 'GLOBAL_AI_DISABLED' });
  assert.equal(stopped, false); assert.equal(f.records.get(instance.id)!.status, 'started');
  assert.throws(() => f.service.authenticate(f.descriptor().token), { code: 'APP_ACCESS_REVOKED' });
  await assert.rejects(f.service.preview({ profileId: 'codex' }, 'http://127.0.0.1:8787'), { code: 'GLOBAL_AI_DISABLED' });
});
test('loopback endpoint and supported Codex profile validation reject arbitrary commands/config', () => {
  assert.equal(toolEndpoint('http://127.0.0.1:9911'), 'http://127.0.0.1:9911/api/v1/global-ai/tools');
  assert.throws(() => toolEndpoint('https://other.example')); assert.throws(() => toolEndpoint('http://user@127.0.0.1'));
  assert.deepEqual(codexProfileArgs(profile), profile.args);
  for (const args of [['--dangerously-bypass-approvals-and-sandbox'], ['--cd', '/secret'], ['resume', '--last'], ['-c', 'mcp_servers.other.url="https://x"'], ['--model']])
    assert.throws(() => codexProfileArgs({ ...profile, args }), GlobalAIError);
  assert.throws(() => codexProfileArgs({ ...profile, executable: '/bin/sh' }), { code: 'PROFILE_UNSUPPORTED' });
});
test('a Claude Code profile accepts only a model and effort; Helper owns its permission mode and MCP servers', () => {
  assert.deepEqual(claudeProfileArgs(claude), claude.args);
  assert.deepEqual(claudeProfileArgs({ ...claude, executable: '/Users/me/.local/bin/claude', args: [] }), []);
  for (const args of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--allowedTools', 'Bash'], ['--mcp-config', '{}'],
    ['--settings', '{}'], ['--add-dir', '/secret'], ['--resume'], ['--continue'], ['-p', 'hi'], ['--model'], ['--model', 'bad model'], ['--effort', 'minimal'], ['-m', 'opus']])
    assert.throws(() => claudeProfileArgs({ ...claude, args }), GlobalAIError);
  assert.throws(() => claudeProfileArgs({ ...claude, executable: '/bin/zsh', args: ['-lc', 'claude'] }), { code: 'PROFILE_UNSUPPORTED' });
  assert.throws(() => claudeProfileArgs({ ...claude, adapterHint: 'codex' }), { code: 'PROFILE_UNSUPPORTED' });
  // Each CLI is validated by its own rules; a Codex argument does not pass as a Claude Code one, or the reverse.
  assert.throws(() => helperProfileArgs({ ...claude, args: ['--no-daemon'] }), { code: 'PROFILE_ARGUMENT' });
  assert.throws(() => helperProfileArgs({ ...profile, args: ['--effort', 'high'] }), { code: 'PROFILE_ARGUMENT' });
  assert.throws(() => helperProfileArgs({ ...profile, adapterHint: 'manual' }), { code: 'PROFILE_UNSUPPORTED' });
});
test('Claude Code launches in manual mode with only the AltCLI read server, auto-allowed; Codex keeps its read-only sandbox', () => {
  const host = new NativeGlobalHost(loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: '/data' }), '/repo'), directory = '/data/global-ai/one';
  const args = host.args(claude, directory), mcp = args[args.indexOf('--mcp-config') + 1]!;
  // The variadic --allowedTools is last, so it cannot take another argument; nothing names a directory, setting or other tool.
  assert.deepEqual(args, [...claude.args, '--permission-mode', 'manual', '--strict-mcp-config', '--mcp-config', mcp, '--allowedTools', 'mcp__altcli_read']);
  assert.deepEqual(JSON.parse(mcp), { mcpServers: { altcli_read: { type: 'stdio', command: process.execPath,
    args: ['/repo/web/scripts/global-ai-mcp.mjs', '/data/global-ai/one/connection.json'] } } });
  assert.deepEqual(host.args(profile, directory).slice(0, 7), [...profile.args, '--cd', directory, '--sandbox', 'read-only']);
});
test('only enabled Helper profiles that Helper can launch are listed for selection', async () => {
  const f = serviceFixture();
  f.profiles.push({ ...profile, id: 'wrapper', executable: '/bin/zsh', args: ['-lc', 'codex'] }, { ...profile, id: 'bypass', args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { ...claude, id: 'claude', args: [] }, { ...claude, id: 'claude-bypass', args: ['--dangerously-skip-permissions'] },
    { ...claude, id: 'claude-wrapper', executable: '/bin/zsh', args: ['-lc', 'claude'] }, { ...profile, id: 'off', enabled: false },
    { ...profile, id: 'agent', purpose: 'agent' });
  assert.deepEqual(f.service.launchableProfiles().map(p => p.id), ['codex', 'claude']);
  // An agent profile cannot start Helper even when its arguments would be acceptable.
  await assert.rejects(f.service.preview({ profileId: 'agent' }, 'http://127.0.0.1:8787'), { code: 'PROFILE_UNKNOWN' });
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
test('a saturated display budget leaves app access granted; a failed inspection still revokes it', async () => {
  const f = serviceFixture(); const { view } = await f.start(), token = f.descriptor().token;
  f.host.inspect = async () => { throw new AppError('OBSERVATION_BUSY', 'Host observation is busy. Wait for the next refresh.', 503); };
  await assert.rejects(f.service.view(), { code: 'OBSERVATION_BUSY' });
  assert.equal(f.service.authenticate(token).instance.id, view.instance!.id);
  f.host.inspect = async () => { throw new Error('changed terminal'); };
  assert.equal((await f.service.view()).nativeState, 'unavailable');
  assert.throws(() => f.service.authenticate(token), { code: 'APP_ACCESS_REVOKED' });
});

const attentionItem: AttentionItem = { id: '11111111-1111-4111-8111-111111111111', key: 'run:run-a', kind: 'run', facets: ['completion_gate'],
  subject: { type: 'run', runId: 'run-a', repository: '/work/a', phase: 'implementation', participants: ['Coder A'], commandId: 'command-a' },
  title: 'Completion evidence holds the handoff · Implementation', detail: 'Manual input requires checkpoint review.',
  destination: { surface: 'control-access', repository: '/work/a', runId: 'run-a' }, revision: 2, sourceVersion: 3, status: 'open',
  openedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:01:00Z', resolvedAt: null, resolution: null, seenRevision: null, stale: false };
function scopedFixture() {
  const fixture = readFixture();
  fixture.state.runs[0]!.planning = { step: 'checkpoint', current: { text: 'PRIVATE_PLAN_TEXT', revision: 1, hash: 'h' }, request: { requireApproval: true },
    endorsements: {}, objections: { 'coder-a': 'PRIVATE_OBJECTION' } } as never;
  fixture.state.runs[0]!.implementation = { latestPublication: { sha: 'c'.repeat(40), projectChanged: true,
    entry: { decision: null, needsHuman: false, summary: 'PRIVATE_SUMMARY', checks: ['PRIVATE_CHECK'] } } } as never;
  const services = { ...fixture.services, attention: { item: (id: string) => id === attentionItem.id ? attentionItem : undefined, open: () => ({ items: [attentionItem], total: 1 }) },
    launch: (id: string) => id === 'launch-a' ? { id, kind: 'workspace' as const, status: 'uncertain', phase: 'executing', message: 'Host restarted during startup.',
      sessionName: 'codex-main', profileLabel: 'Codex', repository: '/work/a', branch: 'main', updatedAt: '2026-10-02T00:00:00Z', cleanup: null, closed: false, identityRecorded: false } : undefined };
  return new AppReads(services);
}
const job: ReadPrincipal = { kind: 'job', scope: { itemId: attentionItem.id, runId: 'run-a', launchId: 'launch-a' } };
test('every tool declares an output schema, and each reply is the exact JSON that conforms to it', async () => {
  const reads = scopedFixture();
  const calls: [string, Record<string, unknown>][] = [['get_capabilities', {}], ['list_workspaces', {}], ['list_runs', {}], ['get_run', { runId: 'run-a' }],
    ['get_recent_events', { runId: 'run-a' }], ['search_docs', { query: 'blocked' }], ['read_doc', { document: 'README.md' }], ['list_attention', {}],
    ['get_attention_item', { itemId: attentionItem.id }], ['get_launch', { launchId: 'launch-a' }]];
  assert.deepEqual(calls.map(([name]) => name), APP_TOOLS.map(t => t.name));
  for (const [name, args] of calls) {
    const definition = APP_TOOLS.find(t => t.name === name)!, reply = await reads.call(name, args);
    assert.equal(violation(definition.outputSchema as Schema, reply), null, name);
    assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
  }
  const capabilities = (await reads.call('get_capabilities', {})).data as { contract: string; backgroundAssistant: unknown; effects: boolean };
  assert.equal(capabilities.contract, 'global-ai-read-v2'); assert.equal(capabilities.effects, false);
  assert.deepEqual(capabilities.backgroundAssistant, { attention: true, runtime: 'unavailable', enabled: false });
  // A reply that would break its declared contract is refused instead of being returned.
  const broken = readFixture(); (broken.state.runs[0] as { status: unknown }).status = 7;
  await assert.rejects(broken.reads.call('list_runs', {}), { code: 'TOOL_CONTRACT' });
});
test('a Background job reads only its admitted issue, without host-wide listings, plan text or publication bodies', async () => {
  const reads = scopedFixture();
  assert.deepEqual(toolsFor(job).map(t => t.name), ['get_capabilities', 'get_run', 'get_recent_events', 'search_docs', 'read_doc', 'get_attention_item', 'get_launch']);
  assert.deepEqual(toolsFor({ kind: 'helper' }), APP_TOOLS);
  for (const name of ['list_runs', 'list_workspaces', 'list_attention']) await assert.rejects(reads.call(name, {}, job), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(reads.call('get_run', { runId: 'secret-run' }, job), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(reads.call('get_attention_item', { itemId: '22222222-2222-4222-8222-222222222222' }, job), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(reads.call('get_launch', { launchId: 'launch-b' }, job), { code: 'OUT_OF_SCOPE' });
  // Model-supplied scope widening is an unexpected argument, not a new principal.
  await assert.rejects(reads.call('get_run', { runId: 'run-a', scope: { runId: 'secret-run' } }, job), { code: 'INVALID_INPUT' });
  const scoped = await reads.call('get_run', { runId: 'run-a' }, job), text = JSON.stringify(scoped);
  for (const secret of ['PRIVATE_PLAN_TEXT', 'PRIVATE_OBJECTION', 'PRIVATE_SUMMARY', 'PRIVATE_CHECK', 'PRIVATE_RAW_PROMPT']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual((scoped.data as { omitted: string[] }).omitted, ['plan text', 'objection text', 'publication summary and checks']);
  assert.equal(violation(APP_TOOLS.find(t => t.name === 'get_run')!.outputSchema as Schema, scoped), null);
  const helper = JSON.stringify(await reads.call('get_run', { runId: 'run-a' }));
  assert.ok(helper.includes('PRIVATE_PLAN_TEXT') && helper.includes('PRIVATE_SUMMARY')); // Helper keeps its approved host-wide view
  assert.equal(((await reads.call('get_attention_item', { itemId: attentionItem.id }, job)).data as { item: AttentionItem }).item.revision, 2);
  await assert.rejects(scopedFixture().call('get_launch', { launchId: 'missing' }), { code: 'LAUNCH_UNKNOWN' });
});
test('MCP tools/list carries every output schema with the structured reply it describes', async () => {
  const f = serviceFixture(); await f.start(); const token = f.descriptor().token;
  const listed = await f.service.tools(token, { method: 'list' }) as { tools: { name: string; outputSchema: unknown }[] };
  assert.deepEqual(listed.tools.map(t => t.name), APP_TOOLS.map(t => t.name)); assert.ok(listed.tools.every(t => t.outputSchema));
  const protocol = createProtocol((body: unknown) => f.service.tools(token, body));
  await protocol({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const called = await protocol({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_capabilities', arguments: {} } }) as { result: { structuredContent: unknown; content: { text: string }[] } };
  assert.deepEqual(JSON.parse(called.result.content[0]!.text), called.result.structuredContent);
  assert.equal(violation(APP_TOOLS[0]!.outputSchema as Schema, called.result.structuredContent), null);
});
test('a Background assistant profile records only a direct Claude Code model and effort', () => {
  const background = { ...claude, purpose: 'background' as const };
  assert.deepEqual(backgroundProfileArgs(background), ['--model', 'sonnet', '--effort', 'max']);
  assert.throws(() => backgroundProfileArgs({ ...profile, purpose: 'background' }), { code: 'PROFILE_UNSUPPORTED' });
  assert.throws(() => backgroundProfileArgs({ ...background, args: ['--model', 'sonnet', '--dangerously-skip-permissions'] }), { code: 'PROFILE_ARGUMENT' });
  assert.throws(() => backgroundProfileArgs({ ...background, executable: '/bin/zsh' }), { code: 'PROFILE_ARGUMENT' });
});
