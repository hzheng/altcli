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
    const identity = item.identity ?? item.placeholder;
    if (!identity || !/^\$\d+$/.test(item.sessionId ?? '') || !/^@\d+$/.test(item.windowId ?? '') || !/^%\d+$/.test(identity.paneId) ||
      !/^\d+$/.test(identity.serverPid) || !/^\d+$/.test(identity.serverStarted)) throw new AppError('LAUNCH_CHANGED', 'Invalid recorded cleanup identity.', 409);
    requestId(item.id);
    // tmux evaluates this and kills in its own command queue: a respawn, new split/window, linked window or changed marker between
    // HTTP confirmation and execution must not turn dead-pane cleanup into termination of a live session. -F runs no shell.
    const matches = { session_id: item.sessionId!, window_id: item.windowId!, pane_id: identity.paneId, pid: identity.serverPid,
      start_time: identity.serverStarted, '@altcli_launch': item.id, session_windows: '1', window_panes: '1', window_linked: '0', pane_dead: '1' };
    const condition = Object.entries(matches).map(([key, value]) => `#{==:#{${key}},${value}}`).reduce((a, b) => `#{&&:${a},${b}}`);
    await run(['if-shell', '-F', '-t', identity.paneId, condition, `kill-session -t ${item.sessionId}`]);
  } };
}
