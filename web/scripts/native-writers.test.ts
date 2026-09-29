/** Private tmux + real broker/PTYS and Chromium/xterm. The in-process socket bridge
 * isolates transport costs from Next; it is not deployed HTTP/WSS or provider acceptance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import type { WebSocket } from 'ws';
import { Store } from '../src/server/store.ts';
import type { InputAuthority } from '../src/server/input-authority.ts';
import type { TerminalBroker } from '../src/server/terminal-broker.ts';
import { loadConfig } from '../src/server/config.ts';
import { createRunner, inspectPane, TmuxAdapter } from '../src/server/adapters/tmux.ts';
import { attachTmux, inspectAttach, type AttachTarget } from '../src/server/tmux-attach.ts';
import type { TerminalFrame, TerminalTarget } from '../src/contracts/terminals.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
const collect = async () => { await global.gc?.({ type:'major', execution:'async' }); };
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>|boolean) {for(let n=0;n<200;n++){if(await check())return;await delay(10);}assert.fail('Native writer condition timed out');}

test('private native writers: original period, modes, interleaving, costs and 100 clean stop cycles', {timeout:180000}, async t=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'altcli-writers-')));
  const config=loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(dir,'data'),ALTCLI_TMUX_SOCKET:join(dir,'t.sock'),ALTCLI_ENABLE_TERMINAL:'true'});
  const run=createRunner(config.tmuxBin,config.tmuxSocket),store=new Store(config.dataDir);let authority:InputAuthority;
  const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<main></main>');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch(),page=await browser.newPage();
  const browserCdp=await browser.newBrowserCDPSession();
  let broker:TerminalBroker|undefined;
  t.after(async()=>{await broker?.shutdown();await browser.close();await new Promise<void>(r=>server.close(()=>r()));store.close();await run(['kill-server']).catch(()=>{});await rm(dir,{recursive:true,force:true});});
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  await page.addStyleTag({path:new URL('../node_modules/@xterm/xterm/css/xterm.css',import.meta.url).pathname});
  await page.addScriptTag({path:new URL('../node_modules/@xterm/xterm/lib/xterm.js',import.meta.url).pathname});
  await page.evaluate(()=>{(window as any).terms={};});
  await writeFile(join(dir,'reader.cjs'), `const fs=require('node:fs');
fs.writeFileSync(process.argv[2],'');process.stdin.setRawMode(true);process.stdout.write('\\x1b[?1h\\x1b[?2004hFixture\\r\\n');
process.stdin.on('data',data=>fs.appendFileSync(process.argv[2],data));
setInterval(()=>{if(fs.existsSync(process.argv[3]))process.stdout.write(('output fixture '+Date.now()+' ').repeat(40)+'\\r\\n');},20);`);
  for(let n=0;n<2;n++)await run([...(n===0?['-f','/dev/null']:[]),'new-session','-d','-s',`fixture${n}`,'-x','80','-y','24',process.execPath,join(dir,'reader.cjs'),join(dir,`bytes${n}`),join(dir,'output')]);
  await until(async()=>(await inspectPane(run,'%1')).command==='node');
  const targets=await Promise.all(['%0','%1'].map(async id=>inspectAttach(config,(await inspectPane(run,id)).identity)));
  let snapshots=0,nativeChecks=0;
  const plane=new ControlPlane(new Controller(config,store,new TmuxAdapter(run)));broker=plane.terminals;authority=plane.authority;
  broker.services.attach=async(...args)=>{const attachment=await attachTmux(...args),active=attachment.active;attachment.active=async()=>{nativeChecks++;return active();};return attachment;};
  // Fixtures are raw byte readers, not registered coding agents. Only target lookup is
  // injected; admission uses the real all-pane process snapshot and durable holds.
  (plane as unknown as {terminalTarget:(target:TerminalTarget)=>Promise<AttachTarget>}).terminalTarget=async target=>targets[Number('agentId' in target?target.agentId:0)]!;
  const begin=broker.services.begin;broker.services.begin=async(...args)=>{if(!args[3])snapshots++;return begin(...args);};
  class Socket extends EventEmitter {
    readyState=1;bufferedAmount=0;generation='';writer=false;native=false;processed=0;received=0;acknowledged=0;holdAck=false;tail=Promise.resolve();id='';
    send(text:string){const f=JSON.parse(text) as TerminalFrame;
      if(f.type==='reset'){this.generation=f.generation;this.processed=0;this.acknowledged=0;this.native=f.native;}
      if(f.type==='keyboard')this.writer=f.writer;
      const total=f.type==='out'?(this.processed+=f.bytes):0;if(f.type==='out')this.received+=f.bytes;
      this.tail=this.tail.then(async()=>{if(f.type==='reset')await page.evaluate(id=>(window as any).terms[id].reset(),this.id);
        if(f.type==='out'){await page.evaluate(({id,data})=>new Promise<void>(r=>(window as any).terms[id].write(Uint8Array.from(atob(data),c=>c.charCodeAt(0)),r)),{id:this.id,data:f.data});if(!this.holdAck&&this.readyState===1&&this.generation===f.generation){this.acknowledged=total;this.emit('message',Buffer.from(JSON.stringify({type:'processed',generation:f.generation,sequence:f.sequence,processedBytes:total})),false);}}});
    }
    close(){if(this.readyState===1){this.readyState=3;this.emit('close');}}
    terminate(){this.close();}
  }
  const connections:{socket:Socket;seq:number;target:number}[]=[],expectedBytes=[0,0],registrations=[randomUUID(),randomUUID()];
  const heartbeat=setInterval(()=>{for(const c of connections)if(c.socket.readyState===1&&c.socket.generation)c.socket.emit('message',Buffer.from(JSON.stringify({type:'heartbeat',generation:c.socket.generation})),false);},10000);
  t.after(()=>clearInterval(heartbeat));
  const connect=async(n:number)=>{
    const opened=await broker!.open({protocol:2,target:{agentId:String(n%2),registrationId:registrations[n%2]!},clientInstanceId:randomUUID(),cols:80,rows:24}),socket=new Socket();socket.id=opened.connectionId;
    await page.evaluate(id=>{const el=document.createElement('div');el.id=id;document.querySelector('main')!.append(el);const term=new (window as any).Terminal({allowProposedApi:false,cols:80,rows:24,disableStdin:true});term.open(el);(window as any).terms[id]=term;},socket.id);
    broker!.connect(socket as unknown as WebSocket);socket.emit('message',Buffer.from(JSON.stringify({ticket:opened.ticket})),false);await until(()=>!!socket.generation);await socket.tail;
    const c={socket,seq:0,target:n%2};connections.push(c);return c;
  };
  const grant=async(c:typeof connections[number])=>{const start=performance.now();await broker!.keyboard(c.socket.id,{requestId:randomUUID(),expectedBootId:authority.bootId,expectedGeneration:c.socket.generation,action:'acquire'});c.seq=0;await c.socket.tail;return performance.now()-start;};
  const stop=async(cs:typeof connections)=>{const m=authority.pending()[0]!;await broker!.stop({requestId:randomUUID(),expectedBootId:authority.bootId,manualSessionId:m.id,expectedRevision:m.revision,writers:cs.map(c=>{const w=m.writers.find(w=>w.connectionId===c.socket.id)!;return {connectionId:w.connectionId,generation:w.generation,revision:w.revision};})});await Promise.all(cs.map(c=>c.socket.tail));};
  const input=async(c:typeof connections[number],data:string)=>{await broker!.input(c.socket.id,{generation:c.socket.generation,seq:++c.seq,encoding:'utf8',data});expectedBytes[c.target]!+=Buffer.byteLength(data);};
  const clients=async()=>{try{return (await run(['list-clients','-F','#{client_pid}'])).trim().split('\n').filter(Boolean).length;}catch{return 0;}};
  // Captured-only observation preserves the auto-sized worker and still promotes to native input.
  const first=await connect(0);assert.equal(first.socket.native,false);assert.equal(await clients(),0);
  const capturedMs=await grant(first);assert.deepEqual(await page.evaluate(id=>({paste:(window as any).terms[id].modes.bracketedPasteMode,cursor:(window as any).terms[id].modes.applicationCursorKeysMode}),first.socket.id),{paste:true,cursor:true});await until(()=>clients().then(n=>n===1));
  await until(async()=>page.evaluate(id=>(window as any).terms[id].modes.bracketedPasteMode,first.socket.id));
  assert.equal(await page.evaluate(id=>(window as any).terms[id].modes.applicationCursorKeysMode,first.socket.id),true);
  const encoded=await page.evaluate(id=>{const term=(window as any).terms[id],bytes:string[]=[];term.options.disableStdin=false;const sub=term.onData((s:string)=>bytes.push(s));term.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',keyCode:38,bubbles:true}));term.paste('é次🙂\nline2');sub.dispose();return bytes;},first.socket.id);
  assert.deepEqual(encoded,['\x1bOA','\x1b[200~é次🙂\rline2\x1b[201~']);
  await input(first,encoded.join(''));await until(async()=>(await readFile(join(dir,'bytes0'))).toString()===encoded.join(''));
  await stop([first]);assert.equal(await clients(),0);
  // Native observation is allowed only after a fixture-owned manual sizing policy.
  for(const target of targets)await run(['set-option','-w','-t',target.sessionId,'window-size','manual']);
  // Reopen to compare the same number of observer attachments and writers.
  await broker.close(first.socket.id);await first.socket.tail;await page.evaluate(id=>{(window as any).terms[id].dispose();delete (window as any).terms[id];document.getElementById(id)!.remove();},first.socket.id);connections.length=0;
  const nativePids=[targets[0]!.identity.serverPid,...targets.map(t=>t.identity.panePid)];
  const nativeCpu=async()=>{const ids=[...nativePids,(await run(['list-clients','-F','#{client_pid}'])).trim().split('\n')].flat().filter(Boolean);return execFileSync('ps',['-o','time=','-p',ids.join(',')],{encoding:'utf8'}).trim().split('\n').reduce((sum,s)=>sum+s.trim().split(':').reduce((n,v)=>60*n+Number(v),0),0);};
  const sample=async()=>{
    await collect();const received=connections.reduce((n,c)=>n+c.socket.received,0),checks=nativeChecks,nativeBefore=await nativeCpu();const browserBefore=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((n,p)=>n+p.cpuTime,0);
    const before=process.cpuUsage(),time=performance.now();await delay(1200);
    const cpu=process.cpuUsage(before),nativeCpuPct=((await nativeCpu())-nativeBefore)*1000/(performance.now()-time)*100,info=await browserCdp.send('SystemInfo.getProcessInfo');
    const browserRss=info.processInfo.reduce((sum,p)=>sum+Number(execFileSync('ps',['-o','rss=','-p',String(p.id)],{encoding:'utf8'}).trim()||0),0)/1024;
    const browserCpu=(info.processInfo.reduce((n,p)=>n+p.cpuTime,0)-browserBefore)*1000/(performance.now()-time)*100;
    return {nativeCpuPct:+nativeCpuPct.toFixed(2),nativeChecks:nativeChecks-checks,outputBytes:connections.reduce((n,c)=>n+c.socket.received,0)-received,browserIdleCpuPct:+browserCpu.toFixed(2),nodeMiB:+(process.memoryUsage().rss/1048576).toFixed(2),browserMiB:+browserRss.toFixed(2),nodeIdleCpuPct:+((cpu.user+cpu.system)/1000/(performance.now()-time)*100).toFixed(2),clients:await clients()};
  };
  const latency=async(cs:typeof connections,data='x')=>{const values=[];for(let i=0;i<20;i++){const c=cs[i%cs.length]!,before=performance.now();await input(c,data);values.push(performance.now()-before);}values.sort((a,b)=>a-b);return +values[18]!.toFixed(2);};
  const outputSample=async()=>{await writeFile(join(dir,'output'),'');try{return await sample();}finally{await rm(join(dir,'output'));await Promise.all(connections.map(c=>c.socket.tail));}};
  const rows=[];
  for(const n of [1,2,4,8]){
    while(connections.length<n)await connect(connections.length);
    await until(()=>clients().then(c=>c===n));await Promise.all(connections.map(c=>c.socket.tail));const observer=await sample(),observerOutput=await outputSample();
    const firstInput=async(c:typeof connections[number])=>{const start=performance.now();await grant(c);await input(c,'x');return performance.now()-start;};
    const admission=[await firstInput(connections[0]!)],baselineReceiptP95Ms=await latency([connections[0]!]),baselinePasteP95Ms=await latency([connections[0]!],'\x1b[200~'+ 'é'.repeat(256)+'\x1b[201~');
    for(const c of connections.slice(1))admission.push(await firstInput(c));
    const writer=await sample(),steadyReceiptP95Ms=await latency(connections),writerOutput=await outputSample(),pasteP95Ms=await latency(connections,'\x1b[200~'+'é'.repeat(256)+'\x1b[201~');
    for(let i=0;i<2;i++)if(expectedBytes[i])await until(async()=>(await readFile(join(dir,`bytes${i}`))).length===expectedBytes[i]);
    const offsets=await Promise.all([0,1].map(async i=>(await readFile(join(dir,`bytes${i}`)).catch(()=>Buffer.alloc(0))).length));
    await Promise.all(connections.map((c,i)=>input(c,String.fromCharCode(65+i))));
    for(let i=0;i<2;i++)if(connections.length>i)await until(async()=>{const actual=(await readFile(join(dir,`bytes${i}`))).subarray(offsets[i]).toString().split('').sort().join('');return actual===connections.filter((_c,j)=>j%2===i).map((_c,j)=>String.fromCharCode(65+i+2*j)).join('');});
    assert.equal(writer.clients,n);assert.equal(snapshots,1);assert.equal(authority.pending()[0]!.writers.filter(w=>w.live).length,n);
    const attachPids=(await run(['list-clients','-F','#{client_pid}'])).trim().split('\n');
    const attachMiB=attachPids.reduce((sum,pid)=>sum+Number(execFileSync('ps',['-o','rss=','-p',pid],{encoding:'utf8'}).trim()),0)/1024;
    rows.push({connections:n,observer,writer,observerOutput,writerOutput,attachProcesses:n,attachMiB:+attachMiB.toFixed(2),firstInputMs:Math.round(Math.max(...admission)),baselineReceiptP95Ms,steadyReceiptP95Ms,baselinePasteP95Ms,pasteP95Ms});
    await stop(connections);
  }
  const close=async(c:typeof connections[number])=>{await broker!.close(c.socket.id);await c.socket.tail;await page.evaluate(id=>{(window as any).terms[id].dispose();delete (window as any).terms[id];document.getElementById(id)!.remove();},c.socket.id);connections.splice(connections.indexOf(c),1);};
  for(const c of [...connections])await close(c);
  await collect();const beforeCycles=process.memoryUsage(),fdBeforeCycles=(await readdir('/dev/fd')).length,cycleHeapMiB=[],cycleRssMiB=[],cycleDescriptors=[];
  for(let n=0;n<100;n++){
    try { const c=await connect(0);await grant(c);await input(c,'z');await stop([c]);await close(c); }
    catch(error){throw new Error(`Full connection cycle ${n+1} failed`,{cause:error});}
    assert.equal(await clients(),0);
    if(n%25===24){await collect();cycleHeapMiB.push(+(process.memoryUsage().heapUsed/1048576).toFixed(2));cycleRssMiB.push(+(process.memoryUsage().rss/1048576).toFixed(2));cycleDescriptors.push((await readdir('/dev/fd')).length);}
  }
  assert.equal(snapshots,1);assert.equal(authority.pending()[0]!.writers.filter(w=>w.live).length,0);
  assert.equal(await page.evaluate(()=>Object.keys((window as any).terms).length),0);
  assert.ok(cycleDescriptors.every(n=>n<=fdBeforeCycles+4),`Descriptor leak: baseline ${fdBeforeCycles}; samples ${cycleDescriptors.join(',')}`);
  // A slow/disconnected consumer leaves its evidence; the other writer still works.
  const slow=await connect(0),healthy=await connect(1);await grant(slow);await grant(healthy);slow.socket.holdAck=true;
  const slowOutput=await outputSample(),slowBacklog=slow.socket.processed-slow.socket.acknowledged;
  assert.ok(slowBacklog>0&&slowBacklog<=1024*1024);await close(slow);assert.equal(authority.pending()[0]!.recoveryRequired,true);
  await input(healthy,'healthy');await stop([healthy]);await close(healthy);
  await delay(1000);await collect();
  console.log(JSON.stringify({scope:'private ControlPlane/broker/PTY + Chromium xterm; fixture target lookup; no Next or network latency',capturedToWriterMs:Math.round(capturedMs),rows,cycles:100,cycleHeapMiB,cycleRssMiB,fdBeforeCycles,cycleDescriptors,heapBeforeCyclesMiB:+(beforeCycles.heapUsed/1048576).toFixed(2),heapAfterCloseMiB:+(process.memoryUsage().heapUsed/1048576).toFixed(2),cycleNodeRssDeltaMiB:+((process.memoryUsage().rss-beforeCycles.rss)/1048576).toFixed(2),slowOutput,slowBacklog,clientsAfterClose:await clients(),browserTerminalsAfterClose:await page.evaluate(()=>Object.keys((window as any).terms).length)}));
});
