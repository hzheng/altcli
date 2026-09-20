import { readFile } from 'node:fs/promises';
import type { CommitAssignment } from '../../../web/src/contracts/implementation.ts';
import { assertWorktreeInput } from '../../../web/src/server/commit-handoff.ts';

const assignment: CommitAssignment = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
if (assignment.initialWorktreeFingerprint && (assignment.identity.turn !== 1 || assignment.identity.action !== 'work')) {
  throw new Error('Only the first work assignment may include unfinished work.');
}
if (assignment.commitOnly && (assignment.identity.turn !== 1 || assignment.identity.action !== 'work' || !assignment.initialWorktreeFingerprint)) {
  throw new Error('Commit-only publication requires the first work assignment and captured input.');
}
await assertWorktreeInput(assignment.root, assignment.branch, assignment.identity.parent, assignment.initialWorktreeFingerprint);
console.log('Assignment branch, parent and initial worktree verified.');
