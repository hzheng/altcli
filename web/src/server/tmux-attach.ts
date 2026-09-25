import { isDeepStrictEqual } from 'node:util';
import type { PaneIdentity } from '../contracts/api.ts';
import { AppError } from '../core/errors.ts';
import type { Config } from './config.ts';
import { inspectPane } from './adapters/tmux.ts';
import { terminalEnvironment, terminalRunner } from './terminal-environment.ts';

export interface AttachTarget { identity: PaneIdentity; sessionId: string; label: string }
export interface Attachment {
  pid: number; write(data: Buffer): void; resize(cols: number, rows: number): void;
  pause(): void; resume(): void; close(): Promise<void>;
  /** `size` is the effective tmux window, which other clients may also influence. */
  active(): Promise<{ paneId: string; command: string; sessionId: string; label: string; size?: string }>;
}
/** ignore-size alone is insufficient when the last ordinary client leaves. Do
 * not attach observers to automatically sized windows, even alongside a desktop. */
export async function assertObserverSize(config: Config, sessionId: string): Promise<void> {
  const policies = (await terminalRunner(config)(['list-windows', '-t', sessionId, '-F', '#{window-size}'])).trimEnd().split('\n');
  if (!policies.length || policies.some(policy => policy !== 'manual')) throw new AppError('CAPTURE_FALLBACK',
    'Captured text: native observation could resize this session. Take keyboard to use its native terminal.', 409);
}
export async function inspectAttach(config: Config, identity: PaneIdentity): Promise<AttachTarget> {
  const run = terminalRunner(config);
  const pane = await inspectPane(run, identity.paneId);
  if (!isDeepStrictEqual(pane.identity, identity)) throw new AppError('TARGET_CHANGED', 'The terminal instance changed. Recheck.', 409);
  const fields = (await run(['display-message', '-p', '-t', identity.paneId, '#{session_id}\t#{session_name}\t#{session_grouped}\t#{destroy-unattached}\t#{detach-on-destroy}'])).trimEnd().split('\t');
  if (fields.length !== 5 || !/^\$\d+$/.test(fields[0]!) || !['0','1'].includes(fields[2]!) || fields[3] !== 'off' || !['on','off','no-detached','previous','next'].includes(fields[4]!)) throw new AppError('TERMINAL_LIFETIME', 'This session has an incompatible destroy-unattached policy or unverified lifetime options. Use captured text or configure its lifetime yourself.', 409);
  return { identity, sessionId: fields[0]!, label: fields[1]! };
}
export async function attachTmux(config: Config, target: AttachTarget, writer: boolean, cols: number, rows: number,
  data: (bytes: Buffer) => void, exited: () => void): Promise<Attachment> {
  const fresh = await inspectAttach(config, target.identity);
  if (fresh.sessionId !== target.sessionId) throw new AppError('TARGET_CHANGED', 'The target session changed.', 409);
  if (!writer) await assertObserverSize(config, target.sessionId);
  const { spawn } = await import('node-pty'); // Mock mode never loads a native addon.
  const child = spawn(config.tmuxBin, [...(config.tmuxSocket ? ['-S', config.tmuxSocket] : []), '-u', 'attach-session', '-E', '-t', target.sessionId,
    ...(!writer ? ['-f', 'read-only,ignore-size'] : [])], { name: 'xterm-256color', cols, rows, env: terminalEnvironment(), encoding: null });
  let ended = false;
  const exit = new Promise<void>(resolve => child.onExit(() => { ended = true; exited(); resolve(); }));
  child.onData(bytes => data(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
  const run = terminalRunner(config);
  return {
    pid: child.pid, write: bytes => child.write(bytes), resize: (c, r) => child.resize(c, r), pause: () => child.pause(), resume: () => child.resume(),
    async close() {
      if (ended) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 1000);
      try { await exit; } finally { clearTimeout(timer); }
    },
    async active() {
      // The original target must still be the same pane in the same session: a lost target never falls back elsewhere.
      if ((await inspectAttach(config, target.identity)).sessionId !== target.sessionId) throw new AppError('TARGET_CHANGED', 'The terminal target moved or its session ended. Reconnect as an observer.', 409);
      if (!writer) await assertObserverSize(config, target.sessionId);
      const clients = (await run(['list-clients', '-F', '#{client_pid}\t#{session_id}\t#{pane_id}\t#{pane_current_command}\t#{window_width}x#{window_height}\t#{session_name}'])).trimEnd().split('\n');
      const current = clients.map(line => line.split('\t')).find(parts => parts[0] === String(child.pid));
      // A writer may deliberately navigate to another session (covered by the server-wide keyboard hold); the label follows.
      // A read-only observer cannot navigate, so a changed session means tmux moved it after a loss.
      if (!current || current.length !== 6 || (!writer && current[1] !== target.sessionId)) throw new AppError('TARGET_CHANGED', 'The attached client changed sessions or exited. Reconnect as an observer.', 409);
      return { sessionId: current[1]!, paneId: current[2]!, command: current[3]!, size: current[4]!, label: current[5]! };
    },
  };
}
