'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandRecord, SessionRegistration } from '../contracts/api';
import type { RelayRun, WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { RegisterPane } from './RegisterPane';
import { RelayPairs } from './RelayPairs';
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const PREFERENCE = 'codercrew.autoRelay';
const LAYOUT = 'codercrew.paneLayout';
const TURN_LIMIT = 'codercrew.turnLimit';
const DEFAULT_TURN_LIMIT = 20;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString();
interface AgentStatus { badge: 'working' | 'sending' | 'waiting' | 'attention' | 'idle'; detail: string; when: string | null }
/** One line per agent, derived only from server state: the active run and its current turn, or the agent's last recorded turn. */
function statusOf(agent: SessionRegistration, run: RelayRun | undefined, state: WorkflowState): AgentStatus {
  if (state.instances.find((i) => i.agentId === agent.id)?.status === 'replaced') {
    return { badge: 'attention', detail: 'The CLI in this pane exited or restarted since registration. Remove and re-register it before the next run.', when: null };
  }
  const active = run && (run.status === 'running' || run.status === 'paused') && run.participants.some((p) => p.id === agent.id);
  const execution = state.executions.find((e) => e.agentId === agent.id);
  const command = state.commands.find((c) => c.id === execution?.commandId);
  if (active && execution) {
    const task = execution.input.kind === 'relay' ? 'a review of the partner\'s work' : `"${execution.input.text}"`;
    if (run.status === 'paused') return { badge: 'attention', detail: `Paused while on ${task}. ${run.reason}`, when: run.updatedAt };
    if (execution.status === 'delivered') return { badge: 'working', detail: `Working on ${task}`, when: command?.createdAt ?? null };
    if (execution.status === 'uncertain') return { badge: 'attention', detail: 'Delivery uncertain; inspect the terminal before doing anything else.', when: run.updatedAt };
    return { badge: 'sending', detail: `Being sent ${task}`, when: null };
  }
  if (active) {
    const current = state.executions.find((e) => e.commandId === run.currentCommandId);
    const busy = run.participants.find((p) => p.id === current?.agentId);
    // A plain Send never routes to the partner; it is idle, not waiting for a turn that will not come.
    if (current?.input.kind === 'instruction' && current.input.handoff !== true) return { badge: 'idle', detail: `Idle. Not part of this turn; ${busy?.label ?? 'the partner'} is on a plain Send.`, when: null };
    return { badge: 'waiting', detail: `Waiting for ${busy?.label ?? 'the partner'} to finish`, when: null };
  }
  // A turn recorded before this registration belongs to an earlier CLI instance and says nothing about this one.
  const last = state.turns.find((t) => t.agentId === agent.id && t.receivedAt >= agent.registeredAt);
  if (!last) return { badge: 'idle', detail: 'Idle. No turn recorded for this registration yet.', when: null };
  const result = last.outcome ? `${last.outcome}${last.reason ? ` — ${last.reason}` : ''}` : 'finished; no RELAY-OUTCOME line';
  return { badge: 'idle', detail: `Idle. Last turn: ${result}`, when: last.receivedAt };
}
const Icon = ({ badge }: { badge: AgentStatus['badge'] }) => <span className={`state-icon ${badge}`} title={badge} aria-hidden="true" />;
/** Follows new output while the reader is at the bottom; a reader who scrolled up keeps their place. */
function Output({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null); const stick = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text]);
  return <pre ref={ref} tabIndex={0} aria-label={label} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }}>{text}</pre>;
}
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
  const [layout, setLayout] = useState<'parallel' | 'focus'>('parallel'); const [focusOverride, setFocusOverride] = useState<string | null>(null);
  const [turnLimit, setTurnLimit] = useState(String(DEFAULT_TURN_LIMIT));
  // History follows the selected pair by default; "All" or a specific pair is an explicit choice that then sticks.
  const [historyPair, setHistoryPair] = useState<'all' | 'selected' | string>('selected'); const [historyOrder, setHistoryOrder] = useState<'desc' | 'asc'>('desc');
  const submission = useRef(false); const generation = useRef(0); const readNumber = useRef(0);
  useEffect(() => { try { if (localStorage.getItem(PREFERENCE) === 'false') setAutoContinue(false); if (localStorage.getItem(LAYOUT) === 'focus') setLayout('focus');
    const limit = localStorage.getItem(TURN_LIMIT); if (limit && /^\d+$/.test(limit)) setTurnLimit(limit); } catch { /* preference only */ } }, []);
  const limitValue = /^\d+$/.test(turnLimit) ? Number(turnLimit) : NaN; const limitValid = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 200;
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
  const pairs = state?.pairs ?? [];
  const historicalPairIds = [...new Set((state?.commands ?? []).flatMap((command) => command.pairId ? [command.pairId] : []))]
    .filter((id) => !pairs.some((candidate) => candidate.id === id));
  const pair = pairs.find((p) => p.id === pairId);
  // The internal sentinel follows the active pair while the control shows that pair's single, starred option.
  const historyFilter = historyPair === 'selected' ? pair ? `pair:${pair.id}` : 'all' : historyPair;
  const visible = pair ? projectSessions.filter((s) => pair.sessions.includes(s.id)) : projectSessions;
  const owned = (state?.runs ?? []).filter((r) => r.repository === project && (r.status === 'running' || r.status === 'paused'));
  const transportHold = state?.reservations.find((r) => r.repository === project);
  const latestRun = owned[0] ?? state?.runs.find((r) => r.repository === project);
  const statuses = new Map(state ? projectSessions.map((s) => [s.id, statusOf(s, latestRun, state)] as const) : []);
  const working = projectSessions.find((s) => ['working', 'sending'].includes(statuses.get(s.id)?.badge ?? ''))?.id ?? null;
  const lastActive = [...projectSessions].sort((a, b) => (statuses.get(b.id)?.when ?? '').localeCompare(statuses.get(a.id)?.when ?? ''))[0]?.id ?? null;
  // A new working agent takes the focus back from a manual tab choice.
  useEffect(() => { if (working) setFocusOverride(null); }, [working]);
  const preferredFocus = focusOverride ?? working ?? lastActive ?? current?.id;
  const focused = visible.some((s) => s.id === preferredFocus) ? preferredFocus : visible[0]?.id;
  const shown = layout === 'focus' ? visible.filter((s) => s.id === focused) : visible;
  const chooseLayout = (next: 'parallel' | 'focus') => { setLayout(next); try { localStorage.setItem(LAYOUT, next); } catch { /* preference only */ } };
  const stale = !!error || clock - updated > 10000;
  const instance = state?.instances.find((i) => i.agentId === current?.id)?.status;
  const replaced = instance === 'replaced'; const instanceUnknown = state?.mode === 'tmux' && instance !== 'current';
  const available = state?.snapshots.find((s) => s.agentId === current?.id)?.status === 'available';
  const blocked = busy || stale || !state?.inputEnabled || !current?.registrationId || instanceUnknown || !available || owned.length > 0 || !!transportHold || !!unknownRequest || (!!pair && !limitValid);
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
        ...(pair ? { pairId: pair.id, turnLimit: limitValue } : {}), autoContinue: !!pair && autoContinue && (kind === 'relay' || handoff), confirmReady: true } });
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
    {state && !!sessions.length && project && <div className="pair-switcher">
      <RelayPairs token={token} sessions={sessions} pairs={pairs} repository={project}
        lockedRepositories={state.runs.filter((run) => run.status === 'running' || run.status === 'paused').map((run) => run.repository)}
        selectedPairId={pairId} disabled={busy}
        onSelectPair={(chosen) => { setPairId(chosen?.id ?? null); setFocusOverride(null); if (chosen) select(chosen.sessions.includes(current!.id) ? current!.id : chosen.sessions[0]); else setReady(false); }}
        onSelectProject={(root) => { setPairId(null); setFocusOverride(null); select(sessions.find((s) => s.repository === root)!.id); }}
        onChanged={(notice) => { setMessage(notice); void refresh(); }} />
    </div>}
    {!!sessions.length && <>
      <div className="target-row"><nav className="agent-tabs" aria-label="Command target">{visible.map((s) => <button key={s.id} className={s.id === current?.id ? 'selected' : ''} aria-pressed={s.id === current?.id} onClick={() => { select(s.id); setFocusOverride(s.id); }}>
          <Icon badge={statuses.get(s.id)?.badge ?? 'idle'} />{s.label}</button>)}</nav>
        <div className="row-tools"><div className="segmented" role="group" aria-label="Pane layout">
            <button className={layout === 'parallel' ? 'selected' : 'quiet'} aria-pressed={layout === 'parallel'} onClick={() => chooseLayout('parallel')}>Parallel</button>
            <button className={layout === 'focus' ? 'selected' : 'quiet'} aria-pressed={layout === 'focus'} onClick={() => chooseLayout('focus')}>Focus</button></div>
          <button className="quiet" disabled={busy} onClick={() => setAdding(true)}>+ Add pane</button></div></div>
      <p className="project-path mono muted">{project}</p>
      <section className={`panes ${layout}`} aria-label="Agent output">{shown.map((s) => {
        const snapshot = state?.snapshots.find((p) => p.agentId === s.id);
        const execution = state?.executions.find((e) => e.agentId === s.id);
        const ended = state?.turns.find((t) => t.agentId === s.id && t.receivedAt >= s.registeredAt);
        return <article key={s.id} className={`pane ${s.id === current?.id ? 'active' : ''}`}>
          <div className="pane-heading"><h2><Icon badge={statuses.get(s.id)?.badge ?? 'idle'} />{s.label}</h2><span className="mono muted">{s.agentType} · {s.identity.paneId}</span></div>
          <div className="pane-meta"><span>{s.repository}</span><span className="badge">{execution ? execution.status.toUpperCase() : 'NO ACTIVE CONTROLLER TURN'}</span></div>
          {ended?.outcome && <div className={`outcome ${ended.outcome}`}>{ended.outcome}: {ended.reason}</div>}
          <Output label={`${s.label} output`} text={(snapshot?.status === 'unavailable' ? snapshot.error : snapshot?.text) || 'Waiting for a capture'} />
          <div className="pane-footer"><span>{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : ''}</span>
            {removeId === s.id ? <span>Forget this registration? <button disabled={busy} onClick={() => void remove(s)} aria-label={`Confirm remove ${s.label}`}>Confirm</button><button onClick={() => setRemoveId(null)}>Keep</button></span>
              : <button className="quiet" aria-label={`Remove ${s.label}`} disabled={busy || owned.length > 0} onClick={() => setRemoveId(s.id)}>Remove</button>}</div>
        </article>;
      })}</section>
      {state && <details className="panel status" open>
        <summary><h2>Status</h2>
          {latestRun && <span className={`badge ${latestRun.status === 'paused' ? 'warning' : ''}`}>{latestRun.status === 'running' ? 'RUN ACTIVE' : `RUN ${latestRun.status.toUpperCase()}`} · {latestRun.automaticTurns}/{latestRun.turnLimit} automatic turns</span>}</summary>
        {latestRun ? <p className="muted">{latestRun.participants.map((p) => p.label).join(' ⇄ ')}{latestRun.pairId ? ` (pair "${latestRun.pairId}")` : ' (single-agent turn)'} · {latestRun.reason} · {timeOf(latestRun.updatedAt)}</p>
          : <p className="muted">No run has been started in this project.</p>}
        <table><thead><tr><th>Agent</th><th>State</th><th>Detail</th><th>When</th></tr></thead>
          <tbody>{projectSessions.map((s) => { const status = statuses.get(s.id)!;
            return <tr key={s.id}><td>{s.label} <small className="mono muted">{s.agentType}</small></td>
              <td><span className="state"><Icon badge={status.badge} />{status.badge}</span></td>
              <td className="command-text">{status.detail}</td><td className="mono muted">{status.when ? timeOf(status.when) : ''}</td></tr>; })}</tbody></table>
      </details>}
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
      {replaced && <div className="notice">The CLI in {current?.label}'s pane exited or restarted since registration. Remove it and register the pane again (+ Add pane) before sending.</div>}
      {instanceUnknown && !replaced && <div className="notice">The host cannot confirm the CLI process in {current?.label}'s pane. Re-register it before sending.</div>}
      {transportHold && !owned.length && <div className="notice">An older uncertain delivery holds this project. Inspect its terminals and any partially typed input before acknowledging. Nothing is replayed. <button disabled={busy} onClick={() => void releaseLegacy()}>I checked the legacy delivery</button></div>}
      <section className="composer"><div className="section-heading"><h2>Send to {current?.label}</h2><span className="badge">{owned.length ? 'EXECUTION OWNED' : 'MANUAL START'}</span></div>
        {!state?.inputEnabled && <p>Read-only console: the host has disabled input.</p>}
        <form onSubmit={(e) => { e.preventDefault(); void send('instruction'); }}>
          <label className="sr-only" htmlFor="instruction">Instruction to {current?.label}</label>
          <div className="command-line"><textarea id="instruction" autoComplete="off" rows={3} value={text} disabled={blocked} maxLength={1900} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send('instruction'); } }} placeholder="Instruction or optional review context. ⌘/Ctrl+Enter sends." />
            <button className="primary" disabled={blocked || !ready || !text.trim()}>Send</button>
            <button type="button" disabled={blocked || !ready || !text.trim() || !pair} onClick={() => void send('instruction', true)}>Send &amp; relay ↗</button>
            <button type="button" disabled={blocked || !ready} onClick={() => void send('relay')}>Relay ↗</button></div>
          <label className="readiness"><input type="checkbox" aria-label="Ready to send" checked={ready} disabled={blocked} onChange={(e) => setReady(e.target.checked)} />
            I checked that all participants are at empty prompts, have no background writers, use their standard Git index, and will remain under controller ownership for this run.</label>
        </form>
        {pair && <label className="readiness auto"><input type="checkbox" aria-label="Auto-relay" checked={autoContinue} disabled={busy || owned.length > 0} onChange={(e) => { setAutoContinue(e.target.checked); try { localStorage.setItem(PREFERENCE, String(e.target.checked)); } catch { /* preference only */ } }} />
          Prefer automatic continuation for the next explicitly started run of pair "{pair.name}". Plain Send never relays; Send &amp; relay requests one review even when this preference is off, and only if the worker changed the worktree.</label>}
        {pair && <label className="readiness turn-limit">Maximum automatic turns per run
          <input type="number" inputMode="numeric" aria-label="Maximum automatic turns" min={1} max={200} step={1} value={turnLimit} disabled={busy || owned.length > 0} aria-invalid={!limitValid}
            onChange={(e) => { setTurnLimit(e.target.value); try { localStorage.setItem(TURN_LIMIT, e.target.value); } catch { /* preference only */ } }} />
          <span className="muted">1–200, default {DEFAULT_TURN_LIMIT}; frozen into the run when it starts.</span></label>}
        <p className="fine">The server validates and deduplicates correlated completions. Unknown background-work state pauses a run. No fresh-event effect in this page sends commands.</p>
      </section>
      <details className="history"><summary>Command history</summary>
        <div className="history-tools">
          <label>Pair <select aria-label="History pair filter" value={historyFilter} onChange={(e) => setHistoryPair(pair && e.target.value === `pair:${pair.id}` ? 'selected' : e.target.value)}>
            <option value="all">All</option>
            {pairs.map((p) => <option key={p.id} value={`pair:${p.id}`}>{p.name} ({nameOf(p.repository)}){p.id === pair?.id ? ' *' : ''}</option>)}
            {historicalPairIds.map((id) => <option key={id} value={`pair:${id}`}>{id} (removed)</option>)}
          </select></label>
          <button type="button" className="quiet" aria-label="Toggle history order" onClick={() => setHistoryOrder((o) => o === 'desc' ? 'asc' : 'desc')}>{historyOrder === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}</button>
        </div>
        {(() => {
          const wanted = historyFilter.startsWith('pair:') ? historyFilter.slice(5) : undefined;
          const rows = (state?.commands ?? []).filter((c) => historyFilter === 'all' || (wanted !== undefined && c.pairId === wanted));
          if (historyOrder === 'asc') rows.reverse(); // The server supplies stable newest-first append order; reversing preserves timestamp ties.
          return rows.length ? <table><thead><tr><th>Time</th><th>Agent</th><th>Pair</th><th>Command</th><th>Delivery</th></tr></thead>
            <tbody>{rows.map((c) => <tr key={c.id}><td className="mono muted">{new Date(c.createdAt).toLocaleString()}</td><td>{sessions.find((s) => s.id === c.agentId)?.label ?? c.agentId}</td>
              <td className="muted">{c.pairId ? state?.pairs.find((p) => p.id === c.pairId)?.name ?? c.pairId : ''}</td><td className="command-text">{c.text}</td><td>{c.status}</td></tr>)}</tbody></table>
            : <p className="empty-history">No commands match this filter.</p>;
        })()}</details>
    </>}
    {message && <p className="feedback" role="status">{message}</p>}
    <p className="fine">Pause a run before manual terminal takeover. Locking this view or disconnecting your phone does not interrupt workers.</p>
  </main>;
}
