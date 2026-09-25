import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { InputAuthority } from '../src/server/input-authority.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import type { TerminalFrame, TerminalConnection } from '../src/contracts/terminals.ts';
class Socket extends EventEmitter {
  readyState=1; bufferedAmount=0; frames:TerminalFrame[]=[];
  send(text:string){this.frames.push(JSON.parse(text));}
  close(){if(this.readyState!==1)return;this.readyState=3;this.emit('close');}
  terminate(){this.close();}
  frame(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
}
let directory:string, store:Store, plane:ControlPlane;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'altcli-broker-'));store=new Store(directory);for(const s of mockSessions())store.saveSession(s);
  plane=new ControlPlane(new Controller(loadConfig({ALTCLI_ADAPTER:'mock',ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:directory,ALTCLI_ENABLE_TERMINAL:'true',ALTCLI_ENABLE_LEGACY_RELAY:'true',ALTCLI_ENABLE_AGENT_LAUNCH:'true'}),store,new MockAdapter()));});
afterEach(async()=>{await plane.terminals.shutdown();store.close();rmSync(directory,{recursive:true,force:true});});
const settle=()=>new Promise(r=>setTimeout(r,10));
async function connect():Promise<{opened:TerminalConnection;socket:Socket;generation:string}>{const s=(await plane.state()).sessions[0]!;const opened=await plane.terminals.open({target:{agentId:s.id,registrationId:s.registrationId},cols:80,rows:24,clientInstanceId:randomUUID()});const socket=new Socket();plane.terminals.connect(socket as unknown as WebSocket);socket.frame({ticket:opened.ticket});await settle();const reset=socket.frames.find(f=>f.type==='reset');assert.ok(reset?.type==='reset');return {opened,socket,generation:reset.generation};}
const grant=(c:Awaited<ReturnType<typeof connect>>,transfer=false)=>plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:c.generation,action:'acquire',confirmReady:true,transfer});
test('resize admission bounds native inspection concurrency and frequency and preserves dimension clamps',async t=>{
  let finish!:()=>void,hold=true;const sizes:number[][]=[];
  plane.terminals.services.attach=async(_config,target)=>({pid:1,write:()=>{},resize:(cols,rows)=>{sizes.push([cols,rows]);},pause:()=>{},resume:()=>{},close:async()=>{},active:async()=>{if(hold)await new Promise<void>(r=>{finish=r;});return {paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'};}});
  const c=await connect();let now=Date.now();t.mock.method(Date,'now',()=>now);
  const input={generation:c.generation,cols:10000,rows:1};
  const first=plane.terminals.resize(c.opened.connectionId,input);
  try {await assert.rejects(plane.terminals.resize(c.opened.connectionId,input),/one request per 100 ms/);}
  finally {hold=false;finish();await first;}
  assert.deepEqual(sizes,[[500,5]]);
  await assert.rejects(plane.terminals.resize(c.opened.connectionId,input),/one request per 100 ms/);
  now+=100;await plane.terminals.resize(c.opened.connectionId,{...input,cols:80,rows:24});
  assert.deepEqual(sizes,[[500,5],[80,24]]);
});
/** The published WebSocket frame contract (inline JSON in shared/openapi.yaml), checked for the constructs it uses. */
type Schema={type?:string;const?:unknown;pattern?:string;anyOf?:Schema[];properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean};
const frameVariants=():Schema[]=>{const line=readFileSync(join(import.meta.dirname,'../../shared/openapi.yaml'),'utf8').split('\n').find(l=>l.trim().startsWith('TerminalFrame:'))!;return JSON.parse(line.trim().slice('TerminalFrame:'.length)).oneOf;};
function conforms(s:Schema,v:unknown):boolean{
  if(s.anyOf)return s.anyOf.some(x=>conforms(x,v));
  if(s.const!==undefined)return v===s.const;
  if(s.type==='string')return typeof v==='string'&&(!s.pattern||new RegExp(s.pattern).test(v));
  if(s.type==='integer')return Number.isInteger(v);
  if(s.type==='boolean')return typeof v==='boolean';
  if(s.type==='null')return v===null;
  if(s.type!=='object'||typeof v!=='object'||v===null)return false;
  const o=v as Record<string,unknown>;
  return (s.required??[]).every(k=>k in o)&&Object.entries(o).every(([k,x])=>s.properties?.[k]?conforms(s.properties[k]!,x):s.additionalProperties!==false);
}
const published=(frame:unknown)=>frameVariants().filter(s=>conforms(s,frame)).length===1;
test('every emitted terminal frame, including active with its window size, matches the published contract',async()=>{
  const c=await connect();
  for(let n=0;n<150&&!c.socket.frames.some(f=>f.type==='active');n++)await settle();
  const active=c.socket.frames.find(f=>f.type==='active');assert.ok(active?.type==='active'&&active.size==='80x24',JSON.stringify(active));
  for(const frame of c.socket.frames)assert.ok(published(frame),`unpublished frame shape: ${JSON.stringify(frame)}`);
  assert.equal(published({...active,unexpected:true}),false,'unknown fields stay rejected');
  assert.equal(published({...active,size:'wide'}),false,'size is columns x rows');
});
test('observer input is rejected; only acknowledged same-generation input changes the durable byte count',async()=>{
  const c=await connect();await assert.rejects(plane.terminals.input(c.opened.connectionId,{generation:c.generation,seq:1,encoding:'utf8',data:'x'}),/keyboard grant/);
  const owned=await grant(c);assert.equal(plane.authority.pending()[0]?.inputMayHaveOccurred,false);
  const value={generation:owned.generation,seq:1,encoding:'utf8',data:'é\x1b[A'};
  const first=await plane.terminals.input(c.opened.connectionId,value);assert.deepEqual(await plane.terminals.input(c.opened.connectionId,value),first);
  assert.equal(plane.authority.pending()[0]!.bytes,Buffer.byteLength(value.data));
  await assert.rejects(plane.terminals.input(c.opened.connectionId,{...value,data:'different'}),/Conflicting/);
  await assert.rejects(plane.terminals.input(c.opened.connectionId,{...value,seq:3}),/gap/);
  await assert.rejects(plane.terminals.input(c.opened.connectionId,{...value,generation:c.generation}),/connection changed/);
  const serialized=store.db.prepare('SELECT value FROM keyboard_sessions').get() as {value:string};assert.ok(!serialized.value.includes('é'));
});
test('release is durable, blocks new turns before claim, and explicit settled reconciliation never sends',async()=>{
  const c=await connect(), owned=await grant(c);
  const release={requestId:randomUUID(),expectedGeneration:owned.generation,action:'release'};
  const result=await plane.terminals.keyboard(c.opened.connectionId,release);assert.equal(result.writer,false);assert.equal(plane.authority.blocked,true);
  assert.deepEqual(await plane.terminals.keyboard(c.opened.connectionId,release),result);
  await assert.rejects(plane.submit({requestId:randomUUID(),agentId:'codex',kind:'relay',confirmReady:true}),/Manual terminal input/);assert.equal(plane.workflow.runs().length,0);
  const m=plane.authority.pending()[0]!;await plane.reconcileManual({requestId:randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmReady:true});assert.equal(plane.authority.blocked,false);assert.equal(plane.workflow.runs().length,0);
  await plane.terminals.close(c.opened.connectionId);assert.equal(plane.authority.blocked,false,'closing settled observer must not revive barrier');
});
test('two clients serialize decisions; transfer revokes the old generation and preserves unresolved input',async()=>{
  const first=await connect(),second=await connect();const owner=await grant(first);
  await plane.terminals.input(first.opened.connectionId,{generation:owner.generation,seq:1,encoding:'utf8',data:'x'});
  await assert.rejects(grant(second),/Confirm transfer/);const transferred=await grant(second,true);
  assert.equal(plane.authority.pending().length,1);assert.equal(transferred.manualSession!.bytes,1);
  await assert.rejects(plane.terminals.input(first.opened.connectionId,{generation:owner.generation,seq:2,encoding:'utf8',data:'y'}));
  assert.equal(plane.authority.pending()[0]!.connectionId,second.opened.connectionId);
});
test('restart or disconnect retains the barrier even when terminal feature is disabled',async()=>{
  const c=await connect();await grant(c);c.socket.close();await settle();assert.equal(plane.authority.pending()[0]!.live,false);assert.equal(plane.authority.blocked,true);
  const recovered=new InputAuthority(store);assert.equal(recovered.blocked,true);plane.config.terminalEnabled=false;
  await assert.rejects(plane.submit({requestId:randomUUID(),agentId:'codex',kind:'relay',confirmReady:true}),/Manual terminal input/);
});
test('human reconciliation requires a bounded inspection note and refuses any live keyboard or operation',async()=>{
  const c=await connect(), owned=await grant(c), m=owned.manualSession!;
  const input={requestId:randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmInspected:true as const,note:'Inspected possible prior/background effects.'};
  await assert.rejects(plane.reconcileManual(input),/Release the keyboard/);
  const unrelated=plane.authority.save({...m,id:randomUUID(),live:false});
  await assert.rejects(plane.reconcileManual({...input,manualSessionId:unrelated.id,expectedRevision:unrelated.revision}),/Release the keyboard/);
  await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:owned.generation,action:'release'});
  const current={...input,expectedRevision:plane.authority.get(m.id).revision};
  for(const note of ['', ' ', 'x'.repeat(1001), 'line\nbreak'])await assert.rejects(plane.reconcileManual({...current,note}),/Invalid|Record/);
  await assert.rejects(plane.reconcileManual({...current,confirmReady:true}),/Confirm one inspection/);
  await assert.rejects(plane.authority.acquire(()=>plane.reconcileManual(current)),/Release the keyboard/);
  assert.equal(plane.authority.get(m.id).reconciliationRequired,true);
});
test('human reconciliation cannot release delivery, setup or launch reservations',async()=>{
  const c=await connect(), owned=await grant(c);
  await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:owned.generation,action:'release'});
  const m=plane.authority.pending()[0]!,input={requestId:randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmInspected:true as const,note:'Inspected fixture host.'};
  store.db.prepare('INSERT INTO reservations(repository,active_id) VALUES (?,?)').run('/demo/other',randomUUID());
  await assert.rejects(plane.reconcileManual(input),/delivery, setup or launch is unresolved/);store.db.exec('DELETE FROM reservations');
  for(const status of ['applying','uncertain']) {
    store.db.prepare('INSERT INTO worktree_removals(id,value) VALUES (?,?)').run(randomUUID(),JSON.stringify({status}));
    await assert.rejects(plane.reconcileManual(input),/delivery, setup or launch is unresolved/);store.db.exec('DELETE FROM worktree_removals');
  }
  store.db.prepare('INSERT INTO launch_reservations(index_path,launch_id) VALUES (?,?)').run('/demo/other/.git/index',randomUUID());
  await assert.rejects(plane.reconcileManual(input),/delivery, setup or launch is unresolved/);store.db.exec('DELETE FROM launch_reservations');
  assert.equal(plane.authority.get(m.id).reconciliationRequired,true);
  const result=await plane.reconcileManual(input);assert.equal(result.reconciliationRequired,false);
  assert.deepEqual(await plane.reconcileManual(input),result);
  await assert.rejects(plane.reconcileManual({...input,note:'Different inspection'}),/another terminal decision/);
});
test('in-flight automation excludes keyboard acquisition before any durable grant',async()=>{
  const c=await connect();let release!:()=>void;const pending=plane.authority.automated(()=>new Promise<void>(r=>{release=r;}));
  await assert.rejects(grant(c),/in flight/);assert.equal(plane.authority.pending().length,0);release();await pending;
});
test('first-frame tickets are single-use and exact Origin and Host are mandatory',async()=>{
  const c=await connect();const second=new Socket();plane.terminals.connect(second as unknown as WebSocket);second.frame({ticket:c.opened.ticket});await settle();assert.equal(second.readyState,3);
  for(const origin of [undefined,'null','http://evil.invalid'])assert.equal(plane.terminals.authorize(origin,'127.0.0.1:8787'),false);
  assert.equal(plane.terminals.authorize('http://127.0.0.1:8787','evil.invalid'),false);assert.equal(plane.terminals.authorize('http://127.0.0.1:8787','127.0.0.1:8787'),true);
});
test('forged credit, input-disabled grants, and conflicting idempotence keys fail closed',async()=>{
  const c=await connect();assert.throws(()=>plane.terminals.processed(c.opened.connectionId,{generation:c.generation,sequence:1,processedBytes:9999}),/acknowledgment/);
  plane.config.inputEnabled=false;await assert.rejects(grant(c),/Input is disabled/);plane.config.inputEnabled=true;
  const request={requestId:randomUUID(),action:'acquire',expectedGeneration:c.generation,confirmReady:true};
  const [a,b]=await Promise.all([plane.terminals.keyboard(c.opened.connectionId,request),plane.terminals.keyboard(c.opened.connectionId,request)]);assert.deepEqual(a,b);assert.equal(plane.authority.pending().length,1);
  await assert.rejects(plane.terminals.keyboard(c.opened.connectionId,{...request,transfer:true}),/another terminal decision/);
});
test('project entry persists empty mock projects without panes, deduplicates, and respects read-only',async()=>{
  const p=await plane.projects.add({path:'/demo/new'});assert.deepEqual(await plane.projects.add({path:'/demo/new'}),p);
  const list=await plane.projects.discover([],[]);assert.ok(list.find(x=>x.id===p.id)?.worktrees.length);
  plane.config.inputEnabled=false;await assert.rejects(plane.projects.add({path:'/demo/other'}),/disabled/);
});
test('profile previews freeze revisions; launch confirmations are idempotent and mock panes stay discoverable',async()=>{
  const p=await plane.projects.add({path:'/demo/new'});const tree=(await plane.projects.discover([],[])).find(x=>x.id===p.id)!.worktrees[0]!;
  const profile=(await plane.launches.profile({label:'Codex',executable:'codex',args:['','a b',';'],adapterHint:'codex',enabled:true}))!;
  const input={projectId:p.id,items:[{worktreeId:tree.id,profileId:profile.id,count:2}]};const preview=await plane.launches.preview(input);
  const confirmation={requestId:preview.requestId,previewDigest:preview.digest,confirm:true};const batch=await plane.launches.confirm(confirmation);
  assert.equal(batch.items.length,2);assert.notEqual(batch.items[0]!.sessionName,batch.items[1]!.sessionName);assert.deepEqual(await plane.launches.confirm(confirmation),batch);
  assert.equal((await plane.workspaces()).workspaces.find(w=>w.cwd==='/demo/new')?.agents.length,2);
  const next=await plane.launches.preview(input);await plane.launches.profile({label:'Changed',executable:'codex',args:[],adapterHint:'codex',enabled:true,expectedRevision:profile.revision},profile.id);
  await assert.rejects(plane.launches.confirm({requestId:next.requestId,previewDigest:next.digest,confirm:true}),/changed/);assert.equal(plane.launches.batches().length,1);
});
test('a discovered project launches without path re-entry and is remembered only on confirmation',async()=>{
  const p=(await plane.workspaces()).projects![0]!,tree=p.worktrees[0]!;
  assert.equal(store.projects().length,0);
  const profile=(await plane.launches.profile({label:'Discovered',executable:'codex',args:[],adapterHint:'codex',enabled:true}))!;
  const preview=await plane.launches.preview({projectId:p.id,items:[{worktreeId:tree.id,profileId:profile.id,count:1}]});
  assert.equal(store.projects().length,0,'preview must not persist project selection');
  const batch=await plane.launches.confirm({requestId:preview.requestId,previewDigest:preview.digest,confirm:true});
  assert.equal(batch.items[0]!.status,'running');assert.equal(store.projects()[0]!.id,p.id);
});
test('renderer credit bounds output, pauses only the attachment, resumes below low water, and closes a stalled renderer',async()=>{
  let output!:(bytes:Buffer)=>void, paused=0, resumed=0, closed=0;
  plane.terminals.services.attach=async(_config,target,_writer,_cols,_rows,data)=>{output=data;return {pid:1,write:()=>{},resize:()=>{},pause:()=>{paused++;},resume:()=>{resumed++;},close:async()=>{closed++;},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})};};
  const c=await connect();for(let n=0;n<16;n++)output(Buffer.alloc(65536,120));
  const frames=c.socket.frames.filter(f=>f.type==='out');assert.ok(frames.every(f=>f.bytes<=16384));assert.equal(frames.reduce((n,f)=>n+f.bytes,0),1024*1024);assert.equal(paused,1);
  const last=frames.at(-1)!;plane.terminals.processed(c.opened.connectionId,{generation:last.generation,sequence:last.sequence,processedBytes:1024*1024});assert.equal(resumed,1);
  output(Buffer.from('idle renderer'));await new Promise(r=>setTimeout(r,11200));assert.equal(c.socket.readyState,3);assert.equal(closed,1);assert.equal(plane.authority.pending().length,0);
});
test('release drains an in-flight identity check and rejects queued input before transfer can write',async()=>{
  let unblock!:()=>void, inspect=false, writes=0;
  plane.terminals.services.attach=async(_config,target)=>({pid:1,write:()=>{writes++;},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{},active:async()=>{if(inspect)await new Promise<void>(r=>{unblock=r;});return {paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'};}});
  const c=await connect(), owner=await grant(c);inspect=true;
  const input=plane.terminals.input(c.opened.connectionId,{generation:owner.generation,seq:1,encoding:'utf8',data:'never written'});const rejection=assert.rejects(input,/ended before writing/);
  await settle();const release=plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:owner.generation,action:'release'});await settle();inspect=false;unblock();await rejection;await release;assert.equal(writes,0);assert.equal(plane.authority.pending()[0]!.inputMayHaveOccurred,false);
});
test('the old PTY exit during observer/writer replacement cannot close the new generation',async()=>{
  let closes=0;
  plane.terminals.services.attach=async(_config,target,_writer,_cols,_rows,_data,exited)=>({pid:1,write:()=>{},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{closes++;exited();},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})});
  const c=await connect(), owner=await grant(c);assert.equal(c.socket.readyState,1);assert.equal(closes,1);
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:owner.generation,action:'release'});
  assert.equal(released.writer,false);assert.equal(c.socket.readyState,1);assert.equal(closes,2);
  await grant({...c,generation:released.generation},true);assert.equal(c.socket.readyState,1);assert.equal(closes,3);
});
test('late observer attachment and old identity-check failure cannot replace or close the writer',async()=>{
  let finishObserver!:()=>void,rejectWatch!:()=>void,attachments=0,oldClosed=0,writes=0,holdWatch=false;
  plane.terminals.services.attach=async(_config,target,writer)=>{
    attachments++;if(!writer&&attachments===1)await new Promise<void>(r=>{finishObserver=r;});
    return {pid:attachments,write:()=>{assert.equal(writer,true);writes++;},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{if(!writer)oldClosed++;},active:async()=>{if(holdWatch)await new Promise<void>((_r,reject)=>{rejectWatch=()=>reject(Error('retired client'));});return {paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'};}};
  };
  const c=await connect(),owner=await grant(c);finishObserver();await settle();assert.equal(oldClosed,1);
  await plane.terminals.input(c.opened.connectionId,{generation:owner.generation,seq:1,encoding:'utf8',data:'x'});assert.equal(writes,1);
  holdWatch=true;for(let n=0;n<150&&!rejectWatch;n++)await settle();assert.ok(rejectWatch,'watcher must have started');
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedGeneration:owner.generation,action:'release'});
  holdWatch=false;rejectWatch();await settle();assert.equal(c.socket.readyState,1);assert.equal(released.writer,false);
});
