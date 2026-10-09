import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type { BackgroundAction } from '../../contracts/background-actions.ts';
import { GlobalAIError } from '../global-ai/reads.ts';
import { jobEnvironment } from '../../../scripts/background-native.mjs';
import { resolveExecutable } from '../config.ts';
import { terminalHost } from '../terminal-gateway.ts';
import { cleanActionValue, redactActionText, type ActionGrant, type ActionResult } from './actions.ts';
import { READ_APP_OPERATIONS } from './app-operations.ts';

const alive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
/** One bounded foreground command. File edits and explicit shell programs use this same audited boundary. */
export async function executeCommand(action: BackgroundAction, signal: AbortSignal, started: (pid: number) => void, admitted: () => void, ownerToken = ''): Promise<ActionResult> {
  const op = action.operation;
  if (op.kind !== 'command') throw new GlobalAIError('ACTION_KIND', 'Expected a host command.', 400);
  const directory = await realpath(op.directory).catch(() => null);
  if (directory !== op.directory || !(await stat(directory)).isDirectory()) throw new GlobalAIError('ACTION_DIRECTORY', 'The exact working directory is missing or changed. Request its canonical path.');
  const environment = jobEnvironment();
  environment.PATH = (environment.PATH ?? '').split(delimiter).filter(Boolean).map(path => isAbsolute(path) ? path : resolve(directory, path)).join(delimiter);
  // Child processes never inherit the app bearer token, hook variables, tmux identity or arbitrary environment overrides.
  const executable = resolveExecutable(op.executable.includes('/') ? resolve(directory, op.executable) : op.executable, environment);
  if (!executable) throw new GlobalAIError('ACTION_EXECUTABLE', 'This command executable is unavailable.');
  if (signal.aborted) throw new GlobalAIError('ACTION_REVOKED', 'Action execution was canceled before launch.');
  admitted();
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>, pid: number | null = null, done = false, bytes = 0, output = Buffer.alloc(0), truncated = false, stopped = false;
    let deadline: ReturnType<typeof setTimeout>, kill: ReturnType<typeof setTimeout> | undefined, abandon: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, forced = false) => {
      // A parent can exit before a child that ignored TERM. Keep the scheduled KILL and inspection in that case.
      if (!forced && stopped && pid !== null && alive(pid)) return;
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(kill); clearTimeout(abandon); signal.removeEventListener('abort', stop);
      const settled = pid === null || !alive(pid);
      resolve({ status: !settled ? 'uncertain' : code === 0 && !stopped ? 'completed' : 'failed',
        message: !settled ? 'The command process group may still be running. Ownership is retained; inspect it.' : stopped ? 'Command stopped; process-group exit verified. Earlier changes may remain.' : `Command exited with ${code ?? 'no exit code'}.`,
        result: { exitCode: code, pid, output: redactActionText(output.toString('utf8').replace(/\uFFFD$/, ''), ownerToken), truncated, processGroupExited: settled } });
    };
    const stop = () => {
      if (done || stopped) return; stopped = true;
      if (pid) try { process.kill(-pid, 'SIGTERM'); } catch { /* settlement is inspected */ }
      kill = setTimeout(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* inspected below */ } }, 3000);
      abandon = setTimeout(() => finish(null, true), 6000);
    };
    const capture = (chunk: Buffer) => {
      bytes += chunk.length;
      if (output.length < 8192) output = Buffer.concat([output, chunk.subarray(0, 8192 - output.length)]);
      if (bytes > 8192) truncated = true;
      if (bytes > 1048576) stop();
    };
    try {
      child = spawn(executable, op.args, { cwd: directory, env: environment as NodeJS.ProcessEnv, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      pid = child.pid ?? null;
    } catch { finish(null); return; }
    child.once('error', () => {}); child.once('close', code => finish(code));
    child.stdout!.on('data', capture); child.stderr!.on('data', capture); child.stdin!.on('error', () => {});
    signal.addEventListener('abort', stop, { once: true }); deadline = setTimeout(stop, 120000);
    // Keep cancellation and settlement observation attached even if persisting the process identity fails.
    try { if (pid) started(pid); } catch { child.stdin!.end(); stop(); return; }
    child.stdin!.end(op.stdin ?? ''); if (signal.aborted) stop();
  });
}
/** Uses the existing authenticated routes and their services. The action grant carries provenance, not permission to skip validation. */
export async function executeApp(action: BackgroundAction, signal: AbortSignal, admitted: () => void, grant: () => ActionGrant, ownerToken: string, allowedOrigins: string[] = []): Promise<ActionResult> {
  const op = action.operation, origin = terminalHost().loopbackOrigin;
  if (op.kind !== 'app' || !origin || new URL(origin).hostname !== '127.0.0.1') throw new GlobalAIError('HOST_UNAVAILABLE', 'The app action needs this host’s loopback server.');
  if (signal.aborted) throw new GlobalAIError('ACTION_REVOKED', 'Action execution was canceled before delivery.');
  // Transport always stays on loopback, including hosts configured for browser access through a private HTTPS name only.
  const authOrigin = allowedOrigins.find(value => new URL(value).host === new URL(origin).host) ?? allowedOrigins[0] ?? origin;
  const read = READ_APP_OPERATIONS.includes(`${op.method} ${op.path}`);
  admitted();
  const handle = grant();
  let receipt: { status: number; body: unknown } | null = null;
  try { receipt = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    // http.request preserves the configured Host header; fetch rewrites it to the transport address. Redirects are never followed.
    const call = request(origin + op.path, { method: op.method, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      headers: { Authorization: `Bearer ${ownerToken}`, Origin: authOrigin, Host: new URL(authOrigin).host, 'Content-Type': 'application/json', 'X-AltCLI-Background-Action': handle.token } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) { call.destroy(new Error('Action receipt exceeded its bound.')); return; } chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { try { resolve({ status: response.statusCode ?? 500, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { reject(new Error('No structured app receipt.')); } });
    });
    call.once('error', reject); call.end(op.body === undefined ? undefined : JSON.stringify(op.body));
  }); } catch { /* Transport failure alone cannot establish whether the handler ran. */ }
  const evidence = handle.settle(), result = receipt ? { httpStatus: receipt.status, body: cleanActionValue(receipt.body, ownerToken) } : null;
  if (evidence === 'unused') return { status: 'failed', message: 'The app handler did not run. Its unused grant was revoked; nothing will be replayed.', result };
  const ok = receipt !== null && receipt.status >= 200 && receipt.status < 300;
  if (evidence === 'consumed' && read) return { status: ok ? 'completed' : 'failed',
    message: ok ? 'App read completed.' : 'App read failed or its result was unavailable. This audited read has no effects.', result };
  if (evidence === 'consumed' && ok) return { status: 'accepted',
    message: 'App request accepted. Task completion is unverified; inspect the original operation and its ownership.', result };
  return { status: 'uncertain', message: 'The app handler may have changed state. Inspect the original operation before reconciling; nothing will be replayed.', result };
}
