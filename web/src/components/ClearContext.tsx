'use client';
import { useEffect, useRef, useState } from 'react';
import type { ClearContextInput, CommandRecord } from '../contracts/api';
import type { AgentActivity, ManagedSession } from '../contracts/workflow';
import { api, HttpError } from '../client/api';
import { clearContextCommand } from '../core/clear-context';
import { overrideKey, useMounted, type Override } from './Holds';

/** A deliberate per-agent conversation reset, separate from task instructions and Git/worktree cleanup. */
export function ClearContext({ token, agent, activity, blocked, reasonShown, busy, viewKey, override, submit, refresh, onUncertain }: {
  token: string; agent: ManagedSession; activity?: AgentActivity; blocked: string; busy: boolean; viewKey: string;
  override: Override | null;
  /** The pane already displays its input-mode blocker beside this action. */
  reasonShown: boolean;
  submit: (work: () => Promise<void>) => Promise<void>; refresh: () => Promise<void>; onUncertain: (id: string) => void;
}) {
  const [confirmation, setConfirmation] = useState(''), [message, setMessage] = useState('');
  const command = clearContextCommand(agent.agentType);
  const reason = blocked || (activity?.state === 'working' ? 'Wait for this agent to finish before clearing context.' : '');
  const intentKey = JSON.stringify([agent, activity, viewKey, reason]);
  const intent = useRef({ key: intentKey, revision: 0 }), mounted = useMounted();
  if (intent.current.key !== intentKey) intent.current = { key: intentKey, revision: intent.current.revision + 1 };
  const key = JSON.stringify([intentKey, overrideKey(override)]);
  useEffect(() => { setConfirmation(''); }, [key]);
  // Releasing the holds changes the override: the receipt or partial-release report of this click must stay visible.
  useEffect(() => { setMessage(''); }, [intentKey]);
  if (!command) return null;
  async function clear() {
    if (busy || reason || confirmation !== key) return;
    const input: ClearContextInput = { requestId: crypto.randomUUID(), agentId: agent.id, registrationId: agent.registrationId,
      expectedActivityUpdatedAt: activity?.updatedAt ?? null, confirmReady: true };
    const intentRevision = intent.current.revision;
    await submit(async () => {
      setConfirmation(''); setMessage('Sending context reset…');
      let dispatched = false;
      try {
        if (override) {
          await override.clear();
          if (!mounted.current || intent.current.revision !== intentRevision) throw Error('Terminal input was released, but the target or displayed state changed. Inspect and confirm again; nothing was sent.');
        }
        dispatched = true;
        const result = await api<CommandRecord>(token, 'sessions/clear-context', { body: input });
        if (result.status === 'delivered') setMessage(`${command} sent to ${agent.label}. Check the terminal for the fresh conversation.`);
        else {
          setMessage(result.error ?? 'Delivery is unresolved. Inspect the terminal before proceeding.');
          if (result.status !== 'rejected') onUncertain(input.requestId);
        }
      } catch (error) {
        if (dispatched && (!(error instanceof HttpError) || error.status >= 500 || error.code === 'CLEAR_PENDING')) onUncertain(input.requestId);
        setMessage(dispatched && !(error instanceof HttpError) ? 'The response is unknown. Inspect the terminal; nothing is resent.'
          : error instanceof Error ? error.message : 'Terminal input could not be released. Nothing was sent.');
      } finally { await refresh(); }
    });
  }
  return <div className="clear-context">
    <button type="button" className="quiet" disabled={busy || !!reason} title={reason || 'Start a fresh conversation in this agent’s existing terminal.'}
      aria-expanded={confirmation === key} onClick={() => { setMessage(''); setConfirmation(confirmation === key ? '' : key); }}>Clear context…</button>
    {reason && !reasonShown && <span className="fine">{reason}</span>}
    {confirmation === key && <section className="notice" aria-label={`Clear context for ${agent.label}`}>
      <p>Send <code>{command}</code> to <strong>{agent.label}</strong> in <code>{agent.cwd ?? agent.repository}</code> and start a fresh conversation? The agent will lose this conversation’s context. Files, commits and the tmux session stay in place.</p>
      <p>Confirm its prompt is empty and the agent and its background work have finished.</p>
      {!!override?.lines.length && <><p>Confirming also accepts:</p><ul className="consequences" aria-label="Consequences of clearing context">{override.lines.map(line => <li key={line}>{line}</li>)}</ul></>}
      <div className="pane-buttons"><button type="button" disabled={busy || !!reason} onClick={() => void clear()}>Clear {agent.label} context</button>
        <button type="button" onClick={() => setConfirmation('')}>Cancel</button></div>
    </section>}
    {message && <p className="fine" role="status">{message}</p>}
  </div>;
}
