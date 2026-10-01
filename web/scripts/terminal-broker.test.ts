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
import { parseStandalone } from '../src/core/implementation-validation.ts';
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
async function connect():Promise<{opened:TerminalConnection;socket:Socket;generation:string}>{
  const s=(await plane.state()).sessions[0]!;const opened=await plane.terminals.open({protocol:2,target:{agentId:s.id,registrationId:s.registrationId},cols:80,rows:24,clientInstanceId:randomUUID()});
  const socket=new Socket();plane.terminals.connect(socket as unknown as WebSocket);socket.frame({ticket:opened.ticket});
  for(let n=0;n<400&&socket.readyState===1&&!socket.frames.some(f=>f.type==='reset');n++)await settle();
  const reset=socket.frames.find(f=>f.type==='reset');assert.ok(reset?.type==='reset');return {opened,socket,generation:reset.generation};
}
const grant=(c:Awaited<ReturnType<typeof connect>>)=>plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:c.generation,action:'acquire'});
async function settledStart() {
  const c=await connect(),owned=await grant(c);
  const requestId=randomUUID();
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,expectedRevision:owned.manualSession!.revision,action:'releaseSettled',confirmReady:true,handoffRequestId:requestId});
  const settled=released.manualSession!;assert.equal(settled.settlement?.requestId,requestId);
  const state=await plane.state(),group=state.groups.find(g=>g.cwd==='/demo/project')!;
  return {c,input:{requestId,groupId:group.id,groupRevision:group.revision,registrations:Object.fromEntries(state.sessions.filter(s=>group.members.includes(s.id)).map(s=>[s.id,s.registrationId])),agentId:'codex',policy:'peer' as const,text:'Checked handoff',confirmReady:true as const,keyboardSettlement:{manualSessionId:settled.id,revision:settled.revision}}};
}
async function externalStart() {
  const s=(await plane.state()).sessions.find(s=>s.id==='codex')!;
  await plane.recordEvent({source:'codex',event:'turn_started',paneId:s.identity.paneId,socketPath:s.identity.socketPath,identity:s.identity,prompt:'External work after settlement.',sessionId:'external',sourceTurnId:randomUUID(),startedAt:new Date().toISOString()});
}
test('settlement evidence rejects new native activity before handoff admission',async()=>{
  const {input}=await settledStart();await externalStart();
  await assert.rejects(plane.submitStandalone(input),/settlement.*changed/i);
  assert.equal(plane.workflow.runs().length,0);
});
test('settlement evidence is checked again after asynchronous admission inspection',async t=>{
  const {input}=await settledStart();let changed=false;
  t.mock.method(plane.adapter,'preflight',async()=>{if(!changed){changed=true;await externalStart();}});
  await assert.rejects(plane.submitStandalone(input),/settlement.*changed/i);
  assert.equal(plane.workflow.runs().length,0);
});
test('settlement evidence belongs to one request and duplicate delivery still returns its receipt',async()=>{
  const {input}=await settledStart();
  await assert.rejects(plane.submitStandalone({...input,requestId:randomUUID()}),/settlement.*changed/i);
  const record=await plane.submitStandalone(parseStandalone(input));assert.equal(record.status,'delivered');
  await externalStart();assert.deepEqual(await plane.submitStandalone(input),record);
});
test('settlement evidence cannot survive another keyboard grant and release',async()=>{
  const {input}=await settledStart(),other=await connect(),owned=await grant(other);
  await plane.terminals.keyboard(other.opened.connectionId,{requestId:randomUUID(),action:'releaseSettled',expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,confirmReady:true});
  assert.equal(plane.authority.blocked,false);
  await assert.rejects(plane.submitStandalone(input),/settlement.*changed/i);
});
test('settlement evidence cannot survive a backend restart',async()=>{
  const {input}=await settledStart();await plane.terminals.shutdown();
  plane=new ControlPlane(new Controller(plane.config,store,new MockAdapter()));
  await assert.rejects(plane.submitStandalone(input),/settlement.*changed/i);
  assert.equal(plane.workflow.runs().length,0);
});
test('settlement evidence is checked at delivery after the run has claimed ownership',async t=>{
  const {input}=await settledStart();const processes=plane.adapter.processes.bind(plane.adapter);let changed=false;
  t.mock.method(plane.adapter,'processes',async(...args:Parameters<typeof processes>)=>{
    if(plane.workflow.runs().length&&!changed){changed=true;await externalStart();}return processes(...args);
  });
  const record=await plane.submitStandalone(input);
  assert.equal(changed,true);assert.equal(record.status,'rejected');assert.match(record.error!,/settlement.*changed/i);
  assert.equal(plane.workflow.runs()[0]!.status,'paused');
});
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
test('an exempt app terminal types without a manual record, server-wide hold or reconciliation',async()=>{
  plane.terminals.services.exempt=()=>true;
  const modes:boolean[]=[];
  plane.terminals.services.attach=async(_config,target,writer,_cols,_rows,_data,_exit,paneInput)=>{
    if(writer)modes.push(paneInput===true);
    return {pid:1,write:()=>{},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})};
  };
  const c=await connect(),owned=await plane.authority.automated(()=>grant(c));
  assert.deepEqual(modes,[true]); // Helper stays usable while unrelated automation is in flight, with input pinned to its pane.
  assert.equal(owned.writer,true);assert.equal(owned.manualSession,null);
  await plane.terminals.input(c.opened.connectionId,{generation:owned.generation,seq:1,encoding:'utf8',data:'1'});
  assert.deepEqual(plane.authority.pending(),[]);assert.equal(plane.authority.blocked,false);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM keyboard_sessions').get() as {n:number}).n,0);
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,action:'release'});
  assert.equal(released.writer,false);assert.equal(released.manualSession,null);assert.deepEqual(plane.authority.pending(),[]);
  await assert.rejects(plane.terminals.input(c.opened.connectionId,{generation:released.generation,seq:1,encoding:'utf8',data:'x'}),/keyboard grant/);
});
test('Helper input remains independent while another terminal holds a manual-input period',async()=>{
  const agent=await connect(),agentGrant=await grant(agent);
  plane.terminals.services.exempt=()=>true;
  const before=plane.authority.pending(),helper=await connect(),helperGrant=await grant(helper);
  await plane.terminals.input(helper.opened.connectionId,{generation:helperGrant.generation,seq:1,encoding:'utf8',data:'Helper question'});
  await plane.terminals.close(helper.opened.connectionId);
  assert.equal(helperGrant.manualSession,null);assert.deepEqual(plane.authority.pending(),before);
  await plane.terminals.input(agent.opened.connectionId,{generation:agentGrant.generation,seq:1,encoding:'utf8',data:'agent input'});
  assert.equal(plane.authority.pending()[0]!.bytes,11);
});
test('closing Helper drains an asynchronous pane write and refuses queued bytes without replay',async()=>{
  plane.terminals.services.exempt=()=>true;
  let entered!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});const writes:string[]=[];
  plane.terminals.services.attach=async(_config,target)=>({pid:1,write:async bytes=>{writes.push(bytes.toString());entered();await gate;},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})});
  const c=await connect(),owned=await grant(c);
  const send=(seq:number,data:string)=>plane.terminals.input(c.opened.connectionId,{generation:owned.generation,seq,encoding:'utf8',data});
  const first=send(1,'first');await started;const queued=send(2,'queued');
  const results=Promise.allSettled([first,queued]);let closed=false;
  const closing=plane.terminals.close(c.opened.connectionId).then(()=>{closed=true;});
  await settle();assert.equal(closed,false);assert.equal(plane.authority.busy,false);resume();await closing;
  assert.deepEqual((await results).map(r=>r.status),['fulfilled','rejected']);assert.deepEqual(writes,['first']);assert.deepEqual(plane.authority.pending(),[]);
});
test('release is durable, blocks new turns before claim, and explicit settled reconciliation never sends',async()=>{
  const c=await connect(), owned=await grant(c);
  const release={requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,action:'release'};
  const result=await plane.terminals.keyboard(c.opened.connectionId,release);assert.equal(result.writer,false);assert.equal(plane.authority.blocked,true);
  assert.deepEqual(await plane.terminals.keyboard(c.opened.connectionId,release),result);
  await assert.rejects(plane.submit({requestId:randomUUID(),agentId:'codex',kind:'relay',confirmReady:true}),/Manual terminal input/);assert.equal(plane.workflow.runs().length,0);
  const m=plane.authority.pending()[0]!;await plane.reconcileManual({requestId:randomUUID(),manualSessionId:m.id,expectedRevision:m.revision,confirmReady:true});assert.equal(plane.authority.blocked,false);assert.equal(plane.workflow.runs().length,0);
  await plane.terminals.close(c.opened.connectionId);assert.equal(plane.authority.blocked,false,'closing settled observer must not revive barrier');
});
test('checked settled release refuses input after confirmation and leaves the keyboard held',async()=>{
  const c=await connect(),owned=await grant(c);
  await plane.terminals.input(c.opened.connectionId,{generation:owned.generation,seq:1,encoding:'utf8',data:'x'});
  await assert.rejects(plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),action:'releaseSettled',expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,expectedRevision:owned.manualSession!.revision,confirmReady:true}),/Manual input changed/);
  assert.equal(plane.authority.pending()[0]!.live,true);
  assert.equal(plane.workflow.runs().length,0);
});
test('checked settled release binds the current writer revision and retains idempotent receipts',async()=>{
  const c=await connect(),owned=await grant(c);
  const input={requestId:randomUUID(),action:'releaseSettled',expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,expectedRevision:owned.manualSession!.revision,confirmReady:true};
  const result=await plane.terminals.keyboard(c.opened.connectionId,input);
  assert.equal(result.writer,false);assert.equal(result.manualSession!.reconciliationRequired,false);
  assert.deepEqual(await plane.terminals.keyboard(c.opened.connectionId,input),result);
  assert.equal(plane.authority.blocked,false);assert.equal(plane.workflow.runs().length,0);
  await assert.rejects(plane.terminals.input(c.opened.connectionId,{generation:owned.generation,seq:1,encoding:'utf8',data:'x'}));
  for(const action of ['acquire','release'])await assert.rejects(plane.terminals.keyboard(c.opened.connectionId,{...input,requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:result.generation,action}),/revision.*settled release/);
  await assert.rejects(plane.terminals.keyboard(c.opened.connectionId,{...input,requestId:randomUUID(),expectedRevision:undefined,handoffRequestId:randomUUID()}),/checked settled release/);
});
test('two writers join one original period without revoking or resetting each other',async()=>{
  const first=await connect(),second=await connect();const owner=await grant(first);
  await plane.terminals.input(first.opened.connectionId,{generation:owner.generation,seq:1,encoding:'utf8',data:'x'});
  const transferred=await grant(second);
  assert.equal(plane.authority.pending().length,1);assert.equal(transferred.manualSession!.bytes,1);
  await plane.terminals.input(first.opened.connectionId,{generation:owner.generation,seq:2,encoding:'utf8',data:'y'});
  await plane.terminals.input(second.opened.connectionId,{generation:transferred.generation,seq:1,encoding:'utf8',data:'z'});
  const period=plane.authority.pending()[0]!;
  assert.equal(period.id,owner.manualSession!.id);assert.deepEqual(period.panes,owner.manualSession!.panes);
  assert.equal(period.bytes,3);assert.equal(period.writers.filter(w=>w.live).length,2);
  assert.equal(period.writers.find(w=>w.connectionId===first.opened.connectionId)!.generation,owner.generation);
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
  const unrelated=plane.authority.save({...m,id:randomUUID(),live:false,writers:m.writers.map(w=>({...w,live:false}))});
  await assert.rejects(plane.reconcileManual({...input,manualSessionId:unrelated.id,expectedRevision:unrelated.revision}),/Release the keyboard/);
  await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,action:'release'});
  const current={...input,expectedRevision:plane.authority.get(m.id).revision};
  for(const note of ['', ' ', 'x'.repeat(1001), 'line\nbreak'])await assert.rejects(plane.reconcileManual({...current,note}),/Invalid|Record/);
  await assert.rejects(plane.reconcileManual({...current,confirmReady:true}),/Confirm one inspection/);
  await assert.rejects(plane.authority.acquire(()=>plane.reconcileManual(current)),/Release the keyboard/);
  assert.equal(plane.authority.get(m.id).reconciliationRequired,true);
});
test('human reconciliation cannot release delivery, setup or launch reservations',async()=>{
  const c=await connect(), owned=await grant(c);
  await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owned.generation,action:'release'});
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
  const request={requestId:randomUUID(),action:'acquire',expectedBootId:plane.authority.bootId,expectedGeneration:c.generation,confirmReady:true};
  const [a,b]=await Promise.all([plane.terminals.keyboard(c.opened.connectionId,request),plane.terminals.keyboard(c.opened.connectionId,request)]);assert.deepEqual(a,b);assert.equal(plane.authority.pending().length,1);
  await assert.rejects(plane.terminals.keyboard(c.opened.connectionId,{...request,confirmReady:false}),/another terminal decision/);
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
  assert.equal(batch.items.length,2);assert.deepEqual(batch.items.map(i=>i.sessionName),['Codex-main','Codex-main-2'],'short names: profile and branch, numbered when taken');assert.deepEqual(await plane.launches.confirm(confirmation),batch);
  assert.equal((await plane.workspaces()).workspaces.find(w=>w.cwd==='/demo/new')?.agents.length,2);
  const next=await plane.launches.preview(input);await plane.launches.profile({label:'Changed',executable:'codex',args:[],adapterHint:'codex',enabled:true,expectedRevision:profile.revision},profile.id);
  await assert.rejects(plane.launches.confirm({requestId:next.requestId,previewDigest:next.digest,confirm:true}),/changed/);assert.equal(plane.launches.batches().length,1);
});
test('short session names stay unique across worktrees: live names are skipped, and a name reserved after the live read refuses the confirm',async()=>{
  const first=await plane.projects.add({path:'/demo/first'}),second=await plane.projects.add({path:'/demo/second'});const trees=await plane.projects.discover([],[]);
  const tree=(id:string)=>trees.find(x=>x.id===id)!.worktrees[0]!;
  const profile=(await plane.launches.profile({label:'Codex',executable:'codex',args:[],adapterHint:'codex',enabled:true}))!;
  const previewOf=(project:string)=>plane.launches.preview({projectId:project,items:[{worktreeId:tree(project).id,profileId:profile.id,count:1}]});
  const a=await previewOf(first.id),b=await previewOf(second.id);assert.equal(a.items[0]!.sessionName,'Codex-main');assert.equal(b.items[0]!.sessionName,'Codex-main');
  // B's live listing is read, then A reserves and starts the same name before B's reservation transaction.
  const launches=plane.launches as unknown as {sessionNames:()=>Promise<Set<string>>};const real=launches.sessionNames;let raced=false;
  launches.sessionNames=async()=>{const stale=await real();if(!raced){raced=true;await plane.launches.confirm({requestId:a.requestId,previewDigest:a.digest,confirm:true});}return stale;};
  try{await assert.rejects(plane.launches.confirm({requestId:b.requestId,previewDigest:b.digest,confirm:true}),/reserved a previewed session name/);}finally{launches.sessionNames=real;}
  assert.deepEqual(plane.launches.batches().flatMap(x=>x.items).map(i=>i.sessionName),['Codex-main']);
  // A later preview sees the live name and numbers past it; a name taken after preview refuses instead of being renamed.
  const c=await previewOf(second.id);assert.equal(c.items[0]!.sessionName,'Codex-main-2');
  const d=await previewOf(first.id);assert.equal(d.items[0]!.sessionName,'Codex-main-2');
  await plane.launches.confirm({requestId:c.requestId,previewDigest:c.digest,confirm:true});
  await assert.rejects(plane.launches.confirm({requestId:d.requestId,previewDigest:d.digest,confirm:true}),/now in use|reserved a previewed/);
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
  await settle();const release=plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owner.generation,action:'release'});await settle();inspect=false;unblock();await rejection;await release;assert.equal(writes,0);assert.equal(plane.authority.pending()[0]!.inputMayHaveOccurred,false);
});
test('the old PTY exit during observer/writer replacement cannot close the new generation',async()=>{
  let closes=0;
  plane.terminals.services.attach=async(_config,target,_writer,_cols,_rows,_data,exited)=>({pid:1,write:()=>{},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{closes++;exited();},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})});
  const c=await connect(), owner=await grant(c);assert.equal(c.socket.readyState,1);assert.equal(closes,1);
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owner.generation,action:'release'});
  assert.equal(released.writer,false);assert.equal(c.socket.readyState,1);assert.equal(closes,2);
  await grant({...c,generation:released.generation});assert.equal(c.socket.readyState,1);assert.equal(closes,3);
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
  const released=await plane.terminals.keyboard(c.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:owner.generation,action:'release'});
  holdWatch=false;rejectWatch();await settle();assert.equal(c.socket.readyState,1);assert.equal(released.writer,false);
});
test('acknowledgments and heartbeats in flight for a replaced generation are ignored; an unknown generation still closes the connection',async()=>{
  const c=await connect();const owned=await grant(c);assert.notEqual(owned.generation,c.generation);
  c.socket.frame({type:'processed',generation:c.generation,sequence:1,processedBytes:10});c.socket.frame({type:'heartbeat',generation:c.generation});await settle();
  assert.equal(c.socket.readyState,1,'a frame for the generation the grant replaced is not a protocol violation');
  await plane.terminals.input(c.opened.connectionId,{generation:owned.generation,seq:1,encoding:'utf8',data:'x'});
  c.socket.frame({type:'heartbeat',generation:randomUUID()});await settle();
  assert.equal(c.socket.readyState,3,'a generation this connection never had still fails closed');
});

