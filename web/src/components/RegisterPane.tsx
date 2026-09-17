'use client';
import { useEffect, useState } from 'react';
import type { AgentType, AvailablePane, PanePreview, RegistrationResult, SessionRegistration } from '../contracts/api';
import { assertAgentCommand, suggestAgentType } from '../core/policy';
import { slugify } from '../core/validation';
import { api } from '../client/api';
interface Props {
  token: string; panes: AvailablePane[]; panesError: string | null; disabled: boolean;
  onRegistered: (session: SessionRegistration, replaced: boolean) => void;
  onClose?: () => void; hint?: string; project?: string; projects: string[]; sessions?: SessionRegistration[];
}
export function RegisterPane({ token, panes, panesError, disabled, onRegistered, onClose, sessions = [] }: Props) {
  const [id, setId] = useState(''); const [label, setLabel] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('other'); const [relayPrompt, setRelayPrompt] = useState('relay');
  const [preview, setPreview] = useState<PanePreview | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const pane = panes.find((p) => p.identity.paneId === id);
  let existing: SessionRegistration | undefined;
  try { existing = sessions.find((s) => s.id === slugify(label)); } catch { /* incomplete label */ }
  useEffect(() => {
    setPreview(null); if (!id) return;
    const abort = new AbortController();
    api<PanePreview>(token, `panes/preview?paneId=${encodeURIComponent(id)}`, { signal: abort.signal })
      .then(setPreview).catch((e) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Preview failed.'); });
    return () => abort.abort();
  }, [id, token]);
  function choose(p: AvailablePane) {
    setId(p.identity.paneId); setReplace(false); setError('');
    const old = sessions.find((s) => s.id === p.registeredAs);
    setAgentType(old?.agentType ?? suggestAgentType(p.command)); setRelayPrompt(old?.relayPrompt ?? 'relay');
    setLabel(old?.label ?? `${suggestAgentType(p.command)} ${p.identity.paneId}`);
  }
  async function register() {
    if (!pane || busy || disabled || (existing && !replace)) return;
    setBusy(true); setError('');
    try {
      // The backend derives Git root/index from the actual pane CWD. An ancestor path is not proof of one worktree.
      const result = await api<RegistrationResult>(token, 'sessions', { body: { paneId: id, label, agentType, relayPrompt } });
      onRegistered(result.session, result.replaced);
    } catch (e) { setError(e instanceof Error ? e.message : 'Registration failed.'); }
    finally { setBusy(false); }
  }
  return <section className="panel register" aria-labelledby="register-heading">
    <div className="section-heading"><h2 id="register-heading">Choose the pane that runs a coding CLI</h2>{onClose && <button onClick={onClose} disabled={busy}>Cancel</button>}</div>
    <p className="muted">Directories shown here are working directories, not verified repository identities. The server discovers the canonical worktree and index when you register.</p>
    {panesError && <p className="notice error" role="alert">{panesError}</p>}
    {!panes.length && !panesError && <p>Start your coding CLIs in tmux on this host.</p>}
    <ul className="pane-list" aria-label="Live tmux panes">{panes.map((p) => {
      let blocked = p.dead || p.inMode || p.synchronized;
      try { assertAgentCommand(p.command); } catch { blocked = true; }
      return <li key={p.identity.paneId} className={p.identity.paneId === id ? 'selected' : blocked ? 'blocked' : ''}>
        <span className="mono">{p.location} · {p.identity.paneId}</span><span>{p.command}</span><span className="cwd">{p.cwd}</span>
        {blocked ? <span>Not an eligible foreground CLI, or unsafe pane mode.</span> : <button disabled={disabled || busy} aria-label={`Select ${p.identity.paneId}`} onClick={() => choose(p)}>{p.registeredAs ? 'Rebind' : 'Select'}</button>}
      </li>;
    })}</ul>
    {pane && <form onSubmit={(e) => { e.preventDefault(); void register(); }}>
      <pre className="preview" aria-label={`Preview of ${id}`}>{preview?.text ?? 'Loading preview…'}</pre>
      <div className="register-grid"><div className="field"><label htmlFor="register-label">Label</label><input id="register-label" maxLength={40} value={label} disabled={busy} onChange={(e) => { setLabel(e.target.value); setReplace(false); }} required /></div>
        <div className="field"><label htmlFor="register-type">Agent type</label><select id="register-type" value={agentType} onChange={(e) => setAgentType(e.target.value as AgentType)} disabled={busy}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="other">Other CLI</option></select></div></div>
      <details><summary>Advanced</summary><label htmlFor="relay-prompt">Relay prompt</label><input id="relay-prompt" value={relayPrompt} onChange={(e) => setRelayPrompt(e.target.value)} disabled={busy} /></details>
      {existing && <label className="readiness"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />Explicitly replace the binding for "{existing.label}". Existing runs must be reconciled first.</label>}
      <button type="submit" className="primary" disabled={disabled || busy || !label.trim() || (!!existing && !replace)}>Register pane</button>
    </form>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
