import { execFile } from 'node:child_process';
import { closeSync, fstatSync, readdirSync, statSync, type Stats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { PaneIdentity } from '../contracts/api.ts';
import { AppError } from '../core/errors.ts';
import type { Config } from './config.ts';
import { inspectPane } from './adapters/tmux.ts';
import { terminalEnvironment, terminalRunner } from './terminal-environment.ts';

export interface AttachTarget { identity: PaneIdentity; sessionId: string; label: string }
const isOpen = (fd: number) => { try { fstatSync(fd); return true; } catch { return false; } };
/** Listing /dev/fd opens and closes a descriptor of its own, the lowest free one, which a spawn may reuse at once. */
const openDescriptors = () => new Set(readdirSync('/dev/fd').map(Number).filter(isOpen));
/** node-pty 1.1.0 (the latest stable release) leaks pseudo-terminals on every macOS spawn. pty_posix_spawn opens
 * spare masters to guard descriptors 0-2, breaks with count 0 when the first one is above stderr, and its
 * `for (; count > 0; count--)` cleanup then closes nothing; it also never closes the parent's copy of the slave.
 * Each keeps a pseudo-terminal allocated until the host runs out (kern.tty.ptmx_max), and the retained slave hides
 * end-of-file when the client exits. Close exactly the masters this spawn opened besides node-pty's own and the
 * parent's copy of its slave; nothing else runs on this thread in between. Only enable this for the audited version. */
function closeLeakedTerminals(before: Set<number>, child: unknown): void {
  const { _fd: master, _pty: slave } = child as { _fd?: unknown; _pty?: unknown };
  if (process.platform !== 'darwin' || typeof master !== 'number' || typeof slave !== 'string') return;
  const device = (stat: () => Stats) => { try { const s = stat(); return s.isCharacterDevice() ? s.rdev : null; } catch { return null; } };
  const masterDevice = device(() => fstatSync(master)), slaveDevice = device(() => statSync(slave));
  if (masterDevice === null) return;
  for (const fd of openDescriptors()) {
    const rdev = before.has(fd) || fd === master ? null : device(() => fstatSync(fd));
    if (rdev !== null && (rdev === slaveDevice || rdev >>> 24 === masterDevice >>> 24)) closeSync(fd);
  }
}
/** node-pty 1.1.0 also never closes the kqueue its macOS exit thread watches the child with. Only lskq shows which
 * queue that is: the one whose sole event is this child's exit. Once that exit has been delivered the finished thread
 * no longer uses it; a queue that cannot be identified while the child runs stays open. */
function exitWatcher(pid: number): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(done => execFile('/usr/bin/lskq', ['-p', String(process.pid)], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
    const events = error ? [] : stdout.split('\n').flatMap(line => {
      const match = /\sfd\s+(\d+)\s+\S+.*?\s(\d+)\s+([A-Z_]+)\s/.exec(line) ?? /\sfd\s+(\d+)\s/.exec(line);
      return match ? [{ queue: Number(match[1]), event: `${match[3]}:${match[2]}` }] : [];
    });
    const queues = events.filter(e => e.event === `PROC:${pid}`).map(e => e.queue);
    done(queues.length === 1 && events.filter(e => e.queue === queues[0]).length === 1 ? queues[0]! : null);
  }));
}
export interface Attachment {
  /** The first synchronized native redraw has reached the output callback. */
  ready?: Promise<void>;
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
    'Captured text: native observation could resize this session. Type in Terminal input to open its native writer.', 409);
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
  // A fixed release may close and reuse its kqueue before onExit. Never close saved
  // descriptor numbers under a different implementation; audit each stable upgrade.
  const cleanup = process.platform === 'darwin' &&
    (await import('node-pty/package.json', { with: { type: 'json' } })).default.version === '1.1.0';
  const before = cleanup ? openDescriptors() : null;
  const child = spawn(config.tmuxBin, [...(config.tmuxSocket ? ['-S', config.tmuxSocket] : []), '-u', '-T', 'sync', 'attach-session', '-E', '-t', target.sessionId,
    ...(!writer ? ['-f', 'read-only,ignore-size'] : [])], { name: 'xterm-256color', cols, rows, env: terminalEnvironment(), encoding: null });
  if (before) closeLeakedTerminals(before, child);
  const watcher = cleanup ? exitWatcher(child.pid) : Promise.resolve(null);
  let ended = false;
  const exit = new Promise<void>(resolve => child.onExit(() => {
    ended = true; exited(); resolve();
    void watcher.then(fd => { if (fd !== null) closeSync(fd); }).catch(() => {});
  }));
  let shown!: () => void;
  const ready = new Promise<void>(resolve => { shown = resolve; });
  // Per-client capability (not a tmux option): xterm 6 supports synchronized output.
  // tmux 3.5a tty_sync_end closes the redraw after modes/screen bytes, even across PTY chunks.
  let initial = '', started = false, complete = false;
  child.onData(bytes => {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); data(chunk);
    if (!complete) {
      initial += chunk.toString('latin1');
      for (const match of initial.matchAll(/\x1b\[\?2026([hl])/g)) {
        if (match[1] === 'h') started = true;
        else if (started) { complete = true; shown(); break; }
      }
      initial = complete ? '' : initial.slice(-16);
    }
  });
  await watcher; // Identified while the child runs, before anyone can close it.
  const run = terminalRunner(config);
  return {
    ready, pid: child.pid, write: bytes => child.write(bytes), resize: (c, r) => child.resize(c, r), pause: () => child.pause(), resume: () => child.resume(),
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
