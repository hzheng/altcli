import { execFile, spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { AppError } from '../core/errors.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';

const gitEnvironment = (): NodeJS.ProcessEnv => {
  // Retain Next's required NODE_ENV typing as well as the inherited environment.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
};
/** Read-only discovery of the standard worktree/index. Per-process Git overrides are unsupported. */
export async function resolveWorktree(cwd: string): Promise<WorktreeIdentity | null> {
  const directory = await realpath(cwd);
  const output = await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-path', 'index'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, shell: false, env: gitEnvironment() }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (/not a git repository|must be run in a work tree/i.test(stderr)) return resolve('');
        reject(new AppError('GIT_IDENTITY', 'Could not inspect Git identity. Check Git availability and repository access.', 409));
      });
  });
  if (!output) return null;
  const paths = output.trimEnd().split('\n');
  if (paths.length !== 3 || paths.some((p) => !isAbsolute(p) || /[\u0000-\u001f]/.test(p))) throw new AppError('GIT_IDENTITY', 'Ambiguous Git paths. Registration refused.', 409);
  const root = await realpath(paths[0]!);
  const gitDir = await realpath(paths[1]!);
  const indexPath = await realpath(paths[2]!).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(paths[2]!)), paths[2]!.split('/').pop()!);
  });
  return { root, gitDir, indexPath };
}
export function sameWorktree(a: WorktreeIdentity | null, b: WorktreeIdentity | null): boolean {
  return !!a && !!b && a.root === b.root && a.gitDir === b.gitDir && a.indexPath === b.indexPath;
}

const UNREADABLE = () => new AppError('GIT_STATE', 'Could not read the worktree state.', 409);
/** Stream a read-only Git command's stdout into the digest; the caller judges the exit status. */
function gitInto(hash: Hash, root: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, shell: false });
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}
function untrackedPaths(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, shell: false, env: gitEnvironment() },
      (error, stdout) => error ? reject(error) : resolve(stdout.split('\0').filter(Boolean)));
  });
}
async function fileInto(hash: Hash, path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) { hash.update(`link:${await readlink(path)}`); return; }
  if (!stat.isFile()) { hash.update(`special:${stat.mode}`); return; } // never block on a fifo or socket
  await new Promise<void>((resolve, reject) => createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject));
}
/** Read-only digest of everything a reviewer could see: HEAD, index entries, unstaged content and untracked file contents.
 * Equal digests before and after a turn mean the agent left nothing to review. Ignored files do not count. */
export async function worktreeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const section = (name: string) => hash.update(`\0${name}\0`);
  try {
    section('head');
    const head = await gitInto(hash, root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.status !== 0 && (head.status !== 1 || head.stderr)) throw UNREADABLE(); // status 1 without stderr: unborn branch
    section('index');
    if ((await gitInto(hash, root, ['ls-files', '--stage', '-z'])).status !== 0) throw UNREADABLE();
    section('worktree');
    if ((await gitInto(hash, root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary'])).status !== 0) throw UNREADABLE();
    section('untracked');
    for (const path of await untrackedPaths(root)) { hash.update(`\0${path}\0`); await fileInto(hash, join(root, path)); }
  } catch (error) {
    throw error instanceof AppError ? error : UNREADABLE();
  }
  return hash.digest('hex');
}
