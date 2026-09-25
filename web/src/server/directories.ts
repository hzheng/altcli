import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CheckoutObservation, DirectoryEntry, DirectoryListing, DirectoryListInput } from '../contracts/projects.ts';
import { AppError } from '../core/errors.ts';
import { parseDirectoryList } from '../core/project-validation.ts';
import { defaultBranch, gitRead } from './commit-handoff.ts';
import { commonGitDir } from './projects.ts';
import { currentBranch, resolveWorktree } from './worktree.ts';

/** Work bounds for one listing: entries read, entries returned, symbolic links resolved, and metadata reads in flight. */
export const DIRECTORY_LIMITS = { scan: 5000, entries: 500, links: 64, parallel: 16 } as const;
const UNAVAILABLE = () => new AppError('DIRECTORY_UNAVAILABLE', 'That directory does not exist or cannot be read. Check the path and its permissions.', 409);
async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

/** Git's own classification of `path`: its checkout root, main or linked, branch and recorded default. Read-only; null outside Git.
 * The directory shape (`.git` file or folder) is never trusted for this: separate Git directories and submodules look alike. */
export async function observeCheckout(path: string): Promise<CheckoutObservation | null> {
  const identity = await resolveWorktree(path);
  if (!identity) return null;
  const commonDir = await commonGitDir(identity.root);
  const kind = identity.gitDir === commonDir ? 'main' : 'linked';
  const [branch, head, recorded] = await Promise.all([currentBranch(identity.root),
    gitRead(identity.root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], true).then((out) => out.trim() || null), defaultBranch(identity.root)]);
  const main = kind === 'linked' ? await mainCheckoutOf(identity.root, commonDir) : { mainCheckout: null, mainCheckoutNote: null };
  return { root: identity.root, commonDir, kind, branch, head, defaultBranch: recorded, ...main };
}
/** Git lists the main working tree first; a bare repository has none to offer. */
async function mainCheckoutOf(root: string, commonDir: string): Promise<Pick<CheckoutObservation, 'mainCheckout' | 'mainCheckoutNote'>> {
  const first: string[] = [];
  for (const field of (await gitRead(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) { if (!field) break; first.push(field); }
  if (first.includes('bare')) return { mainCheckout: null, mainCheckoutNote: 'This repository is bare, so it has no main checkout to add. Add this checkout or a non-bare clone instead.' };
  const path = first.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
  const identity = path ? await resolveWorktree(path).catch(() => null) : null;
  return identity && identity.gitDir === commonDir ? { mainCheckout: identity.root, mainCheckoutNote: null }
    : { mainCheckout: null, mainCheckoutNote: `Git lists the main checkout at ${path ?? 'an unknown path'}, but it is missing or inaccessible.` };
}

/** One bounded listing of a host directory's immediate subdirectories, plus Git's classification of the directory itself.
 * It reads names and metadata only: no file contents, recursion, project records, tmux sessions or Git changes. */
export async function listDirectory(value: unknown, mode: 'tmux' | 'mock'): Promise<DirectoryListing> {
  const input = parseDirectoryList(value);
  if (mode === 'mock') return mockListing(input);
  const home = await realpath(homedir()).catch(() => homedir());
  let path: string;
  try { path = await realpath(input.path ?? home); if (!(await stat(path)).isDirectory()) throw UNAVAILABLE(); } catch { throw UNAVAILABLE(); }
  const found: { name: string; link: boolean }[] = []; let scanned = 0, truncated = false;
  const dir = await opendir(path, { bufferSize: 64 }).catch(() => { throw UNAVAILABLE(); });
  try {
    for await (const entry of dir) {
      if (++scanned > DIRECTORY_LIMITS.scan || found.length >= DIRECTORY_LIMITS.entries) { truncated = true; break; }
      // Names with control characters cannot be entered as a path, so they are not offered either.
      if ((!input.hidden && entry.name.startsWith('.')) || /[\u0000-\u001f\u007f]/.test(entry.name)) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) found.push({ name: entry.name, link: entry.isSymbolicLink() });
    }
  } catch { throw UNAVAILABLE(); }
  const links = found.filter((f) => f.link);
  if (links.length > DIRECTORY_LIMITS.links) truncated = true;
  const resolvable = new Set(links.slice(0, DIRECTORY_LIMITS.links).map((f) => f.name));
  const entries = (await inBatches(found.filter((f) => !f.link || resolvable.has(f.name)), DIRECTORY_LIMITS.parallel, async ({ name, link }): Promise<DirectoryEntry | null> => {
    const own = join(path, name);
    // A symbolic link is shown with its destination and navigates there; it is never followed silently.
    const target = link ? await realpath(own).then(async (resolved) => (await stat(resolved)).isDirectory() ? resolved : null).catch(() => null) : own;
    if (!target || /[\u0000-\u001f\u007f]/.test(target)) return null;
    return { name, path: target, gitCandidate: await lstat(join(target, '.git')).then(() => true, () => false), linkedFrom: link ? own : null };
  })).filter((entry): entry is DirectoryEntry => !!entry).sort((a, b) => a.name.localeCompare(b.name));
  let checkout: CheckoutObservation | null = null, checkoutError: string | null = null;
  try { checkout = await observeCheckout(path); } catch (error) { checkoutError = error instanceof AppError ? error.message : 'Git could not inspect this directory.'; }
  return { path, parent: path === dirname(path) ? null : dirname(path), home, entries, truncated, checkout, checkoutError };
}

/** Mock mode reads no real directory: `/demo/<name>` stands for a simulated main checkout on `main`, as in project entry. */
function mockListing(input: DirectoryListInput): DirectoryListing {
  const path = input.path ?? '/demo';
  const base = { path, home: '/demo', truncated: false, checkoutError: null };
  if (path === '/') return { ...base, parent: null, entries: [{ name: 'demo', path: '/demo', gitCandidate: false, linkedFrom: null }], checkout: null };
  if (path === '/demo') return { ...base, parent: '/', checkout: null,
    entries: ['other', 'project'].map((name) => ({ name, path: `/demo/${name}`, gitCandidate: true, linkedFrom: null })) };
  if (!/^\/demo\/[A-Za-z0-9_-]+$/.test(path)) throw new AppError('MOCK_PROJECT', 'Mock repository paths use /demo/name. No real directory is inspected.');
  return { ...base, parent: '/demo', entries: [], checkout: { root: path, commonDir: `${path}/.git`, kind: 'main', branch: 'main', head: 'a'.repeat(40), defaultBranch: null, mainCheckout: null, mainCheckoutNote: null } };
}
