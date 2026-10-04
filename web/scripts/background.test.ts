import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { AttentionService } from '../src/server/attention/service.ts';
import { BackgroundService, type BackgroundServices } from '../src/server/background/service.ts';
import { AppReads } from '../src/server/global-ai/reads.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import type { LaunchProfile } from '../src/contracts/launches.ts';
import { VERIFIED_CLAUDE_VERSIONS } from './background-native.mjs';
import { settlementBlockers } from '../src/server/upgrade.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-background-test-'))), store = new Store(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let clock = Date.parse('2026-10-02T00:00:00Z'), launches = 0, stops = 0, failLaunch = false;
  let runnerToken = '', jobToken = '', receipt: unknown = null;
  const profile: LaunchProfile = { id: 'background', label: 'Incident analyst', revision: 1, purpose: 'background', executable: 'claude', adapterHint: 'claude', args: ['--model', 'haiku'], enabled: true };
  const attention = new AttentionService(store.db);
  const item: AttentionItem = { id: randomUUID(), key: 'run:fixture', kind: 'run', facets: ['delivery_uncertain'],
    subject: { type: 'run', runId: 'fixture', repository: '/synthetic', phase: 'implementation', participants: ['a', 'b'], commandId: 'c' },
    title: 'Delivery uncertain', detail: 'A receipt is missing.', destination: { surface: 'control-access', runId: 'fixture', repository: '/synthetic' },
    revision: 1, sourceVersion: 1, status: 'open', openedAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
    resolvedAt: null, resolution: null, seenRevision: null, stale: false };
  const write = () => store.db.prepare('INSERT INTO attention_items(id,key,status,fingerprint,updated_at,value) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value')
    .run(item.id, item.key, item.status, 'fixture', item.updatedAt, JSON.stringify(item)); write();
  const reads = new AppReads({ attention, kb: { documents: [] }, featureFlags: () => ({}), launch: () => undefined, run: () => undefined,
    state: async () => { throw new Error('Unexpected state read.'); }, workspaces: async () => { throw new Error('Unexpected workspace read.'); } });
  const host: BackgroundServices['host'] = {
    bridge: '/installed/bridge.mjs', executable: async () => '/bin/claude', version: async () => VERIFIED_CLAUDE_VERSIONS[0]!,
    environmentHash: () => 'env', args: p => p.args,
    prepare: async (_i, d) => { runnerToken = d.token; }, descriptor: async (_i, d) => { runnerToken = d.token; },
    jobDescriptor: async (_i, _id, d) => { jobToken = d.token; return '/private/job.json'; },
    launch: async (_i, save) => { launches++; save({ phase: 'executing' }); if (failLaunch) throw new Error('lost');
      save({ phase: 'observed', sessionId: '$1', windowId: '@1', identity: { paneId: '%1', panePid: '1234', serverPid: '1', serverStarted: 'start', socketPath: '/private/tmux' } }); },
    inspect: async i => ({ identity: i.identity!, sessionId: i.sessionId!, label: 'Background', dead: false }),
    stop: async () => { stops++; }, receipt: async () => { if (!receipt) throw new Error('unavailable'); return receipt; },
  };
  const services: BackgroundServices = { db: store.db, attention, reads, host, directory: join(directory, 'background'), profiles: () => [profile],
    enabled: () => true, launchGuard: work => work(), now: () => clock };
  let service = new BackgroundService(services);
  const enable = async () => {
    const p = await service.preview({ profileId: profile.id }, 'http://127.0.0.1:8787');
    return service.enable({ id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true });
  };
  const advance = async (ms = 20000) => { clock += ms; await service.tick(); };
  const claim = async () => (await service.runner(runnerToken, { method: 'poll' }) as { job: { id: string; sessionId: string; prompt: string } | null }).job;
  const start = async () => { await enable(); await service.tick(); await advance(); return (await claim())!; };
  const complete = async (job: { id: string; sessionId: string }, status = 'succeeded', overrides = {}) => {
    const reply = await service.tools(jobToken, { method: 'call', name: 'get_attention_item', arguments: { itemId: item.id } }) as { evidenceId: string };
    const result = { settled: true, pid: 123, sessionId: job.sessionId, model: 'fixture-model', status, category: 'completed',
      assessment: { itemId: item.id, itemRevision: item.revision, summary: 'Delivery needs inspection.', likelyCause: 'A receipt was lost.',
        nextSteps: ['Inspect the original delivery.'], uncertainties: ['Whether it ran is unknown.'], evidence: [{ id: reply.evidenceId, note: 'The receipt is absent.' }], surface: 'control_access' }, ...overrides };
    await service.runner(runnerToken, { method: 'complete', attemptId: job.id, result }); return result;
  };
  return { store, item, profile, write, services, host, get service() { return service; }, enable, advance, claim, start, complete,
    token: () => jobToken, runner: () => runnerToken, launches: () => launches, stops: () => stops,
    failLaunch: () => { failLaunch = true; }, setReceipt: (value: unknown) => { receipt = value; },
    restart: () => { service = new BackgroundService(services); return service; },
    control: (action: string, more = {}) => service.control({ action, instanceId: service.settings().instance!.id, ...more }, 'http://127.0.0.1:8787') };
}

