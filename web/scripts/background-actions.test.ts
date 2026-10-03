import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { BackgroundActions, operation, type ActionServices } from '../src/server/background/actions.ts';
import { executeCommand } from '../src/server/background/action-executor.ts';
import { backgroundAuthorization, withBackgroundAuthorization } from '../src/server/background/action-context.ts';
import type { BackgroundAction, BackgroundOperation } from '../src/contracts/background-actions.ts';
import type { BackgroundAttempt, BackgroundSettings } from '../src/contracts/background.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import { settlementBlockers } from '../src/server/upgrade.ts';
import { InputAuthority } from '../src/server/input-authority.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
function fixture(executor?: ActionServices['execute']) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-actions-'))), store = new Store(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let clock = Date.now(), calls = 0;
  const settings = { enabled: true, paused: false, needsInspection: false, revision: 1, instance: { id: 'instance' } } as BackgroundSettings;
  const item = { id: 'issue', revision: 1, sourceVersion: 1, status: 'open', stale: false } as AttentionItem;
  const attempt = { id: 'attempt', instanceId: 'instance', enablement: 1, itemId: item.id, itemRevision: 1, sourceVersion: 1 } as BackgroundAttempt;
  const services: ActionServices = { db: store.db, settings: () => settings, item: id => id === item.id ? item : undefined,
    enabled: () => true, ownerToken: 'synthetic-owner-credential', now: () => clock, settled: () => {},
    execute: executor ?? (async (_action, _signal, _started, admitted) => { admitted(); calls++; return { status: 'completed', message: 'Fixture effect completed.', result: { changed: true } }; }) };
  const actions = new BackgroundActions(services);
  cleanups.push(() => actions.shutdown());
  const raw = (id: string) => JSON.parse((store.db.prepare('SELECT value FROM background_actions WHERE id=?').get(id) as { value: string }).value) as BackgroundAction;
  const propose = async (op: BackgroundOperation = { kind: 'app', method: 'POST', path: '/api/v1/runs', body: { action: 'pause', runId: 'fixture' } }, key: string = randomUUID(), job = attempt) => {
    const result = await actions.tool('request_action', { requestKey: key, reason: 'Resolve the fixture issue.', operation: op }, job) as { action: { id: string } };
    return raw(result.action.id);
  };
  const allow = (app: 'ask' | 'allow' = 'allow', command: 'ask' | 'allow' = 'ask', risk: 'ask' | 'allow' = 'ask') => actions.savePermissions({ expectedRevision: actions.permissions().revision, app, command, risk, confirm: true });
  const approve = (a: BackgroundAction) => actions.decide({ action: 'approve', id: a.id, digest: a.digest, confirm: true });
  return { actions, services, settings, item, attempt, directory, store, propose, raw, approve, allow, calls: () => calls, advance: (ms: number) => { clock += ms; } };
}

