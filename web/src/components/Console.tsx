'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandRecord, SessionRegistration } from '../contracts/api';
import type { RelayRun, WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { RegisterPane } from './RegisterPane';
import { RelayPairs } from './RelayPairs';
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const PREFERENCE = 'codercrew.autoRelay';
/** A view and command client. There is intentionally no effect that sends another turn. */
export function Console() {
  const [token, setToken] = useState(''); const [draftToken, setDraftToken] = useState('');
  const [state, setState] = useState<WorkflowState | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [pairId, setPairId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); const [text, setText] = useState(''); const [ready, setReady] = useState(false);
  const [autoContinue, setAutoContinue] = useState(true); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [updated, setUpdated] = useState(0);
  const [clock, setClock] = useState(Date.now()); const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<string | null>(null); const [removeId, setRemoveId] = useState<string | null>(null);
  const submission = useRef(false); const generation = useRef(0); const readNumber = useRef(0);
  useEffect(() => { try { if (localStorage.getItem(PREFERENCE) === 'false') setAutoContinue(false); } catch { /* preference only */ } }, []);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const read = ++readNumber.current; const version = generation.current;
    try { const next = await api<WorkflowState>(token, 'state', { signal });
      if (version === generation.current && read === readNumber.current) { setState(next); setUpdated(Date.now()); setError(''); }
    } catch (caught) { if (!signal?.aborted && version === generation.current && read === readNumber.current) setError(caught instanceof Error ? caught.message : 'Connection failed.'); }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(abort.signal); if (!abort.signal.aborted) timer = setTimeout(poll, 2000); };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [token, refresh]);
  const sessions = state?.sessions ?? [];
  const current = sessions.find((s) => s.id === selected) ?? sessions[0];
  const project = current?.repository;
  const projects = [...new Set(sessions.map((s) => s.repository))];
  const projectSessions = sessions.filter((s) => s.repository === project);
  const pairs = (state?.pairs ?? []).filter((p) => p.repository === project);
  const pair = pairs.find((p) => p.id === pairId);
  const visible = pair ? projectSessions.filter((s) => pair.sessions.includes(s.id)) : projectSessions;
  const owned = (state?.runs ?? []).filter((r) => r.repository === project && (r.status === 'running' || r.status === 'paused'));
  const transportHold = state?.reservations.find((r) => r.repository === project);
  const stale = !!error || clock - updated > 10000;
  const available = state?.snapshots.find((s) => s.agentId === current?.id)?.status === 'available';
  const blocked = busy || stale || !state?.inputEnabled || !current?.registrationId || !available || owned.length > 0 || !!transportHold || !!unknownRequest;
  const select = (id: string) => { setSelected(id); setReady(false); setText(''); setMessage(''); };
  function lock() {
    generation.current++; readNumber.current++; setToken(''); setDraftToken(''); setState(null); setReady(false);
    setSelected(null); setPairId(null); setMessage(''); setError(''); setUnknownRequest(null);
  }
  async function send(kind: 'relay' | 'instruction', handoff = false) {
    if (blocked || !ready || !current || submission.current) return;
    submission.current = true; setBusy(true); setReady(false);
    const requestId = crypto.randomUUID();
    try {
      const record = await api<CommandRecord>(token, 'commands', { body: { requestId, agentId: current.id, kind,
        ...(text.trim() ? { text: text.trim() } : {}), handoff,
        ...(pair ? { pairId: pair.id } : {}), autoContinue: !!pair && autoContinue && (kind === 'relay' || handoff), confirmReady: true } });
      setMessage(`${record.status.toUpperCase()}: ${record.error ?? 'Terminal delivery recorded. The server owns this run until completion or human takeover.'}`);
      if (record.status !== 'rejected') setText('');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Command failed.');
      if (!(caught instanceof HttpError) || caught.status >= 500) setUnknownRequest(requestId);
    } finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function action(run: RelayRun, operation: 'pause' | 'takeover') {
    if (submission.current) return;
    submission.current = true; setBusy(true);
    try {
      await api(token, 'runs', { body: { runId: run.id, action: operation, ...(operation === 'takeover' ? { confirmReady: true } : {}) } });
      setMessage(operation === 'pause' ? 'Run paused. The current agent was not interrupted.' : 'Human takeover recorded. Nothing was replayed or marked successful.');
      if (operation === 'pause') setTakeover(run.id); else { setTakeover(null); setReady(false); }
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Action failed.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function releaseLegacy() {
    if (!transportHold || submission.current) return;
    submission.current = true; setBusy(true);
    try { await api(token, 'control/release', { body: { expectedCommandId: transportHold.activeCommandId, confirmReady: true } });
      setMessage('Legacy delivery acknowledged. Nothing was replayed or marked successful.');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Could not acknowledge delivery.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  async function remove(session: SessionRegistration) {
    if (submission.current) return;
    submission.current = true; setBusy(true);
    try { await api(token, `sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }); setMessage(`Removed ${session.label}. No process was stopped.`); setRemoveId(null); }
    catch (caught) { setMessage(caught instanceof Error ? caught.message : 'Removal failed.'); }
    finally { await refresh(); submission.current = false; setBusy(false); }
  }
  if (!token) return <main className="unlock-shell">
    <div className="wordmark"><span className="brand-mark">C</span> CoderCrew</div>
    <section className="unlock-card"><p className="eyebrow">YOUR AGENTS. ONE CONSOLE.</p><h1>Stay in control.</h1>
      <form onSubmit={(e) => { e.preventDefault(); setToken(draftToken.trim()); setDraftToken(''); }}>
        <label htmlFor="token">Host access token</label><input id="token" type="password" autoComplete="off" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} required />
        <button className="primary">Open console</button>
      </form><p className="fine">The token stays in page memory. Locking or closing this page does not pause a server-owned run.</p>
    </section></main>;
  return <main className="console-shell">
    <header className="topbar"><div className="wordmark"><span className="brand-mark">C</span> CoderCrew</div>
      <div className="toolbar"><span className="badge">{state?.mode === 'mock' ? 'MOCK MODE' : 'LOCAL HOST'}</span><button className="quiet" onClick={lock} disabled={busy}>Lock</button></div></header>
    <div className="page-heading"><div><p className="eyebrow">SERVER-OWNED RUNS</p><h1>Agent console</h1><p className="muted">Viewing another project never changes a running relay.</p></div>
      <div className="connection">{stale ? 'Not current' : 'Connected'}<small>{updated ? new Date(updated).toLocaleTimeString() : 'Connecting'}</small></div></div>
    {error && <div className="notice error" role="alert">{error} <button onClick={() => void refresh()}>Refresh</button></div>}
    {state?.mode === 'mock' && <div className="notice">Simulated panes. No commands reach real terminals.</div>}
    {state && (adding || !sessions.length) && <RegisterPane token={token} panes={state.panes} panesError={state.panesError} disabled={busy}
      project={project} projects={projects} sessions={sessions} onClose={sessions.length ? () => setAdding(false) : undefined}
      onRegistered={(session, replaced) => { setSelected(session.id); setPairId(null); setReady(false); setAdding(false);
        setMessage(`Registered "${session.label}" at ${session.identity.paneId}${replaced ? '; previous instance replaced' : ''}.`); void refresh(); }} />}
    {projects.length > 1 && <nav className="project-tabs" aria-label="Project">{projects.map((p) => <button key={p} aria-pressed={p === project} className={p === project ? 'selected' : ''}
      onClick={() => { select(sessions.find((s) => s.repository === p)!.id); setPairId(null); }}>{nameOf(p)}</button>)}</nav>}
    {!!sessions.length && <>
      <div className="target-row"><nav className="agent-tabs" aria-label="Command target">{visible.map((s) => <button key={s.id} className={s.id === current?.id ? 'selected' : ''} aria-pressed={s.id === current?.id} onClick={() => select(s.id)}>{s.label}</button>)}</nav>
        <button className="quiet" disabled={busy} onClick={() => setAdding(true)}>+ Add pane</button></div>
      <p className="project-path mono muted">{project}{pair ? ` · showing pair "${pair.name}"` : ''}</p>
      <section className="panes" aria-label="Agent output">{visible.map((s) => {
        const snapshot = state?.snapshots.find((p) => p.agentId === s.id);
        const execution = state?.executions.find((e) => e.agentId === s.id);
        const ended = state?.turns.find((t) => t.agentId === s.id);
        return <article key={s.id} className={`pane ${s.id === current?.id ? 'active' : ''}`}>
          <div className="pane-heading"><h2>{s.label}</h2><span className="mono muted">{s.agentType} · {s.identity.paneId}</span></div>
          <div className="pane-meta"><span>{s.repository}</span><span className="badge">{execution ? execution.status.toUpperCase() : 'NO ACTIVE CONTROLLER TURN'}</span></div>
          {ended?.outcome && <div className={`outcome ${ended.outcome}`}>{ended.outcome}: {ended.reason}</div>}
          <pre tabIndex={0} aria-label={`${s.label} output`}>{snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text || 'Waiting for a capture'}</pre>
          <div className="pane-footer"><span>{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : ''}</span>
            {removeId === s.id ? <span>Forget this registration? <button disabled={busy} onClick={() => void remove(s)} aria-label={`Confirm remove ${s.label}`}>Confirm</button><button onClick={() => setRemoveId(null)}>Keep</button></span>
              : <button className="quiet" aria-label={`Remove ${s.label}`} disabled={busy || owned.length > 0} onClick={() => setRemoveId(s.id)}>Remove</button>}</div>
        </article>;
      })}</section>
      {owned.map((run) => <section key={run.id} className="panel" aria-label="Active run">
        <div className="section-heading"><h2>{run.status === 'paused' ? 'Run paused' : 'Run active'}</h2><span className="badge">{run.automaticTurns}/{run.turnLimit} automatic turns</span></div>
        <p>{run.participants.map((s) => s.label).join(' ⇄ ')} · {run.pairId ?? 'single-agent turn'}</p><p>{run.reason}</p>
        <button disabled={busy} onClick={() => void action(run, 'pause')}>Pause / take over</button>
        {takeover === run.id && <div className="notice">Pause does not interrupt any process. Inspect all participants, stop background writers, and resolve any partially typed input before releasing ownership.
          <button disabled={busy} onClick={() => void action(run, 'takeover')}>I checked every participant; release ownership</button><button onClick={() => setTakeover(null)}>Keep paused</button></div>}
      </section>)}
      {unknownRequest && <div className="notice error" role="alert">Request {unknownRequest} has an uncertain HTTP result. Inspect its server run and the terminal; do not resend it.
        <button onClick={() => setUnknownRequest(null)}>I checked the server and terminal</button></div>}
      {!current?.registrationId && <div className="notice">This registration predates the run protocol. Re-register it before sending.</div>}
      {transportHold && !owned.length && <div className="notice">An older uncertain delivery holds this project. Inspect its terminals and any partially typed input before acknowledging. Nothing is replayed. <button disabled={busy} onClick={() => void releaseLegacy()}>I checked the legacy delivery</button></div>}
      <section className="composer"><div className="section-heading"><h2>Send to {current?.label}</h2><span className="badge">{owned.length ? 'EXECUTION OWNED' : 'MANUAL START'}</span></div>
        {!state?.inputEnabled && <p>Read-only console: the host has disabled input.</p>}
        <form onSubmit={(e) => { e.preventDefault(); void send('instruction'); }}>
          <label className="sr-only" htmlFor="instruction">Instruction to {current?.label}</label>
          <div className="command-line"><input id="instruction" autoComplete="off" value={text} disabled={blocked} maxLength={1900} onChange={(e) => setText(e.target.value)} placeholder="Instruction or optional review context" />
            <button className="primary" disabled={blocked || !ready || !text.trim()}>Send</button>
            <button type="button" disabled={blocked || !ready || !text.trim() || !pair} onClick={() => void send('instruction', true)}>Send &amp; relay ↗</button>
            <button type="button" disabled={blocked || !ready} onClick={() => void send('relay')}>Relay ↗</button></div>
          <label className="readiness"><input type="checkbox" aria-label="Ready to send" checked={ready} disabled={blocked} onChange={(e) => setReady(e.target.checked)} />
            I checked that all participants are at empty prompts, have no background writers, use their standard Git index, and will remain under controller ownership for this run.</label>
        </form>
        <label className="readiness auto"><input type="checkbox" aria-label="Auto-relay" checked={autoContinue} disabled={!pair || busy || owned.length > 0} onChange={(e) => { setAutoContinue(e.target.checked); try { localStorage.setItem(PREFERENCE, String(e.target.checked)); } catch { /* preference only */ } }} />
          Prefer automatic continuation for the next explicitly started run. Select a pair below to arm it. Plain Send never relays; Send &amp; relay requests one review even when this preference is off.</label>
        <p className="fine">The server validates and deduplicates correlated completions. Unknown background-work state pauses a run. No fresh-event effect in this page sends commands.</p>
      </section>
      {project && state && <RelayPairs token={token} sessions={projectSessions} pairs={pairs} selectedPairId={pairId} disabled={busy || owned.length > 0}
        onSelectPair={(id) => { setPairId(id); setReady(false); const chosen = pairs.find((p) => p.id === id); if (chosen && !chosen.sessions.includes(current!.id)) setSelected(chosen.sessions[0]); }}
        onChanged={(notice) => { setMessage(notice); void refresh(); }} />}
      <details className="history"><summary>Command history</summary><table><thead><tr><th>Agent</th><th>Command</th><th>Delivery</th></tr></thead>
        <tbody>{state?.commands.map((c) => <tr key={c.id}><td>{sessions.find((s) => s.id === c.agentId)?.label ?? c.agentId}</td><td>{c.text}</td><td>{c.status}</td></tr>)}</tbody></table></details>
    </>}
    {message && <p className="feedback" role="status">{message}</p>}
    <p className="fine">Pause a run before manual terminal takeover. Locking this view or disconnecting your phone does not interrupt workers.</p>
  </main>;
}
