// The main checkout owns the host's hook and skill installation. A linked worktree is disposable: pointing the CLIs'
// global configuration into it leaves every hook command and skill link dangling once that worktree is removed.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
/** The checkout whose hooks/ and skills/ the installers reference: the repository's main worktree, or `checkout` itself
 * when it is not inside a Git repository (a plain copy has nothing else to point at) or the repository is bare. */
export function installRoot(checkout) {
  const result = spawnSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) return { root: checkout, linked: false };
  // -z terminates every field with NUL and ends each record with an empty field; the main worktree is listed first.
  const first = result.stdout.split('\0'); const end = first.indexOf(''); if (end >= 0) first.splice(end);
  const main = first.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
  if (!main || first.includes('bare')) return { root: checkout, linked: false };
  return { root: main, linked: realpathSync(main) !== realpathSync(checkout) };
}
