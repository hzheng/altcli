import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LaunchProfile } from '../../contracts/launches.ts';
import type { GlobalAIInstance } from '../../contracts/global-ai.ts';
import type { Config } from '../config.ts';
import { resolveExecutable } from '../config.ts';
import { inspectPane } from '../adapters/tmux.ts';
import { terminalRunner, tmuxLiteral } from '../terminal-environment.ts';
import { childEnvironmentArgs, launchEnvironment } from '../launches.ts';
import { resolveWorktree } from '../worktree.ts';
import { GLOBAL_ORIENTATION, codexProfileArgs } from './codex.ts';
import { hash, GlobalAIError } from './reads.ts';
import type { GlobalHost } from './service.ts';

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o077 || await realpath(path) !== resolve(path))
    throw new GlobalAIError('APP_DIRECTORY', 'Global AI needs a private ordinary directory owned by this host user.');
}
async function privateFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.part`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}
export class NativeGlobalHost implements GlobalHost {
  readonly config: Config;
  readonly bridge: string;
  constructor(config: Config, repoRoot: string) { this.config = config; this.bridge = join(repoRoot, 'web/scripts/global-ai-mcp.mjs'); }
  private environment(): Record<string, string> {
    const env = launchEnvironment();
    // App tools use a different credential. Do not point Global AI at the owner's hook env file.
    delete env.ALTCLI_ENV; delete env.ALTCLI_URL;
    env.CODEX_HOME = this.config.codexHome;
    return env;
  }
  environmentHash(): string { return hash(this.environment()); }
  async executable(profile: LaunchProfile): Promise<string> {
    codexProfileArgs(profile);
    const path = resolveExecutable(profile.executable, this.environment());
    if (!path) throw new GlobalAIError('CLI_MISSING', 'Codex is not executable on the host PATH. Install/sign in yourself before launching.');
    return realpath(path);
  }
  args(profile: LaunchProfile, directory: string): string[] {
    const mcp = { command: process.execPath, args: [this.bridge, join(directory, 'connection.json')], enabled: true };
    return [...codexProfileArgs(profile), '--cd', directory, '--sandbox', 'read-only',
      '-c', `mcp_servers.altcli_read.command=${JSON.stringify(mcp.command)}`,
      '-c', `mcp_servers.altcli_read.args=${JSON.stringify(mcp.args)}`,
      '-c', 'mcp_servers.altcli_read.enabled=true'];
  }
  async prepare(instance: GlobalAIInstance, descriptor: { endpoint: string; token: string }): Promise<void> {
    await privateDirectory(join(this.config.dataDir, 'global-ai'));
    await privateDirectory(instance.directory);
    if (await resolveWorktree(instance.directory)) throw new GlobalAIError('APP_DIRECTORY', 'Global AI must start outside a Git worktree; choose another AltCLI data directory.');
    const script = await lstat(this.bridge);
    if (!script.isFile() || script.isSymbolicLink()) throw new GlobalAIError('MCP_MISSING', 'The installed Global AI MCP bridge is missing.');
    await privateFile(join(instance.directory, 'AGENTS.md'), GLOBAL_ORIENTATION);
    await this.descriptor(instance, descriptor);
  }
  async descriptor(instance: GlobalAIInstance, descriptor: { endpoint: string; token: string }): Promise<void> {
    await privateDirectory(instance.directory);
    await privateFile(join(instance.directory, 'connection.json'), JSON.stringify({ schema: 1, ...descriptor }) + '\n');
  }
  async inspect(instance: GlobalAIInstance) {
    if (!instance.identity || !instance.sessionId || !instance.windowId) throw new GlobalAIError('GLOBAL_IDENTITY', 'No exact observed Global AI terminal identity.');
    const run = terminalRunner(this.config), pane = await inspectPane(run, instance.identity.paneId);
    const values = (await run(['display-message', '-p', '-t', pane.identity.paneId, '#{session_id}\t#{window_id}\t#{@altcli_global_ai}'])).trimEnd().split('\t');
    if (!isDeepStrictEqual(pane.identity, instance.identity) || values.join('\t') !== [instance.sessionId, instance.windowId, instance.id].join('\t') || pane.cwd !== instance.directory)
      throw new GlobalAIError('GLOBAL_IDENTITY', 'Global AI identity, marker or directory changed. Nothing was adopted.');
    return { identity: pane.identity, sessionId: instance.sessionId, label: 'Global AI', dead: pane.dead };
  }
  async capture(instance: GlobalAIInstance): Promise<string> {
    await this.inspect(instance);
    return (await terminalRunner(this.config)(['capture-pane', '-p', '-t', instance.identity!.paneId, '-S', '-200'])).slice(-24000);
  }
  async launch(instance: GlobalAIInstance, save: (change: Partial<GlobalAIInstance>) => void): Promise<void> {
    const run = terminalRunner(this.config);
    save({ phase: 'creating' });
    const ids = (await run(['new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}', '-s', instance.sessionName,
      '-c', tmuxLiteral(instance.directory), '/usr/bin/env', '/bin/sleep', '86400'])).trimEnd().split('\t');
    if (ids.length !== 3 || !/^\$\d+$/.test(ids[0]!) || !/^@\d+$/.test(ids[1]!) || !/^%\d+$/.test(ids[2]!)) throw new GlobalAIError('GLOBAL_IDENTITY', 'tmux did not return an exact creation identity.');
    const original = (await inspectPane(run, ids[2]!)).identity;
    save({ phase: 'placeholder', sessionId: ids[0]!, windowId: ids[1]!, identity: original });
    await run(['set-option', '-t', ids[0]!, 'destroy-unattached', 'off']);
    await run(['set-option', '-t', ids[0]!, 'update-environment', '']);
    await run(['set-option', '-t', ids[0]!, 'mouse', 'on']);
    await run(['set-option', '-w', '-t', ids[1]!, 'remain-on-exit', 'on']);
    await run(['set-option', '-t', ids[0]!, '@altcli_global_ai', instance.id]);
    await this.inspect(instance);
    const environment = childEnvironmentArgs(await run(['show-environment', '-g']), await run(['show-environment', '-t', ids[0]!]), this.environment());
    save({ phase: 'executing' });
    await run(['respawn-pane', '-k', '-t', ids[2]!, '-c', tmuxLiteral(instance.directory), '/usr/bin/env', ...environment.map(tmuxLiteral),
      tmuxLiteral(instance.executable), ...instance.args.map(tmuxLiteral)]);
    const observed = (await inspectPane(run, ids[2]!)).identity;
    if (observed.serverPid !== original.serverPid || observed.serverStarted !== original.serverStarted || observed.socketPath !== original.socketPath)
      throw new GlobalAIError('GLOBAL_IDENTITY', 'The tmux server changed during launch.');
    // Only the one directly observed respawn may replace the placeholder PID.
    const candidate = { ...instance, identity: observed };
    await this.inspect(candidate); save({ identity: observed, phase: 'observed' });
  }
}
