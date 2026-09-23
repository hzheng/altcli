import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { WorkspaceDiscovery, WorkflowState } from '../src/contracts/workflow';
import type { ProjectWorktree, WorktreeCreateInput, WorktreeCreation, WorktreeDiscard, WorktreePreview } from '../src/contracts/projects';

const token = 'a'.repeat(64); // test fixture only
const headers = { Authorization: `Bearer ${token}` };
async function fixture(page: Page, request: APIRequestContext, inputEnabled = true) {
  const inventory = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  inventory.projects = inventory.projects!.filter((p) => p.name === 'project');
  inventory.workspaces = inventory.workspaces.filter((w) => w.worktree.root === '/demo/project');
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = inputEnabled;
  await page.route('**/api/v1/workspaces', (route) => route.fulfill({ json: inventory }));
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  await page.goto('/'); await page.getByLabel('Host access token').fill(token); await page.getByRole('button', { name: 'Open console' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project project', exact: true })).toBeVisible();
  return inventory;
}
const tree = (path: string, branch: string | null, head = 'a'.repeat(40)): ProjectWorktree => ({ id: `tree-${path}`, path, branch, head, main: false,
  identity: { root: path, gitDir: `/demo/project/.git/worktrees/${path.split('/').pop()}`, indexPath: `/demo/project/.git/worktrees/${path.split('/').pop()}/index` }, error: null });
function preview(inventory: WorkspaceDiscovery, branch: string): WorktreePreview {
  const project = inventory.projects![0]!; const source = project.worktrees[0]!;
  return { requestId: crypto.randomUUID(), projectId: project.id, sourceWorktreeId: source.id, source: source.identity!, sourceBranch: source.branch, sourceHead: source.head!, branch, path: `/home/fixture/.altcli/project/${branch}` };
}
async function openForm(page: Page, branch = 'feature/login') {
  await page.getByRole('button', { name: 'Create task worktree', exact: true }).click();
  await page.getByLabel('New task branch', { exact: true }).fill(branch);
}
/** The console feedback carrying `text`. An operation's own busy line is also a status region, and both can be shown at once. */
const notice = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('project navigation keeps linked, detached and empty worktrees visible without starting a task', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/.altcli/project/login', 'fix/login'), tree('/home/fixture/.altcli/project/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Check removal of inspect', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Open inspect', exact: true })).toContainText('detached HEAD');
  await page.screenshot({ path: info.outputPath('project-worktrees.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.locator('.context-bar')).toContainText('fix/login');
  await expect(page.getByRole('button', { name: /Start Plan|^Commit / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open login', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('creation previews its exact path and baseline, requires confirmation, and produces an empty worktree', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); let shown: WorktreePreview; const creates: WorktreeCreateInput[] = [];
  await page.route('**/api/v1/projects/worktrees/preview', (route) => { shown = preview(inventory, route.request().postDataJSON().branch); return route.fulfill({ json: shown }); });
  await page.route('**/api/v1/projects/worktrees', (route) => {
    const input = route.request().postDataJSON() as WorktreeCreateInput; creates.push(input);
    inventory.projects![0]!.worktrees.push(tree(input.path, input.branch));
    return route.fulfill({ json: { input, status: 'ready', message: 'Worktree created. Start your coding agents here, then Recheck.', updatedAt: new Date().toISOString() } });
  });
  await openForm(page); expect(creates).toEqual([]);
  await page.getByRole('button', { name: 'Preview worktree', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create confirmed worktree' }); await expect(create).toBeDisabled();
  await expect(page.getByRole('form', { name: 'Create task worktree' })).toContainText('/home/fixture/.altcli/project/feature/login');
  await page.getByLabel('Confirm worktree creation').check();
  await page.screenshot({ path: info.outputPath('create-worktree.png'), fullPage: true });
  await create.click();
  await expect(notice(page, 'Worktree created')).toBeVisible(); expect(creates).toEqual([{ ...shown!, confirm: true }]);
  await expect(page.getByRole('button', { name: 'Open login', exact: true })).toContainText('No agents');
  await page.getByRole('button', { name: 'Open login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
});
test('branch edits and changed source commits revoke worktree creation confirmation', async ({ page, request }) => {
  const inventory = await fixture(page, request);
  await page.route('**/api/v1/projects/worktrees/preview', (route) => route.fulfill({ json: preview(inventory, route.request().postDataJSON().branch) }));
  await openForm(page); await page.getByRole('button', { name: 'Preview worktree', exact: true }).click(); await page.getByLabel('Confirm worktree creation').check();
  await page.getByLabel('New task branch', { exact: true }).fill('feature/settings');
  await expect(page.getByRole('button', { name: 'Create confirmed worktree' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview worktree', exact: true }).click(); await expect(page.getByLabel('Confirm worktree creation')).not.toBeChecked();
  await page.getByLabel('Confirm worktree creation').check(); inventory.projects![0]!.worktrees[0]!.head = 'b'.repeat(40);
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(page.getByRole('button', { name: 'Create confirmed worktree' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview worktree', exact: true }).click(); await expect(page.getByLabel('Confirm worktree creation')).not.toBeChecked();
});
test('uncertain creation stays owned and offers inspection instead of resending', async ({ page, request }) => {
  const inventory = await fixture(page, request); let count = 0;
  await page.route('**/api/v1/projects/worktrees/preview', (route) => route.fulfill({ json: preview(inventory, route.request().postDataJSON().branch) }));
  await page.route('**/api/v1/projects/worktrees', (route) => {
    count++; const operation: WorktreeCreation = { input: route.request().postDataJSON(), status: 'uncertain', message: 'Inspect the result; nothing is retried.', updatedAt: new Date().toISOString() };
    inventory.projects![0]!.creations = [operation]; return route.fulfill({ json: operation });
  });
  await page.route('**/api/v1/projects/worktrees/reconcile', (route) => {
    const operation = inventory.projects![0]!.creations[0]!; expect(route.request().postDataJSON()).toEqual({ requestId: operation.input.requestId });
    operation.status = 'ready'; operation.message = 'Exact clean result verified.'; return route.fulfill({ json: operation });
  });
  await openForm(page); await page.getByRole('button', { name: 'Preview worktree', exact: true }).click(); await page.getByLabel('Confirm worktree creation').check();
  await page.getByRole('button', { name: 'Create confirmed worktree' }).click();
  await expect(page.getByText('Worktree creation uncertain', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create confirmed worktree' })).toBeDisabled();
  await page.getByRole('button', { name: 'Inspect creation result', exact: true }).click();
  await expect(notice(page, 'Exact clean result verified')).toBeVisible(); expect(count).toBe(1);
});
test('different agent directories remain task groups under one shared checkout', async ({ page, request }) => {
  const inventory = await fixture(page, request); const initial = inventory.workspaces[0]!;
  inventory.workspaces = [{ ...initial, agents: [initial.agents[0]!] }, { ...initial, cwd: '/demo/project/web', agents: [initial.agents[1]!] }];
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open project', exact: true })).toContainText('2 agent directories');
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects and agents', exact: true })).toBeVisible();
  await expect(page.getByText('These groups share one checkout', { exact: false })).toBeVisible();
  await page.locator('.directory-groups').getByRole('button').filter({ hasText: '/demo/project/web' }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace web', exact: true })).toBeVisible();
});
test('a read-only host allows project navigation but disables worktree creation', async ({ page, request }) => {
  await fixture(page, request, false); await expect(page.getByRole('button', { name: 'Create task worktree', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
});

test('squash removal requires preview and confirmation, removes the card and retains history notice', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  let removals = 0;
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity,
    branch: target.branch, head: target.head, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), integratedBy: 'squash', integratedCommit: 'b'.repeat(40) };
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/removal', (route) => {
    removals++; expect(route.request().postDataJSON()).toEqual({ ...shown, confirm: true });
    project.worktrees = project.worktrees.filter((w) => w.id !== target.id);
    return route.fulfill({ json: { input: route.request().postDataJSON(), status: 'removed', message: 'Worktree removed. Its branch, commits and run history are retained.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Check removal of feature/finished', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Remove feature/finished', exact: true })).toContainText('Squash integration verified');
  await expect(page.getByRole('region', { name: 'Remove feature/finished', exact: true })).toContainText('Any ignored files in this directory, including local environment files, dependencies and build output, will also be deleted.');
  expect(removals).toBe(0);
  await page.screenshot({ path: info.outputPath('remove-worktree.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open finished', exact: true })).toHaveCount(0);
  await expect(notice(page, 'history are retained')).toBeVisible(); expect(removals).toBe(1);
});
test('squash into main previews the exact operation and message, requires confirmation, and posts the edited message once', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished', head: target.head, dirty: true,
    targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), target: project.worktrees[0]!.identity, mergeBase: 'b'.repeat(40), through: target.head, previousCommit: null, commitCount: 2,
    commits: [{ sha: 'd'.repeat(40), subject: 'second' }, { sha: 'c'.repeat(40), subject: 'first' }], tree: 'e'.repeat(40),
    message: 'Squash feature/finished\n\nSquash of feature/finished (bbbbbbb..aaaaaaa, 2 commits).\n\n- first\n- second\n',
    commands: ['git -C /demo/project diff --binary ' + 'b'.repeat(40) + ' ' + 'e'.repeat(40) + ' | git -C /demo/project apply --index --binary', 'git -C /demo/project commit -m <message>'], consent: 'f'.repeat(64) };
  const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/integration/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/integration', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: route.request().postDataJSON(), status: 'integrated', message: 'Squashed feature/finished into main as 0123456789ab. Use Check removal when you are done.', updatedAt: new Date().toISOString(), commit: '0123456789ab' + 'f'.repeat(28) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  // The three lifecycle actions read top to bottom: squash, removal check, discard; the branch is not repeated in the visible labels.
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'finished' });
  await expect(card.getByRole('button')).toHaveText(['finished0 AGENTS/home/fixture/tasks/finishedBranch: feature/finishedNo agents · start coding CLIs here, then Recheck', 'Squash into main', 'Check removal', 'Discard…']);
  await page.getByRole('button', { name: 'Squash feature/finished into main', exact: true }).click();
  const region = page.getByRole('region', { name: 'Squash feature/finished', exact: true });
  await expect(region).toContainText('Squash 2 commits from feature/finished (bbbbbbb..aaaaaaa) into main');
  await expect(region).toContainText('git -C /demo/project diff --binary'); await expect(region).toContainText('uncommitted changes; they are not part of this squash');
  const message = page.getByLabel('Squash commit message'); await expect(message).toHaveValue(shown.message);
  // The budget shown is the JSON-encoded size the server enforces; an oversized message disables confirmation instead of failing later.
  const confirm = page.getByRole('button', { name: 'Confirm squash', exact: true }); await expect(confirm).toBeEnabled();
  await message.fill('"'.repeat(4096)); await expect(region).toContainText('8,194 of 8,192 bytes (JSON-encoded, as sent) — shorten the message to confirm.'); await expect(confirm).toBeDisabled();
  await message.fill('feat: finished\n\nSquash of feature/finished.\n'); await expect(region).toContainText('49 of 8,192 bytes'); await expect(confirm).toBeEnabled(); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('squash-worktree.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm squash', exact: true }).click();
  await expect(notice(page, 'Squashed feature/finished into main')).toBeVisible();
  // The confirmation is compact: consent digest plus the edited message, never the (possibly large) preview echoed back.
  expect(posted).toEqual([{ projectId: project.id, worktreeId: target.id, through: shown.through, requestId: shown.requestId, consent: shown.consent, message: 'feat: finished\n\nSquash of feature/finished.\n', confirm: true }]);
  await expect(page.getByRole('button', { name: 'Squash feature/finished into main', exact: true })).toBeVisible();
});
test('discard warns about the work that would be lost and requires the exact branch name', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished', head: target.head,
    targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), dirty: true, changeCount: 2, fingerprint: 'e'.repeat(64), unmergedCommits: 3 };
  const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/discard/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/discard', (route) => {
    posted.push(route.request().postDataJSON()); project.worktrees = project.worktrees.filter((w) => w.id !== target.id);
    return route.fulfill({ json: { input: route.request().postDataJSON(), status: 'discarded', message: 'Discarded feature/finished: its worktree and branch are deleted. Run history is retained.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Discard feature/finished', exact: true }).click();
  const region = page.getByRole('region', { name: 'Discard feature/finished', exact: true });
  await expect(region).toContainText('Lost: 3 commits not in main and 2 uncommitted changes');
  await expect(region).toContainText('does not check that anything was integrated');
  const confirm = page.getByRole('button', { name: 'Confirm discard', exact: true }); await expect(confirm).toBeDisabled();
  await page.getByLabel('Branch name to discard').fill('feature/finish'); await expect(confirm).toBeDisabled();
  await page.getByLabel('Branch name to discard').fill('feature/finished'); await expect(confirm).toBeEnabled(); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('discard-worktree.png'), fullPage: true });
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Open finished', exact: true })).toHaveCount(0);
  await expect(notice(page, 'worktree and branch are deleted')).toBeVisible();
  expect(posted).toEqual([{ ...shown, confirmBranch: 'feature/finished', confirm: true }]);
});
test('deletion actions stay clickable while agents occupy a worktree: the hint names them and the click shows the server refusal', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/busy', 'feature/busy'); project.worktrees.push(target);
  const demo = inventory.workspaces[0]!; // give the task worktree the demo agents so the card counts them as occupants
  inventory.workspaces.push({ ...demo, cwd: target.path, worktree: target.identity!, branch: target.branch, sharesIndexWith: [] });
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ status: 409, json: { error: { code: 'WORKTREE_IN_USE', message: 'A tmux pane is still in this worktree. Move or close it yourself, then Recheck.' } } }));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'busy' });
  await expect(card.getByRole('status').filter({ hasText: 'still in this worktree' }).first()).toContainText(/Codex, Claude( Code)? are still in this worktree; the server refuses removal/);
  const check = page.getByRole('button', { name: 'Check removal of feature/busy', exact: true }); await expect(check).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Discard feature/busy', exact: true })).toBeEnabled();
  await check.click();
  await expect(page.getByRole('alert').filter({ hasText: 'tmux pane' })).toContainText('A tmux pane is still in this worktree. Move or close it yourself, then Recheck.');
  await expect(check).toBeEnabled(); // the refusal is information, not a lock
});
test('removal rejection is shown and stale worktree preview disables confirmation', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ status: 409, json: { error: { code: 'NOT_INTEGRATED', message: 'Combined changes are not integrated.' } } }));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Check removal of feature/finished', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Combined changes' })).toContainText('not integrated');
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ json: { projectId: project.id, worktreeId: target.id,
    requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), integratedBy: 'ancestry', integratedCommit: target.head } }));
  await page.getByRole('button', { name: 'Check removal of feature/finished', exact: true }).click();
  target.head = 'c'.repeat(40); await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm removal', exact: true })).toBeDisabled();
});