test('simultaneous first grants snapshot once and each connection keeps its own generation',async t=>{
  const a=await connect(),b=await connect();
  const boundary=plane as unknown as {manualSnapshot():Promise<import('../src/contracts/terminals.ts').ManualPane[]>};
  const snapshot=boundary.manualSnapshot.bind(plane);let snapshots=0;
  t.mock.method(boundary,'manualSnapshot',async()=>{snapshots++;return snapshot();});
  const [first,second]=await Promise.all([grant(a),grant(b)]);
  assert.equal(snapshots,1);assert.equal(first.manualSession!.id,second.manualSession!.id);
  const period=plane.authority.pending()[0]!;assert.equal(period.writers.length,2);
  assert.deepEqual(period.writers.map(w=>w.generation),[first.generation,second.generation]);
  await plane.terminals.keyboard(a.opened.connectionId,{requestId:randomUUID(),expectedBootId:plane.authority.bootId,expectedGeneration:first.generation,action:'release'});
  assert.equal(plane.authority.pending()[0]!.live,true);
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:1,encoding:'utf8',data:'still writable'});
  assert.throws(()=>plane.authority.assertAutomated(),/Manual terminal input/);
});

test('a join preserves input recorded while its target is inspected',async t=>{
  const a=await connect(),b=await connect(),first=await grant(a);
  const begin=plane.terminals.services.begin.bind(plane.terminals.services);
  let entered!:()=>void,continueJoin!:()=>void;
  const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>continueJoin=r);
  t.mock.method(plane.terminals.services,'begin',async(...args:Parameters<typeof begin>)=>{entered();await gate;return begin(...args);});
  const joining=grant(b);await waiting;
  await plane.terminals.input(a.opened.connectionId,{generation:first.generation,seq:1,encoding:'utf8',data:'during join'});
  const before=plane.authority.pending()[0]!;continueJoin();await joining;
  const after=plane.authority.pending()[0]!;
  assert.equal(after.bytes,before.bytes);assert.equal(after.writers[0]!.bytes,before.writers[0]!.bytes);
  assert.equal(after.writers[0]!.revision,before.writers[0]!.revision);assert.ok(after.revision>before.revision);
});

