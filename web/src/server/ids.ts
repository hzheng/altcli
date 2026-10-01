import { createHash } from 'node:crypto';
/** Stable host-local IDs: a project from its canonical common directory, a worktree from its project, Git directory and index. */
export const idOf = (kind: string, value: unknown) => `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