test('a lost removal response offers inspection and cannot resend or discard its pending confirmation', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity,
    branch: target.branch, head: target.head, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), integratedBy: 'squash', integratedCommit: 'b'.repeat(40) };
  let removals = 0;
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/removal', (route) => { removals++; return route.abort(); });
  await page.route('**/api/v1/projects/worktrees/removal/reconcile', (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: shown.requestId });
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'failed', message: 'The original worktree remains. Preview again.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Check removal of feature/finished', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm removal', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Inspect this removal response', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check removal of feature/finished', exact: true })).toBeEnabled();
  expect(removals).toBe(1);
});

test('an uncertain discard shows what inspection found and finishes only through the confirmed branch deletion', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); // the worktree itself is already gone
  const input = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity!, branch: target.branch!, head: target.head!, targetRef: 'refs/heads/main',
    targetHead: 'b'.repeat(40), dirty: false, changeCount: 0, fingerprint: 'c'.repeat(64), unmergedCommits: 2, confirmBranch: target.branch!, confirm: true as const };
  const operation: WorktreeDiscard = { input, status: 'uncertain', message: 'Backend restarted during discard. Inspect its result; nothing is retried.', updatedAt: new Date().toISOString() };
  project.discards = [operation]; const posted: string[] = [];
  await page.route('**/api/v1/projects/worktrees/discard/reconcile', (route) => {
    posted.push('reconcile'); expect(route.request().postDataJSON()).toEqual({ requestId: input.requestId });
    operation.message = 'The worktree directory is gone, its Git worktree entry is gone and the branch feature/finished still exists at aaaaaaaaaaaa. Only the branch deletion is left: confirm it below to finish this discard, or delete the branch by hand and inspect again.';
    operation.branchRemains = true; return route.fulfill({ json: operation });
  });
  await page.route('**/api/v1/projects/worktrees/discard/finish', (route) => {
    posted.push('finish'); expect(route.request().postDataJSON()).toEqual({ requestId: input.requestId, confirm: true });
    operation.status = 'discarded'; operation.message = 'Discarded feature/finished: its branch is deleted after the worktree. Run history is retained.'; delete operation.branchRemains;
    return route.fulfill({ json: operation });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByText('Worktree discard uncertain', { exact: true })).toBeVisible();
  const finish = page.getByRole('button', { name: 'Delete branch feature/finished and finish discard', exact: true });
  await expect(finish).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect discard result', exact: true }).click();
  await expect(notice(page, 'Only the branch deletion is left')).toBeVisible();
  await expect(page.getByLabel('Project worktrees project').getByText('Only the branch deletion is left')).toBeVisible();
  await expect(finish).toBeVisible(); expect(posted).toEqual(['reconcile']);
  await finish.click();
  await expect(notice(page, 'its branch is deleted after the worktree')).toBeVisible();
  await expect(page.getByText('Worktree discard uncertain', { exact: true })).toHaveCount(0);
  expect(posted).toEqual(['reconcile', 'finish']);
});

