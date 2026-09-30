'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Checkpoint, InteractionInput, InteractionRecord } from '../contracts/interactions';
import type { ManagedSession, RelayRun, WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { useRemembered } from '../client/memory';
import { Acknowledgement, overrideKey, useMounted, type Override } from './Holds';

export function InteractionComposer({ token, state, run, agent, draftKey, disabled, viewEpoch, refresh, onSent, active, override }: {
  token: string; state: WorkflowState; run: RelayRun; agent: ManagedSession; draftKey: string;
  disabled: boolean; viewEpoch: number; refresh: () => Promise<void>;
  /** A delivered input: the console shows the agent's terminal. */
  onSent: () => void;
  /** The selected card: only it shows its inspection check. */
  active: boolean;
  /** Manual input this input overrides, listed in the check and cleared before sending. The run itself is kept. */
  override: Override | null;
}) {
  const [text, setText] = useRemembered(`${draftKey}:text`, '');
  const [answer, setAnswer] = useRemembered(`${draftKey}:answer`, '');
  const [present, setPresent] = useState(false); const [escape, setEscape] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [unknown, setUnknown] = useState(false);
  const reasonId = useId();
  const turn = state.executions.find((t) => t.commandId === run.currentCommandId);
  const revision = run.interaction?.revision ?? 0;
  useEffect(() => { setPresent(false); setEscape(false); }, [run.currentCommandId, run.status, run.pauseRequested, turn?.status, agent.registrationId, revision, viewEpoch, disabled, active, JSON.stringify(overrideKey(override))]);
  // What the check authorizes except the manual input it clears: any change while that input is cleared cancels the send.
  const intent = JSON.stringify([run.currentCommandId, run.status, run.pauseRequested, turn?.status, agent.registrationId, revision, viewEpoch, active, text, answer]);
  const intentRef = useRef({ key: intent, revision: 0 });
  if (intentRef.current.key !== intent) intentRef.current = { key: intent, revision: intentRef.current.revision + 1 };
  const mounted = useMounted();
  const pending = state.interactions?.some((r) => r.input.runId === run.id && ['recorded','sending','uncertain'].includes(r.status));
  const publication = run.implementation?.latestPublication?.entry;
  const humanObjection = publication?.commandId === run.currentCommandId && publication.decision === 'object' && publication.needsHuman;
  const reason = disabled ? 'The terminal is not currently available for input.' : unknown ? 'The response is unknown. Inspect input history before doing anything else.'
    : pending ? 'An input delivery is pending or uncertain. Inspect it before sending again.'
    : run.status === 'paused' ? humanObjection
      ? 'This run paused after an objection requiring human direction. Inspect the terminals, then use Take control here to end this run and send a new instruction.'
      : 'The controller is paused; the agent may still be working. Review the checkpoint in Control access, or inspect the terminals and use Take control here to send a new instruction.'
    : run.status === 'waiting' ? 'This run is waiting at a checkpoint. Review it in Control access before continuing, or use Take control here to send a new instruction.'
    : turn?.agentId !== agent.id ? 'Another agent owns this checkout. This draft has not been sent.'
    : run.status !== 'running' || run.pauseRequested || run.interaction?.fault || turn?.status !== 'delivered' ? 'Wait for the checkpoint or reconcile the paused controller.'
    : !turn.sessionId || !turn.sourceTurnId ? 'Waiting for the exact native start acknowledgment.' : '';
  const off = !!reason || busy || !present || !active;
  async function send(purpose: InteractionInput['purpose'], key?: 'Enter' | 'Escape') {
    if (off || !turn?.sessionId || !turn.sourceTurnId) return;
    setBusy(true); setMessage(''); setPresent(false); setEscape(false);
    const intentRevision = intentRef.current.revision; const sent = purpose === 'answer' ? answer : text;
    // The check accepted the listed manual input; it is stopped and recorded first. A failed step, any change to the draft, turn or
    // view meanwhile, or this composer going away (Lock, another workspace) sends nothing, and is never reported as an unknown input
    // result. The recorded decision stands; only the pending input is dropped.
    if (override) {
      try {
        await override.clear();
        if (!mounted.current) return;
        if (intentRef.current.revision !== intentRevision) throw Error('Manual input was recorded, but the draft, turn or view changed. Inspect and confirm again; nothing was sent.');
      } catch (error) { if (!mounted.current) return; setMessage(error instanceof Error ? error.message : 'Manual input could not be cleared. Nothing was sent.'); setBusy(false); await refresh(); return; }
    }
    try {
      const record = await api<InteractionRecord>(token, 'interactions', { body: { requestId: crypto.randomUUID(), runId: run.id, commandId: turn.commandId, agentId: agent.id, registrationId: agent.registrationId,
        sessionId: turn.sessionId, sourceTurnId: turn.sourceTurnId, expectedRevision: revision, purpose, confirmPresent: true,
        ...(purpose === 'key' ? { key, ...(key === 'Escape' ? { confirmInterrupt: true } : {}) } : { text: sent }) } });
      setMessage(record.status === 'delivered' ? 'Delivered to terminal. The controller will wait for your input check after this turn.' : `${record.status}: ${record.error}`);
      // Only the delivered draft is cleared; a newer one survives.
      const consumed = (current: string) => current === sent ? '' : current;
      if (record.status === 'delivered') { if (purpose === 'detail') setText(consumed); if (purpose === 'answer') setAnswer(consumed); onSent(); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Input response is unknown.');
      if (!(error instanceof HttpError) || error.status >= 500) setUnknown(true);
    } finally { setBusy(false); await refresh(); }
  }
  return <section className="pane-actions" aria-label={`Input for ${agent.label}`}>
    <p className="zone-label"><span aria-hidden="true">⌨️</span> Input to {agent.label} · {run.status === 'paused' ? 'controller paused' : run.status === 'waiting' ? 'waiting at checkpoint' : 'run in progress'}{turn?.status === 'finished' && ' · turn finished'}</p>
    <label>Add detail to this task<textarea aria-label={`Add detail for ${agent.label}`} rows={2} value={text} maxLength={1900} onChange={(e) => setText(e.target.value)} /></label>
    {turn?.status !== 'finished' && <p className="fine">After the current task: {run.implementation ? turn?.input.handoff ? 'publish the assigned result, then review with the peer' : 'publish the assigned result, then stop' : run.planning ? 'continue the configured planning workflow' : 'stop after the instruction'}. This update does not change that choice.</p>}
    {active ? <div role="group" aria-label={`Input check for ${agent.label}`}>
      <Acknowledgement label={`I inspected ${agent.label}’s terminal and intend this input`} checked={present} disabled={!!reason || busy} onChange={setPresent} lines={override?.lines ?? []}>
        I inspected {agent.label}’s terminal and intend this input.</Acknowledgement>
      {reason && <p id={reasonId} className="fine" role="status">{reason}</p>}
      <p className="fine">Applies to <strong>Send update</strong>, answers and keys for {agent.label} in this run.</p>
    </div> : <p className="fine">Select {agent.label} to confirm your inspection and send input.</p>}
    <button type="button" disabled={off || !text.trim()} onClick={() => void send('detail')}>Send update to {agent.label}</button>
    {/* The selected card explains a blocker beside its check; another card says it here. */}
    {reason ? !active && <p className="fine" role="status">{reason}</p> : !present && active && <p className="fine">Confirm your terminal inspection above.</p>}
    <details className="pane-disclosure"><summary>Terminal controls</summary>
      <p className="fine">Inspect the capture and its time above. Answers are literal; their meaning depends on the current dialog. Input holds progression until a post-turn check. A queued new turn may require takeover; inspect the terminal after sending.</p>
      <label>Literal answer<textarea aria-label={`Literal answer for ${agent.label}`} rows={1} maxLength={1900} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
      <div className="pane-buttons"><button disabled={off || !answer.trim()} onClick={() => void send('answer')}>Send answer</button><button disabled={off} onClick={() => void send('key', 'Enter')}>Enter</button><button disabled={off} onClick={() => setEscape(true)}>Esc…</button></div>
      {escape && <div className="notice"><p>Escape may dismiss the dialog or interrupt {agent.label}. An interrupted assignment requires reconciliation.</p><button disabled={off} onClick={() => void send('key', 'Escape')}>Send Escape</button><button onClick={() => setEscape(false)}>Cancel</button></div>}
    </details>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function CheckpointControls({ token, checkpoint, disabled, refresh, override, viewEpoch }: {
  token: string; checkpoint: Checkpoint; disabled: boolean; refresh: () => Promise<void>; override: Override | null; viewEpoch: number;
}) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const blocked = checkpoint.fault || Object.values(checkpoint.external).some((e) => e.state !== 'clear');
  const mounted = useMounted();
  // Clearing manual input is expected to change that hold. A changed checkpoint or view still cancels continuation, even if restored.
  const intent = JSON.stringify([token, checkpoint, disabled, viewEpoch]);
  const intentRef = useRef({ key: intent, revision: 0 });
  if (intentRef.current.key !== intent) intentRef.current = { key: intent, revision: intentRef.current.revision + 1 };
  if (checkpoint.kind === 'waiting' && !Object.keys(checkpoint.external).length) return null;
  async function confirm() {
    if (blocked || busy || disabled) return;
    setBusy(true); setMessage('');
    const revision = intentRef.current.revision;
    if (override) {
      try {
        await override.clear();
        if (!mounted.current) return;
        if (intentRef.current.revision !== revision) throw Error('Manual input was recorded, but the checkpoint or view changed. Inspect again; the controller was not continued.');
      } catch (error) {
        if (!mounted.current) return;
        setMessage(error instanceof Error ? error.message : 'Manual input could not be recorded. The controller was not continued.'); setBusy(false); await refresh(); return;
      }
    }
    try {
      await api(token, 'checkpoints', { body: { requestId: crypto.randomUUID(), runId: checkpoint.runId, commandId: checkpoint.commandId, expectedRevision: checkpoint.revision, action: checkpoint.kind === 'waiting' ? 'restore' : 'review_input', confirmReady: true } });
      setMessage('Checkpoint reconciled. Inspect the current controller state.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Checkpoint response unknown. Refresh before another action.'); }
    finally { setBusy(false); await refresh(); }
  }
  return <section className="notice" aria-label="Input checkpoint">
    <p>{blocked ? checkpoint.reason || 'Missing activity evidence; inspect the workers and take over if needed.' : 'The original result is validated. Check every checkout terminal, queued input and background writer before continuing.'}</p>
    {!blocked && <p className="fine">Continuing tells the controller every checkout writer is settled: empty prompts, no queued input.</p>}
    {!blocked && override && <><p className="fine">Continuing also accepts these manual-input consequences. This controller run is kept:</p>
      <ul aria-label="Consequences of continuing">{override.lines.map(line => <li key={line}>{line}</li>)}</ul></>}
    <button disabled={disabled || busy || blocked} onClick={() => void confirm()}>{checkpoint.kind === 'waiting' ? 'Restore checkpoint' : 'Review input and continue'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
