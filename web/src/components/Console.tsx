"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandRecord, ConsoleState, HandoffOutcome, SessionRegistration, TurnEvent } from "../contracts/api";
/** Auto-relay stops by itself after this many automatic turns per activation; the human re-enables it deliberately. */
const AUTO_RELAY_LIMIT = 20;
/** How long a relay's outcome line may stay pending before the console reports it missing and stops automation. */
const OUTCOME_PATIENCE_MS = 45_000;
const OUTCOME_LABEL: Record<HandoffOutcome, string> = { accept_and_improve: "ACCEPTED + IMPROVED", accept_without_improvement: "ACCEPTED, NOTHING TO HAND OFF", strong_objection: "OBJECTION", no_incoming_handoff: "NO INCOMING HANDOFF" };
import { api, HttpError } from "../client/api";
import { RegisterPane } from "./RegisterPane";
import { RelayPairs } from "./RelayPairs";
const projectName = (repository: string) => repository.split("/").filter(Boolean).pop() ?? repository;
export function Console() {
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState("");
  const [state, setState] = useState<ConsoleState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Standing consent, per page: on accept_and_improve, send `relay` to the other agent without a click.
  const [autoRelay, setAutoRelay] = useState(false);
  const [autoTurns, setAutoTurns] = useState(0);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [lastRefresh, setLastRefresh] = useState(0);
  const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  const submission = useRef(false);
  const generation = useRef(0);
  const latestRead = useRef(0);
  /** Turn events seen by the previous poll, per session (receivedAt plus outcome state); a change while the page is open is news. */
  const seenTurns = useRef<Map<string, string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const read = ++latestRead.current;
    const currentGeneration = generation.current;
    try {
      const data = await api<ConsoleState>(token, "state", { signal });
      if (read === latestRead.current && currentGeneration === generation.current) {
        setState(data); setLastRefresh(Date.now()); setConnectionError("");
      }
    } catch (error) {
      if (signal?.aborted || currentGeneration !== generation.current) return;
      if (read === latestRead.current) setConnectionError(error instanceof Error ? error.message : "Connection lost.");
    }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh(abort.signal);
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [refresh, token]);
  function lock() {
    generation.current += 1; latestRead.current += 1;
    setToken(""); setDraftToken(""); setState(null); setSelected(null); setSelectedPairId(null); setAdding(false); setReady(false); setMessage(""); setConnectionError(""); setUnknownRequest(null);
  }
  const sessions = state?.sessions ?? [];
  // A removed or not-yet-chosen target falls back to the first registration.
  const current = sessions.find((session) => session.id === selected) ?? sessions[0];
  // A project is a worktree root; sessions that share it share one hold and can form pairs.
  const projects = sessions.map((session) => session.repository).filter((repository, index, all) => all.indexOf(repository) === index);
  const project = current?.repository;
  const projectSessions = sessions.filter((session) => session.repository === project);
  const projectPairs = (state?.pairs ?? []).filter((pair) => pair.repository === project);
  const pair = projectPairs.find((p) => p.id === selectedPairId);
  const visible = pair ? projectSessions.filter((session) => pair.sessions.includes(session.id)) : projectSessions;
  const activeCommandId = state?.reservations.find((reservation) => reservation.repository === project)?.activeCommandId ?? null;
  // The worktree stays held only while a command is in flight or its delivery is uncertain; a clean delivery settles it.
  const activeCommand = state?.commands.find((command) => command.id === activeCommandId);
  const uncertain = activeCommand?.status === "uncertain";
  // Anything held that is not still being sent must be clearable from here; a stale hold must never strand a project.
  const clearable = Boolean(activeCommand) && activeCommand!.status !== "recorded" && activeCommand!.status !== "sending";
  const labelOf = (id: string) => sessions.find((session) => session.id === id)?.label ?? id;
  // What the CLI's own hook last reported versus what was last sent to it. Idle = the hook spoke after the last send.
  const lastEventOf = (id: string): TurnEvent | undefined => state?.turns.find((turn) => turn.agentId === id);
  const lastSentOf = (id: string): CommandRecord | undefined => state?.commands.find((command) => command.agentId === id && command.status !== "rejected");
  // A session is idle when its hook has closed the last command sent to it; a turn that answered something else (text
  // typed in the terminal, or a delivery altered by leftover input) leaves that command open, so the session is working.
  const closesLastSent = (id: string): boolean => { const sent = lastSentOf(id); const event = lastEventOf(id); return !sent || (event !== undefined && event.commandId === sent.id); };
  const activityOf = (id: string): "idle" | "working" | "unknown" => !lastEventOf(id) ? "unknown" : closesLastSent(id) ? "idle" : "working";
  /** True unless the console has a reason to think the session is busy: something sent to it that no hook report has closed. */
  const presumedIdle = (id: string): boolean => closesLastSent(id);
  const currentEvent = current ? lastEventOf(current.id) : undefined;
  // Readiness is pre-ticked unless the console has a reason to think the target is busy: something was sent to it
  // from here and its own hook has not reported a turn end since. Never sent to = presumed at its prompt.
  const currentSent = current ? lastSentOf(current.id) : undefined;
  const currentIdle = current ? presumedIdle(current.id) : false;
  // The relay partner: the pair says so; with exactly two sessions in the project it is simply the other one.
  const partnerOf = (id: string) => projectPairs.find((p) => p.sessions.includes(id))?.sessions.find((s) => s !== id)
    ?? (projectSessions.length === 2 ? projectSessions.find((s) => s.id !== id)?.id : undefined);
  // Readiness follows what is known: pre-ticked when the target's hook reported it idle since the last send, cleared
  // otherwise. The human can still untick it; it is a suggestion, never a bypass of the confirmation.
  const readinessKey = current ? `${current.id}|${currentEvent?.receivedAt ?? ""}|${currentIdle}` : "";
  useEffect(() => { setReady(currentIdle); }, [readinessKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A pending outcome ages on the client clock; tick once a second so the patience limit is observed without a poll.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const overdue = (event: TurnEvent) => event.outcomeState === "pending" && now - Date.parse(event.receivedAt) > OUTCOME_PATIENCE_MS;
  // When the current target's turn event changes while the page is open, a new turn end or an outcome that arrived,
  // and it closes a command sent to it, act on it. Events already present when the page loaded do not count.
  useEffect(() => {
    if (!state) return;
    const keyOf = (t: TurnEvent) => `${t.receivedAt}|${overdue(t) ? "overdue" : t.outcomeState}`;
    const seen = new Map(state.turns.filter((t) => t.agentId).map((t) => [t.agentId!, keyOf(t)]));
    const before = seenTurns.current;
    seenTurns.current = seen;
    if (!before || !current) return;
    const key = seen.get(current.id);
    if (!key || before.get(current.id) === key || !currentEvent) return;
    const at = currentEvent.receivedAt;
    const stopAuto = (why: string) => { if (autoRelay) { setAutoRelay(false); setMessage((m) => `${m} Auto-relay stopped: ${why}`); } };
    if (!currentEvent.commandId) {
      // The turn did not answer anything sent from here. With a command still open, the delivery was probably altered
      // by text left in the input line, or is queued behind terminal work; either way a human must look.
      if (currentSent && currentEvent.prompt !== null) {
        setMessage(`${current.label} finished a turn that was not the one sent from here: its prompt was "${currentEvent.prompt.slice(0, 80)}". Your ${currentSent.kind} ("${currentSent.text.slice(0, 40)}") is still open; check the pane for leftover input or a queued turn, then take over.`);
        stopAuto("the agent answered a different prompt.");
      }
      return;
    }
    if (currentEvent.outcomeState === "pending" && !overdue(currentEvent)) { setMessage(`${current.label} finished its turn at ${new Date(at).toLocaleTimeString()}; waiting for its RELAY-OUTCOME line. You can take over at any time.`); return; }
    const partner = partnerOf(current.id);
    const closed = currentEvent.commandId ? state.commands.find((c) => c.id === currentEvent.commandId) : undefined;
    const finished = `${current.label} finished its turn at ${new Date(at).toLocaleTimeString()}`;
    const reason = currentEvent.reason ?? "no reason given";
    const handOff = (note: string) => { if (partner && !text) { setSelected(partner); setMessage(`${finished}: ${note} Next: ${labelOf(partner)}.`); } else setMessage(`${finished}: ${note}`); };
    /** Why an automatic relay to the partner cannot go out right now, or null when it can. */
    const cannotRelay = (): string | null => !partner ? "no relay partner in this project."
      : text ? "an instruction is being typed."
      : !presumedIdle(partner) ? `${labelOf(partner)} may still be working.` : null;
    // The auto-relay checkbox: keep a chain going on accept_and_improve, within the turn cap.
    const continueChain = () => {
      if (!autoRelay) return;
      const why = cannotRelay() ?? (autoTurns >= AUTO_RELAY_LIMIT ? `${AUTO_RELAY_LIMIT} automatic turns reached.` : null);
      if (why) { stopAuto(why); return; }
      setAutoTurns((n) => n + 1);
      void send("relay", partner!, true);
    };
    // A direct instruction ends without an outcome line. Plain Send just finishes, whatever the checkbox says.
    // "Send & relay" relays to the partner by itself once the work is done, whatever the checkbox says.
    if (closed?.kind === "instruction" && !currentEvent.outcome) {
      if (!(closed.handoff ?? false)) { setMessage(`${current.label} finished the instruction you sent at ${new Date(closed.createdAt).toLocaleTimeString()}.`); return; }
      const why = cannotRelay();
      if (why) { handOff(`finished the work you sent, but it was not relayed automatically: ${why}`); return; }
      setSelected(partner!); setMessage(`${finished}: finished the work you sent; relaying to ${labelOf(partner!)}.`);
      void send("relay", partner!, true);
      return;
    }
    // The reviewer's own outcome line decides what happens next. Only accept_and_improve can continue automatically.
    switch (currentEvent.outcome) {
      case "strong_objection":
        if (partner && !text) {
          setSelected(partner); setText(`${current.label} rejected your handoff: ${reason} Address it, then hand off again.`);
          setMessage(`${finished}: OBJECTION — ${reason} An instruction to ${labelOf(partner)} is prefilled; review it, then Send.`);
        } else setMessage(`${finished}: OBJECTION — ${reason}`);
        stopAuto("the reviewer objected.");
        break;
      case "accept_without_improvement": setMessage(`${finished}: accepted with nothing to hand off, so the relay chain is complete. Run the final task-level checks yourself.`); stopAuto("the chain is complete."); break;
      case "no_incoming_handoff": setMessage(`${finished}: it found nothing to review.`); stopAuto("there was nothing to review."); break;
      case "accept_and_improve": handOff(currentEvent.reason ? `accepted and improved — ${currentEvent.reason.replace(/[.。]?$/, ".")}` : "accepted and improved."); continueChain(); break;
      default: handOff(overdue(currentEvent) ? `no RELAY-OUTCOME line arrived within ${OUTCOME_PATIENCE_MS / 1000} s; check the pane and take over.` : "no RELAY-OUTCOME line in its final message; check the pane."); stopAuto("no RELAY-OUTCOME line.");
    }
  }, [state?.turns, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const livePane = (session: SessionRegistration) => state?.panes.find((pane) => pane.identity.socketPath === session.identity.socketPath && pane.identity.paneId === session.identity.paneId);
  /** `auto` is the auto-relay path: the standing consent replaces the per-send readiness tick; everything else is identical. */
  async function send(kind: "relay" | "instruction", targetId = current?.id, auto = false, handoff = false) {
    const target = sessions.find((session) => session.id === targetId);
    if (submission.current || !target || (!auto && !ready)) return;
    if (auto && (stale || !state?.inputEnabled || unknownRequest || state?.reservations.some((r) => r.repository === target.repository))) { setAutoRelay(false); setMessage("Auto-relay stopped: the console is not in a state to send."); return; }
    submission.current = true; setSending(true); setReady(false);
    const requestId = crypto.randomUUID();
    try {
      const record = await api<CommandRecord>(token, "commands", { body: { requestId, agentId: target.id, kind,
        ...(text.trim() && !auto ? { text: text.trim() } : {}), ...(handoff ? { handoff: true } : {}), confirmReady: true } });
      const hooked = Boolean(lastEventOf(target.id));
      setMessage(`${auto ? "RELAYED AUTOMATICALLY, " : ""}${record.status.toUpperCase()}: ${record.error ?? (record.status === "delivered"
        ? `the terminal accepted the text for ${target.label}. ${hooked ? `Its hook will report when the turn ends.` : `It has never reported a turn end yet, so watch its panel (see SETUP section 6 for hooks).`}`
        : "recorded.")}`);
      if (record.status === "delivered" && !auto) setText("");
      if (auto && record.status !== "delivered" && autoRelay) { setAutoRelay(false); setMessage((m) => `${m} Auto-relay stopped: delivery was ${record.status}.`); }
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : "Connection interrupted."} No automatic retry was made.`);
      // 5xx and transport failures may happen after dispatch. Require explicit inspection.
      if (!(error instanceof HttpError) || error.status >= 500) setUnknownRequest(requestId);
      if (auto && autoRelay) setAutoRelay(false);
    } finally {
      await refresh(); submission.current = false; setSending(false);
    }
  }
  async function acknowledge() {
    if (!activeCommandId || submission.current) return;
    submission.current = true; setSending(true);
    try {
      await api(token, "control/release", { body: { expectedCommandId: activeCommandId, confirmReady: true } });
      setMessage("Uncertain delivery acknowledged. Nothing was resent; no task was marked complete.");
      setReady(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not acknowledge. Refresh the console before retrying."); }
    finally { await refresh(); submission.current = false; setSending(false); }
  }
  async function remove(session: SessionRegistration) {
    if (submission.current) return;
    setConfirmRemove(null);
    submission.current = true; setSending(true);
    try {
      await api(token, `sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setMessage(`Removed the registration "${session.label}". No agent was stopped.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Removal failed."); }
    finally { await refresh(); submission.current = false; setSending(false); }
  }
  const stale = Boolean(connectionError) || Date.now() - lastRefresh > 10000;
  const available = current ? state?.snapshots.find((snapshot) => snapshot.agentId === current.id)?.status === "available" : false;
  const blocked = sending || stale || !state?.inputEnabled || !current || !available || Boolean(activeCommandId) || Boolean(unknownRequest);
  const unmatched = state?.turns.find((turn) => turn.agentId === null);
  if (!token) return <main className="unlock-shell">
    <div className="wordmark"><span className="brand-mark">C</span> CoderCrew <span className="small-tag">LOCAL FIRST</span></div>
    <section className="unlock-card">
      <p className="eyebrow">YOUR AGENTS. ONE CONSOLE.</p>
      <h1>Stay in control.</h1>
      <p className="muted">Read your coding agents, send an instruction, and guide the next review. Your existing tmux sessions stay where they are.</p>
      <form onSubmit={(event) => { event.preventDefault(); setToken(draftToken.trim()); setDraftToken(""); }}>
        <label htmlFor="token">Host access token</label>
        <input id="token" type="password" autoComplete="off" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} placeholder="Paste the token from web/.env.local" required />
        <button className="primary" type="submit">Open console <span aria-hidden="true">↗</span></button>
      </form>
      <p className="fine">The token stays in this page's memory. Reloading requires it again. Start with <code>node scripts/setup.mjs</code>.</p>
    </section>
    <footer>Manual control first. Automatic relay comes later.</footer>
  </main>;
  return <main className="console-shell">
    <header className="topbar">
      <div className="wordmark"><span className="brand-mark">C</span> CoderCrew <span className="small-tag">CONSOLE</span></div>
      <div className="toolbar"><span className={`badge ${state?.mode === "mock" ? "warning" : ""}`}>{state?.mode === "mock" ? "MOCK MODE" : "LOCAL HOST"}</span><button className="quiet" onClick={lock} disabled={sending}>Lock</button></div>
    </header>
    <div className="page-heading"><div><p className="eyebrow">WORKSPACE / MANUAL CONTROL</p><h1>Agent console</h1><p className="muted">Independent agents in tmux. One place to guide the work.</p></div>
      <div className="connection"><span className={`dot ${stale ? "dim" : ""}`} />{stale ? "Not current" : "Connected"}<small>{lastRefresh ? `Updated ${new Date(lastRefresh).toLocaleTimeString()}` : "Connecting to host"}</small></div>
    </div>
    {state?.mode === "mock" && <div className="notice">Preview mode. These are simulated panes. Commands do not reach tmux or modify any repository.</div>}
    {connectionError && <div className="notice error" role="alert">{connectionError} <button className="quiet" onClick={() => void refresh()}>Refresh</button></div>}
    {state && sessions.length === 0 && <div className="notice">Register the two panes that will relay on one repository: pick each coding CLI's tmux pane below. The first pane sets the project; the second must be in the same worktree. Nothing is sent by registering.</div>}
    {state && sessions.length === 0 && message && <p className="feedback" role="status">{message}</p>}
    {unmatched && !sessions.some((s) => s.identity.paneId === unmatched.paneId) && <div className="notice">A {unmatched.source === "claude" ? "Claude Code" : unmatched.source === "codex" ? "Codex" : "CLI"} hook reported a finished turn from pane <code>{unmatched.paneId}</code> at {new Date(unmatched.receivedAt).toLocaleTimeString()}, but that pane is not registered. Register it, or re-register if the CLI was restarted.</div>}
    {state && (adding || sessions.length === 0) && <RegisterPane token={token} panes={state.panes} panesError={state.panesError} disabled={sending}
      project={sessions.length > 0 ? project : undefined} projects={projects}
      onClose={sessions.length > 0 ? () => setAdding(false) : undefined}
      hint={sessions.length === 0 ? "first of two panes" : projectSessions.length === 1 ? `1 of 2 panes in ${projectName(project ?? "")}; add the other agent to relay` : undefined}
      onRegistered={(session, replaced) => {
        // Keep the panel open until the pane's project has both agents; then hand over to the console.
        const inProject = sessions.filter((s) => s.repository === session.repository && s.id !== session.id).length + 1;
        setAdding(inProject < 2); setSelected(session.id); setSelectedPairId(null); setReady(false);
        setMessage(`Registered "${session.label}" at ${session.identity.paneId}${replaced ? ", replacing its previous pane" : ""}. No input was sent.${inProject < 2 ? " Add the other agent's pane to start relaying." : " Both panes are in; pick a target, confirm readiness, and Relay."}`);
        void refresh(); }} />}
    {sessions.length > 0 && <>
      {projects.length > 1 && <nav className="project-tabs" aria-label="Project">{projects.map((repository) => <button key={repository} className={repository === project ? "selected" : ""} aria-pressed={repository === project} title={repository} onClick={() => { setSelected(sessions.find((session) => session.repository === repository)?.id ?? null); setSelectedPairId(null); setReady(false); }}>{projectName(repository)}{state?.reservations.some((r) => r.repository === repository) ? <small>CONFIRM DELIVERY</small> : <small>{sessions.filter((s) => s.repository === repository).length} sessions</small>}</button>)}</nav>}
      <div className="target-row">
        <nav className="agent-tabs" aria-label="Command target">{visible.map((session) => <button key={session.id} className={current?.id === session.id ? "selected" : ""} aria-pressed={current?.id === session.id} onClick={() => { setSelected(session.id); setReady(false); }}>{session.label} <small>{current?.id === session.id ? "SELECTED TARGET" : "SELECT TARGET"}</small></button>)}</nav>
        {!adding && <button type="button" className="quiet" onClick={() => setAdding(true)} disabled={sending}>+ Add pane</button>}
      </div>
      {project && <p className="project-path mono muted" title={project}>{project}{pair ? ` · showing pair "${pair.name}"` : ""}</p>}
      <section className="panes" aria-label="Agent output">
        {visible.map((session) => {
          const snapshot = state?.snapshots.find((s) => s.agentId === session.id);
          const live = livePane(session);
          const activity = activityOf(session.id); const event = lastEventOf(session.id); const sent = lastSentOf(session.id);
          return <article key={session.id} className={`pane ${current?.id === session.id ? "active" : ""}`}>
            <div className="pane-heading"><h2>{session.label}</h2><span className="mono muted"><span className="badge">{session.agentType === "codex" ? "Codex" : session.agentType === "claude" ? "Claude Code" : "Other CLI"}</span> {session.identity.paneId}{live ? ` · ${live.location} · ${live.command}` : " · not in the live pane list"}</span></div>
            <div className="pane-meta"><span title={session.repository}>{session.repository}</span>
              <span>{activity === "idle" && event ? <span className="badge">IDLE · turn ended {new Date(event.receivedAt).toLocaleTimeString()}</span>
                : activity === "working" && sent ? <span className="badge warning">WORKING · since {new Date(sent.createdAt).toLocaleTimeString()}</span>
                : <span title="No turn-complete event from this CLI yet. Run node scripts/install-hooks.mjs and restart the CLI.">NO HOOK EVENTS YET</span>} · {snapshot?.status === "available" ? "SNAPSHOT" : "UNAVAILABLE"}</span></div>
            {activity === "idle" && event?.outcome && <div className={`outcome ${event.outcome}`}><strong>{OUTCOME_LABEL[event.outcome]}</strong>{event.reason ? ` — ${event.reason}` : ""}</div>}
            {activity === "idle" && event?.outcomeState === "pending" && <div className="outcome pending">{overdue(event) ? "NO RELAY-OUTCOME LINE ARRIVED — take over" : "READING ITS RELAY-OUTCOME LINE…"}</div>}
            {activity === "working" && event && !event.commandId && event.prompt !== null && sent && <div className="outcome strong_objection"><strong>ANSWERED A DIFFERENT PROMPT</strong> — "{event.prompt.slice(0, 80)}"; your {sent.kind} is still open. Check the input line.</div>}
            <pre tabIndex={0} aria-label={`${session.label} output`}>{snapshot?.status === "unavailable" ? snapshot.error : snapshot?.text || "No output yet."}</pre>
            <div className="pane-footer">{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}` : "Waiting for a capture"}<span>Read-only screen capture</span>
              {confirmRemove === session.id
                ? <span className="confirm-inline"><span>Forget this pane? The agent keeps running.</span><button className="quiet" onClick={() => void remove(session)} disabled={sending} aria-label={`Confirm remove ${session.label}`}>Confirm</button><button className="quiet" onClick={() => setConfirmRemove(null)}>Keep</button></span>
                : <button className="quiet" onClick={() => setConfirmRemove(session.id)} disabled={sending || Boolean(activeCommandId)} aria-label={`Remove ${session.label}`}>Remove</button>}</div>
          </article>;
        })}
      </section>
      {unknownRequest && <div className="notice error" role="alert">Delivery of request <code>{unknownRequest}</code> could not be established. Check the command history and the actual terminal, including partially typed input, before issuing anything else. <button onClick={() => setUnknownRequest(null)}>I checked the terminal</button></div>}
      <section className="composer">
        <div className="section-heading"><div><p className="eyebrow">NEXT INSTRUCTION{project ? ` / ${projectName(project).toUpperCase()}` : ""}</p><h2>Send to {current?.label ?? "…"}</h2></div><span className={`badge ${uncertain ? "warning" : ""}`}>{uncertain ? "CONFIRM DELIVERY" : activeCommandId ? "SENDING" : "MANUAL"}</span></div>
        {clearable && activeCommand && <div className="turn-bar"><span>{uncertain
            ? <>Delivery to <strong>{labelOf(activeCommand.agentId)}</strong> is uncertain: <code>{activeCommand.text}</code> may or may not have reached the pane ({activeCommand.error}). Look at that terminal, fix anything half-typed, then confirm. Nothing is resent.</>
            : <>This project is still held by <code>{activeCommand.text}</code> to <strong>{labelOf(activeCommand.agentId)}</strong> ({activeCommand.status}). Confirm to clear the hold; nothing is resent.</>}</span>
          <button onClick={() => void acknowledge()} disabled={sending}>I checked the terminal</button></div>}
        {state && !state.inputEnabled && <p className="muted">Read-only console: the host runs with <code>CODERCREW_ENABLE_INPUT=false</code>. Captures work; Send and Relay are off.</p>}
        <form onSubmit={(event) => { event.preventDefault(); if (!blocked && ready) void send("instruction"); }}>
          <label className="sr-only" htmlFor="instruction">Instruction to {current?.label ?? "the selected agent"}</label>
          <div className="command-line"><span aria-hidden="true">&gt;</span><input id="instruction" value={text} onChange={(event) => setText(event.target.value)} placeholder="An instruction for Send, or context for Relay (optional)…" maxLength={2000} disabled={blocked} autoComplete="off" /><button type="submit" className="primary" disabled={blocked || !ready || !text.trim()}>Send</button><button type="button" className="primary" disabled={blocked || !ready || !text.trim() || !partnerOf(current?.id ?? "")} title={current && partnerOf(current.id) ? `Send this instruction; when ${current.label} finishes, hand its result to ${labelOf(partnerOf(current.id)!)} for review` : "Needs a relay partner in this project"} onClick={() => void send("instruction", current?.id, false, true)}>Send &amp; relay ↗</button><button type="button" className="secondary" disabled={blocked || !ready} title={text.trim() ? `Sends "${current?.relayPrompt ?? "relay"}: ${text.trim()}"` : `Sends "${current?.relayPrompt ?? "relay"}"`} onClick={() => void send("relay")}>{text.trim() ? "Relay with context ↗" : "Relay ↗"}</button></div>
          <label className="readiness"><input type="checkbox" aria-label="Ready to send" checked={ready} disabled={blocked} onChange={(event) => setReady(event.target.checked)} />{currentIdle && currentEvent && currentSent
          ? <>{current?.label}'s own hook reported its turn ended at {new Date(currentEvent.receivedAt).toLocaleTimeString()}; untick if the terminal shows otherwise.</>
          : currentIdle
          ? <>Nothing has been sent to {current?.label} from this console{currentSent ? " since it last reported" : ""}, so it is presumed at its prompt; untick if its terminal is busy, shows a permission dialog, or has text left in its input line.</>
          : <>I verified that {current?.label ?? "the selected agent"} is at an empty input prompt, no permission dialog is active, and no other agent is writing.</>}</label>
        </form>
        <label className="readiness auto"><input type="checkbox" aria-label="Auto-relay" checked={autoRelay} disabled={!state?.inputEnabled || !current || !partnerOf(current.id)} onChange={(event) => { setAutoRelay(event.target.checked); setAutoTurns(0); }} />
          Auto-relay{autoRelay ? ` (${autoTurns}/${AUTO_RELAY_LIMIT} automatic turns)` : ""}: keep the chain going by itself when a reviewer reports <code>accept_and_improve</code>. Anything else stops it: an objection, a completed chain, a missing outcome line, a busy partner, a non-delivered send, or {AUTO_RELAY_LIMIT} turns. Independent of this box: <strong>Send</strong> never relays; <strong>Send &amp; relay</strong> always relays once the work is done.</label>
        {message && <p className="feedback" role="status">{message}</p>}
        <p className="fine">Delivered = the terminal accepted the text. Turn ended = the agent's own hook said so. Nothing is sent, retried, staged, or interrupted without your click.</p>
      </section>
      {state && project && <RelayPairs token={token} sessions={projectSessions} pairs={projectPairs} selectedPairId={selectedPairId} disabled={sending || Boolean(activeCommandId)}
        onSelectPair={(id) => { setSelectedPairId(id); const chosen = projectPairs.find((p) => p.id === id); if (chosen && current && !chosen.sessions.includes(current.id)) { setSelected(chosen.sessions[0]); setReady(false); } }}
        onChanged={(text) => { setMessage(text); void refresh(); }} />}
      <details className="history">
        <summary><h2>Command history</h2><span className="muted">{state?.commands.length ?? 0} of the most recent 30 · persisted on host</span></summary>
        {state?.commands.length ? <div className="table-scroll"><table><thead><tr><th>Agent / time</th><th>Instruction</th><th>Delivery</th></tr></thead><tbody>{state.commands.map((command) => <tr key={command.id}><td>{labelOf(command.agentId)}<small>{new Date(command.createdAt).toLocaleTimeString()}</small></td><td className="command-text"><code>{command.text}</code><small title={command.id}>{command.id.slice(0, 8)}{command.kind === "instruction" && command.handoff ? " · then relay" : ""}</small></td><td><span className={`badge ${command.status === "uncertain" && !command.releasedAt ? "warning" : ""}`}>{command.status}</span>{command.error && <small>{command.error}</small>}{command.status === "uncertain" && command.releasedAt && <small>acknowledged {new Date(command.releasedAt).toLocaleTimeString()}</small>}</td></tr>)}</tbody></table></div> : <div className="empty-history">No commands yet. Choose an agent and send the first instruction.</div>}
      </details>
    </>}
    <footer>CoderCrew 0.1.0 <span>Snapshot console · Web first · Native iOS reserved</span></footer>
  </main>;
}
