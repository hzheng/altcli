'use client';
import { useEffect, useRef, useState } from 'react';
import type { BackgroundAction, BackgroundActionView, BackgroundPermissions } from '../contracts/background-actions';
import { api } from '../client/api';

const permissionNames = { app: 'App actions', command: 'Host commands and file changes', risk: 'Readiness and risk decisions' } as const;
function ActionCard({ action, disabled, decide }: { action: BackgroundAction; disabled: boolean; decide: (body: unknown) => Promise<boolean> }) {
  const [confirm, setConfirm] = useState(false), [note, setNote] = useState('');
  const op = action.operation;
  return <li className="background-action">
    <div className="section-heading"><strong>{op.kind === 'app' ? `${op.method} ${op.path}` : op.executable}</strong><span className="badge">{action.status}</span></div>
    <p>{action.reason}</p><p className="fine">{action.message}</p>
    <pre aria-label="Exact requested action">{JSON.stringify(op, null, 2)}</pre>
    <p className="fine">Requested {new Date(action.createdAt).toLocaleString()} · expires {new Date(action.expiresAt).toLocaleString()}</p>
    {action.pid !== null && <p className="fine">Recorded command process group: {action.pid}</p>}
    {action.result !== null && <details><summary>Recorded result</summary><pre>{JSON.stringify(action.result, null, 2)}</pre></details>}
    {action.status === 'pending' && <>
      {op.kind === 'command' && <p className="warning-text">This command runs as the host user. It can change files, run programs and access the network; it is not confined to its working directory.</p>}
      {action.risk && <p className="warning-text">This request includes a readiness, inspection or risk decision. Review the current app state and possible background work before confirming.</p>}
      <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> I reviewed this exact request and its required readiness, inspection and risk acknowledgements.</label>
      <div className="pane-buttons"><button disabled={disabled || !confirm} onClick={() => void decide({ action: 'approve', id: action.id, digest: action.digest, confirm: true }).then(ok => { if (ok) setConfirm(false); })}>Approve and run</button>
        <button disabled={disabled} onClick={() => void decide({ action: 'deny', id: action.id, digest: action.digest })}>Deny action</button></div>
    </>}
    {action.status === 'uncertain' && <details><summary>Record inspection</summary>
      <p>Inspect this action’s actual effects and the original app operation. This releases only Background’s action slot and never retries the operation or clears other app holds.</p>
      <label>Inspection note<textarea value={note} maxLength={1000} onChange={e => setNote(e.target.value)} /></label>
      <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> I inspected the possible effects and verified that the command has stopped.</label>
      <button disabled={disabled || !confirm || !note.trim()} onClick={() => void decide({ action: 'reconcile', id: action.id, digest: action.digest, confirm: true, note })}>Record inspected outcome</button>
    </details>}
  </li>;
}