test('ask-first proposals persist in SQLite; reads and settings never approve existing actions', async () => {
  const f = fixture(), a = await f.propose();
  assert.equal(a.status, 'pending'); assert.equal(f.calls(), 0);
  assert.equal(f.actions.view().actions[0]!.id, a.id);
  f.allow(); await f.actions.drain(); assert.equal(f.calls(), 0);
  assert.equal(f.raw(a.id).status, 'pending');
  assert.equal(f.actions.view().entries[0]!.kind, 'permissions');
  assert.throws(() => f.approve(a), { code: 'ACTION_STALE' });
  assert.equal(f.raw(a.id).status, 'stale');
});
test('exact interactive consent executes once; duplicate requests and approval responses return the same receipt', async () => {
  const f = fixture(), a = await f.propose();
  assert.throws(() => f.actions.decide({ action: 'approve', id: a.id, digest: 'changed', confirm: true }), { code: 'ACTION_CHANGED' });
  assert.throws(() => f.actions.decide({ action: 'approve', id: a.id, digest: a.digest }), { code: 'CONFIRM_REQUIRED' });
  f.approve(a); f.approve(a); await f.actions.drain();
  assert.equal(f.calls(), 1); assert.equal(f.raw(a.id).authorization!.decision, 'interactive');
  const repeated = await f.propose(a.operation, randomUUID(), { ...f.attempt, id: 'later-job' });
  assert.equal(repeated.id, a.id); assert.equal(repeated.status, 'completed'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.actions.view().entries.map(e => e.kind), ['completed', 'running', 'proposed']);
});
test('standing app and host permissions are separate; risk decisions need explicit additional delegation', async () => {
  const f = fixture(); f.allow();
  const ordinary = await f.propose(); await f.actions.drain(); assert.equal(f.raw(ordinary.id).status, 'completed');
  const host = await f.propose({ kind: 'command', directory: f.directory, executable: '/bin/echo', args: ['hello'] });
  const risk = await f.propose({ kind: 'app', method: 'POST', path: '/api/v1/runs', body: { action: 'takeover', confirmReady: true } });
  assert.equal(host.status, 'pending'); assert.equal(risk.status, 'pending'); assert.equal(f.calls(), 1);
  assert.equal(f.raw(ordinary.id).authorization!.decision, 'policy');
  f.allow('allow', 'allow', 'allow');
  const next = await f.propose({ kind: 'app', method: 'POST', path: '/api/v1/planning/decision', body: { action: 'approve', confirmReady: true } }, randomUUID(), { ...f.attempt, id: 'next' });
  await f.actions.drain(); assert.equal(f.raw(next.id).authorization!.decision, 'policy'); assert.equal(f.calls(), 2);
});
test('denial, source ABA, disablement, pause and expiry never grant execution', async () => {
  for (const change of ['deny', 'source', 'disable', 'pause', 'expire']) {
    const f = fixture(), a = await f.propose();
    if (change === 'deny') { f.actions.decide({ action: 'deny', id: a.id, digest: a.digest }); f.approve(a); }
    else {
      if (change === 'source') f.item.sourceVersion += 2;
      if (change === 'disable') f.settings.enabled = false;
      if (change === 'pause') f.settings.paused = true;
      if (change === 'expire') f.advance(1800000);
      assert.throws(() => f.approve(a), { code: 'ACTION_STALE' });
    }
    await f.actions.drain(); assert.equal(f.calls(), 0);
  }
});
test('permission revocation wins between durable admission and the first native effect', async () => {
  let release!: () => void, calls = 0; const ready = new Promise<void>(r => { release = r; });
  const f = fixture(async (_a, _s, _p, admitted) => { await ready; admitted(); calls++; return { status: 'completed', message: 'Fixture effect.', result: null }; });
  f.allow(); const a = await f.propose();
  f.allow('ask'); release(); await f.actions.drain(); assert.equal(calls, 0);
  assert.equal(f.raw(a.id).status, 'failed');
  assert.ok(f.actions.view().entries.some(e => e.kind === 'running')); // authorization was retained, never erased
});
test('forged authority, self-managed settings, hooks, remote URLs, escapes and credential literals are refused', async () => {
  const f = fixture();
  for (const path of ['https://example.com/api/v1/runs', '/api/v1/background/actions', '/api/v1/events', '/api/v1/global-ai/tools', '/api/v1/runs/../background', '/api/v1/%62ackground', '/api/v1/runs#other'])
    assert.throws(() => operation({ kind: 'app', method: 'POST', path, body: {} }));
  assert.equal(operation({ kind: 'app', method: 'GET', path: '/api/v1/directories?path=%2Ftmp' }).kind, 'app');
  await assert.rejects(f.actions.tool('request_action', { requestKey: 'x', reason: 'x', approved: true, operation: { kind: 'command', directory: f.directory, executable: '/bin/echo', args: [] } }, f.attempt));
  await assert.rejects(f.propose({ kind: 'command', directory: f.directory, executable: '/bin/echo', args: ['synthetic-owner-credential'] }), { code: 'ACTION_SECRET' });
  assert.equal(f.actions.view().entries.length, 0);
});
test('changed payload under a request key conflicts; get_actions cannot read another issue', async () => {
  const f = fixture(); await f.propose(undefined, 'same');
  await assert.rejects(f.propose({ kind: 'command', directory: f.directory, executable: '/bin/echo', args: [] }, 'same'), { code: 'ACTION_CONFLICT' });
  const other = await f.actions.tool('get_actions', {}, { ...f.attempt, itemId: 'other' }) as { actions: unknown[] };
  assert.equal(other.actions.length, 0);
  await assert.rejects(f.actions.tool('get_actions', { actionId: f.actions.view().actions[0]!.id }, { ...f.attempt, itemId: 'other' }), { code: 'OUT_OF_SCOPE' });
});
test('one-use app grants bind method, query, body, issue and policy; async actor context stays separate from model input', async () => {
  let inspect: (() => void) | undefined;
  const f = fixture(async (a, _s, _p, admitted, grant) => {
    admitted(); const token = grant();
    assert.throws(() => f.actions.consume(token, 'GET', '/api/v1/runs', null), { code: 'ACTION_GRANT' });
    const authority = f.actions.consume(token, 'POST', '/api/v1/runs', a.operation.kind === 'app' ? a.operation.body : null);
    assert.throws(() => f.actions.consume(token, 'POST', '/api/v1/runs', a.operation.kind === 'app' ? a.operation.body : null), { code: 'ACTION_GRANT' });
    await withBackgroundAuthorization(authority, async () => { await Promise.resolve(); assert.equal(backgroundAuthorization()?.actionId, a.id); });
    assert.equal(backgroundAuthorization(), undefined); inspect?.();
    return { status: 'completed', message: 'Receipt.', result: null };
  });
  inspect = () => assert.equal(f.actions.view().actions[0]!.status, 'running');
  f.allow(); const a = await f.propose(); await f.actions.drain(); assert.equal(f.raw(a.id).status, 'completed');
});
test('restart keeps running actions uncertain, blocks another effect and never replays after inspected reconciliation', async () => {
  const f = fixture(), a = await f.propose();
  a.status = 'running'; f.store.db.prepare('UPDATE background_actions SET status=?,value=? WHERE id=?').run('running', JSON.stringify(a), a.id);
  const recovered = new BackgroundActions(f.services); cleanups.push(() => recovered.shutdown());
  assert.equal(recovered.view().actions[0]!.status, 'uncertain');
  assert.ok(settlementBlockers(f.store.db).some(b => b.kind === 'background-action'));
  const next = await f.propose({ kind: 'command', directory: f.directory, executable: '/bin/echo', args: [] });
  assert.throws(() => recovered.decide({ action: 'approve', id: next.id, digest: next.digest, confirm: true }), { code: 'ACTION_UNSETTLED' });
  recovered.decide({ action: 'reconcile', id: a.id, digest: a.digest, confirm: true, note: 'Inspected the fixture; no process remains.' });
  const again = await f.propose(a.operation, 'another'); assert.equal(again.id, a.id); assert.equal(again.status, 'reconciled'); assert.equal(f.calls(), 0);
});
test('audit pagination is durable and stable when new entries arrive; credentials are redacted', () => {
  const f = fixture(); for (let i = 0; i < 120; i++) f.actions.log('host', 'fixture', String(i), { token: 'not-for-display', output: 'synthetic-owner-credential' });
  const first = f.actions.view(); assert.equal(first.entries.length, 50); assert.ok(first.next);
  f.actions.log('owner', 'new', 'New entry'); const older = f.actions.view(first.next!);
  assert.equal(older.entries[0]!.id, 70); assert.equal(older.entries.length, 50);
  const text = JSON.stringify(first); assert.equal(text.includes('synthetic-owner-credential'), false); assert.equal(text.includes('not-for-display'), false);
});
test('real host command writes only after confirmation, preserves literal argv and records observed exit', async () => {
  const f = fixture((a, signal, started, admitted) => executeCommand(a, signal, started, admitted, 'synthetic-owner-credential'));
  const target = join(f.directory, 'result.txt'), literal = '$(touch unwanted) ; `echo surprise`';
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2]); console.log("written")', target, literal] });
  assert.throws(() => readFileSync(target)); f.approve(a); await f.actions.drain();
  assert.equal(readFileSync(target, 'utf8'), literal); assert.equal(f.raw(a.id).status, 'completed');
  assert.match(JSON.stringify(f.raw(a.id).result), /written/); assert.ok(f.raw(a.id).pid);
});
test('held manual input refuses a host command before launch as a known failure that keeps no action slot', async () => {
  let authority!: InputAuthority;
  const f = fixture((a, signal, started, admitted) => authority.automated(() => executeCommand(a, signal, started, admitted)));
  authority = new InputAuthority(f.store); f.allow('ask', 'allow');
  const target = join(f.directory, 'written.txt'), write = (text: string): BackgroundOperation => ({ kind: 'command', directory: f.directory,
    executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', target, text] });
  await authority.acquire(async () => {
    const held = await f.propose(write('held')); await f.actions.drain();
    assert.equal(f.raw(held.id).status, 'failed'); assert.match(f.raw(held.id).message, /Manual terminal input/); assert.equal(f.raw(held.id).pid, null);
  });
  assert.throws(() => readFileSync(target)); assert.equal(f.actions.unsettled(), false);
  const next = await f.propose(write('released')); await f.actions.drain();
  assert.equal(f.raw(next.id).status, 'completed'); assert.equal(readFileSync(target, 'utf8'), 'released');
});
test('canceling a real command retains earlier effects and verifies process-group exit before releasing the slot', async () => {
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const f = fixture((a, signal, pid, admitted) => executeCommand(a, signal, n => { pid(n); started(); }, admitted));
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  f.approve(a); await ready; f.actions.cancel(); await f.actions.drain();
  const result = f.raw(a.id); assert.equal(result.status, 'failed'); assert.equal((result.result as { processGroupExited: boolean }).processGroupExited, true);
  assert.throws(() => process.kill(-result.pid!, 0), { code: 'ESRCH' });
});

test('allowed actions wait for the prior effect; policy changes and expiry invalidate queued proposals', async () => {
  let release!: () => void, calls = 0; const first = new Promise<void>(r => { release = r; });
  const f = fixture(async (_a, _s, _p, admitted) => { admitted(); calls++; if (calls === 1) await first; return { status: 'completed', message: 'Fixture.', result: null }; });
  f.allow(); const a = await f.propose();
  const b = await f.propose({ kind: 'app', method: 'POST', path: '/api/v1/runs', body: { action: 'pause', runId: 'second' } });
  assert.equal(b.status, 'pending'); assert.equal(calls, 1);
  release(); await f.actions.drain(); f.actions.tick(); await f.actions.drain();
  assert.equal(f.raw(a.id).status, 'completed'); assert.equal(f.raw(b.id).status, 'completed'); assert.equal(calls, 2);
  f.allow('ask'); const c = await f.propose({ kind: 'command', directory: f.directory, executable: '/bin/echo', args: [] });
  f.advance(1800000); f.actions.tick(); assert.equal(f.raw(c.id).status, 'stale');
});
test('surviving command work remains uncertain, and non-ASCII output stays within its byte budget', async () => {
  const f = fixture((a, signal, started, admitted) => executeCommand(a, signal, started, admitted));
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath, args: ['-e', 'process.stdout.write("界".repeat(5000))'] });
  f.approve(a); await f.actions.drain();
  const result = f.raw(a.id).result as { output: string; truncated: boolean };
  assert.ok(Buffer.byteLength(result.output) <= 8192); assert.equal(result.truncated, true);
  const b = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath, args: ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"}).unref()'] });
  f.approve(b); await f.actions.drain(); const record = f.raw(b.id);
  cleanups.push(() => { try { process.kill(-record.pid!, 'SIGKILL'); } catch {} });
  assert.equal(record.status, 'uncertain');
  assert.throws(() => f.actions.decide({ action: 'reconcile', id: b.id, digest: b.digest, confirm: true, note: 'Cannot falsely settle surviving work.' }), { code: 'ACTION_UNSETTLED' });
});

