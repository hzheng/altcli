import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchBatch, LaunchInstance } from '../src/contracts/launches.ts';
import { Store } from '../src/server/store.ts';
import { InputAuthority } from '../src/server/input-authority.ts';
import { ProjectCatalog } from '../src/server/projects.ts';
import { LaunchService } from '../src/server/launches.ts';
import { loadConfig } from '../src/server/config.ts';

// Real SQLite; simulated launch execution and explicitly controlled tmux absence evidence.
let directory:string, store:Store, service:LaunchService, original:LaunchBatch;
let absent:boolean|null, listingError:boolean, live:Set<string>, guard:()=>void;
const read=()=>service.batches().find(b=>b.requestId===original.requestId)!;
const input=()=>({projectId:original.items[0]!.projectId,recreateLaunchIds:original.items.map(i=>i.id)});
const confirm=(p:Awaited<ReturnType<LaunchService['preview']>>)=>service.confirm({requestId:p.requestId,previewDigest:p.digest,confirm:true});
const change=(fn:(i:LaunchInstance)=>void)=>{const batch=read();fn(batch.items[0]!);store.db.prepare('UPDATE launches SET value=? WHERE id=?').run(JSON.stringify(batch),batch.requestId);};
beforeEach(async()=>{
  directory=mkdtempSync(join(tmpdir(),'altcli-recovery-'));store=new Store(directory);
  const config=loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:directory,ALTCLI_ADAPTER:'mock',ALTCLI_ENABLE_AGENT_LAUNCH:'true'});
  const catalog=new ProjectCatalog(store,config),authority=new InputAuthority(store);
  const project=await catalog.add({path:'/demo/recovery'}),tree=(await catalog.discover([],[]))[0]!.worktrees[0]!;
  absent=true;listingError=false;live=new Set();guard=()=>{};
  service=new LaunchService(config,store,catalog,authority,()=>guard(),async()=>{if(listingError)throw Error('tmux unreadable');return live;},
    {absent:async()=>absent,sessionPanes:async()=>null,kill:async()=>{throw Error('Recovery must never kill a session');}});
  const profile=(await service.profile({label:'CX',executable:'codex',args:['--no-daemon'],adapterHint:'codex',enabled:true}))!;
  original=await confirm(await service.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:2}]}));
});
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});

test('main recovery is explicit, retires only the missing records, and duplicate confirmations cannot launch twice',async()=>{
  const p=await service.preview(input());assert.deepEqual(p.blockers,[]);assert.equal(p.items[0]!.branch,'main');
  assert.ok(read().items.every(i=>!i.closed));assert.equal(service.batches().length,1);
  const [a,b]=await Promise.all([confirm(p),confirm(p)]);
  assert.equal(a.requestId,b.requestId);assert.equal(service.batches().length,2);
  assert.ok(read().items.every(i=>i.closed&&'recoveryId' in i.closed&&i.closed.recoveryId===a.requestId));
  assert.ok(a.items.every(i=>i.id!==i.recreates!.launchId&&i.status==='running'));
  assert.equal(store.db.prepare('SELECT 1 FROM launch_reservations').get(),undefined);
  await assert.rejects(service.preview(input()),/not verified missing/);
});
for(const evidence of [false,null])test(`present or unknown sessions cannot be recreated (${evidence})`,async()=>{
  absent=evidence;await assert.rejects(service.preview(input()),/not verified missing/);
  assert.equal(service.batches().length,1);assert.ok(read().items.every(i=>!i.closed));
});
test('absence is rechecked at confirmation; no partial retirement when one session changes',async()=>{
  const p=await service.preview(input());absent=null;
  await assert.rejects(confirm(p),/no longer verified missing/);assert.ok(read().items.every(i=>!i.closed));
});
test('read-only missing inspection fails closed when tmux cannot be listed',async()=>{
  service.config.mode='tmux';
  assert.deepEqual(await service.missingSessions(),original.items.map(i=>i.id));
  listingError=true;await assert.rejects(service.missingSessions(),/unreadable/);
  service.config.mode='mock';
  const p=await service.preview(input());assert.ok(p.blockers.length);await assert.rejects(confirm(p));
  assert.ok(read().items.every(i=>!i.closed));
});
test('a live name taken after preview refuses recreation',async()=>{
  const p=await service.preview(input());live.add(p.items[0]!.sessionName);
  await assert.rejects(confirm(p),/name is now in use/);assert.equal(service.batches().length,1);
});
test('a changed historical record, profile or checkout invalidates recreation consent',async()=>{
  const p=await service.preview(input());change(i=>{i.message='Inspected by another client';});
  await assert.rejects(confirm(p),/original launch/);
  const q=await service.preview(input()),profile=original.items[0]!.profile;
  await service.profile({expectedRevision:profile.revision,label:'Updated',executable:'codex',args:['--no-daemon'],adapterHint:'codex',enabled:true},profile.id);
  await assert.rejects(confirm(q),/profile/);
  change(i=>{i.worktree={...i.worktree,indexPath:'/changed/index'};});
  await assert.rejects(service.preview(input()),/checkout changed/);
});
test('unresolved reservations and run ownership are preserved',async()=>{
  guard=()=>{throw Error('A run owns this checkout');};
  assert.match((await service.preview(input())).blockers.join(' '),/run owns/);guard=()=>{};
  const p=await service.preview(input());
  store.db.prepare('INSERT INTO launch_reservations(index_path,launch_id) VALUES(?,?)').run(original.items[0]!.worktree.indexPath,original.requestId);
  await assert.rejects(confirm(p),/launch/i);
  assert.ok(read().items.every(i=>!i.closed));assert.ok(store.db.prepare('SELECT 1 FROM launch_reservations').get());
});
test('different previews cannot recreate the same sessions twice',async()=>{
  const [a,b]=await Promise.all([service.preview(input()),service.preview(input())]);
  const results=await Promise.allSettled([confirm(a),confirm(b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(service.batches().length,2);
});
test('missing profiles and duplicate launch IDs refuse without changing history',async()=>{
  await assert.rejects(service.preview({...input(),recreateLaunchIds:[original.items[0]!.id,original.items[0]!.id]}),/distinct/);
  const profile=original.items[0]!.profile;await service.profile({expectedRevision:profile.revision},profile.id,true);
  await assert.rejects(service.preview(input()),/enabled profile/);assert.equal(service.batches().length,1);
});

for(const siblingOnly of [false,true])test(`an in-flight inspection preserves recreation, siblingOnly=${siblingOnly}`,async()=>{
  let finish!:()=>void;
  Object.defineProperty(service,'verify',{value:()=>new Promise((_resolve,reject)=>{finish=()=>reject(Error('Original session disappeared'));})});
  service.config.mode='tmux';
  const inspecting=service.inspect(original.items[0]!.id);
  service.config.mode='mock';
  const ids=siblingOnly?[original.items[1]!.id]:original.items.map(i=>i.id);
  const replacement=await confirm(await service.preview({...input(),recreateLaunchIds:ids}));
  finish();const observed=await inspecting;
  assert.equal(!!observed.closed,!siblingOnly,'inspection must return the current record');
  assert.ok(read().items.filter(i=>ids.includes(i.id)).every(i=>i.closed&&'recoveryId' in i.closed&&i.closed.recoveryId===replacement.requestId));
});
