'use client';
import { useEffect, useRef, useState } from 'react';
import type { LaunchCleanupPreview, LaunchInstance } from '../contracts/launches';
import { api, HttpError } from '../client/api';

export function LaunchCleanup({token,item,enabled,viewEpoch,onChanged}:{token:string;item:LaunchInstance;enabled:boolean;viewEpoch:number;onChanged:()=>Promise<void>}) {
  const [preview,setPreview]=useState<LaunchCleanupPreview|null>(null),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[lost,setLost]=useState(false);
  const pending=useRef(false);
  useEffect(()=>{setPreview(null);setAck(false);},[item.updatedAt,enabled,viewEpoch]);
  async function act(work:()=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Cleanup failed.');}finally{pending.current=false;setBusy(false);}}
  async function confirm(){if(!preview||!ack)return;
    try{await api<LaunchInstance>(token,`launches/${item.id}/cleanup`,{body:{requestId:preview.requestId,digest:preview.digest,confirmInspected:true}});}
    catch(e){if(!(e instanceof HttpError)||e.status>=500){setLost(true);setPreview(null);throw Error('The cleanup response was lost. Inspect its result before continuing.');}throw e;}
    setPreview(null);setAck(false);await onChanged();
  }
  if(item.cleanup)return <p className="fine">Cleanup {item.cleanup.status}. Use Refresh launch status to check the result; cleanup is never retried automatically.</p>;
  return <>
    {!preview&&!lost&&<button type="button" disabled={!enabled||busy} onClick={()=>void act(async()=>{setAck(false);setPreview(await api<LaunchCleanupPreview>(token,`launches/${item.id}/cleanup/preview`,{body:{}}));})}>Clean up…</button>}
    {preview&&<section aria-label={`Clean up ${item.sessionName}`}>
      <p><strong>{preview.sessionName}</strong>: {preview.state==='missing'?'the recorded session is already gone. Remove its launch card.':preview.state==='dead'?'the pane has exited. Remove its retained tmux session and launch card.':'cleanup is unavailable.'} Launch history is kept.</p>
      {preview.blockers.map(b=><p key={b} role="alert">{b}</p>)}
      {!preview.blockers.length&&<label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} disabled={busy}/> I inspected possible background processes and acknowledge that cleanup does not stop them.</label>}
      <div className="row-tools"><button type="button" disabled={busy||!enabled||!ack||!!preview.blockers.length} onClick={()=>void act(confirm)}>{preview.state==='missing'?'Remove launch card':'Remove dead session'}</button>
      <button type="button" disabled={busy} onClick={()=>{setPreview(null);setAck(false);}}>Cancel cleanup</button></div>
    </section>}
    {lost&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{await api(token,`launches/${item.id}/inspect`,{body:{}});await onChanged();setLost(false);})}>Inspect cleanup result</button>}
    {error&&<p role="alert">{error}</p>}
  </>;
}