test('a disconnected writer retains recovery without revoking an unaffected writer; a fresh grant joins the held period',async()=>{
  const a=await connect(),b=await connect(),c=await connect();await grant(a);const second=await grant(b);
  a.socket.close();await settle();
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:1,encoding:'utf8',data:'safe existing connection'});
  assert.equal(plane.authority.pending()[0]!.writers.filter(w=>w.live).length,1);
  const third=await grant(c);assert.equal(third.writer,true);
  assert.equal(plane.authority.pending().length,1);assert.equal(plane.authority.pending()[0]!.recoveryRequired,true);assert.equal(plane.authority.blocked,true);
  assert.equal(plane.authority.pending()[0]!.writers.filter(w=>w.live).length,2);
});

test('batch handoff binds the full exact writer set, refuses stale input and returns one command-bound receipt',async()=>{
  const a=await connect(),b=await connect(),first=await grant(a),second=await grant(b);
  const m=plane.authority.pending()[0]!,command=randomUUID();
  const input={requestId:randomUUID(),expectedBootId:plane.authority.bootId,manualSessionId:m.id,expectedRevision:m.revision,
    writers:m.writers.map(w=>({connectionId:w.connectionId,generation:w.generation,revision:w.revision})),confirmReady:true,handoffRequestId:command};
  await assert.rejects(plane.terminals.stop({...input,writers:input.writers.slice(0,1)}),/other writers/);
  assert.equal(plane.authority.pending()[0]!.writers.filter(w=>w.live).length,2);
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:1,encoding:'utf8',data:'new'});
  await assert.rejects(plane.terminals.stop(input),/writer set or input changed/);
  const fresh=plane.authority.pending()[0]!;
  const current={...input,expectedRevision:fresh.revision,writers:fresh.writers.map(w=>({connectionId:w.connectionId,generation:w.generation,revision:w.revision}))};
  const result=await plane.terminals.stop(current);
  assert.equal(result.live,false);assert.equal(result.reconciliationRequired,false);assert.equal(result.settlement!.requestId,command);
  assert.equal(plane.authority.blocked,false);assert.deepEqual(await plane.terminals.stop(current),result);
  await assert.rejects(plane.terminals.input(a.opened.connectionId,{generation:first.generation,seq:1,encoding:'utf8',data:'revoked'}));
});

