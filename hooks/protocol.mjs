import { createHash } from 'node:crypto';
export const OUTCOMES = new Set(['no_incoming_handoff', 'strong_objection', 'accept_without_improvement', 'accept_and_improve']);
export const marker = (text) => typeof text === 'string'
  ? /\[codercrew-command:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\s*$/i.exec(text)?.[1] : undefined;
export const plain = (text, max = 2000) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : '';
/** Only the actual final nonempty line is a report. An earlier quoted example is not. */
export function outcomeOf(text) {
  const last = typeof text === 'string' ? text.trimEnd().split('\n').pop() ?? '' : '';
  const match = /^\s*RELAY-OUTCOME:\s*([a-z_]+)(?:\s*[—–-]+\s*(.*))?\s*$/.exec(last);
  return match && OUTCOMES.has(match[1]) ? { outcome: match[1], reason: plain(match[2], 500) || null } : { outcome: null, reason: null };
}
export function backgroundState(payload) {
  const tasks = payload.background_tasks ?? payload['background-tasks'];
  const crons = payload.session_crons ?? payload['session-crons'];
  if ((Array.isArray(tasks) && tasks.length) || (Array.isArray(crons) && crons.length) || payload.stop_hook_active === true) return 'active';
  return Array.isArray(tasks) && Array.isArray(crons) ? 'clear' : 'unknown';
}
export const contextKey = (identity, sessionId) => createHash('sha256').update(JSON.stringify([identity, sessionId])).digest('hex');
export function claudeCompletion(payload, context) {
  // Never read transcript_path. It may still end with a previous turn's response.
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;
  return { ...context, source: 'claude', event: 'turn_complete', settled: text !== null,
    backgroundState: backgroundState(payload), ...outcomeOf(text) };
}
export function codexCompletion(payload, identity) {
  if (payload.type !== 'agent-turn-complete') return null;
  const inputs = payload['input-messages'] ?? payload.input_messages;
  const prompt = Array.isArray(inputs) ? inputs.at(-1) : undefined;
  const commandId = marker(prompt);
  const sessionId = payload['thread-id'] ?? payload.thread_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const nativeTurn = payload['turn-id'] ?? payload.turn_id;
  const text = payload['last-assistant-message'] ?? payload.last_assistant_message;
  return { source: 'codex', event: 'turn_complete', paneId: identity.paneId, socketPath: identity.socketPath, identity, sessionId,
    ...(commandId ? { commandId, sourceTurnId: typeof nativeTurn === 'string' ? nativeTurn : commandId } : {}),
    prompt: plain(prompt) || null, settled: typeof text === 'string', backgroundState: backgroundState(payload), ...outcomeOf(text) };
}
