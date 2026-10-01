'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalAIPreview, GlobalAIView, ToolReply } from '../contracts/global-ai';
import type { LaunchProfile } from '../contracts/launches';
import { api, HttpError } from '../client/api';
import { MemoryContext, type PageMemory } from '../client/memory';
import { NativeTerminal } from './NativeTerminal';
import styles from './GlobalAI.module.css';

type View = GlobalAIView & { profiles: LaunchProfile[]; roots: string[]; rootsTruncated: boolean; fallback: string; capturedAt: string; manualHeld: boolean };
type RunSummary = { id: string; workspace: string; status: string; reason: string };
const examples = ['Why is this run blocked, and what should I do next?', 'Which shared runs need my attention?', 'Explain Commit versus Relay in this installed version.'];

/** A native conversation and read-evidence panel, not another task composer or autonomous scheduler. */
export function GlobalAI() {
  const [token, setToken] = useState(''), [entered, setEntered] = useState('');
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [profile, setProfile] = useState(''), [roots, setRoots] = useState<string[]>([]), [preview, setPreview] = useState<GlobalAIPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [unknownStart, setUnknownStart] = useState(false);
  const [memory, setMemory] = useState<PageMemory>(() => new Map());
  const [client, setClient] = useState(''), [runs, setRuns] = useState<RunSummary[]>([]), [evidence, setEvidence] = useState<ToolReply | null>(null);
  const credential = useRef('');
  const epoch = useRef(0), reading = useRef(false), operating = useRef(false);
  useEffect(() => { setClient(crypto.randomUUID()); }, []);
  const refresh = useCallback(async () => {
    if (!token || credential.current !== token || reading.current) return;
    const generation = epoch.current; reading.current = true;
    try {
      const next = await api<View>(token, 'global-ai');
      if (generation === epoch.current && credential.current === token) { setView(next); setError(''); }
    } catch (e) { if (generation === epoch.current && credential.current === token) setError(e instanceof Error ? e.message : 'Could not read Global AI state.'); }
    finally { reading.current = false; }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [token, refresh]);
  async function action(body: unknown): Promise<unknown> {
    return api(token, 'global-ai', { body });
  }
  async function operate(work: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Operation failed; inspect its recorded state.'); }
    finally { operating.current = false; setBusy(false); await refresh(); }
  }
  function lock() {
    const oldCredential = token;
    credential.current = '';
    epoch.current++; setToken(''); setEntered(''); setView(null); setPreview(null); setConfirmed(false); setEvidence(null); setRuns([]); setMemory(new Map()); setNotice(''); setError('');
    if (oldCredential && client) void api(oldCredential, 'terminals/revoke', { body: { clientInstanceId: client } }).catch(() => {});
    // The native component unmounts. Session lifetime and unresolved manual holds stay host-owned.
  }
  const inspectRead = async (name: string, args: Record<string, unknown> = {}) => {
    const generation = epoch.current;
    const result = await action({ action: 'read', name, arguments: args }) as ToolReply;
    if (generation !== epoch.current) return;
    setEvidence(result);
    if (name === 'list_runs') setRuns((result.data as { runs: RunSummary[] }).runs);
  };
  const change = () => { setPreview(null); setConfirmed(false); };
  return <MemoryContext.Provider value={memory}><main className={styles.page}>
    <header className={styles.header}><div><a href="/">AltCLI Console</a><h1>Global AI</h1><p>A separate conversation with read-only app context. No background jobs or automatic approvals.</p></div>
      {token && <button type="button" onClick={lock}>Lock this page</button>}</header>
    {!token ? <form className={styles.panel} onSubmit={e => { e.preventDefault(); epoch.current++; credential.current = entered.trim(); setToken(entered.trim()); setEntered(''); }}>
      <label>AltCLI access token<input autoComplete="off" type="password" value={entered} onChange={e => setEntered(e.target.value)} required /></label>
      <button>Unlock Global AI</button><p>The token stays in this page's memory. It is never supplied to the AI.</p>
    </form> : <>
      {error && <p role="alert" className={styles.warning}>{error}</p>}{notice && <p role="status">{notice}</p>}
      {!view && <p>Loading host state…</p>}
      {view && <>
        <section className={styles.panel} aria-label="Global AI instance">
          <h2>{view.instance ? `Conversation · ${view.instance.profile.label}` : 'Start a conversation'}</h2>
          <p>Uses the selected CLI's existing sign-in and allowance. No paid fallback is selected. Actual model and remaining quota are unknown.</p>
          {!view.enabled && <p className={styles.warning}>Starting Global AI requires a tmux host with input, native terminal and agent-launch flags enabled. App evidence remains readable.</p>}
          {view.instance ? <>
            <p><strong>{view.instance.status}</strong> · {view.nativeState}. {view.nativeMessage}</p>
            <p>AltCLI tools: {view.toolsEnabled ? `read-only access until ${view.toolsExpireAt}` : 'revoked, expired or not authorized in this host boot'}</p>
            <p>Shared workspace roots: {view.instance.roots.length ? view.instance.roots.join(', ') : 'none (documentation only)'}</p>
            <details><summary>Launch identity and command</summary><p>{view.instance.id}</p><p>{view.instance.directory}</p><pre>{JSON.stringify([view.instance.executable, ...view.instance.args], null, 2)}</pre></details>
            <div className={styles.tools}>
              <button type="button" disabled={busy} onClick={() => void operate(async () => { await action({ action: 'revoke' }); setNotice('AltCLI tool access revoked. The CLI and its conversation were not stopped.'); })}>Revoke app tools</button>
              <button type="button" disabled={busy || !view.enabled || view.instance.status !== 'started'} onClick={() => {
                const id = view.instance!.id;
                if (window.confirm('Restore read-only app tools for this conversation and its original shared roots? This starts no task or new CLI.'))
                  void operate(async () => { await action({ action: 'refresh-tools', instanceId: id, confirm: true }); });
              }}>Refresh original app access</button>
              <button type="button" disabled={busy} onClick={() => {
                const id = view.instance!.id;
                if (window.confirm('Retire this app instance and revoke its tools? This does NOT stop its CLI, remove its tmux session, erase shared context or settle manual input. You can exit the CLI in its terminal first.'))
                  void operate(async () => { await action({ action: 'retire', instanceId: id, confirm: true }); change(); setNotice('App access retired; original tmux session and history retained.'); });
              }}>Retire app access</button>
            </div>
          </> : <>
            <label>Launch profile<select aria-label="Global AI launch profile" value={profile} disabled={busy || unknownStart} onChange={e => { setProfile(e.target.value); change(); }}>
              <option value="">Choose a Codex profile</option>{view.profiles.filter(p => p.enabled && p.adapterHint === 'codex').map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select></label>
            <p>Create profiles in Console → Settings. A1 supports direct Codex with model/reasoning options, not arbitrary wrappers. Nothing launches on page load.</p>
            <fieldset disabled={busy || unknownStart}><legend>Share app records for these workspaces</legend>
              {!view.roots.length && <p>No repositories are required for app help.</p>}
              {view.roots.map(root => <label className={styles.choice} key={root}><input type="checkbox" checked={roots.includes(root)} onChange={e => { setRoots(e.target.checked ? [...roots, root] : roots.filter(r => r !== root)); change(); }} />{root}</label>)}
              <p>Only these app records enter MCP context. Selecting another Console workspace never changes this scope. The user-operated CLI is not an OS sandbox for those roots.</p>
            </fieldset>
            <button type="button" disabled={busy || !profile || !view.enabled || unknownStart} onClick={() => void operate(async () => {
              const generation = epoch.current;
              const result = await action({ action: 'preview', profileId: profile, roots }) as GlobalAIPreview;
              if (generation === epoch.current) { setPreview(result); setConfirmed(false); }
            })}>Preview Global AI launch</button>
            {preview && <div className={styles.preview}><p>{preview.sessionName}</p><p>{preview.directory}</p><pre>{JSON.stringify([preview.executable, ...preview.args], null, 2)}</pre>
              <label className={styles.choice}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I approve this native launch and sharing the selected app context with its model provider.</label>
              <button type="button" disabled={busy || !confirmed || unknownStart} onClick={() => void operate(async () => {
                const generation = epoch.current; setUnknownStart(true); setConfirmed(false);
                try { await action({ action: 'start', id: preview.id, digest: preview.digest, requestId: crypto.randomUUID(), confirm: true }); }
                catch (e) { if (e instanceof HttpError && e.status < 500 && generation === epoch.current) setUnknownStart(false); throw e; }
                if (generation === epoch.current) { setUnknownStart(false); setPreview(null); }
              })}>Start Global AI</button>
            </div>}
            {unknownStart && <p role="alert">The start response needs inspection. Do not repeat it. <button type="button" onClick={() => void operate(async () => { const next = await api<View>(token, 'global-ai'); setView(next); if (next.instance) setUnknownStart(false); })}>Inspect recorded instance</button></p>}
          </>}
        </section>
        {view.instance?.identity && view.instance.sessionId && client && view.nativeState !== 'unavailable' && <section className={styles.terminal} aria-label="Global AI native terminal">
          <NativeTerminal key={view.instance.id} token={token} target={{ launchId: view.instance.id }} clientInstanceId={client} label="Global AI"
            fallback={<pre>{view.fallback || 'Waiting for an observed native terminal.'}</pre>} capturedAt={view.capturedAt} held={view.manualHeld}
            inputEnabled={view.enabled} refresh={refresh} viewEpoch={view.instance.id} />
        </section>}
        {view.manualHeld && <p className={styles.warning}>Manual terminal input holds managed automation across the tmux server. Display stops this page's typing; use Console → Control access to inspect and reconcile. Reading app tools does not clear that hold.</p>}
        <section className={styles.panel} aria-label="Live app evidence"><h2>Evidence, not another prompt</h2>
          <p>Ask questions directly in the native terminal. For example: {examples.join(' · ')}</p>
          <div className={styles.tools}>
            <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('list_runs'))}>Inspect shared runs</button>
            <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('get_capabilities'))}>Installed capabilities</button>
            <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('read_doc', { document: 'docs/GLOBAL-AI.md' }))}>Operating guide</button>
          </div>
          {runs.map(run => <article key={run.id} className={styles.run}><strong>{run.status}</strong> · {run.workspace}<p>{run.reason}</p><code>{run.id}</code>
            <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('get_run', { runId: run.id }))}>Inspect this run</button></article>)}
          {evidence && <details open><summary>{evidence.source} · observed {evidence.observedAt}</summary><p>Revision: <code>{evidence.revision}</code></p><pre className={styles.evidence}>{JSON.stringify(evidence.data, null, 2)}</pre></details>}
          <p><a href="/" target="_blank" rel="noopener">Open Console recovery controls</a>. Inspect the named workspace/run before choosing an action. Navigation never approves or resumes it.</p>
        </section>
      </>}
    </>}
  </main></MemoryContext.Provider>;
}
