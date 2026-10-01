import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.ts';
import { InputAuthority } from '../src/server/input-authority.ts';
import { ProjectCatalog } from '../src/server/projects.ts';
import { LaunchService, launchEnvironment, childEnvironmentArgs } from '../src/server/launches.ts';
import { loadConfig, resolveExecutable } from '../src/server/config.ts';
import { createRunner, listPanes } from '../src/server/adapters/tmux.ts';
import { sessionNamesOf } from '../src/core/session-names.ts';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
for(const existing of [false,true])test(`private tmux service launch: ${existing?'existing contaminated':'fresh absent'} server, argv, environment, instant exit and durable reservation`,async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'altcli-launch-'))),root=join(directory,'repo');await mkdir(root);
  const git=(...args:string[])=>execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-b','main');await writeFile(join(root,'base'),'fixture');git('add','base');git('commit','-m','fixture');
  const tmux=resolveExecutable('tmux')!, wrapper=join(directory,'tmux-audit.mjs'), argvLog=join(directory,'launch-argv.jsonl');
  await writeFile(wrapper,`#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{spawnSync}from'node:child_process';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(argvLog)},JSON.stringify(args)+'\\n',{mode:0o600});const r=spawnSync(${JSON.stringify(tmux)},args,{encoding:'utf8'});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);\n`);await chmod(wrapper,0o700);
  const credentials={OPENAI_API_KEY:'dummy-openai-credential',ANTHROPIC_API_KEY:'dummy-anthropic-credential',CLAUDE_CODE_OAUTH_TOKEN:'dummy-oauth-credential',HTTPS_PROXY:'http://dummy-user:dummy-proxy-password@example.invalid',HTTP_PROXY:'http://dummy-user:dummy-proxy-password@example.invalid',ALL_PROXY:'http://dummy-user:dummy-proxy-password@example.invalid'};
  const original=Object.fromEntries(Object.keys(credentials).map(k=>[k,process.env[k]]));Object.assign(process.env,credentials);
  const config={...loadConfig({ALTCLI_TMUX_BIN:wrapper,ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(directory,'metadata'),ALTCLI_TMUX_SOCKET:join(directory,'t.sock'),ALTCLI_ENABLE_AGENT_LAUNCH:'true'}),worktreeDir:join(directory,'tasks')};
  const run=createRunner('tmux',config.tmuxSocket),store=new Store(config.dataDir),authority=new InputAuthority(store),catalog=new ProjectCatalog(store,config);
  try{
    if(existing){await run(['-f','/dev/null','new-session','-d','-s','fixture','-c',directory,'/bin/sleep','300']);
      for(const [key,value] of Object.entries({ALTCLI_TOKEN:'fixture-secret',NEXT_FAKE_SECRET:'fixture-secret',UNRELATED_SERVICE_SECRET:'fixture-secret',GIT_INDEX_FILE:'/dummy/custom-index',PATH:'/stale/path',TMUX:'stale',TMUX_PANE:'%999',...credentials}))await run(['set-environment','-g',key,value]);
    }else assert.deepEqual(await listPanes(run),[]);
    const project=await catalog.add({path:root});const tree=(await catalog.discover([],[]))[0]!.worktrees[0]!;
    const launches=new LaunchService(config,store,catalog,authority,()=>{},async()=>sessionNamesOf(await listPanes(run)));
    const file=join(directory,'fixture.mjs'),result=join(directory,'result.json');
    await writeFile(file,"import{writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),keys:Object.keys(process.env),tmux:process.env.TMUX,pane:process.env.TMUX_PANE,git:spawnSync('git',['--version']).status}));\n");
    const args=['','space value','é次','quote\"','$(no-shell)',';',String.raw`\;`,'--flag=value'];
    const profile=(await launches.profile({label:'Literal fixture',executable:process.execPath,args:[file,result,...args],adapterHint:'manual',enabled:true}))!;
    const preview=await launches.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:1}]});
    const input={requestId:preview.requestId,previewDigest:preview.digest,confirm:true};const batch=await launches.confirm(input);const item=batch.items[0]!;
    assert.equal(item.sessionName,'Literal-fixture-main','the default name is profile and branch, without a random suffix');
    for(let n=0;n<100;n++){try{await readFile(result);break;}catch{}await wait(20);}
    const output=JSON.parse(await readFile(result,'utf8'));
    assert.deepEqual(output.args,args);assert.equal(output.cwd,root);assert.ok(output.tmux && output.tmux!=='stale');assert.equal(output.pane,item.placeholder?.paneId);assert.equal(output.git,0);
    for(const key of ['ALTCLI_TOKEN','NEXT_FAKE_SECRET','UNRELATED_SERVICE_SECRET','GIT_INDEX_FILE','NODE_OPTIONS','npm_lifecycle_script',...Object.keys(credentials)])assert.ok(!output.keys.includes(key),`child leaked ${key}`);
    const retained=await run(['display-message','-p','-t',item.placeholder!.paneId,'#{pane_start_command}']);
    const clients=await readFile(argvLog,'utf8');
    for(const value of [...Object.values(credentials),'dummy-proxy-password']){assert.equal(retained.includes(value),false,'pane_start_command retained a dummy credential');assert.equal(clients.includes(value),false,'launch tmux client argv contained a dummy credential');}
    assert.ok(item.identity,item.message);assert.equal((await launches.inspect(item.id)).status,'exited');
    assert.equal((await run(['show-options','-v','-t',item.sessionId!,'mouse'])).trim(),'on');
    assert.ok(store.db.prepare('SELECT 1 FROM launch_reservations').get());assert.throws(()=>catalog.assertWorktreeReady(root),/launch/);
    const before=(await run(['list-sessions','-F','#{session_id}']));await launches.confirm(input);assert.equal(await run(['list-sessions','-F','#{session_id}']),before);
    await launches.reconcile(item.id,{requestId:randomUUID(),confirmInspected:true,note:'Fixture exited; inspected private server and child process result.'});assert.equal(store.db.prepare('SELECT 1 FROM launch_reservations').get(),undefined);
    assert.equal((await launches.previewCleanup(item.id)).state,'dead');
    // Revive it after a dead preview. The final tmux-side condition must refuse to kill the now-live pane.
    await run(['respawn-pane','-k','-t',item.identity!.paneId,'/bin/sleep','300']);
    await launches.cleanupHost.kill(item);
    assert.equal((await run(['display-message','-p','-t',item.identity!.paneId,'#{pane_dead}'])).trim(),'0');
    // A confirmed live close binds the recorded pane process; the respawned replacement must survive it.
    await launches.cleanupHost.kill({...item,cleanup:{requestId:randomUUID(),digest:'fixture',status:'applying',acknowledgedAt:new Date().toISOString(),confirmStop:true}});
    assert.equal((await run(['display-message','-p','-t',item.identity!.paneId,'#{pane_dead}'])).trim(),'0');
    await run(['respawn-pane','-k','-t',item.identity!.paneId,'/usr/bin/true']);
    for(let n=0;n<100;n++){if((await run(['display-message','-p','-t',item.identity!.paneId,'#{pane_dead}'])).trim()==='1')break;await wait(20);}
    const cleanup=await launches.previewCleanup(item.id);
    const cleaned=await launches.confirmCleanup(item.id,{requestId:cleanup.requestId,digest:cleanup.digest,confirmInspected:true});
    assert.ok(cleaned.closed,cleaned.message);await assert.rejects(launches.target(item.id),/closed/);
    const next=await launches.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:1}]});
    const missing=(await launches.confirm({requestId:next.requestId,previewDigest:next.digest,confirm:true})).items[0]!;
    await run(['kill-session','-t',missing.sessionId!]);await run(['new-session','-d','-s',missing.sessionName,'/bin/sleep','300']);
    const forget=await launches.previewCleanup(missing.id);assert.equal(forget.state,'missing');
    assert.ok((await launches.confirmCleanup(missing.id,{requestId:forget.requestId,digest:forget.digest,confirmInspected:true})).closed);
    assert.ok((await run(['list-sessions','-F','#{session_name}'])).includes(missing.sessionName),'the reused name belongs to another live session');
    // A running original process is closed only with explicit stop consent, once, by its recorded identity.
    const sleeper=(await launches.profile({label:'Live fixture',executable:'/bin/sleep',args:['300'],adapterHint:'manual',enabled:true}))!;
    const third=await launches.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:sleeper.id,count:1}]});
    const live=(await launches.confirm({requestId:third.requestId,previewDigest:third.digest,confirm:true})).items[0]!;
    const close=await launches.previewCleanup(live.id);assert.equal(close.state,'live',close.blockers.join(' '));
    const consent={requestId:close.requestId,digest:close.digest,confirmInspected:true};
    await assert.rejects(launches.confirmCleanup(live.id,consent),/Confirm stopping/);
    assert.ok((await run(['list-sessions','-F','#{session_id}'])).split('\n').includes(live.sessionId!),'refused consent leaves the agent running');
    const closed=await launches.confirmCleanup(live.id,{...consent,confirmStop:true});
    assert.ok(closed.closed,closed.message);assert.equal(closed.cleanup?.confirmStop,true);
    assert.equal((await run(['list-sessions','-F','#{session_id}'])).split('\n').includes(live.sessionId!),false);
    assert.ok((await run(['list-sessions','-F','#{session_name}'])).includes(missing.sessionName),'closing never targets another session');
  }finally{for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await run(['kill-server']).catch(()=>{});store.close();await rm(directory,{recursive:true,force:true});}
});
test('child environment policy retains explicit nonsecret hook references and rejects process injection names',()=>{
  const env=launchEnvironment({PATH:'/usr/bin:/bin',ALTCLI_ENV:'/tmp/fixture.env',ALTCLI_URL:'http://127.0.0.1:8787',ALTCLI_TOKEN:'dummy',NODE_OPTIONS:'--require=bad',GIT_DIR:'/bad',UNRELATED_SECRET:'dummy'});
  assert.equal(env.ALTCLI_ENV,'/tmp/fixture.env');assert.equal(env.ALTCLI_URL,'http://127.0.0.1:8787');assert.equal(env.ALTCLI_TOKEN,undefined);assert.equal(env.NODE_OPTIONS,undefined);
  assert.ok(childEnvironmentArgs('UNRELATED_SECRET=dummy\nTMUX=stale\n','PATH=old\n',env).includes('UNRELATED_SECRET'));
  assert.throws(()=>launchEnvironment({ALTCLI_URL:'https://example.invalid'}),/loopback/);
});
test('private tmux: an exited launcher with a surviving detached child retains its reservation',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'altcli-launch-child-'))),root=join(directory,'repo');await mkdir(root);
  const git=(...args:string[])=>execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{stdio:'ignore'});
  git('init','-b','main');await writeFile(join(root,'base'),'fixture');git('add','base');git('commit','-m','fixture');
  const config=loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(directory,'data'),ALTCLI_TMUX_SOCKET:join(directory,'t.sock'),ALTCLI_ENABLE_AGENT_LAUNCH:'true'});
  const store=new Store(config.dataDir),catalog=new ProjectCatalog(store,config),launches=new LaunchService(config,store,catalog,new InputAuthority(store),()=>{},async()=>sessionNamesOf(await listPanes(run))),run=createRunner('tmux',config.tmuxSocket);
  let childPid:number|undefined;
  try{
    const program=join(directory,'background.mjs'),result=join(directory,'child-pid');
    await writeFile(program,"import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{detached:true,stdio:'ignore'});writeFileSync(process.argv[2],String(child.pid));child.unref();\n");
    const project=await catalog.add({path:root}),tree=(await catalog.discover([],[]))[0]!.worktrees[0]!;
    const profile=(await launches.profile({label:'Background fixture',executable:process.execPath,args:[program,result],adapterHint:'manual',enabled:true}))!;
    const preview=await launches.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:1}]});
    const batch=await launches.confirm({requestId:preview.requestId,previewDigest:preview.digest,confirm:true});
    for(let n=0;n<100;n++){const value=await readFile(result,'utf8').catch(()=>'');if(value){childPid=Number(value);break;}await wait(20);}
    assert.ok(childPid);process.kill(childPid,0);
    for(let n=0;n<100;n++){if((await launches.inspect(batch.items[0]!.id)).status==='exited')break;await wait(20);}
    assert.equal((await launches.inspect(batch.items[0]!.id)).status,'exited');
    assert.ok(store.db.prepare('SELECT 1 FROM launch_reservations').get(),'exit cannot certify absence of background effects');
    process.kill(childPid,0);assert.throws(()=>catalog.assertWorktreeReady(root),/launch/);
  }finally{if(childPid)try{process.kill(childPid,'SIGKILL');}catch{}await run(['kill-server']).catch(()=>{});store.close();await rm(directory,{recursive:true,force:true});}
});
test('private tmux: failures at every startup boundary retain ownership and never repeat execution',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'altcli-launch-fault-'))),root=join(directory,'repo');await mkdir(root);
  const git=(...args:string[])=>execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-b','main');await writeFile(join(root,'base'),'fixture');git('add','base');git('commit','-m','fixture');
  const {resolveExecutable}=await import('../src/server/config.ts');const {chmod}=await import('node:fs/promises');
  const tmux=resolveExecutable('tmux')!,fault=join(directory,'fault.json'),wrapper=join(directory,'tmux-fixture.mjs'),program=join(directory,'effect.mjs'),effect=join(directory,'effects');
  await writeFile(program,"import{appendFileSync}from'node:fs';appendFileSync(process.argv[2],'executed\\n');\n");
  await writeFile(wrapper,`#!${process.execPath}\nimport{readFileSync}from'node:fs';import{spawnSync}from'node:child_process';const f=JSON.parse(readFileSync(${JSON.stringify(fault)},'utf8'));const args=process.argv.slice(2);const hit=args.includes(f.step);if(hit&&!f.after)process.exit(1);const r=spawnSync(${JSON.stringify(tmux)},args,{encoding:'utf8'});if(hit&&f.after)process.exit(1);process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);\n`);await chmod(wrapper,0o700);
  const config={...loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(directory,'metadata'),ALTCLI_TMUX_SOCKET:join(directory,'t.sock'),ALTCLI_ENABLE_AGENT_LAUNCH:'true',ALTCLI_TMUX_BIN:wrapper}),worktreeDir:join(directory,'tasks')};
  const run=createRunner(tmux,config.tmuxSocket),store=new Store(config.dataDir),authority=new InputAuthority(store),catalog=new ProjectCatalog(store,config);
  try{
    const project=await catalog.add({path:root}),tree=(await catalog.discover([],[]))[0]!.worktrees[0]!;
    const names=async()=>sessionNamesOf(await listPanes(run));
    let launches=new LaunchService(config,store,catalog,authority,()=>{},names);
    const profile=(await launches.profile({label:'Fault fixture',executable:process.execPath,args:[program,effect],adapterHint:'manual',enabled:true}))!;
    for(const [step,after] of [['new-session',true],['destroy-unattached',true],['update-environment',true],['mouse',true],['remain-on-exit',true],['@altcli_launch',true],['respawn-pane',false],['respawn-pane',true]] as const){
      await writeFile(fault,JSON.stringify({step,after}));
      const preview=await launches.preview({projectId:project.id,items:[{worktreeId:tree.id,profileId:profile.id,count:1}]});
      const confirm={requestId:preview.requestId,previewDigest:preview.digest,confirm:true},batch=await launches.confirm(confirm),item=batch.items[0]!;
      assert.equal(item.status,'uncertain',`${step}: ${item.message}`);assert.ok(store.db.prepare('SELECT 1 FROM launch_reservations').get());
      await launches.confirm(confirm);launches=new LaunchService(config,store,catalog,authority,()=>{},names);await launches.confirm(confirm);
      assert.equal((await launches.inspect(item.id)).status,'uncertain','missing post-execution identity must not be adopted');
      const phases:Record<string,string>={'new-session':'creating','destroy-unattached':'created','update-environment':'created','mouse':'created','remain-on-exit':'created','@altcli_launch':'configured','respawn-pane':'executing'};
      assert.equal(item.phase,phases[step],`${step}: ${item.message}`);
      if(step==='respawn-pane'&&after)for(let n=0;n<100;n++){if(await readFile(effect,'utf8').catch(()=>''))break;await wait(20);}
      const effects=await readFile(effect,'utf8').catch(()=>'');assert.equal(effects,step==='respawn-pane'&&after?'executed\n':'');
      await launches.reconcile(item.id,{requestId:randomUUID(),confirmInspected:true,note:'Private fixture inspected at injected fault; no retry.'});
    }
    assert.equal((await run(['list-sessions','-F','#{session_id}'])).trim().split('\n').length,8,'one retained session per confirmation, including the lost creation response');
    // Each retained session keeps its name, so later launches of the same profile and branch take the next free number.
    assert.deepEqual((await run(['list-sessions','-F','#{session_name}'])).trim().split('\n').sort(),['Fault-fixture-main',...[2,3,4,5,6,7,8].map(n=>`Fault-fixture-main-${n}`)].sort());
  }finally{await run(['kill-server']).catch(()=>{});store.close();await rm(directory,{recursive:true,force:true});}
});
test('private tmux: Finish branch closes only the proven launched session by ID and reports a detached survivor', async () => {
  const { FinishCoordinator, tmuxFinishHost } = await import('../src/server/finish.ts');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-finish-'))), root = join(directory, 'repo'), task = join(directory, 'task'); await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); await writeFile(join(root, 'base'), 'fixture'); git('add', 'base'); git('commit', '-m', 'fixture'); git('worktree', 'add', '-b', 'feature/finished', task);
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(directory, 'data'), ALTCLI_TMUX_SOCKET: join(directory, 't.sock'), ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  const run = createRunner('tmux', config.tmuxSocket), store = new Store(config.dataDir), authority = new InputAuthority(store), catalog = new ProjectCatalog(store, config);
  const launches = new LaunchService(config, store, catalog, authority, () => {}, async () => sessionNamesOf(await listPanes(run)));
  let childPid: number | undefined; const children = new Set<number>();
  try {
    // A user's own session in the worktree, which Finish branch must never close.
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'mine', '-c', task, '/bin/sleep', '300']);
    const program = join(directory, 'worker.mjs'), pidFile = join(directory, 'child-pid');
    await writeFile(program, "import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{detached:true,stdio:'ignore'});writeFileSync(process.argv[2]+'-'+process.env.TMUX_PANE,String(child.pid));child.unref();setTimeout(()=>{},300000);\n");
    const project = await catalog.add({ path: root }), tree = (await catalog.discover([], []))[0]!.worktrees.find((w) => w.path === task)!;
    const profile = (await launches.profile({ label: 'Worker', executable: process.execPath, args: [program, pidFile], adapterHint: 'manual', enabled: true }))!;
    const preview = await launches.preview({ projectId: project.id, items: [{ worktreeId: tree.id, profileId: profile.id, count: 2 }] });
    const batch = await launches.confirm({ requestId: preview.requestId, previewDigest: preview.digest, confirm: true });
    const [first, second] = batch.items as [typeof batch.items[0], typeof batch.items[0]];
    assert.deepEqual([first.sessionName, second.sessionName], ['Worker-feature-finished', 'Worker-feature-finished-2']);
    // Each instance owns its child's evidence; the second launch must not overwrite the first one's PID.
    for (const item of batch.items) {
      let pid: number | undefined;
      for (let n = 0; n < 100; n++) { const value = await readFile(`${pidFile}-${item.identity!.paneId}`, 'utf8').catch(() => ''); if (value) { pid = Number(value); break; } await wait(20); }
      assert.ok(pid); children.add(pid); if (item.id === first.id) childPid = pid;
    }
    assert.ok(childPid);
    // A non-CLI program keeps its launch reservation until inspected; an unresolved launch refuses Finish branch.
    for (const item of batch.items) await launches.reconcile(item.id, { requestId: randomUUID(), confirmInspected: true, note: 'Fixture worker inspected on the private server.' });
    // A split inside the worktree stays in scope; a window linked into the user's session takes the second launch out of scope.
    await run(['split-window', '-d', '-t', first.sessionId!, '-c', task, '/bin/sleep', '300']);
    await run(['link-window', '-d', '-s', `${second.windowId}`, '-t', 'mine:']);
    const finish = new FinishCoordinator({ config, store, projects: catalog, launches, authority, host: tmuxFinishHost(config, () => listPanes(run)),
      owner: () => null, delivery: () => false, agents: async () => [], closeTerminals: async () => {},
      remove: (input, parent) => catalog.remove(input, async () => {}, async () => 0, parent), discard: (input, parent) => catalog.discard(input, async () => {}, async () => 0, parent),
      reconcileChild: (kind, id) => kind === 'removal' ? catalog.reconcileRemoval(id) : catalog.reconcileDiscard(id) });
    const shown = await finish.preview({ projectId: project.id, worktreeId: tree.id });
    const scoped = shown.sessions.find((s) => s.sessionId === first.sessionId)!, linked = shown.sessions.find((s) => s.sessionId === second.sessionId)!;
    assert.equal(scoped.closable, true, scoped.reason ?? ''); assert.equal(scoped.panes.length, 2);
    assert.ok(scoped.panes.some((p) => p.processes.some((q) => q.pid === String(childPid))), 'the detached child is retained evidence while it is a descendant');
    assert.equal(linked.closable, false); assert.match(linked.reason!, /shared with another session/);
    assert.ok(shown.others.some((o) => o.location.startsWith('mine:')), 'the user session is occupancy, never a target');
    assert.equal(shown.active, true);
    const done = await finish.confirm({ requestId: shown.requestId, digest: shown.digest, outcome: 'close', stopActive: true, confirm: true });
    const sessions = (await run(['list-sessions', '-F', '#{session_id}'])).trim().split('\n');
    assert.ok(!sessions.includes(first.sessionId!), 'the proven session is gone'); assert.ok(sessions.includes(second.sessionId!), 'the out-of-scope launch is untouched');
    assert.ok((await run(['list-sessions', '-F', '#{session_name}'])).includes('mine'));
    assert.equal(done.status, 'attention', done.message); assert.deepEqual(done.sessions[0]!.survivors.map((p) => p.pid), [String(childPid)]);
    assert.ok(launches.batches().flatMap((b) => b.items).find((i) => i.id === first.id)!.closed);
    process.kill(childPid!, 'SIGKILL'); children.delete(childPid!); childPid = undefined; await wait(100);
    const cleared = await finish.reconcile({ requestId: done.requestId, revision: done.revision, action: 'inspect' });
    assert.equal(cleared.status, 'done', cleared.message);
  } finally { for (const pid of children) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } await run(['kill-server']).catch(() => {}); store.close(); await rm(directory, { recursive: true, force: true }); }
});
test('private tmux: a confirmed branch rename also renames the worktree\'s app-launched session whatever its name, never the user\'s own', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-rename-'))), root = join(directory, 'repo'), task = join(directory, 'ui1'); await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); await writeFile(join(root, 'base'), 'fixture'); git('add', 'base'); git('commit', '-m', 'fixture'); git('worktree', 'add', '-b', 'feature/ui1', task);
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(directory, 'data'), ALTCLI_TMUX_SOCKET: join(directory, 't.sock'), ALTCLI_ENABLE_AGENT_LAUNCH: 'true' });
  const run = createRunner('tmux', config.tmuxSocket), store = new Store(config.dataDir), authority = new InputAuthority(store), catalog = new ProjectCatalog(store, config);
  const launches = new LaunchService(config, store, catalog, authority, () => {}, async () => sessionNamesOf(await listPanes(run)));
  const planner = (id: string, next: string) => launches.plannedRenames(id, next);
  const follow = async (input: { worktreeId: string }, renames: { from: string; to: string }[]) => { const outcome = await launches.renameSessions(input.worktreeId, renames); return ` ${outcome.renamed.map((r) => r.to).join(',')}|${outcome.failed.join(';')}`; };
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'mine-feature-ui1', '-c', task, '/bin/sleep', '300']);
    const project = await catalog.add({ path: root }), tree = (await catalog.discover([], []))[0]!.worktrees.find((w) => w.path === task)!;
    const profile = (await launches.profile({ label: 'CC', executable: process.execPath, args: ['-e', 'setTimeout(()=>{},300000)'], adapterHint: 'manual', enabled: true }))!;
    const preview = await launches.preview({ projectId: project.id, items: [{ worktreeId: tree.id, profileId: profile.id, count: 1 }] });
    const item = (await launches.confirm({ requestId: preview.requestId, previewDigest: preview.digest, confirm: true })).items[0]!;
    assert.equal(item.sessionName, 'CC-feature-ui1');
    await launches.reconcile(item.id, { requestId: randomUUID(), confirmInspected: true, note: 'Fixture program inspected on the private server.' });
    const rename = await catalog.previewRename({ projectId: project.id, worktreeId: tree.id, newBranch: 'feature/ui2' }, planner);
    assert.deepEqual(rename.commands, [`git -C ${task} branch -m feature/ui1 feature/ui2`, 'tmux rename-session -t CC-feature-ui1 CC-feature-ui2']);
    const result = await catalog.rename({ ...rename, confirm: true }, async () => {}, planner, follow);
    assert.equal(result.status, 'renamed', result.message); assert.match(result.message, / CC-feature-ui2\|$/);
    assert.deepEqual((await run(['list-sessions', '-F', '#{session_name}'])).trim().split('\n').sort(), ['CC-feature-ui2', 'mine-feature-ui1']);
    assert.equal(launches.batches()[0]!.items[0]!.sessionName, 'CC-feature-ui2');
    // A branch renamed without its session leaves an older branch's name; the next confirmed rename still takes the session along.
    git('branch', '-m', 'feature/ui2', 'feature/ui3');
    const again = await catalog.previewRename({ projectId: project.id, worktreeId: tree.id, newBranch: 'feature/ui4' }, planner);
    assert.deepEqual(again.commands, [`git -C ${task} branch -m feature/ui3 feature/ui4`, 'tmux rename-session -t CC-feature-ui2 CC-feature-ui4']);
    const next = await catalog.rename({ ...again, confirm: true }, async () => {}, planner, follow);
    assert.equal(next.status, 'renamed', next.message); assert.match(next.message, / CC-feature-ui4\|$/);
    assert.deepEqual((await run(['list-sessions', '-F', '#{session_name}'])).trim().split('\n').sort(), ['CC-feature-ui4', 'mine-feature-ui1']);
    // A session already named for the new branch keeps its name instead of taking a numbered one.
    assert.deepEqual(await planner(tree.id, 'feature/ui4'), []);
    // Numeric branch endings are not duplicate-session numbers unless the launcher can allocate that suffix.
    for (const suffix of ['1', '01', '100', '2', '99']) {
      const numbered = await catalog.previewRename({ projectId: project.id, worktreeId: tree.id, newBranch: `feature/ui-${suffix}` }, planner);
      const renamed = await catalog.rename({ ...numbered, confirm: true }, async () => {}, planner, follow);
      assert.equal(renamed.status, 'renamed', renamed.message);
      assert.equal(launches.batches()[0]!.items[0]!.sessionName, `CC-feature-ui-${suffix}`);
      assert.deepEqual(await planner(tree.id, 'feature/ui'), ['2', '99'].includes(suffix) ? [] : [{ from: `CC-feature-ui-${suffix}`, to: 'CC-feature-ui' }]);
    }
  } finally { await run(['kill-server']).catch(() => {}); store.close(); await rm(directory, { recursive: true, force: true }); }
});
