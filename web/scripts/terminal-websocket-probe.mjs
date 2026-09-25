/** Isolated real-host M0: Next owns one broker, WebSocket first-frame tickets, HTTP controls stay responsive. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';
const directory = await mkdtemp(join(tmpdir(), 'altcli-ws-gate-'));
const cwd = resolve(import.meta.dirname, '..');
const token = 'a'.repeat(64); // disposable test credential
const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const origin = `http://127.0.0.1:${port}`;
const mode = process.argv.includes('--production') ? 'production' : 'development';
const child = spawn(process.execPath, ['--experimental-strip-types', 'server.ts', ...(mode === 'development' ? ['--dev'] : []), '--port', String(port)], { cwd, stdio: ['ignore','pipe','pipe'], env: { ...process.env, ALTCLI_TOKEN: token, ALTCLI_ADAPTER: 'mock', ALTCLI_ENABLE_TERMINAL: 'true', ALTCLI_ENABLE_INPUT: 'true', ALTCLI_DATA_DIR: directory, ALTCLI_ALLOWED_ORIGINS: origin, ...(mode === 'development' ? { ALTCLI_DIST_DIR: '.next-e2e-altcli-ws-probe' } : {}) } });
let log = ''; const sockets = [];
for (const stream of [child.stdout,child.stderr]) stream.on('data', d => { log = (log+d).slice(-8000); });
const wait = ms => new Promise(r => setTimeout(r,ms));
async function request(path, body) {
  const response = await fetch(`${origin}/api/v1/${path}`, { headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body ? {'Content-Type':'application/json'} : {}) }, method: body ? 'POST' : 'GET', ...(body ? {body:JSON.stringify(body)} : {}) });
  const data = await response.json(); return {status:response.status,data};
}
try {
  for(let n=0;n<180;n++) { if(child.exitCode!==null) throw Error(log); try { if((await request('config')).status===200) break; }catch{} await wait(100); }
  const state = (await request('state')).data;
  const session = state.sessions[0]; assert.ok(session?.registrationId, log);
  const opened = [];
  for(let n=0;n<6;n++) {
    const target = state.sessions[n % state.sessions.length];
    const result = await request('terminals', {target:{agentId:target.id,registrationId:target.registrationId},cols:80,rows:24,clientInstanceId:crypto.randomUUID()});
    assert.equal(result.status,200,JSON.stringify(result)); opened.push(result.data);
    const ws = new WebSocket(origin.replace('http:','ws:')+'/api/v1/terminals/socket',{origin}); sockets.push(ws);
    await new Promise((done,fail) => {const timer=setTimeout(()=>fail(Error('Missing reset; '+log)),15000); ws.on('error',fail); ws.once('open',()=>ws.send(JSON.stringify({ticket:result.data.ticket}))); ws.on('message',bytes=>{const f=JSON.parse(bytes); if(f.type==='reset'){result.generation=f.generation;clearTimeout(timer);done();} if(f.type==='out') ws.send(JSON.stringify({type:'processed',generation:f.generation,sequence:f.sequence,processedBytes:f.bytes}));});});
  }
  const before=performance.now(); const invalid=await request(`terminals/${opened[0].connectionId}/keyboard`,{action:'acquire'});
  assert.equal(invalid.status,400,JSON.stringify(invalid)); assert.ok(invalid.data.error.code !== 'INTERNAL_ERROR');
  const elapsed=Math.round(performance.now()-before); assert.ok(elapsed<2000, `Control starved for ${elapsed}ms`);
  const replay = new WebSocket(origin.replace('http:','ws:')+'/api/v1/terminals/socket',{origin}); sockets.push(replay);
  await new Promise((done,fail)=>{const timer=setTimeout(()=>fail(Error('Ticket replay accepted')),5000);replay.once('open',()=>replay.send(JSON.stringify({ticket:opened[0].ticket})));replay.once('close',(code)=>{clearTimeout(timer);assert.equal(code,1008);done();});replay.once('error',fail);});
  console.log(JSON.stringify({mode,connections:6,sharedNextBroker:true,typedErrors:true,ticketReplayRejected:true,controlMs:elapsed}));
} finally {
  sockets.forEach(s=>s.terminate());
  if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await done;clearTimeout(timer);}
  await rm(directory,{recursive:true,force:true});
}
assert.equal(child.exitCode,0,log);
