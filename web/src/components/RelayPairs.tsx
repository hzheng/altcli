"use client";
import { useState } from "react";
import type { RelayPair, SessionRegistration } from "../contracts/api";
import { api } from "../client/api";
interface Props {
  token: string;
  /** All registered sessions and pairs; a pair never spans repositories. */
  sessions: SessionRegistration[];
  pairs: RelayPair[];
  repository: string;
  lockedRepositories: string[];
  selectedPairId: string | null;
  onSelectPair: (pair: RelayPair | null) => void;
  /** Selects a project that has sessions but no pair yet, so its pair can still be created after navigating away. */
  onSelectProject: (repository: string) => void;
  /** True while another request is in flight. */
  disabled: boolean;
  onChanged: (message: string) => void;
}
/** Pair-first navigation; selecting a tab also selects its repository and participants. */
export function RelayPairs({ token, sessions, pairs, repository, lockedRepositories, selectedPairId, onSelectPair, onSelectProject, disabled, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const projectSessions = sessions.filter((session) => session.repository === repository);
  const unpaired = [...new Set(sessions.map((session) => session.repository))].filter((root) => !pairs.some((pair) => pair.repository === root));
  const labelOf = (id: string) => sessions.find((s) => s.id === id)?.label ?? id;
  const projectName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
  function start() {
    // With exactly two sessions the choice is already made; only the name is missing.
    setFirst(projectSessions.length === 2 ? projectSessions[0]!.id : ""); setSecond(projectSessions.length === 2 ? projectSessions[1]!.id : "");
    setName(""); setError(""); setOpen(true);
  }
  function navigate(action: () => void) {
    setOpen(false); setName(""); setFirst(""); setSecond(""); setError(""); setConfirming(null); action();
  }
  async function create() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const pair = await api<RelayPair>(token, "pairs", { body: { name, sessions: [first, second] } });
      setOpen(false);
      onSelectPair(pair);
      onChanged(`Pair "${pair.name}" created: ${labelOf(pair.sessions[0])} ⇄ ${labelOf(pair.sessions[1])}. Nothing was sent.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the pair."); }
    finally { setBusy(false); }
  }
  async function remove(pair: RelayPair) {
    if (busy) return;
    setConfirming(null); setBusy(true); setError("");
    try {
      await api(token, `pairs/${encodeURIComponent(pair.id)}`, { method: "DELETE" });
      if (selectedPairId === pair.id) onSelectPair(null);
      onChanged(`Pair "${pair.name}" removed. Both sessions stay registered.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not remove the pair."); }
    finally { setBusy(false); }
  }
  const locked = disabled || busy; const creationLocked = locked || lockedRepositories.includes(repository);
  return <section className="pairs">
    <div className="strip">
      <nav className="pair-tabs" aria-label="Relay pairs">{pairs.map((pair) => <span key={pair.id} className={`pair-tab ${selectedPairId === pair.id ? "selected" : ""}`}>
        <button type="button" className="pair-choice" aria-pressed={selectedPairId === pair.id} onClick={() => navigate(() => onSelectPair(pair))}>{pair.name} <span>({projectName(pair.repository)})</span></button>
        {confirming === pair.id
          ? <><button type="button" className="pair-action" disabled={locked || lockedRepositories.includes(pair.repository)} onClick={() => void remove(pair)} aria-label={`Confirm remove pair ${pair.name}`}>Remove?</button><button type="button" className="pair-action" onClick={() => setConfirming(null)}>Keep</button></>
          : <button type="button" className="pair-action" disabled={locked || lockedRepositories.includes(pair.repository)} onClick={() => setConfirming(pair.id)} aria-label={`Remove pair ${pair.name}`}>×</button>}
      </span>)}
      {unpaired.map((root) => <span key={root} className={`pair-tab ${!selectedPairId && root === repository ? "selected" : ""}`}>
        <button type="button" className="pair-choice" aria-pressed={!selectedPairId && root === repository} onClick={() => navigate(() => onSelectProject(root))}>{projectName(root)} <span>(no pair)</span></button></span>)}</nav>
      {!open && <button type="button" className="quiet" disabled={creationLocked || projectSessions.length < 2} onClick={start}>+ New pair</button>}
    </div>
    {open && <form className="panel" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="register-grid">
        <div className="field"><label htmlFor="pair-name">Pair name</label>
          <input id="pair-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Review loop" disabled={creationLocked} required autoComplete="off" autoFocus /></div>
        <div className="field"><label htmlFor="pair-first">First session</label>
          <select id="pair-first" value={first} onChange={(event) => setFirst(event.target.value)} disabled={creationLocked} required>
            <option value="">Choose…</option>{projectSessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor="pair-second">Second session</label>
          <select id="pair-second" value={second} onChange={(event) => setSecond(event.target.value)} disabled={creationLocked} required>
            <option value="">Choose…</option>{projectSessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></div>
      </div>
      <div className="register-actions">
        <button type="submit" className="primary" disabled={creationLocked || !name.trim() || !first || !second || first === second}>Create pair</button>
        <button type="button" className="quiet" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <span className="muted">Groups and validates only; it does not automate turns.</span>
      </div>
      {error && <p className="feedback error" role="alert">{error}</p>}
    </form>}
    {!open && error && <p className="feedback error" role="alert">{error}</p>}
  </section>;
}
