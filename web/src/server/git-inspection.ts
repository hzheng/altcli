import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../core/errors.ts';
import { gitEnvironment } from './worktree.ts';

/** Attribute inventories can exceed the usual Git output buffer in a large checkout. */
function inspect(path: string, args: string[], input?: string, allowAbsent = false): Promise<string> {
  return new Promise((resolve, reject) => {
    // Read effective configuration unchanged; the inventory commands themselves never need a filesystem monitor.
    const child = execFile('git', ['--no-replace-objects', '-C', path, ...(args[0] === 'config' ? [] : ['-c', 'core.fsmonitor=false']), ...args],
      { encoding: 'utf8', shell: false, timeout: 60000, maxBuffer: 256 * 1024 * 1024, env: gitEnvironment() },
      (error, stdout) => error && !(allowAbsent && error.code === 1)
        ? reject(new AppError('GIT_STATE', 'Git configuration or attributes could not be inspected. Recheck before continuing.', 409)) : resolve(stdout));
    child.stdin?.on('error', () => {}); // execFile reports an early exit.
    child.stdin?.end(input);
  });
}
/** Squash-only preflight: refuse selected filters before its status/merge reads and external merge drivers before
 * calculating a merge tree. Ordinary discovery and lifecycle status retain normal Git configuration semantics. */
export async function assertGitInspection(path: string, mergeInputs?: string[]): Promise<void> {
  return inspectCheckout(path, mergeInputs, new Set());
}
async function inspectCheckout(path: string, mergeInputs: string[] | undefined, seen: Set<string>): Promise<void> {
  const canonical = await realpath(path);
  if (seen.has(canonical)) throw new AppError('INTEGRATION_CONFIG', 'Recursive submodule inspection is unsupported.', 409);
  seen.add(canonical);
  const names = (await inspect(path, ['config', '--includes', '--null', '--name-only', '--get-regexp',
    '^(merge\\..*\\.driver|filter\\..*\\.(clean|smudge|process))$'], undefined, true)).split('\0').filter(Boolean);
  const unsupported = () => new AppError('INTEGRATION_CONFIG', 'Squash does not support external filesystem monitors, configured merge drivers, or attributes that select configured content filters. Integrate this repository manually; ordinary status and worktree operations remain available. No configuration was changed.', 409);
  if (mergeInputs && names.some(name => name.startsWith('merge.'))) throw unsupported();
  const monitor = (await inspect(path, ['config', '--includes', '--get', 'core.fsmonitor'], undefined, true)).trim().toLowerCase();
  if (!['', 'true', 'false', 'yes', 'no', 'on', 'off', '0', '1'].includes(monitor)) throw unsupported();
  const entries = (await inspect(path, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
  // status recurses into initialized submodules, whose local filters may differ from the parent repository's.
  for (const entry of entries.filter(entry => entry.startsWith('160000 '))) {
    const submodule = join(path, entry.slice(entry.indexOf('\t') + 1));
    const initialized = await lstat(join(submodule, '.git')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (initialized) await inspectCheckout(submodule, undefined, seen);
  }
  const filters = new Set(names.filter(name => name.startsWith('filter.')).map(name => name.slice('filter.'.length, name.lastIndexOf('.'))));
  if (!filters.size) return;
  const paths = new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
  for (const revision of mergeInputs ?? []) for (const name of (await inspect(path, ['ls-tree', '-r', '--name-only', '-z', revision])).split('\0').filter(Boolean)) paths.add(name);
  if (!paths.size) return;
  const input = [...paths].join('\0') + '\0';
  // Git resolves nested attributes, macros, info/attributes and global attributes in every input.
  for (const source of [[], ['--cached'], ...(mergeInputs ?? []).map(revision => [`--source=${revision}`])]) {
    const attributes = (await inspect(path, ['check-attr', '-z', ...source, '--stdin', 'filter'], input)).split('\0');
    for (let i = 2; i < attributes.length; i += 3) if (filters.has(attributes[i]!)) throw unsupported();
  }
}
/** Listings sized by the repository (every tracked path or changed file), with the large-output allowance of the inspections above. */
export function gitListing(path: string, args: string[]): Promise<string> {
  return inspect(path, args);
}
/** Whether the checkout's index or any given tree records a submodule. Worktree updates leave such checkouts to the user. */
export async function hasSubmodules(path: string, trees: string[] = []): Promise<boolean> {
  if ((await inspect(path, ['ls-files', '--stage', '-z'])).split('\0').some((entry) => entry.startsWith('160000 '))) return true;
  for (const tree of trees) if ((await inspect(path, ['ls-tree', '-r', '-z', tree])).split('\0').some((entry) => entry.startsWith('160000 '))) return true;
  return false;
}