test('version 17 migration preserves separate original records and requires recovery with no surviving grants',async()=>{
  const c=await connect(),owned=await grant(c),legacy={...owned.manualSession!};
  await plane.terminals.shutdown();
  const value:Record<string,unknown>={...legacy,live:true,inputMayHaveOccurred:true,bytes:17};delete value.writers;delete value.recoveryRequired;
  store.db.prepare('UPDATE keyboard_sessions SET value=? WHERE id=?').run(JSON.stringify(value),legacy.id);
  const settled={...value,id:randomUUID(),live:false,reconciliationRequired:false,bytes:9};
  store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES (?,?)').run(settled.id,JSON.stringify(settled));
  const older={...value,id:randomUUID(),live:false,bytes:3};
  store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES (?,?)').run(older.id,JSON.stringify(older));
  store.db.pragma('user_version = 17');const config=plane.config;store.close();store=new Store(directory);
  plane=new ControlPlane(new Controller(config,store,new MockAdapter()));
  assert.equal(store.db.pragma('user_version',{simple:true}),19);
  const periods=plane.authority.pending();assert.equal(periods.length,2);
  const archived=plane.authority.get(settled.id);assert.equal(archived.reconciliationRequired,false);assert.equal(archived.recoveryRequired,false);assert.equal(archived.revision,legacy.revision);assert.deepEqual(archived.panes,legacy.panes);
  for(const period of periods){assert.equal(period.live,false);assert.equal(period.recoveryRequired,true);assert.equal(period.writers[0]!.live,false);assert.deepEqual(period.panes,legacy.panes);}
  assert.equal(periods.find(m=>m.id===legacy.id)!.bytes,17);assert.equal(periods.find(m=>m.id===older.id)!.bytes,3);
  await assert.rejects(plane.terminals.open({target:legacy.target,clientInstanceId:randomUUID(),cols:80,rows:24}),/Reload/);
  // New typing joins the newest period after restart; every period keeps its recovery requirement.
  const next=await connect(),joined=await grant(next);
  assert.equal(joined.manualSession!.id,periods.at(-1)!.id);assert.equal(joined.manualSession!.recoveryRequired,true);assert.equal(joined.manualSession!.bootId,plane.authority.bootId);
  await plane.terminals.close(next.opened.connectionId);
  const first=periods[0]!;await plane.reconcileManual({requestId:randomUUID(),manualSessionId:first.id,expectedRevision:first.revision,confirmReady:true});
  assert.equal(plane.authority.blocked,true);
});