test('an empty worktree keeps its setup guidance beside a shell pane, while a blocked coding CLI shows its reason', async ({ page, request }) => {
  const inventory = await fixture(page, request); const template = inventory.workspaces[0]!;
  const card = (path: string, agents: WorkspaceDiscovery['workspaces'][number]['agents']) => ({ ...template, cwd: path, agents,
    worktree: { root: path, gitDir: `/demo/project/.git/worktrees/${path.split('/').pop()}`, indexPath: `/demo/project/.git/worktrees/${path.split('/').pop()}/index` } });
  const shell = { ...template.agents[0]!, identity: { ...template.agents[0]!.identity, paneId: '%8' }, command: 'zsh', kind: 'shell' as const, eligible: false, label: 'zsh %8', registeredAs: null, session: undefined, reason: '"zsh" is a shell or generic interpreter, not a coding CLI.' };
  const moved = { ...template.agents[1]!, identity: { ...template.agents[1]!.identity, paneId: '%9' }, eligible: false, session: undefined, reason: 'This pane moved from /demo/project, where a run or delivery still owns it. Open that worktree, pause and take over the run after inspecting its work, then Recheck to rebind automatically.' };
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/.altcli/project/login', 'fix/login'), tree('/home/fixture/.altcli/project/moved', 'fix/moved'));
  inventory.workspaces.push(card('/home/fixture/.altcli/project/login', [shell]), card('/home/fixture/.altcli/project/moved', [shell, moved]));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Open login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toBeVisible();
  await page.getByRole('button', { name: 'Open Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Open moved', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  // The Projects section stays mounted while hidden and lists the same reason, so assert the text the Console shows.
  await expect(page.getByText('This pane moved from /demo/project').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toHaveCount(0);
});

test('idle source agents permit squash and leave deletion clickable with an occupant hint; disabled squash explains host and ownership blockers', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/batches', 'feature/batches'); project.worktrees.push(target);
  inventory.workspaces.push({ ...inventory.workspaces[0]!, cwd: target.path, worktree: target.identity!, branch: target.branch });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const squash = page.getByRole('button', { name: 'Squash feature/batches into main', exact: true });
  await expect(squash).toBeEnabled();
  const check = page.getByRole('button', { name: 'Check removal of feature/batches', exact: true }); await expect(check).toBeEnabled();
  await expect(check).toHaveAccessibleDescription(/are still in this worktree; the server refuses removal while a pane is inside it/);
  await expect(page.getByRole('button', { name: 'Discard feature/batches', exact: true })).toBeEnabled();
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = false;
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  await expect(squash).toBeDisabled(); await expect(squash).toHaveAccessibleDescription('The host is read-only. Enable input before changing worktrees.');
  await expect(check).toBeDisabled(); await expect(check).toHaveAccessibleDescription('The host is read-only. Enable input before changing worktrees.'); // a hard block disables deletion too
  state.inputEnabled = true; state.reservations = [{ repository: target.path, activeCommandId: crypto.randomUUID() }];
  await expect(squash).toHaveAccessibleDescription('An unresolved delivery owns this worktree. Inspect it in Console first.');
  await expect(check).toBeEnabled(); await expect(check).toHaveAccessibleDescription('An unresolved delivery owns this worktree. Inspect it in Console first.'); // ownership is a hint for deletion; the server decides
  state.reservations = [];
  project.creations = [{ input: { ...preview(inventory, 'feature/pending'), confirm: true }, status: 'uncertain', message: 'Inspect creation.', updatedAt: new Date().toISOString() }];
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(squash).toHaveAccessibleDescription('A worktree operation is applying or uncertain. Inspect its result below before squashing.');
  project.creations = []; target.branch = null;
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Squash batches into main', exact: true })).toHaveAccessibleDescription('The task worktree has detached HEAD. Check out its task branch, then Recheck.');
});
test('changing the batch endpoint revokes its preview and confirms only the chosen range with an edited message', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/batches', 'feature/batches'); project.worktrees.push(target);
  const previews: unknown[] = []; const confirms: unknown[] = [];
  const first = 'c'.repeat(40); const base = 'b'.repeat(40);
  let shown: Record<string, unknown>;
  await page.route('**/api/v1/projects/worktrees/integration/preview', (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    const through = input.through ?? target.head;
    shown = { ...input, through, projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, dirty: false,
      targetRef: 'refs/heads/main', targetHead: base, target: project.worktrees[0]!.identity, mergeBase: base, previousCommit: null, commitCount: through === first ? 1 : 2,
      commits: [{ sha: target.head, subject: 'later change' }, { sha: first, subject: 'first change' }], tree: 'e'.repeat(40), message: through === first ? 'First batch\n' : 'All changes\n', commands: ['Stage previewed changes', 'Commit'], consent: 'f'.repeat(64) };
    return route.fulfill({ json: shown });
  });
  await page.route('**/api/v1/projects/worktrees/integration', (route) => {
    confirms.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'integrated', message: 'Batch integrated. Preview another batch for remaining commits.', updatedAt: new Date().toISOString(), commit: 'd'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Squash feature/batches into main', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm squash', exact: true })).toBeEnabled();
  await page.getByLabel('Squash through commit').fill(first);
  await expect(page.getByRole('button', { name: 'Confirm squash', exact: true })).toHaveCount(0); expect(confirms).toEqual([]);
  await page.getByRole('button', { name: 'Preview batch', exact: true }).click();
  const region = page.getByRole('region', { name: 'Squash feature/batches', exact: true });
  await expect(region).toContainText('Squash 1 commit from feature/batches (bbbbbbb..ccccccc)');
  await expect(region).toContainText('Later task commits will remain for another batch.');
  await page.getByLabel('Squash commit message').fill('feat: batch one');
  await page.screenshot({ path: info.outputPath('squash-batch.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm squash', exact: true }).click();
  await expect(notice(page, 'Batch integrated.')).toBeVisible();
  expect(previews).toEqual([{ projectId: project.id, worktreeId: target.id }, { projectId: project.id, worktreeId: target.id, through: first }]);
  expect(confirms).toEqual([{ projectId: project.id, worktreeId: target.id, through: first, requestId: shown!.requestId, consent: 'f'.repeat(64), message: 'feat: batch one', confirm: true }]);
});

test('batch advice sends exact revisions as a read-only instruction without confirming integration', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/advice', 'feature/advice'); project.worktrees.push(target);
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  state.runs = []; state.executions = []; state.reservations = [];
  state.instances = state.sessions.map((s) => ({ agentId: s.id, status: 'current' }));
  state.activities = state.sessions.map((s) => ({ agentId: s.id, state: 'ready', updatedAt: null, detail: 'Fixture ready' }));
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  const selected = state.groups.find((g) => g.members.length > 0 && g.members.length <= 2)!; const agentId = selected.members[0]!;
  const base = 'b'.repeat(40); const previous = 'c'.repeat(40);
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, dirty: false,
    targetRef: 'refs/heads/main', targetHead: base, target: project.worktrees[0]!.identity, mergeBase: previous, through: target.head, previousCommit: previous,
    commitCount: 1, commits: [{ sha: target.head, subject: 'Remaining change' }], tree: 'e'.repeat(40), message: 'Batch suggestion', commands: [], consent: 'f'.repeat(64) };
  await page.route('**/api/v1/projects/worktrees/integration/preview', (route) => route.fulfill({ json: shown }));
  const advice: Record<string, unknown>[] = []; let integrations = 0;
  await page.route('**/api/v1/instructions', (route) => { advice.push(route.request().postDataJSON()); return route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/projects/worktrees/integration', (route) => { integrations++; return route.fulfill({ json: {} }); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByRole('button', { name: 'Squash feature/advice into main', exact: true }).click();
  await page.getByText('Ask an agent to suggest batches', { exact: true }).click();
  await page.getByRole('button', { name: 'Choose a settled agent' }).click();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(agentId);
  await page.getByLabel('Grouping preference').fill('Keep tests with their behavior.');
  await expect(page.getByRole('button', { name: 'Ask for read-only batch suggestions' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I checked every writer in the selected agent/ }).check();
  await page.getByRole('button', { name: 'Ask for read-only batch suggestions' }).click();
  await expect.poll(() => advice.length).toBe(1); expect(integrations).toBe(0);
  expect(advice[0]!.agentId).toBe(agentId); expect(advice[0]!.handoff).toBeUndefined();
  const text = String(advice[0]!.text);
  for (const literal of [target.head!, base, previous, target.path, 'Do not modify files, commit, merge', 'Keep tests with their behavior.']) expect(text).toContain(literal);
  await expect(page.getByRole('button', { name: 'Confirm squash', exact: true })).toBeVisible();
});
