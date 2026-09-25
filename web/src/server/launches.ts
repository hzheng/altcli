import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LaunchBatch, LaunchInstance, LaunchItem, LaunchPreview, LaunchProfile } from '../contracts/launches.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';
import { AppError, messageOf } from '../core/errors.ts';
import { requestId } from '../core/validation.ts';
import { terminalFields, terminalNumber, terminalText } from '../core/terminal-validation.ts';
import { classifyAgent } from '../core/workspaces.ts';
import { resolveExecutable, type Config } from './config.ts';
import type { Store } from './store.ts';
import type { ProjectCatalog } from './projects.ts';
import type { InputAuthority } from './input-authority.ts';
import { terminalEnvironment, terminalRunner, tmuxLiteral } from './terminal-environment.ts';
import { inspectPane } from './adapters/tmux.ts';
import { inspectAttach, type AttachTarget } from './tmux-attach.ts';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24) || 'agent';
const SETTLED = new Set(['running','reconciled','failed']);
/** Only nonsecret settings: tmux retains the env argv in pane_start_command. CLIs use credential stores. */
export function launchEnvironment(source: Record<string,string|undefined> = process.env): Record<string,string> {
  const cleaned = terminalEnvironment(source), result: Record<string,string> = {};
  for (const key of ['HOME','USER','LOGNAME','SHELL','PATH','LANG','LC_ALL','LC_CTYPE','TZ','TERM','COLORTERM','SSH_AUTH_SOCK','CODEX_HOME','CLAUDE_CONFIG_DIR']) if(cleaned[key] !== undefined) result[key] = cleaned[key];
  if (source.ALTCLI_ENV) { if(!isAbsolute(source.ALTCLI_ENV) || /[\x00-\x1f\x7f]/.test(source.ALTCLI_ENV)) throw new AppError('LAUNCH_ENV', 'ALTCLI_ENV must be an absolute hook configuration path.'); result.ALTCLI_ENV=source.ALTCLI_ENV; }
  if (source.ALTCLI_URL) { const u = new URL(source.ALTCLI_URL); if(u.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname!=='/') throw new AppError('LAUNCH_ENV','ALTCLI_URL must be a loopback HTTP origin.');result.ALTCLI_URL=u.origin; }
  return result;
}
/** Existing tmux servers contribute environment too. Remove every old name except fresh tmux identity, then provide the reviewed host values. */
export function childEnvironmentArgs(global: string, session: string, env: Record<string,string>): string[] {
  const keys = new Set((global+'\n'+session).split('\n').filter(Boolean).map(line => line.replace(/^-/, '').split('=')[0]!));
  if([...keys].some(k=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) throw new AppError('LAUNCH_ENV','Ambiguous tmux environment names. Inspect the host.',409);
  return [...[...keys].filter(k=>!['TMUX','TMUX_PANE'].includes(k)).sort().flatMap(k=>['-u',k]), ...Object.entries(env).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`)];
}
export class LaunchService {
  private previews = new Map<string, LaunchPreview>();
  readonly config: Config; readonly store: Store; readonly projects: ProjectCatalog; readonly authority: InputAuthority;
  readonly guard: (tree: WorktreeIdentity) => void;
  constructor(config: Config, store: Store, projects: ProjectCatalog, authority: InputAuthority, guard: (tree: WorktreeIdentity) => void) {
    this.config=config;this.store=store;this.projects=projects;this.authority=authority;this.guard=guard;
    for(const batch of this.batches()) {
      let changed=false;
      for(const item of batch.items) if(['applying','starting'].includes(item.status)) {item.status='uncertain';item.message='Host restarted during startup. Inspect the original instance; nothing was retried.';changed=true;}
      if(changed) this.save(batch);
    }
  }
  private enabled() { if(!this.config.launchEnabled || !this.config.inputEnabled) throw new AppError('LAUNCH_DISABLED','Agent launching is disabled on this host.',403); }
  profiles(): LaunchProfile[] { return (this.store.db.prepare('SELECT value FROM launch_profiles ORDER BY rowid').all() as {value:string}[]).map(r=>JSON.parse(r.value)); }
  async profile(value: unknown, id?: string, remove=false): Promise<LaunchProfile|null> {
    this.enabled();
    const b=terminalFields(value, remove?['expectedRevision']:['expectedRevision','label','executable','args','adapterHint','enabled']);
    const before=id?this.profiles().find(p=>p.id===id):undefined;
    if(id && (!before || before.revision!==terminalNumber(b.expectedRevision,1,Number.MAX_SAFE_INTEGER))) throw new AppError('PROFILE_CHANGED','The profile changed. Reload before saving.',409);
    if(remove){this.store.db.prepare('DELETE FROM launch_profiles WHERE id=?').run(id!);return null;}
    const label=terminalText(b.label,100), executable=terminalText(b.executable,4096);
    if(!isAbsolute(executable) && !/^[A-Za-z0-9._+-]+$/.test(executable)) throw new AppError('PROFILE_EXECUTABLE','Use an executable name or an absolute path.');
    if(!Array.isArray(b.args) || b.args.length>32 || b.args.some(a=>typeof a!=='string'||Buffer.byteLength(a)>1024||/[\x00-\x1f\x7f]/.test(a)) || Buffer.byteLength(b.args.join(''))>4096) throw new AppError('PROFILE_ARGS','Use at most 32 literal arguments, 1 KiB each and 4 KiB total.');
    if(!['codex','claude','manual'].includes(String(b.adapterHint)) || typeof b.enabled!=='boolean') throw new AppError('PROFILE_INPUT','Choose a display hint and enabled state.');
    if(this.config.mode!=='mock' && !resolveExecutable(executable, launchEnvironment())) throw new AppError('PROFILE_EXECUTABLE','Executable is unavailable on the host.',409);
    const result:LaunchProfile={id:id??randomUUID(),revision:(before?.revision??0)+1,label,executable,args:b.args as string[],adapterHint:b.adapterHint as LaunchProfile['adapterHint'],enabled:b.enabled};
    this.store.db.prepare('INSERT INTO launch_profiles(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(result.id,JSON.stringify(result));return result;
  }
  batches(): LaunchBatch[] {return (this.store.db.prepare('SELECT value FROM launches ORDER BY rowid').all() as {value:string}[]).map(r=>JSON.parse(r.value));}
  private save(batch:LaunchBatch) {this.store.db.prepare('INSERT INTO launches(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(batch.requestId,JSON.stringify(batch));}
  private lookup(id:string): {batch:LaunchBatch;item:LaunchInstance} {for(const batch of this.batches()){const item=batch.items.find(i=>i.id===id);if(item)return {batch,item};}throw new AppError('LAUNCH_CHANGED','Launch instance is unavailable.',409);}
  private update(batch:LaunchBatch,item:LaunchInstance,changes:Partial<LaunchInstance>) {
    Object.assign(item,changes,{updatedAt:new Date().toISOString()});this.save(batch);
    if(batch.items.filter(i=>i.worktree.indexPath===item.worktree.indexPath).every(i=>SETTLED.has(i.status))) this.store.db.prepare('DELETE FROM launch_reservations WHERE index_path=? AND launch_id=?').run(item.worktree.indexPath,batch.requestId);
  }
  private async resolved(profile:LaunchProfile): Promise<string> {
    if(this.config.mode==='mock') return `/mock/bin/${slug(profile.executable)}`;
    const path=resolveExecutable(profile.executable,launchEnvironment());if(!path)throw new AppError('LAUNCH_EXECUTABLE','The executable is unavailable.',409);
    const resolved=await realpath(path);if(!(await stat(resolved)).isFile())throw new AppError('LAUNCH_EXECUTABLE','Executable must resolve to a file.',409);return resolved;
  }
  private assertAvailable(tree:WorktreeIdentity) {if(this.store.worktreeCreations().some(op=>op.input.source.root===tree.root && ['applying','uncertain'].includes(op.status)))throw new AppError('LAUNCH_BUSY','Source worktree setup is unresolved.',409);this.projects.assertWorktreeReady(tree.root);this.guard(tree);if(this.store.db.prepare('SELECT 1 FROM launch_reservations WHERE index_path=?').get(tree.indexPath))throw new AppError('LAUNCH_BUSY','An earlier launch owns this checkout. Inspect it first.',409);}
  async preview(value:unknown):Promise<LaunchPreview> {
    this.enabled();this.authority.assertAutomated();const b=terminalFields(value,['projectId','items']);const projectId=terminalText(b.projectId);
    if(!Array.isArray(b.items)||!b.items.length||b.items.length>6)throw new AppError('LAUNCH_ITEMS','Choose one to six instances.');
    const items:LaunchItem[]=[], blockers:string[]=[];
    for(const row of b.items){const i=terminalFields(row,['worktreeId','profileId','count']), count=terminalNumber(i.count,1,6);
      const tree=await this.projects.launchWorktree(projectId,terminalText(i.worktreeId));const profile=this.profiles().find(p=>p.id===i.profileId);
      if(!profile?.enabled)throw new AppError('PROFILE_CHANGED','Choose an enabled profile.',409);
      try{this.assertAvailable(tree.identity!);}catch(e){blockers.push(messageOf(e));}
      const executable=await this.resolved(profile);const project=this.projects.record(projectId);
      for(let n=0;n<count;n++){const id=randomUUID();items.push({id,projectId,worktreeId:tree.id,worktree:tree.identity!,commonDir:project.commonDir,branch:tree.branch,head:tree.head!,profile,executable,sessionName:`${slug(profile.label)}-${slug(tree.branch??'detached')}-${id.slice(0,8)}`,environmentDigest:digest(launchEnvironment())});}
    }
    if(items.length>6)throw new AppError('LAUNCH_ITEMS','At most six instances may be launched together.');
    if(this.batches().flatMap(b=>b.items).filter(i=>!SETTLED.has(i.status)).length+items.length>8)blockers.push('At most eight launched sessions may await attention.');
    const id=randomUUID(), expiresAt=new Date(Date.now()+120000).toISOString();const result={requestId:id,digest:digest({id,items,expiresAt}),expiresAt,items,blockers:[...new Set(blockers)]};
    for(const [id,p] of this.previews)if(Date.parse(p.expiresAt)<Date.now())this.previews.delete(id);
    if(this.previews.size>=32)throw new AppError('LAUNCH_PREVIEW_LIMIT','Too many launch previews. Wait for older previews to expire.',409);
    this.previews.set(id,result);return result;
  }
  async confirm(value:unknown):Promise<LaunchBatch> {
    const b=terminalFields(value,['requestId','previewDigest','confirm']);const id=requestId(b.requestId), previewDigest=terminalText(b.previewDigest);
    if(b.confirm!==true)throw new AppError('CONFIRM_REQUIRED','Confirm the captured launch preview.');
    const prior=this.batches().find(x=>x.requestId===id);if(prior){if(prior.previewDigest!==previewDigest)throw new AppError('ID_CONFLICT','Launch confirmation changed.',409);return prior;}
    this.enabled();return this.authority.automated(async()=>{
      const preview=this.previews.get(id);if(!preview || preview.digest!==previewDigest || Date.parse(preview.expiresAt)<Date.now() || preview.blockers.length)throw new AppError('LAUNCH_PREVIEW_CHANGED','Preview again before launching.',409);
      for(const item of preview.items){const tree=await this.projects.launchWorktree(item.projectId,item.worktreeId);this.assertAvailable(tree.identity!);
        if(!isDeepStrictEqual(tree.identity,item.worktree)||tree.branch!==item.branch||tree.head!==item.head||!isDeepStrictEqual(this.profiles().find(p=>p.id===item.profile.id),item.profile)||await this.resolved(item.profile)!==item.executable||digest(launchEnvironment())!==item.environmentDigest)throw new AppError('LAUNCH_PREVIEW_CHANGED','A checkout, profile, executable or environment changed. Preview again.',409);
      }
      let claimed=false;
      const batch=this.store.db.transaction(()=>{
        const duplicate=this.batches().find(x=>x.requestId===id);if(duplicate)return duplicate;
        this.enabled();this.authority.assertAutomated();for(const i of preview.items){this.assertAvailable(i.worktree);if(!isDeepStrictEqual(this.profiles().find(p=>p.id===i.profile.id),i.profile)||digest(launchEnvironment())!==i.environmentDigest)throw new AppError('LAUNCH_PREVIEW_CHANGED','Profile or environment changed before reservation.',409);}
        const now=new Date().toISOString();const result:LaunchBatch={requestId:id,previewDigest,createdAt:now,items:preview.items.map(i=>({...i,status:'applying',phase:'reserved',message:'Launch reserved; no program started.',identity:null,placeholder:null,sessionId:null,windowId:null,updatedAt:now}))};
        this.store.saveProject(this.projects.record(preview.items[0]!.projectId));
        this.save(result);for(const index of new Set(preview.items.map(i=>i.worktree.indexPath)))this.store.db.prepare('INSERT INTO launch_reservations(index_path,launch_id) VALUES(?,?)').run(index,id);claimed=true;return result;
      }).immediate();
      if(!claimed)return batch;
      for(const item of batch.items)await this.start(batch,item);
      return batch;
    });
  }
  private async start(batch:LaunchBatch,item:LaunchInstance) {
    const run=terminalRunner(this.config);
    try{
      this.enabled();this.guard(item.worktree);
      if(this.config.mode==='mock'){
        this.update(batch,item,{phase:'observed',status:'running',identity:{paneId:`%mock-${item.id}`,panePid:'10',serverPid:'20',serverStarted:'100',socketPath:'/tmp/altcli-mock'},sessionId:`$mock-${item.id}`,windowId:`@mock-${item.id}`,message:'Simulated launch; no program executed.'});return;
      }
      this.update(batch,item,{phase:'creating',message:'Creating inert placeholder; result must be observed.'});
      const created=(await run(['new-session','-d','-P','-F','#{session_id}\t#{window_id}\t#{pane_id}','-s',item.sessionName,'-c',tmuxLiteral(item.worktree.root),'/usr/bin/env','/bin/sleep','86400'])).trimEnd().split('\t');
      if(created.length!==3||!/^\$\d+$/.test(created[0]!)||!/^@\d+$/.test(created[1]!)||!/^%\d+$/.test(created[2]!))throw new Error('Invalid creation identity');
      const placeholder=(await inspectPane(run,created[2]!)).identity;
      this.update(batch,item,{phase:'created',sessionId:created[0]!,windowId:created[1]!,placeholder,message:'Placeholder created; configuring safe lifetime.'});
      await run(['set-option','-t',item.sessionId!,'destroy-unattached','off']);
      await run(['set-option','-t',item.sessionId!,'update-environment','']);
      await run(['set-option','-t',item.sessionId!,'mouse','on']);
      await run(['set-option','-w','-t',item.windowId!,'remain-on-exit','on']);
      const safe=(await run(['display-message','-p','-t',placeholder.paneId,'#{destroy-unattached}\t#{remain-on-exit}'])).trim();
      if(safe!=='off\ton')throw new Error('Unsafe session lifetime');
      this.update(batch,item,{phase:'configured'});
      await run(['set-option','-t',item.sessionId!,'@altcli_launch',item.id]);
      await this.verify(item,placeholder);
      const environment=childEnvironmentArgs(await run(['show-environment','-g']),await run(['show-environment','-t',item.sessionId!]),launchEnvironment());
      this.update(batch,item,{phase:'marked'});
      // Final asynchronous checks precede the single respawn. Persist possible execution before sending it.
      const tree=await this.projects.launchWorktree(item.projectId,item.worktreeId);
      if(!isDeepStrictEqual(tree.identity,item.worktree)||tree.head!==item.head||tree.branch!==item.branch)throw new Error('Checkout changed');
      this.enabled();this.guard(item.worktree);await this.verify(item,placeholder);
      this.update(batch,item,{phase:'executing',message:'Program execution may occur. Never replay this launch.'});
      await run(['respawn-pane','-k','-t',placeholder.paneId,'-c',tmuxLiteral(item.worktree.root),'/usr/bin/env',...environment.map(tmuxLiteral),tmuxLiteral(item.executable),...item.profile.args.map(tmuxLiteral)]);
      const pane=await inspectPane(run,placeholder.paneId);
      // The respawn changes pane_pid; exact server/session/window/pane identity still comes from creation.
      if(pane.identity.serverPid!==placeholder.serverPid||pane.identity.serverStarted!==placeholder.serverStarted||pane.identity.socketPath!==placeholder.socketPath)throw new Error('Server changed');
      await this.verify(item,pane.identity);
      this.update(batch,item,{phase:'observed',identity:pane.identity,status:'starting',message:'Program started; verifying its current instance does not claim readiness.'});
      await this.inspect(item.id);
      Object.assign(item,this.lookup(item.id).item);
    }catch(e){this.update(batch,item,{status:item.phase==='reserved'?'failed':'uncertain',message:`${messageOf(e)} Inspect the original launch; no automatic retry or cleanup.`});}
  }
  private async verify(item:LaunchInstance, identity=item.identity) {
    if(!identity||!item.sessionId||!item.windowId)throw new AppError('LAUNCH_UNCERTAIN','Creation identity was not durably observed. Inspect manually.',409);
    const run=terminalRunner(this.config);const pane=await inspectPane(run,identity.paneId);
    const ids=(await run(['display-message','-p','-t',identity.paneId,'#{session_id}\t#{window_id}\t#{@altcli_launch}'])).trimEnd().split('\t');
    if(!isDeepStrictEqual(pane.identity,identity)||ids.join('\t')!==[item.sessionId,item.windowId,item.id].join('\t')||pane.cwd!==item.worktree.root)throw new AppError('LAUNCH_CHANGED','The recorded launch identity, marker or directory changed. Nothing was adopted.',409);
    return pane;
  }
  async inspect(id:string):Promise<LaunchInstance> {
    const {batch,item}=this.lookup(id);
    if(item.status==='reconciled'||item.status==='failed'||this.config.mode==='mock')return item;
    try{const pane=await this.verify(item);
      const eligible=classifyAgent({...pane,location:`${item.sessionName}:0.0`},[]).eligible;
      this.update(batch,item,{status:pane.dead?'exited':eligible?'running':'starting',message:pane.dead?'Exited; inspect possible background effects before releasing the reservation.':eligible?`Running ${pane.command}; readiness still requires normal discovery and confirmation.`:`Needs attention: ${pane.command} is not yet an eligible coding CLI.`});
    }catch(e){this.update(batch,item,{status:'uncertain',message:messageOf(e)});}return item;
  }
  async reconcile(id:string,value:unknown):Promise<LaunchInstance> {
    const b=terminalFields(value,['requestId','confirmInspected','note']);requestId(b.requestId);if(b.confirmInspected!==true)throw new AppError('CONFIRM_REQUIRED','Inspect the host, including possible prior and background effects.');
    const note=terminalText(b.note,1000);const {batch,item}=this.lookup(id);
    if(item.humanDecision){if(item.humanDecision.requestId!==b.requestId||item.humanDecision.note!==note)throw new AppError('LAUNCH_CHANGED','This instance was already reconciled.',409);return item;}
    if(item.status==='applying'||this.authority.busy)throw new AppError('LAUNCH_BUSY','Wait for the in-flight operation to settle.',409);
    this.update(batch,item,{status:'reconciled',message:'Human acknowledged possible prior effects. History retained; a new launch needs new consent.',humanDecision:{requestId:b.requestId as string,note,at:new Date().toISOString()}});return item;
  }
  async capture(id: string): Promise<{text: string}> {
    const {item} = this.lookup(id);
    if (this.config.mode === 'mock') return {text: `Simulated launch ${item.sessionName}; no host process.`};
    const pane = await this.verify(item);
    return {text: await terminalRunner(this.config)(['capture-pane', '-p', '-J', '-S', '-250', '-t', pane.identity.paneId])};
  }
  async target(id:string):Promise<AttachTarget> {
    const {item}=this.lookup(id);if(this.config.mode==='mock' && item.identity && item.sessionId)return {identity:item.identity,sessionId:item.sessionId,label:item.sessionName};
    const pane=await this.verify(item);return inspectAttach(this.config,pane.identity);
  }
}