test('plain stop accepts intervening bytes while preserving the other writer and original snapshot',async()=>{
  const a=await connect(),b=await connect(),first=await grant(a),second=await grant(b),m=plane.authority.pending()[0]!;
  const w=m.writers.find(w=>w.connectionId===a.opened.connectionId)!;
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:1,encoding:'utf8',data:'peer'});
  const stopped=await plane.terminals.stop({requestId:randomUUID(),expectedBootId:plane.authority.bootId,manualSessionId:m.id,expectedRevision:m.revision,writers:[{connectionId:w.connectionId,generation:w.generation,revision:w.revision}]});
  assert.equal(stopped.bytes,4);assert.deepEqual(stopped.panes,m.panes);assert.equal(stopped.writers.filter(w=>w.live).length,1);
  assert.equal(stopped.reconciliationRequired,true);assert.equal(stopped.recoveryRequired,false);
  await assert.rejects(plane.terminals.input(a.opened.connectionId,{generation:first.generation,seq:1,encoding:'utf8',data:'stopped'}));
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:2,encoding:'utf8',data:'still live'});
});
test('writer-ready waits for the native redraw; failure retains the barrier and closes the attachment',async()=>{
  let ready!:()=>void,fail!:(error:Error)=>void,closed=0,writers=0;
  plane.terminals.services.attach=async(_config,target,writer)=>({pid:1,ready:writer?new Promise<void>((resolve,reject)=>{writers++;ready=resolve;fail=reject;}):undefined,
    write:()=>{},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{closed++;},active:async()=>({paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'})});
  const a=await connect(),pending=grant(a);
  for(let n=0;writers<1&&n<400;n++)await settle();assert.equal(writers,1);
  assert.equal(a.socket.frames.some(f=>f.type==='keyboard'&&f.writer),false);
  const reset=a.socket.frames.filter(f=>f.type==='reset').at(-1)!;assert.equal(reset.type,'reset');
  await assert.rejects(plane.terminals.input(a.opened.connectionId,{generation:reset.generation,seq:1,encoding:'utf8',data:'too soon'}),/no available keyboard/);
  ready();await pending;
  // Fail b's own redraw: wait until its writer attachment exists rather than a fixed delay, which a loaded host can outlast.
  const b=await connect(),failed=grant(b),rejected=assert.rejects(failed,/redraw failed/);
  for(let n=0;writers<2&&n<400;n++)await settle();assert.equal(writers,2);fail(Error('redraw failed'));await rejected;
  assert.equal(b.socket.readyState,3);assert.equal(plane.authority.pending()[0]!.recoveryRequired,true);assert.ok(closed>=2);
  assert.equal(plane.authority.pending()[0]!.writers.filter(w=>w.live).length,1);
});

test('a stalled writer queue neither blocks another writer nor lets checked stop overtake pending input',async()=>{
  let writers=0,pause=false,unblock!:()=>void;
  plane.terminals.services.attach=async(_config,target,writer)=>{const first=writer&&++writers===1;return {pid:1,write:()=>{},resize:()=>{},pause:()=>{},resume:()=>{},close:async()=>{},active:async()=>{if(first&&pause)await new Promise<void>(r=>unblock=r);return {paneId:target.identity.paneId,sessionId:target.sessionId,label:target.label,command:'fixture'};}};};
  const a=await connect(),b=await connect(),first=await grant(a),second=await grant(b);pause=true;
  const pending=plane.terminals.input(a.opened.connectionId,{generation:first.generation,seq:1,encoding:'utf8',data:'a'}),rejected=assert.rejects(pending,/ended before writing/);await settle();
  await plane.terminals.input(b.opened.connectionId,{generation:second.generation,seq:1,encoding:'utf8',data:'b'});
  const m=plane.authority.pending()[0]!,w=m.writers.find(w=>w.connectionId===a.opened.connectionId)!;
  const input={requestId:randomUUID(),expectedBootId:plane.authority.bootId,manualSessionId:m.id,expectedRevision:m.revision,writers:[{connectionId:w.connectionId,generation:w.generation,revision:w.revision}]};
  await assert.rejects(plane.terminals.stop({...input,confirmReady:true}),/input is still pending/);
  const stopping=plane.terminals.stop(input);await settle();pause=false;unblock();await rejected;await stopping;
  assert.equal(plane.authority.pending()[0]!.bytes,1);assert.equal(plane.authority.pending()[0]!.writers.filter(w=>w.live).length,1);
});

test('a partial batch stop failure retains recovery; a new writer joins it while automation stays held',async()=>{
  const a=await connect(),b=await connect();await grant(a);await grant(b);
  plane.terminals.services.attach=async()=>{throw Error('replacement failed');};
  const m=plane.authority.pending()[0]!;
  await assert.rejects(plane.terminals.stop({requestId:randomUUID(),expectedBootId:plane.authority.bootId,manualSessionId:m.id,expectedRevision:m.revision,
    writers:m.writers.map(w=>({connectionId:w.connectionId,generation:w.generation,revision:w.revision}))}),/replacement failed/);
  assert.equal(plane.authority.pending()[0]!.live,false);assert.equal(plane.authority.pending()[0]!.recoveryRequired,true);assert.equal(plane.authority.blocked,true);
  delete plane.terminals.services.attach;const next=await connect(),joined=await grant(next);
  assert.equal(joined.writer,true);assert.equal(joined.manualSession!.id,m.id);assert.equal(joined.manualSession!.recoveryRequired,true);assert.equal(plane.authority.blocked,true);
});
