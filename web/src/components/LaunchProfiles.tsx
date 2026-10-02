'use client';
import { useEffect, useState } from 'react';
import type { LaunchProfile } from '../contracts/launches';
import { api } from '../client/api';
import { isDirectCodexProfile, lacksCodexNoDaemon } from '../core/policy';
type Form = Omit<LaunchProfile, 'id' | 'revision'>;
const blank: Form = { label:'', executable:'', args:[], adapterHint:'manual', enabled:true };
const PRESETS = { 'Codex preset': { ...blank, label:'Codex', executable:'codex', args:['--no-daemon'], adapterHint:'codex' }, 'Claude preset': { ...blank, label:'Claude Code', executable:'claude', adapterHint:'claude' }, Other: blank } satisfies Record<string, Form>;
type Preset = keyof typeof PRESETS;
const formOf = (p: LaunchProfile): Form => ({ label:p.label, executable:p.executable, args:[...p.args], adapterHint:p.adapterHint, enabled:p.enabled });
/** Saved profiles in one row; the editor below shows the selected profile (the first by default) or a new draft. Revisions stay internal:
 * every write still sends expectedRevision, so a stale edit reports its conflict. Choosing a profile or preset never saves or launches. */
export function LaunchProfiles({token,enabled}:{token:string;enabled:boolean}) {
  const [profiles,setProfiles]=useState<LaunchProfile[]>([]),[selected,setSelected]=useState<string|null>(null),[draft,setDraft]=useState<Preset|null>(null),[form,setForm]=useState<Form>(blank),[menu,setMenu]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const editing=draft?null:profiles.find(p=>p.id===selected)??null;
  function show(p:LaunchProfile|undefined){setDraft(null);setSelected(p?.id??null);setForm(p?formOf(p):blank);}
  function startNew(preset:Preset){setDraft(preset);setForm({...PRESETS[preset],args:[...PRESETS[preset].args]});setMenu(false);}
  // Helper's profiles are managed in Helper → Settings.
  const reload=async(choose:string|null)=>{const next=(await api<LaunchProfile[]>(token,'launch-profiles')).filter(p=>p.purpose!=='helper');setProfiles(next);show(next.find(p=>p.id===choose)??next[0]);};
  useEffect(()=>{void reload(null).catch(e=>setError(e.message));},[token]);
  async function save(remove=false) {if(busy)return;setBusy(true);setError('');try{const result=await api<LaunchProfile|{removed:boolean}>(token,`launch-profiles${editing?`/${editing.id}`:''}`,{method:remove?'DELETE':editing?'PATCH':'POST',body:remove?{expectedRevision:editing!.revision}:{...form,...(editing?{expectedRevision:editing.revision}:{})}});await reload(remove?null:(result as LaunchProfile).id);}catch(e){setError(e instanceof Error?e.message:'Profile changed.');}finally{setBusy(false);}}
  return <section className="panel" aria-label="Launch profiles"><h2>Launch profiles</h2><p>Profiles run a host executable with literal arguments. Saving never executes it. Keep credentials in the host’s CLI setup.</p>
    {!enabled && <p>Profile changes require agent launch and input to be enabled on the host.</p>}
    <div className="profile-bar">
      <div className="profile-row" role="group" aria-label="Saved profiles">{profiles.map(p=><button type="button" key={p.id} className={p.id===editing?.id?'selected':''} aria-pressed={p.id===editing?.id} onClick={()=>show(p)}>{p.label}{!p.enabled&&<span className="muted"> · disabled</span>}{lacksCodexNoDaemon(p)&&<span className="warning-text"> · needs --no-daemon</span>}</button>)}
        {!profiles.length&&<span className="muted">No saved profiles yet. Choose New to create one.</span>}</div>
      <span className="new-profile" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setMenu(false);}} onKeyDown={e=>{if(e.key==='Escape')setMenu(false);}}>
        <button type="button" aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={()=>setMenu(m=>!m)}>New <span aria-hidden="true">▾</span></button>
        {menu&&<span role="menu" aria-label="New profile" className="new-profile-menu">{(Object.keys(PRESETS) as Preset[]).map(name=><button type="button" role="menuitem" key={name} disabled={!enabled&&name!=='Other'} onClick={()=>startNew(name)}>{name}</button>)}</span>}</span>
    </div>
    {(draft||editing)&&<form onSubmit={e=>{e.preventDefault();void save();}}><h3>{editing?`Edit ${editing.label}`:`New profile${draft==='Other'?'':` (${draft})`}`}</h3>
      <label>Profile label<input value={form.label} maxLength={100} onChange={e=>setForm({...form,label:e.target.value})}/></label>
      <label>Executable<input value={form.executable} maxLength={4096} onChange={e=>setForm({...form,executable:e.target.value})}/></label>
      {form.args.map((arg,i)=><div className="row-tools" key={i}><label>Argument {i+1}<input aria-label={`Argument ${i+1}`} value={arg} maxLength={1024} onChange={e=>setForm({...form,args:form.args.map((a,n)=>n===i?e.target.value:a)})}/></label><button type="button" onClick={()=>setForm({...form,args:form.args.filter((_,n)=>n!==i)})}>Remove argument {i+1}</button></div>)}
      <button type="button" disabled={form.args.length>=32} onClick={()=>setForm({...form,args:[...form.args,'']})}>Add argument</button>
      {/* Saved profiles are never rewritten, so an existing Codex profile without the flag is called out where it is edited. */}
      {lacksCodexNoDaemon(form) ? <div className="warning-text" role="status"><p>This Codex profile lacks <code>--no-daemon</code>. With Codex 0.157+ its turns run in the shared background server, whose hooks cannot identify this pane, so AltCLI cannot track them.</p>
        <button type="button" disabled={form.args.length>=32} onClick={()=>setForm({...form,args:['--no-daemon',...form.args]})}>Add --no-daemon</button></div>
        : isDirectCodexProfile(form)?<p className="fine"><code>--no-daemon</code> keeps Codex turns in this terminal so AltCLI can track them. Sessions already running keep the arguments they started with; relaunch them after their current work finishes.</p>
        : form.adapterHint==='codex'&&<p className="fine">For a shell or wrapper, check that its Codex command includes <code>--no-daemon</code>. AltCLI cannot verify or automatically edit that command.</p>}
      <label>Adapter hint<select value={form.adapterHint} onChange={e=>setForm({...form,adapterHint:e.target.value as LaunchProfile['adapterHint']})}><option value="manual">Manual</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>Enabled</label>
      <pre aria-label="Literal argument preview">{JSON.stringify([form.executable,...form.args],null,2)}</pre><p className="fine">No shell parsing, aliases or login files. An explicit shell profile runs with your host permissions; the hint does not grant automation eligibility.</p>
      <button disabled={!enabled||busy||!form.label||!form.executable}>Save profile</button>{editing&&<button type="button" disabled={!enabled||busy} onClick={()=>void save(true)}>Delete profile</button>}
      {draft&&<button type="button" className="quiet" disabled={busy} onClick={()=>show(profiles.find(p=>p.id===selected)??profiles[0])}>Cancel</button>}
    </form>}{error&&<p role="alert">{error}</p>}
  </section>;
}