test('off by default; reads, preview and enablement launch nothing; one settled issue lazily starts one distinct instance', async () => {
  const f = fixture(); assert.equal(f.service.view().settings.enabled, false);
  await f.service.tick(); assert.equal(f.launches(), 0);
  await f.enable(); assert.equal(f.launches(), 0);
  assert.equal(f.service.settings().instance!.role, 'background');
  await f.service.tick(); await f.advance(19999); assert.equal(f.launches(), 0);
  await f.advance(1); assert.equal(f.launches(), 1);
  const job = await f.claim(); assert.ok(job); assert.equal(f.service.view().attempts[0]!.status, 'claimed');
  assert.deepEqual(await f.claim(), null); assert.equal(f.launches(), 1);
});
test('valid evidence produces a current explanation; repeated polls cannot reassess an unchanged version', async () => {
  const f = fixture(), job = await f.start(); await f.complete(job);
  assert.equal(f.service.view().attempts[0]!.assessment!.likelyCause, 'A receipt was lost.');
  await f.advance(60000); assert.equal(await f.claim(), null);
  assert.equal(f.service.view().attempts.length, 1);
});
test('A to B to A revokes the old capability even when material revision is unchanged; stale reply settles without attachment', async () => {
  const f = fixture(), job = await f.start(); f.item.sourceVersion += 2; f.write();
  await assert.rejects(f.service.tools(f.token(), { method: 'list' }), { code: 'BACKGROUND_REVOKED' });
  await f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result: { settled: true, pid: 123, sessionId: job.sessionId,
    model: 'fixture', status: 'succeeded', category: 'completed', assessment: {} } });
  assert.equal(f.service.view().attempts[0]!.status, 'stale'); assert.equal(f.service.view().attempts[0]!.assessment, null);
});
test('resolution revokes tools and hides a previously attached explanation immediately', async () => {
  const f = fixture(), job = await f.start(); await f.complete(job); f.item.status = 'resolved'; f.write();
  assert.equal(f.service.view().attempts[0]!.assessment, null);
});
test('job tokens cannot list other issues or cross the run scope; runner and model credentials are distinct', async () => {
  const f = fixture(); await f.start();
  await assert.rejects(f.service.tools(f.token(), { method: 'call', name: 'list_runs' }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: randomUUID() } }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(f.service.tools(f.token(), { method: 'call', name: 'get_run', arguments: { runId: 'another' } }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(f.service.runner(f.token(), { method: 'poll' }), { code: 'BACKGROUND_REVOKED' });
  await assert.rejects(f.service.tools(f.runner(), { method: 'list' }), { code: 'BACKGROUND_REVOKED' });
});
test('tool-call budget is durable and unserved citations are rejected as a whole', async () => {
  const f = fixture(), job = await f.start();
  for (let i = 0; i < 12; i++) await f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: f.item.id } });
  await assert.rejects(f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: f.item.id } }), { code: 'TOOL_LIMIT' });
  await f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result: { settled: true, pid: 123, sessionId: job.sessionId,
    model: 'fixture', status: 'succeeded', category: 'completed', assessment: { arbitrary: 'not an assessment' } } });
  assert.equal(f.service.view().attempts[0]!.status, 'failed'); assert.equal(f.service.view().attempts[0]!.calls, 12);
});
test('pause lets an admitted job finish; disable revokes access and requests cancellation without releasing ownership', async () => {
  const f = fixture(), job = await f.start(); await f.control('pause'); await f.complete(job);
  assert.equal(f.service.view().attempts[0]!.status, 'succeeded'); await f.control('resume', { confirm: true });
  f.item.sourceVersion++; f.item.revision++; f.write(); await f.service.tick(); await f.advance(30000);
  const next = (await f.claim())!; await f.control('disable');
  assert.deepEqual(await f.service.runner(f.runner(), { method: 'control', attemptId: next.id }), { continue: false });
  await assert.rejects(f.service.tools(f.token(), { method: 'list' }), { code: 'BACKGROUND_REVOKED' });
  await assert.rejects(f.control('stop', { confirm: true }), { code: 'BACKGROUND_UNCERTAIN' }); assert.equal(f.stops(), 0);
});
test('restart retains unknown execution; only a settled exact receipt and explicit Resume can admit new work', async () => {
  const f = fixture(), job = await f.start(), old = f.token(); f.restart();
  assert.equal(f.service.settings().needsInspection, true); assert.equal(f.service.view().attempts[0]!.status, 'uncertain');
  await assert.rejects(f.service.tools(old, { method: 'list' }), { code: 'BACKGROUND_REVOKED' });
  await f.control('inspect'); await assert.rejects(f.control('resume', { confirm: true }), { code: 'BACKGROUND_UNCERTAIN' });
  f.setReceipt({ settled: true, pid: 123, sessionId: job.sessionId, model: null, status: 'canceled', category: 'canceled', assessment: null });
  await f.control('inspect'); assert.equal(f.service.view().attempts[0]!.status, 'canceled');
  assert.equal(f.service.settings().paused, true); await f.control('resume', { confirm: true });
  assert.equal(await f.claim(), null); // the original semantic version is never replayed
});
test('missing receipts and surviving native work keep the single slot past timeout and restart', async () => {
  const f = fixture(), job = await f.start(); await f.advance(136000);
  assert.equal(f.service.view().attempts[0]!.status, 'uncertain');
  await f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result: { settled: false, pid: 123, sessionId: job.sessionId,
    model: null, status: 'failed', category: 'process-unsettled', assessment: null } });
  assert.equal(await f.claim(), null); await assert.rejects(f.control('stop', { confirm: true }), { code: 'BACKGROUND_UNCERTAIN' });
});
test('malformed native receipts cannot settle ownership, and successful results after the deadline cannot attach', async () => {
  const f = fixture(), job = await f.start();
  await assert.rejects(f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result: { settled: true, sessionId: job.sessionId } }), { code: 'RECEIPT_INVALID' });
  assert.equal(f.service.view().attempts[0]!.status, 'claimed');
  await f.advance(120001);
  await f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result: { settled: true, pid: 123, sessionId: job.sessionId, model: 'fixture', status: 'succeeded', category: 'completed', assessment: {} } });
  assert.equal(f.service.view().attempts[0]!.status, 'failed'); assert.equal(f.service.view().attempts[0]!.assessment, null);
});
test('launch uncertainty retains the original slot and cannot automatically create another session', async () => {
  const f = fixture(); f.failLaunch(); await f.enable(); await f.service.tick(); await f.advance(); await f.advance(60000);
  assert.equal(f.launches(), 1); assert.equal(f.service.settings().instance!.status, 'uncertain');
  await assert.rejects(f.enable(), { code: 'BACKGROUND_EXISTS' });
});
test('three failed attempts open the circuit; manual retries obey durable spacing and hourly admission accounting', async () => {
  const f = fixture(); let job = await f.start();
  for (let i = 0; i < 3; i++) {
    await f.complete(job, 'failed');
    if (i < 2) { await assert.rejects(f.control('retry', { attemptId: job.id }), { code: 'RETRY_UNAVAILABLE' });
      await f.advance(30000); await f.control('retry', { attemptId: job.id }); job = (await f.claim())!; }
  }
  assert.equal(f.service.settings().paused, true); assert.equal(f.service.settings().failures, 3);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM background_admissions').get() as { n: number }).n, 3);
});
test('a duplicate completion acknowledges the original result; profile edits invalidate a pending enable preview', async () => {
  const f = fixture(); const p = await f.service.preview({ profileId: f.profile.id }, 'http://127.0.0.1:8787'); f.profile.revision++;
  await assert.rejects(f.service.enable({ id: p.id, digest: p.digest, requestId: randomUUID(), confirm: true }), { code: 'PROFILE_CHANGED' });
  const job = await f.start(), result = await f.complete(job);
  await f.service.runner(f.runner(), { method: 'complete', attemptId: job.id, result });
  assert.equal(f.service.view().attempts.length, 1); assert.equal(f.service.settings().failures, 0);
});
test('ten starts exhaust the rolling hour across restart; explicit retry works after inspection and allowance returns', async () => {
  const f = fixture(); let job = await f.start();
  for (let i = 0; i < 10; i++) {
    await f.complete(job); await f.advance(30000);
    if (i < 9) { await f.control('retry', { attemptId: job.id }); job = (await f.claim())!; }
  }
  await assert.rejects(f.control('retry', { attemptId: job.id }), { code: 'RETRY_UNAVAILABLE' });
  f.restart(); await f.control('inspect'); await f.control('resume', { confirm: true });
  await assert.rejects(f.control('retry', { attemptId: job.id }), { code: 'RETRY_UNAVAILABLE' });
  await f.advance(3600000); await f.control('retry', { attemptId: job.id }); assert.ok(await f.claim());
});
test('evidence byte budget rejects an oversized cumulative reply; revocation wins while a read awaits', async () => {
  const f = fixture(); await f.start(); f.item.detail = 'x'.repeat(40000); f.write();
  await f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: f.item.id } });
  await assert.rejects(f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: f.item.id } }), { code: 'EVIDENCE_LIMIT' });
  f.item.detail = 'short'; f.write();
  const pending = f.service.tools(f.token(), { method: 'call', name: 'get_attention_item', arguments: { itemId: f.item.id } });
  f.item.sourceVersion++; f.write(); await assert.rejects(pending, { code: 'BACKGROUND_REVOKED' });
});
test('settled history is bounded while current referenced evidence and recorded instance ownership remain visible to upgrade checks', async () => {
  const f = fixture(), job = await f.start();
  assert.ok(settlementBlockers(f.store.db).some(b => b.kind === 'background-instance'));
  const current = f.service.view().attempts[0]!, other = { ...f.item, id: randomUUID(), key: 'run:other' };
  f.store.db.prepare('INSERT INTO attention_items(id,key,status,fingerprint,updated_at,value) VALUES(?,?,?,?,?,?)').run(other.id, other.key, 'open', 'other', other.updatedAt, JSON.stringify(other));
  const save = (id: string, itemId: string, status: string, at: string) => f.store.db.prepare('INSERT INTO background_attempts(id,item_id,status,admitted_at,value) VALUES(?,?,?,?,?)')
    .run(id, itemId, status, at, JSON.stringify({ ...current, id, itemId, status, admittedAt: at, finishedAt: at }));
  const retained = randomUUID(); save(retained, other.id, 'succeeded', '2025-01-01T00:00:00Z');
  for (let i = 0; i < 220; i++) save(randomUUID(), 'resolved-fixture', 'failed', new Date(Date.parse('2025-02-01T00:00:00Z') + i * 1000).toISOString());
  await f.complete(job);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM background_attempts').get() as { n: number }).n, 201);
  assert.ok(f.store.db.prepare('SELECT id FROM background_attempts WHERE id=?').get(retained));
  await f.control('stop', { confirm: true });
  assert.equal(settlementBlockers(f.store.db).some(b => b.kind.startsWith('background')), false);
});