/** Polling observes history. Only explicit form and button handlers authorize anything. */
export function BackgroundActions({ token, mode }: { token: string; mode: 'settings' | 'log' }) {
  const [view, setView] = useState<BackgroundActionView | null>(null), [before, setBefore] = useState<number | undefined>();
  const [draft, setDraft] = useState<BackgroundPermissions | null>(null), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [current, setCurrent] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const sequence = useRef(0), dirty = useRef(false);
  useEffect(() => { setConfirm(false); }, [mode]);
  async function refresh(signal?: AbortSignal) {
    const read = ++sequence.current;
    const next = await api<BackgroundActionView>(token, `background/actions${before ? `?before=${before}` : ''}`, { signal });
    if (signal?.aborted || read !== sequence.current) return;
    setView(next); setCurrent(true); if (!dirty.current) setDraft(next.permissions);
  }
  useEffect(() => {
    const abort = new AbortController(); let reading = false;
    const read = async () => { if (reading) return; reading = true;
      try { await refresh(abort.signal); } catch (e) { if (!abort.signal.aborted) { setCurrent(false); setError(e instanceof Error ? e.message : 'Could not read Background log.'); } }
      finally { reading = false; } };
    void read(); const timer = setInterval(() => void read(), 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [token, before]);
  async function decide(body: unknown) {
    if (busy) return false; setBusy(true); setError(''); setNotice('');
    try { await api(token, 'background/actions', { body }); await refresh(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Action changed.'); await refresh().catch(() => setCurrent(false)); return false; }
    finally { setBusy(false); }
  }
  return <section className="panel background-actions" aria-label={mode === 'log' ? 'Background action log' : 'Background action permissions'}>
    <h2>{mode === 'log' ? 'Log' : 'Action permissions'}</h2>
    {error && <p className="notice error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {mode === 'settings' && <>
      <p>Background can request app operations and host commands, including file changes. By default, each request waits for you in <strong>Log</strong>. Allowing a category lets future requests run without another confirmation.</p>
      <p className="fine">App actions use the app’s existing validation and operation records. Readiness and risk decisions need their own permission; delegated decisions are recorded as Background decisions and never become native process evidence.</p>
      <p className="warning-text">Host commands have the host user’s file and network access, including outside the working directory. App actions can also launch agents, send terminal input and change worktrees. The log records requested operations and their results, not every system call made by a program.</p>
      {draft && <form onSubmit={e => { e.preventDefault(); if (!confirm || busy || !current) return;
        void decide({ action: 'permissions', expectedRevision: draft.revision, app: draft.app, command: draft.command, risk: draft.risk, confirm: true }).then(ok => {
          if (ok) { dirty.current = false; setConfirm(false); setNotice('Saved action permissions. Existing proposals were not approved.'); void refresh(); }
        }); }}>
        {(Object.keys(permissionNames) as (keyof typeof permissionNames)[]).map(key => <label key={key}>{permissionNames[key]}<select value={draft[key]} onChange={e => { dirty.current = true; setConfirm(false); setDraft({ ...draft, [key]: e.target.value as 'ask' | 'allow' }); }}>
          <option value="ask">Ask every time</option><option value="allow">Allow without confirmation</option>
        </select></label>)}
        {view && draft.revision !== view.permissions.revision && <p role="alert">Permissions changed in another client. Reload them before saving.</p>}
        <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> I authorize these permissions for future Background requests and understand their access.</label>
        <button disabled={busy || !current || !confirm || draft.revision !== view?.permissions.revision}>Save action permissions</button>
        <button type="button" disabled={busy} onClick={() => { dirty.current = false; setConfirm(false); if (view) setDraft(view.permissions); }}>Reload permissions</button>
      </form>}
    </>}
    {mode === 'log' && <>
      <p>Requests, decisions, executions and tool calls are saved in the host database. Closing this page grants no approval. Unknown outcomes are retained and never automatically retried.</p>
      <h3>Actions needing attention</h3>
      {!view?.actions.length ? <p>No actions need confirmation or inspection.</p> : <ul className="attention-items">{view.actions.map(action => <ActionCard key={`${action.id}:${action.status}`} action={action} disabled={busy || !current} decide={decide} />)}</ul>}
      <h3>History</h3>{before && <button type="button" onClick={() => setBefore(undefined)}>Newest entries</button>}
      {!view?.entries.length ? <p>No Background actions have been recorded.</p> : <ol className="attention-items">{view.entries.map(entry => <li key={entry.id}>
        <div className="section-heading"><strong>{entry.kind}</strong><span className="fine">{new Date(entry.at).toLocaleString()} · {entry.actor}</span></div>
        <p>{entry.message}</p>{entry.actionId && <p className="fine">Action {entry.actionId}</p>}
        {entry.detail !== null && <details><summary>Details</summary><pre>{JSON.stringify(entry.detail, null, 2)}</pre></details>}
      </li>)}</ol>}
      {view?.next && <button type="button" disabled={busy} onClick={() => setBefore(view.next!)}>Older log entries</button>}
    </>}
  </section>;
}
