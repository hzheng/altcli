import { createHash, randomUUID } from 'node:crypto';
export const OUTCOMES = new Set(['no_incoming_handoff', 'strong_objection', 'accept_without_improvement', 'accept_and_improve']);
export const marker = (text) => typeof text === 'string'
  ? /\[altcli-command:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]\s*$/i.exec(text)?.[1] : undefined;
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
  // stop_hook_active describes Stop-hook continuation, not the task registry.
  if ((Array.isArray(tasks) && tasks.length) || (Array.isArray(crons) && crons.length)) return 'active';
  return Array.isArray(tasks) && Array.isArray(crons) ? 'clear' : 'unknown';
}
/** Only counts and known task kinds leave the hook; never descriptions, commands or cron prompts. */
export function backgroundSummary(payload) {
  const tasks = payload.background_tasks ?? payload['background-tasks'];
  const crons = payload.session_crons ?? payload['session-crons'];
  const kinds = new Set(['local_bash', 'local_agent', 'remote_agent', 'in_process_teammate']);
  return { tasks: Array.isArray(tasks) ? Math.min(tasks.length, 100000) : null,
    crons: Array.isArray(crons) ? Math.min(crons.length, 100000) : null,
    taskTypes: Array.isArray(tasks) ? [...new Set(tasks.map(t => kinds.has(t?.type) ? t.type : 'unknown'))].sort() : [] };
}
export const contextKey = (identity, sessionId) => createHash('sha256').update(JSON.stringify([identity, sessionId])).digest('hex');
/** Claude Code >= 2.1.196 sends the same prompt_id to UserPromptSubmit and the Stop that closes that prompt. */
export const promptId = (payload) => typeof payload.prompt_id === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(payload.prompt_id) ? payload.prompt_id : null;
/** How a payload identifies its prompt. A present-but-invalid ID is not evidence of an older CLI, so it is its own mode. */
export const pairingOf = (payload) => promptId(payload) ? 'native' : Object.hasOwn(payload, 'prompt_id') ? 'invalid' : 'legacy';
export function claudeStart(payload, target, previous) {
  const pairing = pairingOf(payload);
  // Without a native prompt id, two starts without an intervening Stop cannot be safely paired with one completion.
  // Fail closed rather than let a queued prompt borrow the preceding turn's final response. A recorded completionSequence
  // is that intervening Stop, even when the slot stays active awaiting clear background evidence.
  const commandId = pairing === 'native' || (pairing === 'legacy' && (previous?.phase !== 'active' || previous.completionSequence !== undefined)) ? marker(payload.prompt) : undefined;
  return { source: 'claude', paneId: target.paneId, socketPath: target.socketPath, identity: target, sessionId: payload.session_id,
    sourceTurnId: promptId(payload) ?? randomUUID(), prompt: plain(payload.prompt), ...(commandId ? { commandId } : {}) };
}
/** Local-only pairing provenance. Never include `pairing` in the HTTP hook payload. */
export function claudeStartState(payload, target, previous) {
  return { phase: 'active', pairing: pairingOf(payload), context: claudeStart(payload, target, previous) };
}
/** Claude Code re-enters the model with a synthetic `<task-notification>` prompt when a background task or subagent
 * finishes. The payload carries no provenance, so this is a text shape, and it only matters while a turn is active. */
export const isTaskNotification = (payload) => payload.hook_event_name === 'UserPromptSubmit' && typeof payload.prompt === 'string' && /^\s*<task-notification[\s>]/i.test(payload.prompt);
/** The saved slot after a mid-turn notification: unchanged, except that the Stop closing this re-entry may carry the
 * notification's own prompt_id, so remember it as a continuation of the active turn. Null when nothing is active, in
 * which case the caller treats the prompt as an ordinary start. */