test('deferred callbacks cannot carry a completed app request’s delegated authority into another operation', async () => {
  let later!: () => void; const barrier = new Promise<void>(r => { later = r; }); let observation: Promise<unknown> | undefined;
  await withBackgroundAuthorization({ actionId: 'ended', decision: 'policy', policyRevision: 1, at: new Date().toISOString() }, async () => {
    observation = barrier.then(() => backgroundAuthorization());
    assert.equal(backgroundAuthorization()?.actionId, 'ended');
  });
  later(); assert.equal(await observation, undefined);
});
test('cancellation still kills the exact child group when its parent exits before a child that ignored TERM', async () => {
  const f = fixture((a, signal, started, admitted) => executeCommand(a, signal, started, admitted));
  const marker = join(f.directory, 'child-ready');
  const child = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`;
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath,
    args: ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref();setInterval(()=>{},1000)`] });
  f.approve(a);
  cleanups.push(() => { const pid = f.raw(a.id).pid; if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  const deadline = Date.now() + 5000;
  while (true) { try { readFileSync(marker); break; } catch { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 20)); } }
  f.actions.cancel(); await f.actions.drain(); const result = f.raw(a.id);
  assert.equal(result.status, 'failed'); assert.equal((result.result as { processGroupExited: boolean }).processGroupExited, true);
  assert.throws(() => process.kill(-result.pid!, 0), { code: 'ESRCH' });
});

