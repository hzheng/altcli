import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { WorkspaceDiscovery, WorkflowState } from '../src/contracts/workflow';
import type { ProjectWorktree, WorktreeCreateInput, WorktreeCreation, WorktreePreview } from '../src/contracts/projects';

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
  return { requestId: crypto.randomUUID(), projectId: project.id, sourceWorktreeId: source.id, source: source.identity!, sourceBranch: source.branch, sourceHead: source.head!, branch, path: `/home/fixture/.codercrew/project/${branch}` };
}
async function openForm(page: Page, branch = 'feature/login') {
  await page.getByRole('button', { name: 'Create task worktree', exact: true }).click();
  await page.getByLabel('New task branch', { exact: true }).fill(branch);
}
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('project navigation keeps linked, detached and empty worktrees visible without starting a task', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/.codercrew/project/login', 'fix/login'), tree('/home/fixture/.codercrew/project/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(1);
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
  await expect(page.getByRole('form', { name: 'Create task worktree' })).toContainText('/home/fixture/.codercrew/project/feature/login');
  await page.getByLabel('Confirm worktree creation').check();
  await page.screenshot({ path: info.outputPath('create-worktree.png'), fullPage: true });
  await create.click();
  await expect(page.getByRole('status')).toContainText('Worktree created'); expect(creates).toEqual([{ ...shown!, confirm: true }]);
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
  await expect(page.getByRole('status')).toContainText('Exact clean result verified'); expect(count).toBe(1);
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
