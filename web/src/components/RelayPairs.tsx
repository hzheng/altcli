"use client";
import { useState } from "react";
import type { RelayPair, SessionRegistration } from "../contracts/api";
import { api } from "../client/api";
interface Props {
  token: string;
  /** Sessions and pairs of the current project only; a pair never spans repositories. */
  sessions: SessionRegistration[];
  pairs: RelayPair[];
  selectedPairId: string | null;
  onSelectPair: (id: string | null) => void;
  /** True while another request is in flight or this project's worktree is held. */
  disabled: boolean;
  onChanged: (message: string) => void;
}
/** A compact strip in the main view; the creation form appears only on demand. Rendered only when a pair is possible or exists. */
export function RelayPairs({ token, sessions, pairs, selectedPairId, onSelectPair, disabled, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const labelOf = (id: string) => sessions.find((s) => s.id === id)?.label ?? id;
  if (sessions.length < 2 && pairs.length === 0) return null;
  function start() {
    // With exactly two sessions the choice is already made; only the name is missing.
    setFirst(sessions.length === 2 ? sessions[0]!.id : ""); setSecond(sessions.length === 2 ? sessions[1]!.id : "");
    setName(""); setError(""); setOpen(true);
  }
  async function create() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const pair = await api<RelayPair>(token, "pairs", { body: { name, sessions: [first, second] } });
      setOpen(false);
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
  const locked = disabled || busy;
  return <section className="pairs" aria-label="Relay pairs">
    <div className="strip">
      <span className="eyebrow">RELAY PAIRS</span>
      {pairs.length === 0 && <span className="muted">None yet. A pair names the two sessions that alternate reviews on this worktree.</span>}
      {pairs.map((pair) => <span key={pair.id} className={`chip ${selectedPairId === pair.id ? "selected" : ""}`}>
        <strong>{pair.name}</strong> <span className="muted">{labelOf(pair.sessions[0])} ⇄ {labelOf(pair.sessions[1])}</span>
        <button type="button" className="quiet" aria-pressed={selectedPairId === pair.id} onClick={() => onSelectPair(selectedPairId === pair.id ? null : pair.id)}>{selectedPairId === pair.id ? "Showing" : "Show"}</button>
        {confirming === pair.id
          ? <><button type="button" className="quiet" disabled={locked} onClick={() => void remove(pair)} aria-label={`Confirm remove pair ${pair.name}`}>Remove?</button><button type="button" className="quiet" onClick={() => setConfirming(null)}>Keep</button></>
          : <button type="button" className="quiet" disabled={locked} onClick={() => setConfirming(pair.id)} aria-label={`Remove pair ${pair.name}`}>×</button>}
      </span>)}
      {!open && sessions.length >= 2 && <button type="button" className="quiet" disabled={locked} onClick={start}>+ New pair</button>}
    </div>
    {open && <form className="panel" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="register-grid">
        <div className="field"><label htmlFor="pair-name">Pair name</label>
          <input id="pair-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Review loop" disabled={locked} required autoComplete="off" autoFocus /></div>
        <div className="field"><label htmlFor="pair-first">First session</label>
          <select id="pair-first" value={first} onChange={(event) => setFirst(event.target.value)} disabled={locked} required>
            <option value="">Choose…</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor="pair-second">Second session</label>
          <select id="pair-second" value={second} onChange={(event) => setSecond(event.target.value)} disabled={locked} required>
            <option value="">Choose…</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select></div>
      </div>
      <div className="register-actions">
        <button type="submit" className="primary" disabled={locked || !name.trim() || !first || !second || first === second}>Create pair</button>
        <button type="button" className="quiet" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <span className="muted">Groups and validates only; it does not automate turns.</span>
      </div>
      {error && <p className="feedback error" role="alert">{error}</p>}
    </form>}
    {!open && error && <p className="feedback error" role="alert">{error}</p>}
  </section>;
}
