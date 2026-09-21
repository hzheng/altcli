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
if (typeof assignment.resultPath !== 'string' || !assignment.resultPath.startsWith('/') || assignment.resultPath === assignment.root || assignment.resultPath.startsWith(`${assignment.root}/`)) {
  throw new Error('The result path must be an absolute path outside the checkout.');
}
await assertWorktreeInput(assignment.root, assignment.branch, assignment.identity.parent, assignment.initialWorktreeFingerprint);
console.log('Assignment branch, parent, result path and initial worktree verified.');
