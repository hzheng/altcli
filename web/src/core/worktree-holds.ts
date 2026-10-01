import type { Project } from '../contracts/projects.ts';
import { FINISH_HOLDING } from '../contracts/projects.ts';

/** A checkout that a recorded worktree operation owns until it is inspected, and why. */
export interface WorktreeHold { root: string; reason: string }
const open = (op: { status: string }) => op.status === 'applying' || op.status === 'uncertain';
const refName = (ref: string) => ref.replace('refs/heads/', '');
const held = (root: string, what: string, where = 'in Projects') => ({ root, reason: `${what} Inspect it ${where} before starting work.` });

/** Every checkout the server's worktree readiness check refuses for a recorded operation, in its order, so the console can disable work
 * there and say why instead of letting a start fail. Presentation only: the server still decides, including for an unresolved launch,
 * which discovery does not report. A squash holds both its task worktree and the integration checkout. */
export function worktreeHolds(projects: Project[]): WorktreeHold[] {
  return projects.flatMap((p) => {
    const card = (root: string) => p.worktrees.some((tree) => tree.path === root);
    return [
      ...(p.removals ?? []).filter(open).map((op) => held(op.input.worktree.root, `Removal of worktree ${op.input.branch} is ${op.status}.`)),
      ...(p.discards ?? []).filter(open).map((op) => held(op.input.worktree.root, `Discard of worktree ${op.input.branch} is ${op.status}.`)),
      ...(p.integrations ?? []).filter(open).flatMap((op) => {
        // Its notice is in the task worktree's card while that worktree exists.
        const what = `Squash of ${op.input.branch} into ${refName(op.input.targetRef)} is ${op.status}.`;
        const where = card(op.input.worktree.root) ? `on the ${op.input.branch} worktree in Projects` : 'in Projects';
        return [held(op.input.target.root, what, where), held(op.input.worktree.root, what, where)];
      }),
      ...p.creations.filter(open).map((op) => held(op.input.path, `Creation of worktree ${op.input.branch} is ${op.status}.`)),
      ...(p.finishes ?? []).filter((op) => FINISH_HOLDING.includes(op.status)).map((op) =>
        ({ root: op.preview.worktree.root, reason: `Finish branch owns ${op.preview.branch} (${op.status.replaceAll('_', ' ')}). Inspect or complete it in Projects before starting work.` })),
      ...(p.updates ?? []).filter(open).map((op) => held(op.input.worktree.root, `Worktree ${op.input.mode ?? 'update'} of ${op.input.branch} is ${op.status}.`)),
      ...(p.renames ?? []).filter(open).map((op) => held(op.input.worktree.root, `Branch rename ${op.input.branch} → ${op.input.newBranch} is ${op.status}.`)),
    ];
  });
}
