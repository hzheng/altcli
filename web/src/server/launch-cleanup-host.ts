import type { LaunchInstance } from '../contracts/launches.ts';
import { AppError } from '../core/errors.ts';
import { requestId } from '../core/validation.ts';
import type { Config } from './config.ts';
import { listPanes } from './adapters/tmux.ts';
import { tmuxFinishHost, type FinishHost } from './finish.ts';
import { terminalRunner } from './terminal-environment.ts';

export type LaunchCleanupHost = Pick<FinishHost, 'sessionPanes'|'absent'> & { kill(item: LaunchInstance): Promise<void> };
export function launchCleanupHost(config: Config): LaunchCleanupHost {
  const run = terminalRunner(config), host = tmuxFinishHost(config, () => listPanes(run));
  return { ...host, async kill(item) {
    const stopLive = item.cleanup?.confirmStop === true;
    const identity = item.identity ?? item.placeholder;
    if (!identity || !/^\$\d+$/.test(item.sessionId ?? '') || !/^@\d+$/.test(item.windowId ?? '') || !/^%\d+$/.test(identity.paneId) ||
      !/^\d+$/.test(identity.serverPid) || !/^\d+$/.test(identity.serverStarted) || (stopLive && !/^\d+$/.test(identity.panePid))) throw new AppError('LAUNCH_CHANGED', 'Invalid recorded cleanup identity.', 409);
    requestId(item.id);
    // tmux evaluates this and kills in its own command queue: a respawn, new split/window, linked window or changed marker between
    // HTTP confirmation and execution must not stop a replacement process. Dead cleanup still requires pane_dead; an explicit
    // live close instead binds the original process PID (and may close it if it exits while the command is queued). -F runs no shell.
    const matches: Record<string, string> = { session_id: item.sessionId!, window_id: item.windowId!, pane_id: identity.paneId, pid: identity.serverPid,
      start_time: identity.serverStarted, '@altcli_launch': item.id, session_windows: '1', window_panes: '1', window_linked: '0' };
    if (stopLive) matches.pane_pid = identity.panePid; else matches.pane_dead = '1';
    const condition = Object.entries(matches).map(([key, value]) => `#{==:#{${key}},${value}}`).reduce((a, b) => `#{&&:${a},${b}}`);
    await run(['if-shell', '-F', '-t', identity.paneId, condition, `kill-session -t ${item.sessionId}`]);
  } };
}
