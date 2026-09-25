'use client';
import { useEffect, useState } from 'react';
import type { LaunchBatch, LaunchInstance, LaunchPreview, LaunchProfile } from '../contracts/launches';
import type { ProjectWorktree } from '../contracts/projects';
import { api, HttpError } from '../client/api';
import { NativeTerminal } from './NativeTerminal';
export function LaunchAgents({token,projectId,tree,enabled,inputEnabled,terminalEnabled,held,clientInstanceId,onChanged,viewEpoch=0,requested=0}:{token:string;projectId:string;tree:ProjectWorktree;enabled:boolean;inputEnabled:boolean;terminalEnabled:boolean;held:boolean;clientInstanceId:string;onChanged:(notice:string)=>Promise<void>;viewEpoch?:number;requested?:number}) {
  const [open,setOpen]=useState(false),[profiles,setProfiles]=useState<LaunchProfile[]>([]),[rows,setRows]=useState<{profileId:string;count:number}[]>([]),[preview,setPreview]=useState<LaunchPreview|null>(null),[batches,setBatches]=useState<LaunchBatch[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[unknown,setUnknown]=useState<string|null>(null),[terminal,setTerminal]=useState<string|null>(null),[inspectId,setInspectId]=useState<string|null>(null),[note,setNote]=useState('');
  const refresh=async()=>{setBatches(await api<LaunchBatch[]>(token,'launches'));};
  useEffect(()=>{if(requested){setOpen(true);void api<LaunchProfile[]>(token,'launch-profiles').then(setProfiles).catch(e=>setError(e.message));}},[requested,token]);
  useEffect(()=>{setPreview(null);},[viewEpoch,tree.head,tree.branch,enabled,held]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[token]);
  async function act(work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy(false);}}
  const items=batches.flatMap(b=>b.items).filter(i=>i.worktreeId===tree.id);
  return <div className="launch-agents" id={`launch-${tree.id}`}><button type="button" disabled={!enabled||busy||held||!!tree.error} onClick={()=>void act(async()=>{setOpen(x=>!x);setProfiles(await api<LaunchProfile[]>(token,'launch-profiles'));await refresh();})}>Launch agents…</button>
    {open&&<section aria-label={`Launch agents in ${tree.path}`}><h3>Launch agents in {tree.branch??'detached HEAD'}</h3><p className="mono">{tree.path}</p>
      {!profiles.some(p=>p.enabled)&&<p>Create an enabled Launch profile in Settings first.</p>}
      {rows.map((row,i)=><div key={i} className="row-tools"><label>Profile {i+1}<select aria-label={`Launch profile ${i+1}`} value={row.profileId} onChange={e=>{setRows(rows.map((r,n)=>n===i?{...r,profileId:e.target.value}:r));setPreview(null);}}><option value="">Choose profile</option>{profiles.filter(p=>p.enabled).map(p=><option value={p.id} key={p.id}>{p.label}</option>)}</select></label><label>Count<input type="number" min={1} max={6} value={row.count} onChange={e=>{setRows(rows.map((r,n)=>n===i?{...r,count:Number(e.target.value)}:r));setPreview(null);}}/></label><button type="button" onClick={()=>{setRows(rows.filter((_,n)=>n!==i));setPreview(null);}}>Remove row</button></div>)}
      <button type="button" disabled={rows.length>=6} onClick={()=>{setRows([...rows,{profileId:profiles.find(p=>p.enabled)?.id??'',count:1}]);setPreview(null);}}>Add launch row</button>
      <button type="button" disabled={busy||!enabled||held||!rows.length||rows.some(r=>!r.profileId)||!!unknown} onClick={()=>void act(async()=>setPreview(await api<LaunchPreview>(token,'launches/preview',{body:{projectId,items:rows.map(r=>({...r,worktreeId:tree.id}))}})))}>Preview launch</button>
      {preview&&<div className="notice"><table><thead><tr><th>Session</th><th>Literal executable and arguments</th><th>Commit</th></tr></thead><tbody>{preview.items.map(i=><tr key={i.id}><td>{i.sessionName}</td><td><code>{JSON.stringify([i.executable,...i.profile.args])}</code></td><td>{i.head.slice(0,12)}</td></tr>)}</tbody></table>
        <p>Creates dedicated sessions with your host permissions. Startup does not establish readiness. No automatic cleanup or retry.</p>{preview.blockers.map(b=><p key={b}>{b}</p>)}
        <button type="button" disabled={busy||!enabled||held||!!preview.blockers.length||!!unknown} onClick={()=>void act(async()=>{setUnknown(preview.requestId);try{await api<LaunchBatch>(token,'launches',{body:{requestId:preview.requestId,previewDigest:preview.digest,confirm:true}});}catch(e){if(e instanceof HttpError&&e.status<500)setUnknown(null);throw e;}setUnknown(null);setPreview(null);await refresh();await onChanged('Launch results recorded. Inspect startup before starting a task.');})}>Launch {preview.items.length} sessions</button></div>}
      {unknown&&<p role="alert">Launch {unknown} needs inspection. <button type="button" onClick={()=>void act(async()=>{await refresh();const all=await api<LaunchBatch[]>(token,'launches');if(all.some(b=>b.requestId===unknown))setUnknown(null);})}>Inspect recorded request</button></p>}
    </section>}
    {items.map(item=><div className="notice" key={item.id}><strong>{item.sessionName} · {item.status}</strong><p>{item.message}</p><div className="row-tools">
      <button type="button" disabled={busy} onClick={()=>void act(async()=>{await api<LaunchInstance>(token,`launches/${item.id}/inspect`,{body:{}});await refresh();await onChanged('Launch inspected without retry.');})}>Inspect</button>
      {terminalEnabled&&item.identity&&<button type="button" onClick={()=>setTerminal(terminal===item.id?null:item.id)}>{terminal===item.id?'Close terminal':'Open terminal'}</button>}
      {!['running','reconciled','failed','applying'].includes(item.status)&&<button type="button" onClick={()=>{setInspectId(item.id);setNote('');}}>Reconcile after host inspection…</button>}</div>
      {inspectId===item.id&&<div><p>Inspect the original operation, all possible sessions and background effects on the host. A missing session does not prove the program never ran. This releases the reservation and retains that uncertainty in history.</p><label>Inspection note<input value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label><button type="button" disabled={!note.trim()||busy} onClick={()=>void act(async()=>{await api(token,`launches/${item.id}/reconcile`,{body:{requestId:crypto.randomUUID(),confirmInspected:true,note}});setInspectId(null);await refresh();await onChanged('Launch reconciled by human inspection. Nothing was replayed.');})}>Record inspected reconciliation</button><button type="button" onClick={()=>setInspectId(null)}>Cancel</button></div>}
      {terminal===item.id&&<NativeTerminal token={token} target={{launchId:item.id}} clientInstanceId={clientInstanceId} viewEpoch={viewEpoch} label={item.sessionName} held={held} inputEnabled={inputEnabled} refresh={refresh} fallback={<LaunchCapture token={token} id={item.id} />}/>}
    </div>)}{error&&<p role="alert">{error}</p>}
  </div>;
}

function LaunchCapture({token,id}:{token:string;id:string}) {
  const [text,setText]=useState('Reading captured output…'),[capturedAt,setCapturedAt]=useState('');
  useEffect(()=>{let done=false,pending=false;const abort=new AbortController();const read=async()=>{if(pending)return;pending=true;try{const result=await api<{text:string}>(token,`launches/${id}/capture`,{signal:abort.signal});if(!done){setText(result.text);setCapturedAt(new Date().toLocaleTimeString());}}catch(e){if(!done)setText(e instanceof Error?e.message:'Capture unavailable.');}finally{pending=false;}};void read();const timer=setInterval(()=>void read(),2000);return()=>{done=true;abort.abort();clearInterval(timer);};},[token,id]);
  return <><p className="fine">{capturedAt && `Captured at ${capturedAt}`}</p><pre tabIndex={0} aria-label="Launch captured output">{text}</pre></>;
}
