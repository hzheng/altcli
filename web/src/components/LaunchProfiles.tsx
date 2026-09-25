'use client';
import { useEffect, useState } from 'react';
import type { LaunchProfile } from '../contracts/launches';
import { api } from '../client/api';
const blank = { label:'', executable:'', args:[] as string[], adapterHint:'manual' as LaunchProfile['adapterHint'], enabled:true };
export function LaunchProfiles({token,enabled}:{token:string;enabled:boolean}) {
  const [profiles,setProfiles]=useState<LaunchProfile[]>([]),[editing,setEditing]=useState<LaunchProfile|null>(null),[form,setForm]=useState(blank),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const reload=()=>api<LaunchProfile[]>(token,'launch-profiles').then(setProfiles);
  useEffect(()=>{void reload().catch(e=>setError(e.message));},[token]);
  async function save(remove=false) {if(busy)return;setBusy(true);setError('');try{await api(token,`launch-profiles${editing?`/${editing.id}`:''}`,{method:remove?'DELETE':editing?'PATCH':'POST',body:remove?{expectedRevision:editing!.revision}:{...form,...(editing?{expectedRevision:editing.revision}:{})}});setEditing(null);setForm(blank);await reload();}catch(e){setError(e instanceof Error?e.message:'Profile changed.');}finally{setBusy(false);}}
  return <section className="panel" aria-label="Launch profiles"><h2>Launch profiles</h2><p>Profiles run a host executable with literal arguments. Saving never executes it. Keep credentials in the host’s CLI setup.</p>
    {!enabled && <p>Profile changes require agent launch and input to be enabled on the host.</p>}
    <ul>{profiles.map(p=><li key={p.id}><button type="button" onClick={()=>{setEditing(p);setForm({label:p.label,executable:p.executable,args:[...p.args],adapterHint:p.adapterHint,enabled:p.enabled});}}>{p.label} · revision {p.revision}{!p.enabled?' · disabled':''}</button></li>)}</ul>
    <div className="row-tools">{(['codex','claude'] as const).map(name=><button type="button" disabled={!enabled||busy} key={name} onClick={()=>{setEditing(null);setForm({...blank,label:name==='codex'?'Codex':'Claude Code',executable:name,adapterHint:name});}}>Use {name} preset</button>)}<button type="button" onClick={()=>{setEditing(null);setForm(blank);}}>New profile</button></div>
    <form onSubmit={e=>{e.preventDefault();void save();}}><label>Profile label<input value={form.label} maxLength={100} onChange={e=>setForm({...form,label:e.target.value})}/></label>
      <label>Executable<input value={form.executable} maxLength={4096} onChange={e=>setForm({...form,executable:e.target.value})}/></label>
      {form.args.map((arg,i)=><div className="row-tools" key={i}><label>Argument {i+1}<input aria-label={`Argument ${i+1}`} value={arg} maxLength={1024} onChange={e=>setForm({...form,args:form.args.map((a,n)=>n===i?e.target.value:a)})}/></label><button type="button" onClick={()=>setForm({...form,args:form.args.filter((_,n)=>n!==i)})}>Remove argument {i+1}</button></div>)}
      <button type="button" disabled={form.args.length>=32} onClick={()=>setForm({...form,args:[...form.args,'']})}>Add argument</button>
      <label>Adapter hint<select value={form.adapterHint} onChange={e=>setForm({...form,adapterHint:e.target.value as LaunchProfile['adapterHint']})}><option value="manual">Manual</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>Enabled</label>
      <pre aria-label="Literal argument preview">{JSON.stringify([form.executable,...form.args],null,2)}</pre><p className="fine">No shell parsing, aliases or login files. An explicit shell profile runs with your host permissions; the hint does not grant automation eligibility.</p>
      <button disabled={!enabled||busy||!form.label||!form.executable}>Save profile</button>{editing&&<button type="button" disabled={!enabled||busy} onClick={()=>void save(true)}>Delete profile</button>}
    </form>{error&&<p role="alert">{error}</p>}
  </section>;
}
