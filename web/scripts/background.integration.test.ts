import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.ts';
import { loadConfig } from '../src/server/config.ts';
import { terminalRunner } from '../src/server/terminal-environment.ts';
import { AttentionService } from '../src/server/attention/service.ts';
import { AppReads } from '../src/server/global-ai/reads.ts';
import { BackgroundService, type BackgroundServices } from '../src/server/background/service.ts';
import { NativeBackgroundHost } from '../src/server/background/host.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import type { LaunchProfile } from '../src/contracts/launches.ts';
import { VERIFIED_CLAUDE_VERSION } from './background-native.mjs';

let tmux = true; try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { tmux = false; }
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(100); } assert.fail('Native Background condition did not settle.');
}
test(process.env.ALTCLI_BACKGROUND_REAL === '1' ? 'installed Claude in a recorded private tmux runner: scoped synthetic evidence and validated assessment'
  : 'real private tmux runner: exact claim, scoped evidence, completion, restart cancellation and explicit recovery (fixture provider)', { skip: !tmux }, async () => {
  const realProvider = process.env.ALTCLI_BACKGROUND_REAL === '1';
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-background-tmux-'))), store = new Store(directory);
  const config = loadConfig({ ALTCLI_ADAPTER: 'tmux', ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: directory,
    ALTCLI_ENABLE_INPUT: 'true', ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_AGENT_LAUNCH: 'true', ALTCLI_TMUX_SOCKET: join(directory, 'tmux.sock') });
  const run = terminalRunner(config), binary = join(directory, 'claude');
  await writeFile(binary, `#!${process.execPath}
const {readFileSync}=require('node:fs');
if(process.argv.includes('--version')){console.log(${JSON.stringify(VERIFIED_CLAUDE_VERSION)});process.exit(0)}
const args=process.argv.slice(2), sid=args[args.indexOf('--session-id')+1];
const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.altcli_job;
const d=JSON.parse(readFileSync(mcp.args[1],'utf8'));
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{
 const binding=JSON.parse(prompt.slice(prompt.indexOf('Item binding: ')+14));
 const response=await fetch(d.endpoint,{method:'POST',headers:{Authorization:'Bearer '+d.token,Origin:new URL(d.endpoint).origin,'Content-Type':'application/json'},body:JSON.stringify({method:'call',name:'get_attention_item',arguments:{itemId:binding.itemId}})});
 const reply=await response.json(); if(!response.ok)process.exit(2);
 const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 send({type:'system',subtype:'init',session_id:sid,tools:['StructuredOutput','mcp__altcli_job__get_attention_item'],mcp_servers:[{name:'altcli_job',status:'connected'}],plugins:[],model:'fixture'});
 if(reply.data.item.detail==='hold'){setInterval(()=>{},1000);return;}
 send({type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{itemId:binding.itemId,itemRevision:binding.itemRevision,summary:'Inspect delivery.',likelyCause:'A receipt is missing.',nextSteps:['Inspect the original delivery.'],uncertainties:['Execution is unknown.'],evidence:[{id:reply.evidenceId,note:'Recorded uncertainty.'}],surface:'control_access'}});
});
`, { mode: 0o700 });
  const attention = new AttentionService(store.db), host = new NativeBackgroundHost(config, resolve(process.cwd(), '..'));
  const profile: LaunchProfile = { id: 'fixture', label: 'Background fixture', revision: 1, executable: realProvider ? 'claude' : binary, adapterHint: 'claude',
    args: realProvider ? ['--model', 'haiku', '--effort', 'low'] : [], enabled: true, purpose: 'background' };
  let clock = Date.now();
  const item: AttentionItem = { id: randomUUID(), key: 'run:fixture', kind: 'run', facets: ['delivery_uncertain'],
    subject: { type: 'run', runId: 'fixture', repository: '/synthetic', phase: 'implementation', participants: ['a', 'b'], commandId: 'c' },
    title: 'Delivery uncertain', detail: 'A receipt is missing.', destination: { surface: 'control-access', runId: 'fixture', repository: '/synthetic' },
    revision: 1, sourceVersion: 1, status: 'open', openedAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(), resolvedAt: null,
    resolution: null, seenRevision: null, stale: false };
  const write = () => store.db.prepare('INSERT INTO attention_items(id,key,status,fingerprint,updated_at,value) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
    .run(item.id, item.key, 'open', 'fixture', item.updatedAt, JSON.stringify(item)); write();
  const reads = new AppReads({ attention, kb: { documents: [] }, featureFlags: () => ({}), launch: () => undefined, run: () => undefined,
    state: async () => { throw new Error('Unexpected state read.'); }, workspaces: async () => { throw new Error('Unexpected discovery.'); } });
  const services: BackgroundServices = { db: store.db, attention, reads, host, directory: join(directory, 'background'), profiles: () => [profile],
    enabled: () => true, launchGuard: work => work(), now: () => clock };
  let service = new BackgroundService(services);
  const server = createServer(async (request, response) => {
    try {
      const kind = request.url?.endsWith('/tools') ? 'tools' : 'runner', token = request.headers.authorization?.slice(7) ?? '';
      service.authenticate(token, kind);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify(await (kind === 'tools' ? service.tools(token, body) : service.runner(token, body))));
    } catch { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'Fixture capability revoked.' } })); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
    const preview = await service.preview({ profileId: profile.id }, origin);
    await service.enable({ id: preview.id, digest: preview.digest, requestId: randomUUID(), confirm: true });
    await service.tick(); clock += 20000; await service.tick();
    assert.equal(service.settings().instance!.status, 'started', service.settings().message);
    const instance = service.settings().instance!, firstIdentity = instance.identity;
    await eventually(() => service.view().attempts[0]?.status === 'succeeded');
    if (!realProvider) assert.equal(service.view().attempts[0]!.assessment!.likelyCause, 'A receipt is missing.');
    assert.equal((await host.inspect(instance)).dead, false);
    if (realProvider) {
      assert.ok(service.view().attempts[0]!.assessment!.evidence.length);
      console.log(JSON.stringify({ provider: instance.providerVersion, model: service.view().attempts[0]!.model, evidence: 'synthetic issue through real host-scoped MCP',
        tmux: 'exact recorded private session', result: 'validated assessment after settled native exit' }));
      await service.control({ action: 'stop', instanceId: instance.id, confirm: true }, origin); return;
    }
    item.sourceVersion++; item.revision++; item.detail = 'hold'; write();
    await service.tick(); clock += 30000; await service.tick();
    await eventually(() => service.view().attempts[0]?.status === 'running' && service.view().attempts[0]!.calls > 0);
    await service.shutdown(); service = new BackgroundService(services);
    assert.equal(service.view().attempts[0]!.status, 'uncertain');
    await eventually(async () => {
      await service.control({ action: 'inspect', instanceId: instance.id }, origin);
      return service.view().attempts[0]?.status === 'canceled';
    });
    assert.equal(service.settings().paused, true);
    await service.control({ action: 'resume', instanceId: instance.id, confirm: true }, origin);
    assert.deepEqual(service.settings().instance!.identity, firstIdentity);
    await delay(1300); assert.equal(service.view().attempts.length, 2);
    // Extra panes cannot be stopped incidentally. The fixture owns its entire separate socket.
    const extra = (await run(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', instance.sessionId!, '/bin/sleep', '60'])).trim();
    await assert.rejects(service.control({ action: 'stop', instanceId: instance.id, confirm: true }, origin), { code: 'GLOBAL_IDENTITY' });
    await run(['kill-window', '-t', extra]);
    await service.control({ action: 'stop', instanceId: instance.id, confirm: true }, origin);
    assert.equal(service.settings().instance!.status, 'retired');
  } finally {
    await service.shutdown(); await run(['kill-server']).catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
