import { createHash, randomUUID } from 'node:crypto';
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
/** Claude Code >= 2.1.196 sends the same prompt_id to UserPromptSubmit and the Stop that closes that prompt. */
export const promptId = (payload) => typeof payload.prompt_id === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(payload.prompt_id) ? payload.prompt_id : null;
/** How a payload identifies its prompt. A present-but-invalid ID is not evidence of an older CLI, so it is its own mode. */
export const pairingOf = (payload) => promptId(payload) ? 'native' : Object.hasOwn(payload, 'prompt_id') ? 'invalid' : 'legacy';
export function claudeStart(payload, target, previous) {
  const pairing = pairingOf(payload);
  // Without a native prompt id, two starts without an intervening Stop cannot be safely paired with one completion.
  // Fail closed rather than let a queued prompt borrow the preceding turn's final response.
  const commandId = pairing === 'native' || (pairing === 'legacy' && previous?.phase !== 'active') ? marker(payload.prompt) : undefined;
  return { source: 'claude', paneId: target.paneId, socketPath: target.socketPath, identity: target, sessionId: payload.session_id,
    sourceTurnId: promptId(payload) ?? randomUUID(), prompt: plain(payload.prompt), ...(commandId ? { commandId } : {}) };
}
/** Local-only pairing provenance. Never include `pairing` in the HTTP hook payload. */
export function claudeStartState(payload, target, previous) {
  return { phase: 'active', pairing: pairingOf(payload), context: claudeStart(payload, target, previous) };
}
/** The saved start this Stop closes, or null when its identity is missing, changed, or ambiguous. */
export function claudeStopContext(payload, target, saved) {
  if (saved?.phase !== 'active' || !saved.context) return null;
  const context = saved.context;
  if (context.sessionId !== payload.session_id || contextKey(context.identity, context.sessionId) !== contextKey(target, payload.session_id)) return null;
  // Start and Stop must identify the prompt the same way: a native start needs its exact ID back, a legacy start
  // needs a Stop that also omits the field. Malformed starts and older slots without provenance never complete.
  if (saved.pairing !== pairingOf(payload) || saved.pairing === 'invalid') return null;
  if (saved.pairing === 'native' && context.sourceTurnId !== promptId(payload)) return null;
  return context;
}
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
