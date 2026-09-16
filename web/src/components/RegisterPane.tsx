"use client";
import { useEffect, useState } from "react";
import type { AgentType, AvailablePane, PanePreview, RegistrationResult, SessionRegistration } from "../contracts/api";
import { assertAgentCommand, suggestAgentType } from "../core/policy";
import { slugify } from "../core/validation";
import { api } from "../client/api";
interface Props {
  token: string;
  panes: AvailablePane[];
  panesError: string | null;
  /** True while another request is in flight. The server separately refuses changes in a worktree with a reserved turn. */
  disabled: boolean;
  onRegistered: (session: SessionRegistration, replaced: boolean) => void;
  /** Absent on the empty state, where there is nothing to go back to. */
  onClose?: () => void;
  /** Progress toward a relay, e.g. "1 of 2 panes registered". */
  hint?: string;
  /** Repository root this panel is adding to; the first selected pane decides when absent. */
  project?: string;
  /** Roots of existing projects, offered as choices. */
  projects: string[];
}
const basename = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
const TYPE_LABEL: Record<AgentType, string> = { codex: "Codex", claude: "Claude Code", other: "Other CLI" };
const idOf = (label: string): string | null => { try { return slugify(label); } catch { return null; } };
/** Why a live pane cannot be selected, or null when it can. Mirrors the server's rules so the list explains itself. */
function blocker(pane: AvailablePane, root: string): string | null {
  if (pane.registeredAs) return `registered as ${pane.registeredAs}`;
  try { assertAgentCommand(pane.command); } catch { return "shell or interpreter, not a coding CLI"; }
  if (pane.dead) return "pane is dead";
  if (root && !within(pane.cwd, root)) return `outside ${basename(root)}; a relay needs one worktree`;
  return null;
}
export function RegisterPane({ token, panes, panesError, disabled, onRegistered, onClose, hint, project, projects }: Props) {
  // null = follow the project prop; "" = explicitly choosing another project; otherwise the chosen root.
  const [root, setRoot] = useState<string | null>(null);
  const activeRoot = root ?? project ?? "";
  const [paneId, setPaneId] = useState("");
  const [label, setLabel] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("other");
  const [repository, setRepository] = useState("");
  const [relayPrompt, setRelayPrompt] = useState("relay");
  const [preview, setPreview] = useState<PanePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pane = panes.find((p) => p.identity.paneId === paneId);
  useEffect(() => {
    // A bounded read of the chosen pane's screen, so the human can tell similar panes apart before registering.
    if (!paneId) { setPreview(null); setPreviewError(""); return; }
    const abort = new AbortController();
    api<PanePreview>(token, `panes/preview?paneId=${encodeURIComponent(paneId)}`, { signal: abort.signal })
      .then((data) => { setPreview(data); setPreviewError(""); })
      .catch((caught) => { if (!abort.signal.aborted) { setPreview(null); setPreviewError(caught instanceof Error ? caught.message : "Preview unavailable."); } });
    return () => abort.abort();
  }, [paneId, token]);
  // Same id as an existing registration means "re-point it at this pane"; say so rather than doing it silently.
  const existing = panes.find((p) => p.registeredAs && p.registeredAs === idOf(label));
  function choose(next: AvailablePane) {
    const type = suggestAgentType(next.command);
    // The first pane picks the project; every later pane in this panel must share its worktree.
    const chosenRoot = activeRoot || next.cwd;
    if (!activeRoot) setRoot(chosenRoot);
    setPaneId(next.identity.paneId); setError(""); setRepository(chosenRoot); setAgentType(type);
    const suggestion = type === "other" ? next.location.split(":")[0] ?? "" : TYPE_LABEL[type];
    setLabel(panes.some((p) => p.registeredAs === idOf(suggestion)) ? `${suggestion} ${next.identity.paneId}` : suggestion);
  }
  async function submit() {
    if (busy || !pane) return;
    setBusy(true); setError("");
    try {
      const result = await api<RegistrationResult>(token, "sessions", { body: { paneId, label, agentType, repository, relayPrompt } });
      setPaneId(""); setLabel(""); setRepository("");
      onRegistered(result.session, result.replaced);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Registration failed."); }
    finally { setBusy(false); }
  }
  const locked = disabled || busy;
  // tmux says "no server running on <socket>" after a server exits and "error connecting to <socket>" when none ever ran.
  const noServer = panesError !== null && /no server running|error connecting to/i.test(panesError);
  // Repositories a relay could run in: existing projects plus the directories of live, registrable CLI panes.
  const candidates = [...projects, ...panes.filter((p) => !blocker(p, "")).map((p) => p.cwd)].filter((r, i, all) => all.indexOf(r) === i);
  return <section className="panel register" aria-labelledby="register-heading">
    <div className="section-heading"><div><p className="eyebrow">STEP 1{hint ? ` · ${hint}` : ""}</p><h2 id="register-heading">Choose the pane that runs a coding CLI</h2></div>
      {onClose && <button type="button" className="quiet" onClick={onClose} disabled={busy}>Cancel</button>}</div>
    {activeRoot ? <p className="project-line"><span className="eyebrow">PROJECT</span> <strong>{basename(activeRoot)}</strong> <span className="mono muted" title={activeRoot}>{activeRoot}</span>
        <button type="button" className="quiet" onClick={() => { setRoot(""); setPaneId(""); }} disabled={locked}>Change</button></p>
      : candidates.length > 1 ? <p className="project-line"><span className="eyebrow">PROJECT</span>
        <label htmlFor="register-project" className="sr-only">Repository</label>
        <select id="register-project" value="" onChange={(event) => setRoot(event.target.value)} disabled={locked}>
          <option value="">Choose a repository, or select a pane below…</option>
          {candidates.map((r) => <option key={r} value={r}>{basename(r)} · {r}</option>)}
        </select></p>
      : null}
    {noServer ? <div className="notice"><strong>No tmux server is running for this user.</strong> Start each coding CLI inside tmux, for example
        <code> tmux new-session -s codex -c /path/to/repo 'exec codex'</code>, and its pane will appear here by itself. <small>{panesError}</small></div>
      : panesError ? <p className="notice error" role="alert">Pane listing unavailable: {panesError}</p>
      : panes.length === 0 ? <p className="muted">The tmux server has no panes. Start a coding CLI in tmux on this host and it will appear here.</p>
      : <ul className="pane-list" aria-label="Live tmux panes">{panes.map((p) => {
        const why = blocker(p, activeRoot);
        const selected = p.identity.paneId === paneId;
        return <li key={p.identity.paneId} className={selected ? "selected" : why ? "blocked" : ""}>
          <span className="mono">{p.location} · {p.identity.paneId}</span>
          <span className="mono process">{p.command}</span>
          <span className="cwd" title={p.cwd}>{p.cwd}</span>
          {why ? <span className="muted">{why}</span>
            : <button type="button" className={selected ? "secondary" : ""} aria-label={`Select ${p.identity.paneId}`} aria-pressed={selected} disabled={locked} onClick={() => choose(p)}>{selected ? "Selected" : "Select"}</button>}
        </li>;
      })}</ul>}
    {pane && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="section-heading"><div><p className="eyebrow">STEP 2</p><h2>Confirm {pane.identity.paneId} and name it</h2></div></div>
      <pre className="preview" aria-label={`Preview of ${pane.identity.paneId}`}>{previewError || preview?.text || "Loading preview…"}</pre>
      <p className="muted">Last lines of the pane{preview ? `, captured ${new Date(preview.capturedAt).toLocaleTimeString()}` : ""}. The process name <code>{pane.command}</code> is what tmux reports; a native Claude Code binary reports its version number.</p>
      <div className="register-grid">
        <div className="field"><label htmlFor="register-label">Label</label>
          <input id="register-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} placeholder="Codex" disabled={locked} required autoComplete="off" />
          {existing && <small className="warn">Same id as the existing registration "{existing.registeredAs}": it will be re-pointed to this pane.</small>}</div>
        <div className="field"><label htmlFor="register-type">Agent type</label>
          <select id="register-type" value={agentType} onChange={(event) => setAgentType(event.target.value as AgentType)} disabled={locked}>
            {(Object.keys(TYPE_LABEL) as AgentType[]).map((type) => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}
          </select></div>
      </div>
      <details className="advanced">
        <summary>Advanced: repository root and relay prompt</summary>
        <div className="register-grid">
          <div className="field"><label htmlFor="register-repository">Repository root</label>
            <input id="register-repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="/absolute/path" disabled={locked} required autoComplete="off" />
            <small>The project's worktree root; every pane registered here shares it, and the pane must be inside it.</small></div>
          <div className="field"><label htmlFor="register-relay">Relay prompt</label>
            <input id="register-relay" value={relayPrompt} onChange={(event) => setRelayPrompt(event.target.value)} maxLength={2000} disabled={locked} required autoComplete="off" />
            <small>What the Relay button types. Keep <code>relay</code> if your global rules map it to the skill.</small></div>
        </div>
      </details>
      <div className="register-actions">
        <button type="submit" className="primary" disabled={locked || !label.trim() || !repository.trim() || !relayPrompt.trim()}>{existing ? "Re-point registration" : "Register pane"}</button>
        <span className="muted">Registration sends no input.</span>
      </div>
      {error && <p className="feedback error" role="alert">{error}</p>}
    </form>}
  </section>;
}
