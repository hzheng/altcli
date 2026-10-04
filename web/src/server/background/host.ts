import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackgroundAttempt, BackgroundInstance } from '../../contracts/background.ts';
import type { LaunchProfile } from '../../contracts/launches.ts';
import type { Config } from '../config.ts';
import { NativeGlobalHost, privateDirectory, privateFile, type NativeAppInstance } from '../global-ai/host.ts';
import { GlobalAIError } from '../global-ai/reads.ts';
import { backgroundProfileArgs } from '../global-ai/service.ts';
import { resolveWorktree } from '../worktree.ts';
import { VERIFIED_CLAUDE_VERSIONS } from '../../../scripts/background-native.mjs';

export class NativeBackgroundHost extends NativeGlobalHost {
  protected override readonly marker = '@altcli_background';
  protected override readonly label = 'Background';
  readonly script: string;
  constructor(config: Config, repoRoot: string) { super(config, repoRoot); this.script = join(repoRoot, 'web/scripts/background-runner.mjs'); }
  override args(profile: LaunchProfile): string[] { return backgroundProfileArgs(profile); }
  protected override command(instance: NativeAppInstance): string[] { return [process.execPath, this.script, join(instance.directory, 'connection.json')]; }
  async version(executable: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(executable, ['--version'], { env: this.environment() as NodeJS.ProcessEnv, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
        // Each accepted CLI release needs a native probe; an upgrade alone does not establish flag compatibility.
        const version = stdout.trim();
        const observed = !error && /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(version) ? `Detected ${version}.` : 'Could not verify the Claude Code version.';
        if (error || !VERIFIED_CLAUDE_VERSIONS.includes(version)) reject(new GlobalAIError('ADAPTER_VERSION', `${observed} Background supports ${VERIFIED_CLAUDE_VERSIONS.join(' or ')}. Other versions need a native capability probe.`));
        else resolve(version);
      });
    });
  }
  override async prepare(instance: NativeAppInstance, descriptor: { endpoint: string; token: string }): Promise<void> {
    await privateDirectory(join(this.config.dataDir, 'background'));
    await privateDirectory(instance.directory);
    if (await resolveWorktree(instance.directory)) throw new GlobalAIError('APP_DIRECTORY', 'Background must run outside a Git worktree.');
    for (const script of [this.script, this.bridge]) {
      const st = await lstat(script);
      if (!st.isFile() || st.isSymbolicLink()) throw new GlobalAIError('RUNNER_MISSING', 'The installed Background runner or MCP bridge is missing.');
    }
    await this.descriptor(instance, descriptor);
  }
  async jobDescriptor(instance: BackgroundInstance, id: string, descriptor: { endpoint: string; token: string }): Promise<string> {
    const directory = join(instance.directory, id); await privateDirectory(directory);
    const path = join(directory, 'job.json');
    await privateFile(path, JSON.stringify({ schema: 1, ...descriptor }) + '\n'); return path;
  }
  async receipt(instance: BackgroundInstance, attempt: BackgroundAttempt): Promise<unknown> {
    const file = await open(join(instance.directory, attempt.id, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > 16384) throw new Error('Invalid receipt.');
      const bytes = Buffer.alloc(16385), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16384) throw new Error('Oversized receipt.');
      const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (value.attemptId !== attempt.id || !['running', 'complete'].includes(value.phase)) throw new Error('No exact invocation receipt.');
      const result = value.phase === 'running' ? { pid: value.pid, sessionId: value.sessionId, model: null, status: 'failed', category: 'interrupted', assessment: null, settled: false } : value.result;
      if (result?.sessionId !== attempt.sessionId) throw new Error('Invocation changed.');
      const pid = result.pid;
      if (pid !== null) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || attempt.pid !== null && attempt.pid !== pid) throw new Error('Invocation changed.');
        try { process.kill(-pid, 0); throw new Error('The invocation process group still exists.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      // An explicit inspection may now prove that previously surviving work has ended. Never salvage its old model result.
      if (!result.settled && pid === null) throw new Error('No observed native process identity.');
      return result.settled ? result : { ...result, settled: true, status: 'failed', category: 'inspection-settled', assessment: null };
    } finally { await file.close(); }
  }
}