test('a relative program resolves in the confirmed working directory, never the app server directory', async () => {
  const f = fixture((a, signal, started, admitted) => executeCommand(a, signal, started, admitted));
  writeFileSync(join(f.directory, 'fixture-runner'), `#!${process.execPath}\nconsole.log(process.cwd());\n`, { mode: 0o700 });
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: './fixture-runner', args: [] });
  f.approve(a); await f.actions.drain(); assert.equal(f.raw(a.id).status, 'completed');
  assert.equal((f.raw(a.id).result as { output: string }).output.trim(), f.directory);
});

test('failure to persist a spawned process identity stops and observes the command before returning', async () => {
  let spawned = 0;
  const f = fixture((a, signal, _started, admitted) => executeCommand(a, signal, pid => { spawned = pid; throw new Error('Fixture storage failure'); }, admitted));
  cleanups.push(() => { if (spawned) try { process.kill(-spawned, 'SIGKILL'); } catch {} });
  const a = await f.propose({ kind: 'command', directory: f.directory, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  f.approve(a); await f.actions.drain();
  assert.ok(spawned); assert.equal(f.raw(a.id).status, 'failed');
  assert.equal((f.raw(a.id).result as { processGroupExited: boolean }).processGroupExited, true);
  assert.throws(() => process.kill(-spawned, 0), { code: 'ESRCH' });
});

test('a full pending queue cannot hide the uncertain action that blocks execution', async () => {
  const f = fixture(async () => ({ status: 'uncertain', message: 'Fixture lost receipt.', result: null }));
  const held = await f.propose(); f.approve(held); await f.actions.drain();
  for (let i = 0; i < 100; i++) await f.propose({ kind: 'app', method: 'POST', path: '/api/v1/runs', body: { action: 'pause', runId: `queued-${i}` } }, `key-${i}`, { ...f.attempt, id: `job-${i}` });
  const view = f.actions.view(); assert.equal(view.actions.length, 101);
  assert.equal(view.actions[0]!.id, held.id); assert.equal(view.actions[0]!.status, 'uncertain');
});
