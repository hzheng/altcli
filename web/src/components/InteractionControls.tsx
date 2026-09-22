'use client';
import { useEffect, useState } from 'react';
import type { Checkpoint, InteractionInput, InteractionRecord } from '../contracts/interactions';
import type { ManagedSession, RelayRun, WorkflowState } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { useRemembered } from '../client/memory';

export function InteractionComposer({ token, state, run, agent, draftKey, disabled, viewEpoch, refresh }: {
  token: string; state: WorkflowState; run: RelayRun; agent: ManagedSession; draftKey: string;
  disabled: boolean; viewEpoch: number; refresh: () => Promise<void>;
}) {
  const [text, setText] = useRemembered(`${draftKey}:text`, '');
  const [answer, setAnswer] = useRemembered(`${draftKey}:answer`, '');
  const [present, setPresent] = useState(false); const [escape, setEscape] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [unknown, setUnknown] = useState(false);
  const turn = state.executions.find((t) => t.commandId === run.currentCommandId);
  const revision = run.interaction?.revision ?? 0;
  useEffect(() => { setPresent(false); setEscape(false); }, [run.currentCommandId, run.status, run.pauseRequested, turn?.status, agent.registrationId, revision, viewEpoch, disabled]);
  const pending = state.interactions?.some((r) => r.input.runId === run.id && ['recorded','sending','uncertain'].includes(r.status));
  const reason = disabled ? 'The terminal is not currently available for input.' : unknown ? 'The response is unknown. Inspect input history before doing anything else.'
    : pending ? 'An input delivery is pending or uncertain. Inspect it before sending again.'
    : turn?.agentId !== agent.id ? 'Another agent owns this checkout. This draft has not been sent.'
    : run.status !== 'running' || run.pauseRequested || run.interaction?.fault || turn?.status !== 'delivered' ? 'Wait for the checkpoint or reconcile the paused controller.'
    : !turn.sessionId || !turn.sourceTurnId ? 'Waiting for the exact native start acknowledgment.' : '';
  const off = !!reason || busy || !present;
  async function send(purpose: InteractionInput['purpose'], key?: 'Enter' | 'Escape') {
    if (off || !turn?.sessionId || !turn.sourceTurnId) return;
    setBusy(true); setMessage(''); setPresent(false); setEscape(false);
    try {
      const record = await api<InteractionRecord>(token, 'interactions', { body: { requestId: crypto.randomUUID(), runId: run.id, commandId: turn.commandId, agentId: agent.id, registrationId: agent.registrationId,
        sessionId: turn.sessionId, sourceTurnId: turn.sourceTurnId, expectedRevision: revision, purpose, confirmPresent: true,
        ...(purpose === 'key' ? { key, ...(key === 'Escape' ? { confirmInterrupt: true } : {}) } : { text: purpose === 'answer' ? answer : text }) } });
      setMessage(record.status === 'delivered' ? 'Delivered to terminal. The controller will wait for your input check after this turn.' : `${record.status}: ${record.error}`);
      if (record.status === 'delivered') { if (purpose === 'detail') setText(''); if (purpose === 'answer') setAnswer(''); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Input response is unknown.');
      if (!(error instanceof HttpError) || error.status >= 500) setUnknown(true);
    } finally { setBusy(false); await refresh(); }
  }
  return <section className="pane-actions" aria-label={`Input for ${agent.label}`}>
    <label>Add detail to this task<textarea aria-label={`Add detail for ${agent.label}`} rows={2} value={text} maxLength={1900} onChange={(e) => setText(e.target.value)} /></label>
    <p className="fine">After the current task: {run.implementation ? turn?.input.handoff ? 'publish the assigned result, then review with the peer' : 'publish the assigned result, then stop' : run.planning ? 'continue the configured planning workflow' : 'stop after the instruction'}. This update does not change that choice.</p>
    <label><input type="checkbox" checked={present} disabled={!!reason || busy} onChange={(e) => setPresent(e.target.checked)} /> I inspected {agent.label}’s terminal and intend this input.</label>
    <button type="button" disabled={off || !text.trim()} onClick={() => void send('detail')}>Send update to {agent.label}</button>
    {reason && <p className="fine" role="status">{reason}</p>}
    <details className="pane-disclosure"><summary>Terminal controls</summary>
      <p className="fine">Inspect the capture and its time above. Answers are literal; their meaning depends on the current dialog. Input holds progression until a post-turn check. A queued new turn may require takeover; inspect the terminal after sending.</p>
      <label>Literal answer<textarea aria-label={`Literal answer for ${agent.label}`} rows={1} maxLength={1900} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
      <div className="pane-buttons"><button disabled={off || !answer.trim()} onClick={() => void send('answer')}>Send answer</button><button disabled={off} onClick={() => void send('key', 'Enter')}>Enter</button><button disabled={off} onClick={() => setEscape(true)}>Esc…</button></div>
      {escape && <div className="notice"><p>Escape may dismiss the dialog or interrupt {agent.label}. An interrupted assignment requires reconciliation.</p><button disabled={off} onClick={() => void send('key', 'Escape')}>Send Escape</button><button onClick={() => setEscape(false)}>Cancel</button></div>}
    </details>
    {message && <p role="status">{message}</p>}
  </section>;
}

export function CheckpointControls({ token, checkpoint, disabled, viewEpoch, refresh }: { token: string; checkpoint: Checkpoint; disabled: boolean; viewEpoch: number; refresh: () => Promise<void> }) {
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { setReady(false); }, [checkpoint.revision, viewEpoch, disabled]);
  const blocked = checkpoint.fault || Object.values(checkpoint.external).some((e) => e.state !== 'clear');
  if (checkpoint.kind === 'waiting' && !Object.keys(checkpoint.external).length) return null;
  async function confirm() {
    if (!ready || blocked || busy || disabled) return;
    setBusy(true); setReady(false);
    try {
      await api(token, 'checkpoints', { body: { requestId: crypto.randomUUID(), runId: checkpoint.runId, commandId: checkpoint.commandId, expectedRevision: checkpoint.revision, action: checkpoint.kind === 'waiting' ? 'restore' : 'review_input', confirmReady: true } });
      setMessage('Checkpoint reconciled. Inspect the current controller state.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Checkpoint response unknown. Refresh before another action.'); }
    finally { setBusy(false); await refresh(); }
  }
  return <section className="notice" aria-label="Input checkpoint">
    <p>{blocked ? checkpoint.reason || 'Missing activity evidence; inspect the workers and take over if needed.' : 'The original result is validated. Check every checkout terminal, queued input and background writer before continuing.'}</p>
    <label><input type="checkbox" disabled={disabled || busy || blocked} checked={ready} onChange={(e) => setReady(e.target.checked)} /> All checkout writers are settled, with empty prompts and no queued input.</label>
    <button disabled={disabled || busy || blocked || !ready} onClick={() => void confirm()}>{checkpoint.kind === 'waiting' ? 'Restore checkpoint' : 'Review input and continue'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