export function claudeContinuation(payload, target, saved) {
  if (saved?.phase !== 'active' || !saved.context || saved.context.sessionId !== payload.session_id ||
    contextKey(saved.context.identity, saved.context.sessionId) !== contextKey(target, payload.session_id)) return null;
  const id = promptId(payload);
  if (!id || saved.pairing !== 'native') return saved;
  return { ...saved, continuations: [...new Set([...(saved.continuations ?? []), id])] };
}
/** The saved start this Stop closes, or null when its identity is missing, changed, or ambiguous. */
export function claudeStopContext(payload, target, saved) {
  if (saved?.phase !== 'active' || !saved.context) return null;
  const context = saved.context;
  if (context.sessionId !== payload.session_id || contextKey(context.identity, context.sessionId) !== contextKey(target, payload.session_id)) return null;
  // Start and Stop must identify the prompt the same way: a native start needs its exact ID back, a legacy start
  // needs a Stop that also omits the field. Malformed starts and older slots without provenance never complete.
  if (saved.pairing !== pairingOf(payload) || saved.pairing === 'invalid') return null;
  if (saved.pairing === 'native' && context.sourceTurnId !== promptId(payload) && !(saved.continuations ?? []).includes(promptId(payload))) return null;
  return context;
}
export function claudeCompletion(payload, context) {
  // Never read transcript_path. It may still end with a previous turn's response.
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;
  return { ...context, source: 'claude', event: 'turn_complete', settled: text !== null,
    backgroundState: backgroundState(payload), backgroundSummary: backgroundSummary(payload), ...outcomeOf(text) };
}
/** Bind only the native prompt event, never the legacy notifier's prompt history. */
export function codexStartState(payload, identity, saved) {
  if (payload.hook_event_name !== 'UserPromptSubmit' || payload.agent_id || payload.subagent ||
    typeof payload.session_id !== 'string' || !payload.session_id || typeof payload.turn_id !== 'string' || !payload.turn_id || typeof payload.prompt !== 'string') return null;
  const context = { source: 'codex', paneId: identity.paneId, socketPath: identity.socketPath, identity,
    sessionId: payload.session_id, sourceTurnId: payload.turn_id, prompt: plain(payload.prompt),
    ...(marker(payload.prompt) ? { commandId: marker(payload.prompt) } : {}) };
  if (saved?.context?.sourceTurnId === payload.turn_id && saved.context.sessionId === payload.session_id &&
    contextKey(saved.context.identity, payload.session_id) === contextKey(identity, payload.session_id)) {
    if (saved.phase === 'active' && (!context.commandId || (context.commandId === saved.context.commandId && context.prompt === saved.context.prompt))) return saved;
    // A second controller command in one native turn cannot acquire the first command's completion.
    delete context.commandId;
    return { phase: 'ambiguous', context };
  }
  return { phase: 'active', context };
}
export function codexCompletion(payload, identity, saved) {
  if (payload.type !== 'agent-turn-complete') return null;
  const sessionId = payload['thread-id'] ?? payload.thread_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const nativeTurn = payload['turn-id'] ?? payload.turn_id;
  const context = saved?.phase === 'active' && saved.context?.sessionId === sessionId && typeof nativeTurn === 'string' &&
    saved.context.sourceTurnId === nativeTurn && contextKey(saved.context.identity, sessionId) === contextKey(identity, sessionId) ? saved.context : null;
  const text = payload['last-assistant-message'] ?? payload.last_assistant_message;
  return { source: 'codex', event: 'turn_complete', paneId: identity.paneId, socketPath: identity.socketPath, identity, sessionId,
    ...(context ? { sourceTurnId: nativeTurn, ...(context.commandId ? { commandId: context.commandId } : {}),
      ...(context.cliPid ? { cliPid: context.cliPid, startedAt: context.startedAt } : {}) } : {}),
    prompt: context?.prompt ?? null, settled: typeof text === 'string', backgroundState: backgroundState(payload), ...outcomeOf(text) };
}
/** Cancellation carries the exact native turn, never a prompt or transcript fallback. */
export function codexInterruption(payload, identity, saved, cliPid) {
  const context = saved?.context;
  if (payload.hook_event_name !== 'Interrupt' || payload.agent_id || payload.subagent ||
    typeof payload.turn_id !== 'string' || !payload.turn_id || typeof payload.session_id !== 'string' ||
    !['active', 'interrupted'].includes(saved?.phase) || context?.source !== 'codex' || !context.cliPid || context.cliPid !== cliPid || !context.startedAt ||
    context.sessionId !== payload.session_id || context.sourceTurnId !== payload.turn_id ||
    contextKey(context.identity, context.sessionId) !== contextKey(identity, payload.session_id)) return null;
  return { ...context, event: 'turn_interrupted', settled: false, backgroundState: 'unknown' };
}
