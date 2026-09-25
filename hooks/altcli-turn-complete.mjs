// Claude: UserPromptSubmit + Stop on stdin. Codex: notify JSON is the last argument.
// Source-specific hooks normalize evidence. They never derive completion from terminal text or stale transcripts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { claudeCompletion, claudeContinuation, claudeStartState, claudeStopContext, codexCompletion, codexInterruption, codexStartState, contextKey, isTaskNotification } from './protocol.mjs';
const [source, ...args] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(homedir(), '.local', 'share', 'altcli', 'hook-turns');
function diagnostic(path, paneId) {
  return (status, details = {}) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ source, paneId, status, at: new Date().toISOString(), ...details }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch { /* Diagnostics must not block the CLI either. */ }
  };
}
const pane = /^%\d+$/.test(process.env.TMUX_PANE ?? '') ? process.env.TMUX_PANE : null;
let report = ['claude', 'codex', 'codex-start'].includes(source)
  ? diagnostic(join(directory, `${contextKey({ paneId: pane, socket: (process.env.TMUX ?? '').split(',')[0] }, source)}.entry.status`), pane) : () => {};
async function post(body) {
  const env = readFileSync(process.env.ALTCLI_ENV ?? join(root, 'web', '.env.local'), 'utf8');
  const token = env.split('\n').map((l) => /^ALTCLI_TOKEN=([0-9a-f]{64})\s*$/i.exec(l)?.[1]).find(Boolean);
  if (!token) { report('missing_token'); return; }
  const base = new URL(process.env.ALTCLI_URL ?? 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) { report('invalid_endpoint'); return; }
  report('posting', { event: body.event, paired: Boolean(body.sourceTurnId), cliPid: body.cliPid ?? null });
  const response = await fetch(new URL('/api/v1/events', base), { method: 'POST', signal: AbortSignal.timeout(body.event === 'turn_interrupted' ? 1500 : 3000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, reporterPid: String(process.pid) }) });
  report(response.ok ? 'posted' : 'rejected', { event: body.event, paired: Boolean(body.sourceTurnId), cliPid: body.cliPid ?? null, httpStatus: response.status });
  return response.ok ? await response.json() : null;
}
function identity() {
  const paneId = process.env.TMUX_PANE; const socket = (process.env.TMUX ?? '').split(',')[0];
  if (!paneId || !/^%\d+$/.test(paneId) || !socket) return null;
  const names = ['paneId', 'panePid', 'serverPid', 'serverStarted', 'socketPath'];
  const format = '#{pane_id}\t#{pane_pid}\t#{pid}\t#{start_time}\t#{socket_path}';
  const result = spawnSync('tmux', ['-S', socket, 'display-message', '-p', '-t', paneId, format], { encoding: 'utf8', timeout: 1500, maxBuffer: 8192, shell: false });
  if (result.status !== 0) return null;
  const fields = result.stdout.trimEnd().split('\t');
  if (fields.length !== 5 || fields[0] !== paneId || !fields[4]) return null;
  return Object.fromEntries(names.map((name, index) => [name, fields[index]]));
}
async function main() {
  report('received');
  const target = identity(); if (!target) { report('identity_unavailable'); return; }
  const payload = JSON.parse(source === 'claude' || source === 'codex-start' ? readFileSync(0, 'utf8') : args.at(-1) ?? '{}');
  const codex = source === 'codex' || source === 'codex-start';
  const sessionId = source === 'codex' ? payload['thread-id'] ?? payload.thread_id : payload.session_id;
  if ((!codex && source !== 'claude') || typeof sessionId !== 'string' || !sessionId || payload.agent_id) return;
  const path = join(directory, `${contextKey(target, sessionId)}${codex ? '.codex' : ''}.json`);
  // Bounded metadata only: never persist payloads, prompts, responses, tokens or arbitrary error messages here.
  // A separate file avoids an asynchronous notify overwriting a newer turn's pairing slot.
  report = diagnostic(`${path}.status`, target.paneId);
  report('received');
  const load = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const save = (value) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  };
  const foreground = () => {
    const result = spawnSync('ps', ['-o', 'tpgid=', '-p', target.panePid], { encoding: 'utf8', timeout: 1500, shell: false });
    const pid = result.stdout?.trim(); return result.status === 0 && /^\d{1,10}$/.test(pid) ? pid : null;
  };
  const activity = (saved, pid) => pid ? { ...saved, context: { ...saved.context, cliPid: pid, startedAt: saved.context.cliPid === pid && saved.context.startedAt ? saved.context.startedAt : new Date().toISOString() } } : saved;
  if (payload.hook_event_name === 'SessionStart') {
    if (!['startup', 'resume'].includes(payload.source) || payload.subagent) return;
    const cliPid = foreground(); if (!cliPid) return;
    await post({ source: codex ? 'codex' : 'claude', event: 'session_started', sessionId, cliPid, startedAt: new Date().toISOString(),
      paneId: target.paneId, socketPath: target.socketPath, identity: target });
    return;
  }
  if (source === 'codex-start') {
    const pid = foreground(); const previous = load();
    if (payload.hook_event_name === 'Interrupt') {
      const event = codexInterruption(payload, target, previous, pid); if (!event) return;
      save({ ...previous, phase: 'interrupted' });
      await post(event); return;
    }
    const binding = codexStartState(payload, target, previous?.context?.cliPid && previous.context.cliPid !== pid ? null : previous); if (!binding) return;
    const saved = activity(binding, pid);
    save(saved); await post({ ...saved.context, event: 'turn_started' }); return;
  }
  // Notify runs after native Stop hooks finish; Stop itself can still block or continue the turn.
  if (source === 'codex') {
    const event = codexCompletion(payload, target, load());
    if (event) await post({ ...event, reporterPid: String(process.pid) }); return;
  }
  if (isTaskNotification(payload)) {
    // Only a mid-turn re-entry is the harness's: a human prompt typed during a turn is queued behind the Stop, so an
    // active slot means nobody typed this. Post nothing and let the closing Stop complete the active command.
    const saved = claudeContinuation(payload, target, load()); if (saved) { save(saved); return; }
    // Nothing is in progress: treat it as the ordinary prompt it is, with normal lifecycle pairing.
  }
  if (payload.hook_event_name === 'UserPromptSubmit') {
    const saved = activity(claudeStartState(payload, target, load()), foreground());
    save(saved);
    await post({ ...saved.context, event: 'turn_started' });
  } else if (payload.hook_event_name === 'Stop') {
    const saved = load(); const context = claudeStopContext(payload, target, saved);
    if (!context) return;
    const completion = claudeCompletion(payload, context);
    const completionDigest = createHash('sha256').update(JSON.stringify(completion)).digest('hex');
    const pending = { ...saved, completionDigest, completionSequence: saved.completionDigest === completionDigest ? saved.completionSequence : (saved.completionSequence ?? 0) + 1 };
    save(pending);
    const event = { ...completion, completionSequence: pending.completionSequence };
    const receipt = await post(event);
    // A failed/unknown delivery or an active registry keeps the exact binding for a later Stop.
    // Never overwrite a new prompt or a newer Stop that arrived while HTTP was in flight.
    if (receipt && event.settled && event.backgroundState === 'clear' &&
      (!context.commandId || (receipt.accepted === true && receipt.completion === 'finished')) && JSON.stringify(load()) === JSON.stringify(pending)) {
      save({ ...pending, phase: 'finished' });
    }
  }
}
try { await main(); } catch { report('failed'); /* Missing evidence pauses the server run; never block or clutter the worker CLI. */ }
if (source === 'codex' && args[0] === '--then' && args.length > 2) {
  // Preserve a foreign notifier, but do not let it hang this hook forever.
  spawnSync(args[1], args.slice(2), { stdio: 'ignore', timeout: 3000, shell: false });
}
process.exit(0);
