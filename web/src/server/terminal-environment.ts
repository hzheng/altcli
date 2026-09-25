import { execFile } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { AppError } from '../core/errors.ts';
import type { Config } from './config.ts';

export const excludedEnvironment = (key: string) => /^(ALTCLI_|NEXT_|__NEXT_|npm_|GIT_|LD_|DYLD_|TMUX$|TMUX_PANE$)/.test(key) || ['NODE_ENV', 'NODE_OPTIONS', 'PORT', 'INIT_CWD', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT'].includes(key);
export function terminalEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !excludedEnvironment(key)) env[key] = value;
  env.PATH = (source.PATH ?? '/usr/bin:/bin').split(delimiter).filter(p => isAbsolute(p) && !/(^|\/)node_modules\/\.bin(?:\/|$)/.test(p)).join(delimiter);
  env.TERM = 'xterm-256color'; env.LANG = source.LANG?.toUpperCase().includes('UTF-8') ? source.LANG : 'en_US.UTF-8';
  return env;
}
/** tmux interprets a trailing semicolon even when invoked with execFile's argv. */
export const tmuxLiteral = (arg: string): string => arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg;
export function terminalRunner(config: Pick<Config, 'tmuxBin' | 'tmuxSocket'>) {
  return (args: string[]): Promise<string> => new Promise((done, fail) => {
    execFile(config.tmuxBin, [...(config.tmuxSocket ? ['-S', config.tmuxSocket] : []), ...args],
      // Next's ambient ProcessEnv requires NODE_ENV; the child deliberately omits it.
      { shell: false, env: terminalEnvironment() as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        // argv and environment can contain sensitive data. Do not expose stderr or Error.command.
        if (error) fail(new AppError('TERMINAL_INSPECTION', 'tmux could not verify this operation. Inspect its recorded state; nothing is retried automatically.', 409));
        else done(stdout);
      });
  });
}
