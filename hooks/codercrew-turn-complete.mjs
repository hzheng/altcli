// Claude: UserPromptSubmit + Stop on stdin. Codex: notify JSON is the last argument.
// Source-specific hooks normalize evidence. They never derive completion from terminal text or stale transcripts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { claudeCompletion, claudeStartState, claudeStopContext, codexCompletion, contextKey } from './protocol.mjs';
const [source, ...args] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
async function post(body) {
  const env = readFileSync(process.env.CODERCREW_ENV ?? join(root, 'web', '.env.local'), 'utf8');
  const token = env.split('\n').map((l) => /^CODERCREW_TOKEN=([0-9a-f]{64})\s*$/i.exec(l)?.[1]).find(Boolean);
  if (!token) return;
  const base = new URL(process.env.CODERCREW_URL ?? 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) return;
  const response = await fetch(new URL('/api/v1/events', base), { method: 'POST', signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Hook rejected: ${response.status}`);
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
  const target = identity(); if (!target) return;
  const payload = JSON.parse(source === 'claude' ? readFileSync(0, 'utf8') : args.at(-1) ?? '{}');
  // This hook is itself a child of the CLI while it posts; the server excludes it from process evidence by pid.
  if (source === 'codex') { const event = codexCompletion(payload, target); if (event) await post({ ...event, reporterPid: String(process.pid) }); return; }
  if (source !== 'claude' || typeof payload.session_id !== 'string' || payload.agent_id) return;
  const directory = join(homedir(), '.local', 'share', 'codercrew', 'hook-turns');
  const path = join(directory, `${contextKey(target, payload.session_id)}.json`);
  const load = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const save = (value) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  };
  if (payload.hook_event_name === 'UserPromptSubmit') {
    const saved = claudeStartState(payload, target, load());
    save(saved);
    await post({ ...saved.context, event: 'turn_started' });
  } else if (payload.hook_event_name === 'Stop') {
    const saved = load(); const context = claudeStopContext(payload, target, saved);
    if (!context) return;
    save({ ...saved, phase: 'finished' });
    await post(claudeCompletion(payload, context));
  }
}
try { await main(); } catch { /* Missing evidence pauses the server run; never block or clutter the worker CLI. */ }
if (source === 'codex' && args[0] === '--then' && args.length > 2) {
  // Preserve a foreign notifier, but do not let it hang this hook forever.
  spawnSync(args[1], args.slice(2), { stdio: 'ignore', timeout: 3000, shell: false });
}
process.exit(0);
