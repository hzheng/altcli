import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { AppError } from '../core/errors.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';

const gitEnvironment = () => {
  const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key as keyof typeof env];
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
  // An unborn repository may not have an index yet; its parent still has a real path.
  const indexPath = await realpath(paths[2]!).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(paths[2]!)), paths[2]!.split('/').pop()!);
  });
  return { root, gitDir, indexPath };
}
export function sameWorktree(a: WorktreeIdentity | null, b: WorktreeIdentity | null): boolean {
  return !!a && !!b && a.root === b.root && a.gitDir === b.gitDir && a.indexPath === b.indexPath;
}
