'use client';
import { useEffect, useRef, useState } from 'react';
import type { SessionRegistration } from '../contracts/api';
import type { LaunchBatch, LaunchInstance, LaunchPreview, LaunchProfile } from '../contracts/launches';
import type { ProjectWorktree } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { useTildify } from '../client/home';
import { isDirectCodexProfile, lacksCodexNoDaemon } from '../core/policy';
import { LaunchCleanup } from './LaunchCleanup';
export function LaunchAgents({token,projectId,tree,sessions,enabled,inputEnabled,held,onChanged,viewEpoch=0,requested=0,busy:outerBusy=false}:{token:string;projectId:string;tree:ProjectWorktree;sessions:SessionRegistration[];enabled:boolean;inputEnabled:boolean;held:boolean;onChanged:(notice:string)=>Promise<void>;viewEpoch?:number;requested?:number;busy?:boolean}) {
  const [open,setOpen]=useState(false),[profiles,setProfiles]=useState<LaunchProfile[]>([]),[agents,setAgents]=useState<{profileId:string}[]>([]),[preview,setPreview]=useState<LaunchPreview|null>(null),[batches,setBatches]=useState<LaunchBatch[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[unknown,setUnknown]=useState<string|null>(null),[inspectId,setInspectId]=useState<string|null>(null),[note,setNote]=useState('');
  const [inspections,setInspections]=useState<Record<string,{state:'checking'|'done'|'error';message:string}>>({});
  const form=useRef<HTMLElement>(null),scrolledRequest=useRef(0),tilde=useTildify();
  const labelOf=(item:LaunchInstance)=>sessions.find(s=>s.repository===item.worktree.root&&item.identity&&
    s.identity.socketPath===item.identity.socketPath&&s.identity.serverPid===item.identity.serverPid&&s.identity.serverStarted===item.identity.serverStarted&&
    s.identity.paneId===item.identity.paneId&&s.identity.panePid===item.identity.panePid)?.label??item.sessionName;
  const refresh=async()=>{setBatches(await api<LaunchBatch[]>(token,'launches'));};
  useEffect(()=>{if(requested){setOpen(true);void api<LaunchProfile[]>(token,'launch-profiles').then(setProfiles).catch(e=>setError(e.message));}},[requested,token]);
  // The explicit launch shortcut selects Agents before scrolling to its form.
  useEffect(()=>{if(open&&requested&&requested!==scrolledRequest.current){form.current?.scrollIntoView({block:'start'});scrolledRequest.current=requested;}},[open,requested]);
  useEffect(()=>{setPreview(null);},[viewEpoch,tree.head,tree.branch,enabled,held]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[token]);
  async function act(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy(false);}}
  async function inspect(item:LaunchInstance){await act(async()=>{
    setInspections(previous=>({...previous,[item.id]:{state:'checking',message:'Checking launch status…'}}));
    let result:LaunchInstance;
    try{result=await api<LaunchInstance>(token,`launches/${item.id}/inspect`,{body:{}});}
    catch(e){setInspections(previous=>({...previous,[item.id]:{state:'error',message:`Could not check launch status: ${e instanceof Error?e.message:'Request failed.'}`}}));return;}
    setBatches(previous=>previous.map(batch=>({...batch,items:batch.items.map(saved=>saved.id===result.id?result:saved)})));
    const unchanged=result.status===item.status&&result.message===item.message&&!result.closed;
    const message=`Checked at ${new Date().toLocaleTimeString()} — ${result.status}${unchanged?' (unchanged)':''}. ${result.message}`;
    setInspections(previous=>({...previous,[item.id]:{state:'done',message}}));
    await onChanged(`${labelOf(item)}: ${message}`);
  });}
  const items=batches.flatMap(b=>b.items).filter(i=>i.worktreeId===tree.id&&!i.closed);
  return <div className="launch-agents" id={`launch-${tree.id}`}>
    {!!items.length&&<section className="worktree-agent-status" aria-label={`Agent status in ${tree.path}`}><h3>Agent status</h3>
    {items.map(item=>{const inspection=inspections[item.id],label=labelOf(item);return <div className="notice" key={item.id} role="group" aria-label={`Launch ${label}`}><strong>{label} · last observed: {item.status}</strong>{label!==item.sessionName&&<p className="fine">tmux session: {item.sessionName}</p>}<p>{tilde(item.message)}</p><div className="row-tools launch-actions">
      <button type="button" disabled={busy} onClick={()=>void inspect(item)}>{inspection?.state==='checking'?'Checking…':'Refresh launch status'}</button>
      <LaunchCleanup token={token} item={item} label={label} enabled={inputEnabled&&!busy&&!outerBusy} viewEpoch={viewEpoch} onChanged={async()=>{await refresh();await onChanged('Cleanup result recorded; launch history retained.');}} />
      {!item.cleanup&&!['running','reconciled','failed','applying'].includes(item.status)&&<button type="button" onClick={()=>{setInspectId(item.id);setNote('');}}>Reconcile after host inspection…</button>}</div>
      {inspection&&<p className="launch-inspection" role={inspection.state==='error'?'alert':'status'}>{inspection.message}</p>}
      {inspectId===item.id&&<div><p>Inspect the original operation, all possible sessions and background effects on the host. A missing session does not prove the program never ran. This releases the reservation and retains that uncertainty in history.</p><label>Inspection note<input value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label><button type="button" disabled={!note.trim()||busy} onClick={()=>void act(async()=>{await api(token,`launches/${item.id}/reconcile`,{body:{requestId:crypto.randomUUID(),confirmInspected:true,note}});setInspectId(null);await refresh();await onChanged('Launch reconciled by human inspection. Nothing was replayed.');})}>Record inspected reconciliation</button><button type="button" onClick={()=>setInspectId(null)}>Cancel</button></div>}
    </div>;})}
    </section>}
    <button type="button" disabled={!enabled||busy||held||!!tree.error} onClick={()=>void act(async()=>{setOpen(x=>!x);setProfiles(await api<LaunchProfile[]>(token,'launch-profiles'));await refresh();})}>Launch agents…</button>
    {open&&<section ref={form} aria-label={`Launch agents in ${tree.path}`}><h3>Launch agents in {tree.branch??'detached HEAD'}</h3><p className="mono">{tilde(tree.path)}</p>
      {!profiles.some(p=>p.enabled)&&<p>Create an enabled Launch profile in Settings first.</p>}
      {agents.map((agent,i)=><div key={i} className="launch-agent"><label>Agent {i+1}<select aria-label={`Agent ${i+1} profile`} value={agent.profileId} disabled={busy||!!unknown} onChange={e=>{setAgents(agents.map((a,n)=>n===i?{profileId:e.target.value}:a));setPreview(null);}}><option value="">Choose profile</option>{profiles.filter(p=>p.enabled).map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label><button type="button" aria-label={`Remove agent ${i+1}`} disabled={busy||!!unknown} onClick={()=>{setAgents(agents.filter((_,n)=>n!==i));setPreview(null);}}>Remove agent</button></div>)}
      <div className="row-tools"><button type="button" disabled={busy||!!unknown||agents.length>=6||!profiles.some(p=>p.enabled)} onClick={()=>{setAgents([...agents,{profileId:profiles.find(p=>p.enabled)?.id??''}]);setPreview(null);}}>Add agent</button>
      <button type="button" disabled={busy||!enabled||held||!agents.length||agents.some(a=>!a.profileId)||!!unknown} onClick={()=>void act(async()=>setPreview(await api<LaunchPreview>(token,'launches/preview',{body:{projectId,items:agents.map(a=>({...a,worktreeId:tree.id,count:1}))}})))}>Preview launch</button></div>
      {preview&&<div className="notice"><table><thead><tr><th>Session</th><th>Literal executable and arguments</th><th>Commit</th></tr></thead><tbody>{preview.items.map(i=><tr key={i.id}><td>{i.sessionName}</td><td><code>{JSON.stringify([i.executable,...i.profile.args])}</code></td><td>{i.head.slice(0,12)}</td></tr>)}</tbody></table>
        <p>Creates dedicated sessions with your host permissions. Startup does not establish readiness. No automatic cleanup or retry.</p>{preview.blockers.map(b=><p key={b}>{b}</p>)}
        {[...new Set(preview.items.filter(i=>lacksCodexNoDaemon(i.profile)).map(i=>i.profile.label))].map(label=><p key={label} className="warning-text" role="status">Profile {label} runs Codex without <code>--no-daemon</code>: with Codex 0.157+ AltCLI cannot track these sessions' turns. Add it in Settings → Launch profiles and preview again.</p>)}
        {[...new Set(preview.items.filter(i=>i.profile.adapterHint==='codex'&&!isDirectCodexProfile(i.profile)).map(i=>i.profile.label))].map(label=><p key={label} role="status">Profile {label} uses a shell or wrapper. Check that its Codex command includes <code>--no-daemon</code>; AltCLI cannot verify that command.</p>)}
        <button type="button" disabled={busy||!enabled||held||!!preview.blockers.length||!!unknown} onClick={()=>void act(async()=>{setUnknown(preview.requestId);try{await api<LaunchBatch>(token,'launches',{body:{requestId:preview.requestId,previewDigest:preview.digest,confirm:true}});}catch(e){if(e instanceof HttpError&&e.status<500)setUnknown(null);throw e;}setUnknown(null);setPreview(null);await refresh();await onChanged('Launch results recorded. Inspect startup before starting a task.');})}>Launch {preview.items.length} sessions</button></div>}
      {unknown&&<p role="alert">Launch {unknown} needs inspection. <button type="button" onClick={()=>void act(async()=>{await refresh();const all=await api<LaunchBatch[]>(token,'launches');if(all.some(b=>b.requestId===unknown))setUnknown(null);})}>Inspect recorded request</button></p>}
    </section>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
