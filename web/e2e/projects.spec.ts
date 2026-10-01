import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { WorkspaceDiscovery, WorkflowState } from '../src/contracts/workflow';
import type { ManualSession } from '../src/contracts/terminals';
import type { DirectoryListing, FinishPreview, ProjectWorktree, TaskFinish, WorktreeCreateInput, WorktreeCreation, WorktreeDiscard, WorktreePreview } from '../src/contracts/projects';
import { observationTransport, expandAgents, expandWorktree } from './ui';

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
/** Shows a worktree's Branch tab and returns one of its always-visible action groups. */
async function openWorktreeMenu(page: Page, label: 'Main' | 'Branch', branch: string) {
  const group = page.getByRole('group', { name: `${label} actions for ${branch}`, exact: true, includeHidden: true });
  await group.locator('xpath=ancestor::li[1]').getByRole('tab', { name: 'Branch', exact: true }).click();
  return page.getByRole('group', { name: `${label} actions for ${branch}`, exact: true });
}
/** Shows the Branch tab holding the named action button and returns that button. */
async function worktreeAction(page: Page, name: string) {
  const item = page.getByRole('button', { name, exact: true, includeHidden: true });
  await item.locator('xpath=ancestor::li[1]').getByRole('tab', { name: 'Branch', exact: true }).click();
  return item;
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

test('worktrees fill one column, put the main checkout first and toggle independently without actions', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const main = project.worktrees[0]!;
  project.worktrees = [tree('/home/fixture/tasks/login', 'feature/login'), main, tree('/home/fixture/tasks/fix', 'fix/issue')];
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const list = page.getByRole('list', { name: 'Available worktrees' }), cards = list.locator(':scope > li');
  const summary = (card: typeof cards) => card.locator(':scope > details > summary');
  await expect(cards).toHaveCount(3); await expect(summary(cards.first())).toContainText('Main checkout');
  await expect(cards.locator('details[open]')).toHaveCount(0);
  const bounds = await list.boundingBox();
  for (let i = 0; i < 3; i++) {
    const box = await cards.nth(i).boundingBox(); expect(box!.width).toBeGreaterThan(bounds!.width - 2);
    if (i) expect(box!.y).toBeGreaterThan((await cards.nth(i - 1).boundingBox())!.y);
  }
  const first = cards.first(), second = cards.nth(1);
  await expandAgents(page, main.path.split('/').pop()!); await expandAgents(page, 'feature/login');
  await first.getByRole('button', { name: 'Launch agents…' }).click();
  const form = first.getByRole('region', { name: `Launch agents in ${main.path}` }); await expect(form).toBeVisible();
  await summary(first).locator('.workspace-title').click(); await expect(first.locator('details').first()).not.toHaveAttribute('open');
  await expect(form).not.toBeVisible(); await expect(second.getByRole('button', { name: 'Launch agents…' })).toBeVisible();
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(form).not.toBeVisible();
  await summary(first).focus(); await page.keyboard.press('Enter'); await expect(form).toBeVisible();
  await summary(second).locator('.workspace-title').click(); await expect(second.getByRole('button', { name: 'Open feature/login', exact: true })).not.toBeVisible();
  await expect(first.getByRole('button', { name: `Open ${main.path.split('/').pop()}`, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projects and agents' })).toBeVisible(); expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('stacked-worktrees.png'), fullPage: true });
});

test('Create task worktree sits at the top of Worktrees with a decorative emoji and opens its form above the list', async ({ page, request }, info) => {
  await fixture(page, request);
  const section = page.getByRole('region', { name: 'Project worktrees project', exact: true });
  const list = section.getByRole('list', { name: 'Available worktrees' });
  const create = section.getByRole('button', { name: 'Create task worktree', exact: true });
  await expect(create).toHaveText('🌱 Create task worktree');
  const headingBox = (await section.getByRole('heading', { name: 'Worktrees', exact: true }).boundingBox())!, createBox = (await create.boundingBox())!;
  expect(createBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
  expect(createBox.y).toBeLessThan(headingBox.y + headingBox.height);
  expect(createBox.y + createBox.height).toBeGreaterThan(headingBox.y);
  expect((await create.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
  await page.screenshot({ path: info.outputPath('create-worktree-top.png'), fullPage: true });
  await create.click();
  const form = section.getByRole('form', { name: 'Create task worktree' }); await expect(form).toBeVisible();
  const currentHeading = (await section.getByRole('heading', { name: 'Worktrees', exact: true }).boundingBox())!;
  const box = (await form.boundingBox())!; expect(box.y).toBeGreaterThan(currentHeading.y + currentHeading.height);
  expect(box.y + box.height).toBeLessThanOrEqual((await list.boundingBox())!.y);
});

test('worktree tabs separate agents and branch actions, remember selection and keep Open console on the right', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/tasks/login', 'feature/login'), tree('/home/fixture/tasks/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const cards = page.getByRole('list', { name: 'Available worktrees' }).locator(':scope > li');
  const card = (name: string) => cards.filter({ has: page.locator('summary', { hasText: `/home/fixture/tasks/${name}` }) });
  const writes: string[] = []; page.on('request', request => { if (request.method() !== 'GET' && !observationTransport(request.url())) writes.push(request.url()); });
  for (const name of ['login', 'inspect']) {
    await expandWorktree(page, name === 'login' ? 'feature/login' : name);
    const tabs = card(name).getByRole('tablist');
    await expect(tabs.getByRole('tab')).toHaveText(['Agents', 'Branch']);
    await expect(tabs.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(card(name).getByRole('tabpanel', { name: 'Agents', exact: true }).getByRole('button', { name: 'Launch agents…' })).toBeVisible();
    await expect(card(name).getByRole('tabpanel', { name: 'Branch', exact: true })).not.toBeVisible();
    const tabsBox = (await tabs.boundingBox())!, consoleBox = (await card(name).getByRole('button', { name: /^Open / }).boundingBox())!;
    expect(consoleBox.x).toBeGreaterThan(tabsBox.x + tabsBox.width);
    expect(Math.abs(tabsBox.y + tabsBox.height / 2 - consoleBox.y - consoleBox.height / 2)).toBeLessThanOrEqual(1);
    expect(await card(name).evaluate(li => li.scrollWidth <= li.clientWidth)).toBe(true);
  }
  await card('login').getByRole('button', { name: 'Launch agents…' }).click();
  const launch = card('login').getByRole('region', { name: 'Launch agents in /home/fixture/tasks/login' }); await expect(launch).toBeVisible();
  await page.screenshot({ path: info.outputPath('worktree-agents-tab.png'), fullPage: true });
  await card('login').getByRole('tab', { name: 'Branch', exact: true }).click();
  await expect(launch).not.toBeVisible();
  await expect(card('login').getByRole('tabpanel', { name: 'Branch', exact: true }).getByRole('button').filter({ visible: true }))
    .toHaveText(['Squash into main', 'Update from main', 'Rebase onto main', 'Reset to main', 'Rename branch', 'Finish branch', 'Check removal', 'Discard']);
  await expect(card('login').getByRole('button', { name: 'Open feature/login', exact: true })).toBeVisible();
  const otherTab = card('inspect').getByRole('tab', { name: 'Agents', exact: true });
  await otherTab.focus(); await page.keyboard.press('ArrowRight');
  await expect(card('inspect').getByRole('tab', { name: 'Branch', exact: true })).toBeFocused();
  await expect(card('inspect').getByRole('tab', { name: 'Branch', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home'); await expect(otherTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(card('login').getByRole('tab', { name: 'Branch', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(otherTab).toHaveAttribute('aria-selected', 'true');
  await card('login').locator('summary .workspace-title').click(); await expandWorktree(page, 'feature/login');
  await expect(card('login').getByRole('tab', { name: 'Branch', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: info.outputPath('worktree-branch-tab.png'), fullPage: true });
  await card('login').getByRole('tab', { name: 'Agents', exact: true }).click(); await expect(launch).toBeVisible();
  expect(writes).toEqual([]);
});

test('the Branch tab shows Main and Branch action groups in view, with forms below and drafts kept', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); inventory.projects![0]!.worktrees.push(tree('/home/fixture/tasks/finished', 'feature/finished'));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expandWorktree(page, 'feature/finished');
  await page.getByRole('tablist', { name: 'Worktree feature/finished sections', exact: true }).getByRole('tab', { name: 'Branch', exact: true }).click();
  const mainItems = page.getByRole('group', { name: 'Main actions for feature/finished', exact: true });
  const branchItems = page.getByRole('group', { name: 'Branch actions for feature/finished', exact: true });
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  // No dropdowns: every action is visible in its labelled group.
  await expect(mainItems.getByRole('heading', { name: 'Main', exact: true })).toBeVisible();
  await expect(mainItems.getByRole('button')).toHaveText(['Squash into main', 'Update from main', 'Rebase onto main', 'Reset to main']);
  await expect(branchItems.getByRole('button')).toHaveText(['Rename branch', 'Finish branch', 'Check removal', 'Discard']);
  const row = async (group: typeof mainItems) => new Set((await group.getByRole('button').evaluateAll(all => all.map(b => Math.round(b.getBoundingClientRect().top)))));
  if (info.project.name === 'desktop') { expect((await row(mainItems)).size).toBe(1); expect((await row(branchItems)).size).toBe(1); }
  await page.screenshot({ path: info.outputPath('branch-groups.png'), fullPage: true });
  // A form opens below its group's buttons, which stay in view; switching tabs keeps the draft.
  await branchItems.getByRole('button', { name: 'Rename branch feature/finished', exact: true }).click();
  const field = page.getByLabel('New branch name', { exact: true }); await field.fill('feature/next');
  const rename = branchItems.getByRole('button', { name: 'Rename branch feature/finished', exact: true });
  expect((await field.boundingBox())!.y).toBeGreaterThan((await rename.boundingBox())!.y);
  await expect(mainItems.getByRole('button', { name: 'Squash feature/finished into main', exact: true })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Worktree feature/finished sections', exact: true });
  await tabs.getByRole('tab', { name: 'Agents', exact: true }).click(); await tabs.getByRole('tab', { name: 'Branch', exact: true }).click();
  await expect(field).toHaveValue('feature/next'); expect(writes).toEqual([]);
  expect(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth)).toBe(true);
});

test('project navigation keeps linked, detached and empty worktrees visible without starting a task', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/.altcli/project/login', 'fix/login'), tree('/home/fixture/.altcli/project/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(1);
  await expandWorktree(page, 'inspect');
  await expect((await worktreeAction(page, 'Check removal of inspect'))).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.locator('summary').filter({ hasText: '/home/fixture/.altcli/project/inspect' })).toContainText('detached HEAD');
  await page.screenshot({ path: info.outputPath('project-worktrees.png'), fullPage: true });
  await expandWorktree(page, 'fix/login'); await page.getByRole('button', { name: 'Open fix/login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.locator('.context-bar')).toContainText('fix/login');
  await expect(page.getByRole('button', { name: /Start Plan|^Commit / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open fix/login', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
  await expect(page.locator('summary').filter({ hasText: '/feature/login' })).toContainText('No agents');
  await expandWorktree(page, 'feature/login'); await page.getByRole('button', { name: 'Open feature/login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
});
test('Launch agents here scrolls to an offscreen form, including a collapsed worktree and repeated requests', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(...Array.from({ length: 8 }, (_, i) => tree(`/home/fixture/tasks/existing-${i}`, `feature/existing-${i}`)));
  await page.route('**/api/v1/projects/worktrees/preview', route => route.fulfill({ json: preview(inventory, route.request().postDataJSON().branch) }));
  await page.route('**/api/v1/projects/worktrees', route => {
    const input = route.request().postDataJSON() as WorktreeCreateInput;
    inventory.projects![0]!.worktrees.push(tree(input.path, input.branch));
    return route.fulfill({ json: { input, status: 'ready', message: 'Worktree created.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await openForm(page); await page.getByRole('button', { name: 'Preview worktree', exact: true }).click();
  await page.getByLabel('Confirm worktree creation').check(); await page.getByRole('button', { name: 'Create confirmed worktree' }).click();
  const shortcut = page.getByRole('button', { name: 'Launch agents here', exact: true }); await expect(shortcut).toBeVisible();
  // Both heading buttons stay together at the end of the row instead of spreading across it.
  const createBox = (await page.getByRole('button', { name: 'Create task worktree', exact: true }).boundingBox())!, shortcutBox = (await shortcut.boundingBox())!;
  await page.screenshot({ path: info.outputPath('launch-here-heading.png') });
  if (info.project.name === 'desktop') expect(shortcutBox.x - (createBox.x + createBox.width)).toBeLessThanOrEqual(16);
  const summary = page.getByRole('list', { name: 'Available worktrees' }).locator('summary').filter({ hasText: '/feature/login' });
  const form = page.getByRole('region', { name: 'Launch agents in /home/fixture/.altcli/project/feature/login', exact: true });
  const heading = form.getByRole('heading', { name: 'Launch agents in feature/login', exact: true });
  await expect(summary).not.toBeInViewport();
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  await shortcut.click(); await expect(heading).toBeInViewport();
  const tabs = summary.locator('xpath=ancestor::li[1]').getByRole('tablist');
  await tabs.getByRole('tab', { name: 'Branch', exact: true }).click(); await expect(form).not.toBeVisible();
  await summary.locator('.workspace-title').click();
  await shortcut.click(); await expect(heading).toBeInViewport();
  // Discovery must not pull a reader back down after they scroll away; another explicit request must.
  await page.evaluate(() => window.scrollTo(0, 0));
  const recheck = page.getByRole('button', { name: 'Recheck', exact: true });
  await recheck.click(); await expect(recheck).toBeEnabled(); await expect(heading).not.toBeInViewport();
  await shortcut.click(); await expect(heading).toBeInViewport(); expect(writes).toEqual([]);
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
test('every worktree card carries its own agents and group editor, whichever worktree Console shows', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/login', 'feature/login'); project.worktrees.push(target);
  const demo = inventory.workspaces[0]!;
  inventory.workspaces.push({ ...demo, cwd: target.path, worktree: target.identity!, branch: target.branch, sharesIndexWith: [] });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const cards = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem');
  for (const name of ['project', 'login']) {
    const label = name === 'login' ? 'feature/login' : name;
    await expandAgents(page, label);
    await expect(cards.filter({ has: page.getByLabel(`Worktree ${label}`, { exact: true }) }).getByRole('region', { name: `Workspace ${name}`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Open feature/login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  // Opening one worktree in Console neither hides the other editor nor adds a separate panel for the opened one.
  await expect(cards.getByRole('region', { name: /^Workspace / })).toHaveCount(2);
  await expect(page.getByRole('region', { name: /^Workspace / })).toHaveCount(2);
});
test('a read-only host allows project navigation but disables worktree creation', async ({ page, request }) => {
  await fixture(page, request, false); await expect(page.getByRole('button', { name: 'Create task worktree', exact: true })).toBeDisabled();
  await expandWorktree(page, 'project'); await page.getByRole('button', { name: 'Open project', exact: true }).click();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await (await worktreeAction(page, 'Check removal of feature/finished')).click();
  await expect(page.getByRole('region', { name: 'Remove feature/finished', exact: true })).toContainText('Squash integration verified');
  await expect(page.getByRole('region', { name: 'Remove feature/finished', exact: true })).toContainText('Any ignored files in this directory, including local environment files, dependencies and build output, will also be deleted.');
  expect(removals).toBe(0);
  await page.screenshot({ path: info.outputPath('remove-worktree.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open feature/finished', exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  // The persistent menus keep all lifecycle actions on the same compact row.
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'finished' });
  await expect(card.locator('.worktree-tab-bar').getByRole('button')).toHaveText(['Open console']);
  await (await worktreeAction(page, 'Squash feature/finished into main')).click();
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
/** An Update, Rebase or Reset preview as the server sends it, for the task worktree `target`. */
function alignPreview(project: { id: string }, target: ReturnType<typeof tree>, overrides: Record<string, unknown>) {
  return { projectId: project.id, worktreeId: target.id, mode: 'update', requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished', head: target.head,
    targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), boundaryBy: 'squash', boundary: 'c'.repeat(40), replay: [{ sha: 'd'.repeat(40), subject: 'later task work', tree: 'e'.repeat(40) }],
    tree: 'e'.repeat(40), fastForward: false, equivalent: 'git rebase --onto main cccccccccccc', lost: null, consent: 'f'.repeat(64),
    commands: ['git -C /home/fixture/tasks/finished checkout --no-overwrite-ignore --no-recurse-submodules -B feature/finished <last replayed commit>'], ...overrides };
}
test('Main menu groups squash, update, rebase and reset; Update previews and confirms only the previewed consent', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = alignPreview(project, target, {});
  const previews: unknown[] = []; const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => { previews.push(route.request().postDataJSON()); return route.fulfill({ json: shown }); });
  await page.route('**/api/v1/projects/worktrees/update', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, recoveryRef: `refs/altcli/preserved/${shown.requestId}`, confirm: true }, status: 'updated', message: 'Updated feature/finished by replaying 1 commit onto main.', updatedAt: new Date().toISOString(), commit: '0'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await openWorktreeMenu(page, 'Main', 'feature/finished');
  const ways = page.getByRole('group', { name: 'Main actions for feature/finished', exact: true });
  await expect(ways.getByRole('button')).toHaveText(['Squash into main', 'Update from main', 'Rebase onto main', 'Reset to main']);
  await expect(ways.getByRole('button', { name: 'Update feature/finished from main', exact: true })).toHaveAttribute('title', /skipping those already squashed/);
  expect(previews).toEqual([]); // choosing is not previewing
  await page.screenshot({ path: info.outputPath('align-worktree.png'), fullPage: true });
  await ways.getByRole('button', { name: 'Update feature/finished from main', exact: true }).click();
  const region = page.getByRole('region', { name: 'Update feature/finished', exact: true });
  await expect(region).toContainText('Replay the 1 commit made after the last squash (through cccccccccccc) onto main at bbbbbbbbbbbb, without conflicts.');
  await expect(region).toContainText('Equivalent to git rebase --onto main cccccccccccc. The app runs the steps listed below instead');
  await expect(region).toContainText('later task work'); await expect(region).toContainText('kept under refs/altcli/preserved');
  await expect(region).toContainText('checkout --no-overwrite-ignore');
  await expect(region).toContainText('Make sure nobody is actively editing in this branch directory, including agents.');
  await expect(region).toContainText('Code conflicts need manual resolution'); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('update-worktree.png'), fullPage: true });
  await region.getByRole('button', { name: 'Confirm update', exact: true }).click();
  await expect(notice(page, 'Updated feature/finished by replaying 1 commit onto main.')).toBeVisible();
  expect(previews).toEqual([{ projectId: project.id, worktreeId: target.id, mode: 'update' }]);
  expect(posted).toEqual([{ projectId: project.id, worktreeId: target.id, mode: 'update', requestId: shown.requestId, consent: shown.consent, confirm: true }]);
});
test('Rebase onto main previews every replayed commit as git rebase main and confirms its consent', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = alignPreview(project, target, { mode: 'rebase', boundaryBy: 'base', boundary: '9'.repeat(40), equivalent: 'git rebase main',
    replay: [{ sha: '1'.repeat(40), subject: 'first', tree: '2'.repeat(40) }, { sha: '3'.repeat(40), subject: 'second', tree: '4'.repeat(40) }] });
  const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/update', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, recoveryRef: `refs/altcli/preserved/${shown.requestId}`, confirm: true }, status: 'updated', message: 'Rebased feature/finished by replaying 2 commits onto main.', updatedAt: new Date().toISOString(), commit: '0'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await openWorktreeMenu(page, 'Main', 'feature/finished');
  await page.getByRole('button', { name: 'Rebase feature/finished onto main', exact: true }).click();
  const region = page.getByRole('region', { name: 'Rebase feature/finished', exact: true });
  await expect(region).toContainText('Replay all 2 commits since feature/finished left main onto main at bbbbbbbbbbbb, without conflicts.');
  await expect(region).not.toContainText('same as Rebase onto main'); await expect(region).toContainText('Equivalent to git rebase main.');
  await expect(region).toContainText('first'); await expect(region).toContainText('second');
  await expect(region).toContainText('Make sure nobody is actively editing in this branch directory, including agents.');
  await expect(region).toContainText('Code conflicts need manual resolution');
  await region.getByRole('button', { name: 'Confirm rebase', exact: true }).click();
  await expect(notice(page, 'Rebased feature/finished by replaying 2 commits onto main.')).toBeVisible();
  expect(posted).toEqual([{ projectId: project.id, worktreeId: target.id, mode: 'rebase', requestId: shown.requestId, consent: shown.consent, confirm: true }]);
});
test('Reset to main warns about lost work and confirms with one button', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = alignPreview(project, target, { mode: 'reset', boundaryBy: 'reset', boundary: 'b'.repeat(40), replay: [], tree: '5'.repeat(40), equivalent: 'git reset --hard main',
    lost: { commits: 2, recent: [{ sha: '6'.repeat(40), subject: 'second' }, { sha: '7'.repeat(40), subject: 'first' }], changes: 2, paths: ['app.txt', 'staged.txt'], fingerprint: '8'.repeat(64) },
    commands: ['git -C /home/fixture/tasks/finished update-ref --stdin <<< "create refs/altcli/preserved/<request> ' + 'a'.repeat(40) + '"',
      'git -C /home/fixture/tasks/finished reset --hard HEAD (discards the 2 uncommitted tracked changes; untracked and ignored files stay)',
      'git -C /home/fixture/tasks/finished checkout --no-overwrite-ignore --no-recurse-submodules -B feature/finished ' + 'b'.repeat(40)] });
  const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/update', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, recoveryRef: `refs/altcli/preserved/${shown.requestId}`, confirm: true }, status: 'updated', message: 'Reset feature/finished to main at bbbbbbbbbbbb, discarding 2 uncommitted changes.', updatedAt: new Date().toISOString(), commit: 'b'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await openWorktreeMenu(page, 'Main', 'feature/finished');
  await page.getByRole('button', { name: 'Reset feature/finished to main', exact: true }).click();
  const region = page.getByRole('region', { name: 'Reset feature/finished', exact: true });
  await expect(region).toContainText('Reset feature/finished to main at bbbbbbbbbbbb.'); await expect(region).toContainText('Equivalent to git reset --hard main.');
  await expect(region).toContainText('2 commits not on main leave the branch; they stay reachable under refs/altcli/preserved');
  await expect(region).toContainText('2 uncommitted changes are discarded and cannot be recovered'); await expect(region).toContainText('staged.txt');
  await expect(region).toContainText('Untracked and ignored files stay.'); await expect(region).toContainText('reset --hard HEAD');
  await expect(region).toContainText('Reset discards your uncommitted tracked work and replaces the branch contents with main.');
  await expect(region).toContainText('Running agents are not stopped');
  await expect(region.getByRole('textbox')).toHaveCount(0);
  const confirm = region.getByRole('button', { name: 'Confirm reset', exact: true }); await expect(confirm).toBeEnabled(); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('reset-worktree.png'), fullPage: true });
  await confirm.click();
  await expect(notice(page, 'Reset feature/finished to main at bbbbbbbbbbbb, discarding 2 uncommitted changes.')).toBeVisible();
  expect(posted).toEqual([{ projectId: project.id, worktreeId: target.id, mode: 'reset', requestId: shown.requestId, consent: shown.consent, confirm: true }]);
});
for (const mode of ['update', 'rebase', 'reset'] as const) test(`${mode} revokes confirmation on a view change but keeps a lost response inspectable`, async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = alignPreview(project, target, { mode });
  let posted = 0; let previews = 0; const inspected: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => { previews++; return route.fulfill({ json: shown }); });
  await page.route('**/api/v1/projects/worktrees/update', (route) => { posted++; return route.abort(); });
  await page.route('**/api/v1/projects/worktrees/update/reconcile', (route) => {
    inspected.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'updated', message: 'Alignment verified; no Git changes were made by inspection.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  const openPreview = async () => {
    await openWorktreeMenu(page, 'Main', 'feature/finished');
    await page.getByRole('button', { name: mode === 'update' ? 'Update feature/finished from main' : mode === 'rebase' ? 'Rebase feature/finished onto main' : 'Reset feature/finished to main', exact: true }).click();
  };
  const switchView = async () => {
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('button', { name: 'Console', exact: true }).click(); await sections.getByRole('button', { name: 'Projects', exact: true }).click();
  };
  await openPreview();
  const confirm = page.getByRole('button', { name: `Confirm ${mode}`, exact: true }); await expect(confirm).toBeEnabled();
  await switchView(); await expect(confirm).toBeDisabled(); expect(posted).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openPreview(); await confirm.click();
  const inspect = page.getByRole('button', { name: `Inspect this ${mode} result`, exact: true }); await expect(inspect).toBeVisible();
  await switchView(); await expect(confirm).toBeDisabled();
  // Update remains clickable, but cannot replace the request whose response was lost (even for another alignment mode).
  const update = page.getByRole('button', { name: 'Update feature/finished from main', exact: true });
  await expect(update).toBeEnabled(); await update.click();
  const explanation = update.locator('..').getByText(`The last ${mode === 'update' ? 'update from main' : mode === 'rebase' ? 'rebase onto main' : 'reset to main'} response is unknown. Inspect its result before continuing.`, { exact: true });
  await expect(explanation).toHaveCount(1); await expect(explanation).toBeFocused();
  await expect(update.locator('..').getByRole('alert')).toHaveCount(0);
  expect(previews).toBe(2); expect(posted).toBe(1); await inspect.click();
  await expect(notice(page, 'Alignment verified')).toBeVisible();
  expect(inspected).toEqual([{ requestId: shown.requestId }]); expect(posted).toBe(1);
  await expect(inspect).toHaveCount(0);
});
test('Rename previews the unchanged directory and uncommitted work, and editing the name revokes the preview', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const previews: { newBranch: string }[] = []; const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/rename/preview', (route) => {
    const body = route.request().postDataJSON() as { newBranch: string }; previews.push(body);
    return route.fulfill({ json: { projectId: project.id, worktreeId: target.id, newBranch: body.newBranch, requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished',
      head: target.head, fingerprint: '1'.repeat(64), dirty: true, checkpoints: 1, commands: [`git -C /home/fixture/tasks/finished branch -m feature/finished ${body.newBranch}`,
        ...(body.newBranch === 'feature/next' ? ['tmux rename-session -t CC-feature-finished CC-feature-next'] : [])] } });
  });
  await page.route('**/api/v1/projects/worktrees/rename', (route) => {
    posted.push(route.request().postDataJSON());
    target.branch = 'feature/next';
    return route.fulfill({ json: { input: route.request().postDataJSON(), status: 'renamed', message: 'Renamed feature/finished to feature/next.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await (await worktreeAction(page, 'Rename branch feature/finished')).click();
  const field = page.getByLabel('New branch name', { exact: true }); await expect(field).toHaveValue('feature/finished');
  await expect(page.getByRole('button', { name: 'Preview rename', exact: true })).toBeDisabled(); // the same name renames nothing
  await field.fill('feature/draft'); await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  const region = page.getByRole('region', { name: 'Rename feature/finished', exact: true });
  await expect(region).toContainText('Rename feature/finished to feature/draft');
  await expect(region).toContainText('including your uncommitted changes'); await expect(region).toContainText('1 recorded squash batch carries over');
  await expect(region).toContainText('Make sure agents are not running Git commands in this branch directory.');
  await expect(region).toContainText('Running agents are not stopped and may still refer to the old branch name.');
  await expect(region).toContainText('No open tmux session AltCLI launched here needs renaming, so session names stay the same.');
  const tabs = page.getByRole('tablist', { name: 'Worktree feature/finished sections', exact: true });
  await tabs.getByRole('tab', { name: 'Agents', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Branch', exact: true }).click();
  await expect(region).toHaveCount(0); await expect(field).toHaveValue('feature/draft');
  await field.fill('feature/next'); await expect(region).toHaveCount(0); expect(posted).toEqual([]); // editing the name revokes the preview
  await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  await expect(region).toContainText('The tmux sessions AltCLI launched here are renamed for the new branch as listed below');
  await expect(region).toContainText('tmux rename-session -t CC-feature-finished CC-feature-next');
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await expect(notice(page, 'Renamed feature/finished to feature/next.')).toBeVisible();
  const renamed = page.locator('summary[aria-label="Worktree feature/next"]');
  await expect(renamed.locator('.workspace-title strong')).toHaveText('▾ feature/next');
  await expect(renamed).not.toContainText('Branch:');
  await expect(renamed.locator('.cwd')).toHaveAttribute('title', '/home/fixture/tasks/finished');
  await expect(page.getByRole('button', { name: 'Open feature/next', exact: true })).toBeVisible();
  expect(previews.map((p) => p.newBranch)).toEqual(['feature/draft', 'feature/next']);
  expect(posted).toEqual([expect.objectContaining({ newBranch: 'feature/next', branch: 'feature/finished', fingerprint: '1'.repeat(64), confirm: true })]);
});
test('a lost rename response stays inspectable after a view change, and is never resent', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, newBranch: 'feature/next', requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished',
    head: target.head, fingerprint: '1'.repeat(64), dirty: false, checkpoints: 0, commands: ['git -C /home/fixture/tasks/finished branch -m feature/finished feature/next'] };
  let renames = 0; let previews = 0; const inspected: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/rename/preview', (route) => { previews++; return route.fulfill({ json: shown }); });
  await page.route('**/api/v1/projects/worktrees/rename', (route) => { renames++; return route.abort(); });
  await page.route('**/api/v1/projects/worktrees/rename/reconcile', (route) => {
    inspected.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'renamed', message: 'Rename to feature/next verified; no Git changes were made by inspection.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await (await worktreeAction(page, 'Rename branch feature/finished')).click();
  await page.getByLabel('New branch name', { exact: true }).fill('feature/next');
  await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  const inspect = page.getByRole('button', { name: 'Inspect this rename result', exact: true }); await expect(inspect).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Worktree feature/finished sections', exact: true });
  await tabs.getByRole('tab', { name: 'Agents', exact: true }).click(); await expect(inspect).not.toBeVisible();
  await tabs.getByRole('tab', { name: 'Branch', exact: true }).click(); await expect(inspect).toBeVisible();
  // Changing views revokes the confirmation, not the identity of the request already sent.
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Console', exact: true }).click(); await sections.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rename feature/finished', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview rename', exact: true })).toBeDisabled();
  const rename = await worktreeAction(page, 'Rename branch feature/finished');
  await expect(rename).toBeEnabled(); await rename.click();
  const explanation = rename.locator('..').getByText('The last rename response is unknown. Inspect its result before continuing.', { exact: true });
  await expect(explanation).toHaveCount(1); await expect(explanation).toBeFocused();
  await expect(rename.locator('..').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('New branch name', { exact: true })).toHaveValue('feature/next');
  expect(previews).toBe(1); expect(renames).toBe(1);
  await inspect.click();
  await expect(notice(page, 'Rename to feature/next verified')).toBeVisible();
  expect(inspected).toEqual([{ requestId: shown.requestId }]); expect(renames).toBe(1);
  await expect(inspect).toHaveCount(0); await expect((await worktreeAction(page, 'Rename branch feature/finished'))).toBeEnabled();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await page.getByRole('button', { name: 'Open feature/finished', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await (await worktreeAction(page, 'Discard feature/finished')).click();
  const region = page.getByRole('region', { name: 'Discard feature/finished', exact: true });
  await expect(region).toContainText('Lost: 3 commits not in main and 2 uncommitted changes');
  await expect(region).toContainText('does not check that anything was integrated');
  const confirm = page.getByRole('button', { name: 'Confirm discard', exact: true }); await expect(confirm).toBeDisabled();
  await page.getByLabel('Branch name to discard').fill('feature/finish'); await expect(confirm).toBeDisabled();
  await page.getByLabel('Branch name to discard').fill('feature/finished'); await expect(confirm).toBeEnabled(); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('discard-worktree.png'), fullPage: true });
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Open feature/finished', exact: true })).toHaveCount(0);
  await expect(notice(page, 'worktree and branch are deleted')).toBeVisible();
  expect(posted).toEqual([{ ...shown, confirmBranch: 'feature/finished', confirm: true }]);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Switch project' })).toHaveValue(project.id);
  await expect(page.getByRole('combobox', { name: 'Switch worktree' })).toHaveValue('');
  await expect(page.locator('.empty-console')).toContainText(`This worktree is no longer available. Choose another worktree in ${project.name}.`);
});
test('deletion actions stay clickable while agents occupy a worktree: the hint names them and the click shows the server refusal', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/busy', 'feature/busy'); project.worktrees.push(target);
  const demo = inventory.workspaces[0]!; // give the task worktree the demo agents so the card counts them as occupants
  inventory.workspaces.push({ ...demo, cwd: target.path, worktree: target.identity!, branch: target.branch, sharesIndexWith: [] });
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ status: 409, json: { error: { code: 'WORKTREE_IN_USE', message: 'A tmux pane is still in this worktree. Move or close it yourself, then Recheck.' } } }));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/busy');
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'busy' });
  // Removal and discard share one occupant hint in the Branch tab; it is shown once and describes both buttons.
  const check = (await worktreeAction(page, 'Check removal of feature/busy')); await expect(check).toBeEnabled();
  const hint = card.getByRole('status').filter({ hasText: 'still in this worktree' });
  await expect(hint).toHaveCount(1); await expect(hint).toContainText(/Codex, Claude( Code)? are still in this worktree; the server refuses removal/);
  const discard = (await worktreeAction(page, 'Discard feature/busy')); await expect(discard).toBeEnabled();
  await expect(check).toHaveAccessibleDescription(/are still in this worktree/); await expect(discard).toHaveAccessibleDescription(/are still in this worktree/);
  await check.click();
  await expect(page.getByRole('alert').filter({ hasText: 'tmux pane' })).toContainText('A tmux pane is still in this worktree. Move or close it yourself, then Recheck.');
  await expect(check).toBeEnabled(); // the refusal is information, not a lock
});
test('removal rejection is shown and stale worktree preview disables confirmation', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ status: 409, json: { error: { code: 'NOT_INTEGRATED', message: 'Combined changes are not integrated.' } } }));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await (await worktreeAction(page, 'Check removal of feature/finished')).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Combined changes' })).toContainText('not integrated');
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ json: { projectId: project.id, worktreeId: target.id,
    requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), integratedBy: 'ancestry', integratedCommit: target.head } }));
  await (await worktreeAction(page, 'Check removal of feature/finished')).click();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  await (await worktreeAction(page, 'Check removal of feature/finished')).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm removal', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Inspect this removal response', exact: true }).click();
  await expect((await worktreeAction(page, 'Check removal of feature/finished'))).toBeEnabled();
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
  await expandWorktree(page, 'fix/login'); await page.getByRole('button', { name: 'Open fix/login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toBeVisible();
  await page.getByRole('button', { name: 'Open Projects', exact: true }).click();
  await expandWorktree(page, 'fix/moved'); await page.getByRole('button', { name: 'Open fix/moved', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  // The Projects section stays mounted while hidden and lists the same reason, so assert the text the Console shows.
  await expect(page.getByText('This pane moved from /demo/project').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toHaveCount(0);
});

test('worktree actions stay clickable and explain blockers without sending requests', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = true;
  await page.route('**/api/v1/state', route => route.fulfill({ json: state }));
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  const main = await openWorktreeMenu(page, 'Main', 'feature/finished');
  const branch = await openWorktreeMenu(page, 'Branch', 'feature/finished');
  const card = main.locator('xpath=ancestor::li[1]');
  const rename = branch.getByRole('button', { name: 'Rename branch feature/finished', exact: true });
  const assertBlocked = async (reason: string, allActions = false) => {
    await expect(main.getByRole('button', { name: 'Squash feature/finished into main' })).toHaveAccessibleDescription(reason);
    const buttons = [...await main.getByRole('button').all(), rename,
      ...(allActions ? await branch.getByRole('button').filter({ hasNotText: 'Rename branch' }).all() : [])];
    expect(buttons).toHaveLength(allActions ? 8 : 5);
    const explanation = card.getByText(reason, { exact: true });
    for (const button of buttons) {
      await expect(button).toBeEnabled(); await button.click();
      await expect(explanation).toHaveCount(1); await expect(explanation).toBeFocused();
      await expect(button.locator('..').getByRole('alert')).toHaveCount(0);
    }
    await buttons[0]!.click(); await expect(explanation).toHaveCount(1); await expect(explanation).toBeFocused();
    await expect(page.getByLabel('New branch name', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm update', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  };
  // A controller run or delivery on the worktree is not a blocker: one acknowledgement lists it, and an action clicked without it
  // explains that and sends nothing. With it, ending the run is the first request, and a refusal stops before any worktree request.
  const squash = main.getByRole('button', { name: 'Squash feature/finished into main' });
  const acknowledgement = card.getByRole('group', { name: 'Proceed with this feature/finished action anyway acknowledgement' });
  for (const status of ['paused', 'running', 'waiting'] as const) {
    const reason = status === 'paused' ? 'Backend restarted. Reconcile this run before starting another; nothing was replayed.' : 'The run still owns this worktree.';
    state.runs = [{ id: 'owned-run', repository: target.path, lockKey: target.identity!.indexPath, pairId: null, participants: [],
      autoContinue: false, pauseOnObjection: true, pauseRequested: false, status, reason, currentCommandId: 'owned-command',
      automaticTurns: 0, turnLimit: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    await expect(acknowledgement).toContainText(`The controller’s ${status} run for`);
    await expect(squash).not.toHaveAttribute('aria-describedby');
    await squash.click(); await expect(main.getByRole('alert')).toContainText('Check “Proceed anyway” above');
    expect(writes).toEqual([]);
  }
  await acknowledgement.getByRole('checkbox').check(); await squash.click();
  await expect(main.getByRole('alert')).toContainText('Nothing was changed. The action was not started');
  expect(writes.map(url => new URL(url).pathname)).toEqual(['/api/v1/runs']); writes.length = 0;
  state.runs = []; state.reservations = [{ repository: target.path, activeCommandId: 'owned-command' }];
  await expect(acknowledgement).toContainText('The older uncertain delivery hold is released');
  await squash.click(); await expect(main.getByRole('alert')).toContainText('Check “Proceed anyway” above'); expect(writes).toEqual([]);
  state.reservations = []; await expect(acknowledgement).toHaveCount(0);
  state.inputEnabled = false;
  await assertBlocked('The host is read-only. Enable input before changing worktrees.', true);
  state.inputEnabled = true;
  project.creations = [{ input: { ...preview(inventory, 'feature/pending'), confirm: true }, status: 'uncertain', message: 'Inspect creation.', updatedAt: new Date().toISOString() }];
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await assertBlocked('A worktree operation is applying, uncertain or waiting (Finish branch). Inspect or complete it first.', true);
  project.creations = [];
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Squash feature/finished into main' })).not.toHaveAttribute('aria-describedby');
  await rename.click(); await expect(page.getByLabel('New branch name', { exact: true })).toHaveValue('feature/finished');
  await expect(rename.locator('..').getByRole('alert')).toHaveCount(0); expect(writes).toEqual([]);
});

test('idle source agents permit squash and leave deletion clickable with an occupant hint; blocked actions explain host and ownership blockers', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/batches', 'feature/batches'); project.worktrees.push(target);
  inventory.workspaces.push({ ...inventory.workspaces[0]!, cwd: target.path, worktree: target.identity!, branch: target.branch });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/batches');
  const squash = (await worktreeAction(page, 'Squash feature/batches into main'));
  await expect(squash).toBeEnabled();
  const check = (await worktreeAction(page, 'Check removal of feature/batches')); await expect(check).toBeEnabled();
  await expect(check).toHaveAccessibleDescription(/are still in this worktree; the server refuses removal while a pane is inside it/);
  await expect((await worktreeAction(page, 'Discard feature/batches'))).toBeEnabled();
  // A blocker shared by several actions is shown once in the card and describes each affected button.
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'feature/batches' });
  const shownOnce = (text: string) => expect(card.getByRole('status').filter({ hasText: text })).toHaveCount(1);
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = false;
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  await expect(squash).toBeEnabled(); await expect(squash).toHaveAccessibleDescription('The host is read-only. Enable input before changing worktrees.');
  await expect(check).toBeEnabled(); await expect(check).toHaveAccessibleDescription('The host is read-only. Enable input before changing worktrees.');
  await shownOnce('The host is read-only');
  state.inputEnabled = true; state.reservations = [{ repository: target.path, activeCommandId: crypto.randomUUID() }];
  // A delivery that owns the worktree is listed once in the acknowledgement instead of blocking the actions.
  await expect(card.getByRole('group', { name: /acknowledgement$/ })).toContainText('The older uncertain delivery hold is released');
  await expect(squash).not.toHaveAttribute('aria-describedby');
  await expect(check).toBeEnabled(); await expect(check).toHaveAccessibleDescription(/are still in this worktree/); // the occupant hint remains; the server decides
  state.reservations = [];
  project.creations = [{ input: { ...preview(inventory, 'feature/pending'), confirm: true }, status: 'uncertain', message: 'Inspect creation.', updatedAt: new Date().toISOString() }];
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const heldReason = 'A worktree operation is applying, uncertain or waiting (Finish branch). Inspect or complete it first.';
  await expect(squash).toHaveAccessibleDescription(heldReason); await expect(check).toBeEnabled(); await expect(check).toHaveAccessibleDescription(heldReason);
  await shownOnce('A worktree operation is applying');
  project.creations = []; target.branch = null;
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect((await worktreeAction(page, 'Squash batches into main'))).toHaveAccessibleDescription('The task worktree has detached HEAD. Check out its task branch, then Recheck.');
});
test('one acknowledgement records earlier manual input before Update from main, and the preview follows it', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = true;
  const now = new Date().toISOString();
  // Only the displayed record is simulated; the acknowledgement's request order is what this test observes.
  const manual: ManualSession = { id: 'manual-fixture', revision: 4, bootId: 'fixture-boot', clientInstanceId: 'other-browser', connectionId: 'gone', generation: 'g', target: { launchId: crypto.randomUUID() },
    live: false, reconciliationRequired: true, inputMayHaveOccurred: true, bytes: 5, createdAt: now, updatedAt: now, reason: 'Fixture input.', panes: [], runs: [], writers: [], recoveryRequired: true, targets: [] };
  state.manualSessions = [manual];
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  const calls: string[] = [];
  await page.route('**/api/v1/terminals/reconcile', (route) => {
    calls.push('reconcile'); expect(route.request().postDataJSON()).toMatchObject({ manualSessionId: 'manual-fixture', expectedRevision: 4, confirmInspected: true });
    state.manualSessions = []; return route.fulfill({ json: { ...manual, reconciliationRequired: false, recoveryRequired: false, revision: 5 } });
  });
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => { calls.push('preview'); return route.fulfill({ json: alignPreview(project, target, {}) }); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  const main = await openWorktreeMenu(page, 'Main', 'feature/finished'), card = main.locator('xpath=ancestor::li[1]');
  const acknowledgement = card.getByRole('group', { name: 'Proceed with this feature/finished action anyway acknowledgement' });
  await expect(acknowledgement).toContainText('Manual terminal input (5 bytes, some of it uncertain) is recorded as accepted');
  const update = main.getByRole('button', { name: 'Update feature/finished from main', exact: true });
  await update.click(); await expect(main.getByRole('alert')).toContainText('Check “Proceed anyway” above'); expect(calls).toEqual([]);
  await acknowledgement.getByRole('checkbox').check(); await update.click();
  await expect(page.getByRole('region', { name: 'Update feature/finished', exact: true })).toBeVisible();
  expect(calls).toEqual(['reconcile', 'preview']); await expect(acknowledgement).toHaveCount(0);
});
test('Proceed anyway is bound to the exact run command, delivery and writer, not to how they read', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const state = await (await request.get('/api/v1/state', { headers })).json() as WorkflowState;
  state.runs = []; state.executions = []; state.reservations = []; state.inputEnabled = true;
  const now = new Date().toISOString();
  const run = { id: 'owned-run', repository: target.path, lockKey: target.identity!.indexPath, pairId: null, participants: [], autoContinue: false, pauseOnObjection: true,
    pauseRequested: false, status: 'paused', reason: 'Fixture.', currentCommandId: 'old-command', automaticTurns: 0, turnLimit: 1, createdAt: now, updatedAt: now };
  state.runs = [run as unknown as WorkflowState['runs'][number]];
  await page.route('**/api/v1/state', (route) => route.fulfill({ json: state }));
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  const main = await openWorktreeMenu(page, 'Main', 'feature/finished'), card = main.locator('xpath=ancestor::li[1]');
  const acknowledgement = card.getByRole('group', { name: 'Proceed with this feature/finished action anyway acknowledgement' });
  const box = acknowledgement.getByRole('checkbox'), text = async () => acknowledgement.getByRole('list', { name: 'Consequences of proceeding' }).textContent();
  const replaced = async (change: () => void) => {
    await box.check(); const before = await text(); change();
    await expect(box).not.toBeChecked({ timeout: 8000 }); expect(await text()).toBe(before);
  };
  // The same paused run now owns another command: its status and label read the same.
  await expect(acknowledgement).toContainText('The controller’s paused run for');
  await replaced(() => { state.runs = [{ ...state.runs[0]!, currentCommandId: 'new-command' }]; });
  // Another delivery, read the same way.
  state.runs = []; state.reservations = [{ repository: target.path, activeCommandId: 'first-delivery' }];
  await expect(acknowledgement).toContainText('The older uncertain delivery hold is released');
  await replaced(() => { state.reservations = [{ repository: target.path, activeCommandId: 'second-delivery' }]; });
  // Another grant for the same terminal: bytes and wording unchanged.
  state.reservations = [];
  const manual: ManualSession = { id: 'manual-fixture', revision: 4, bootId: 'fixture-boot', clientInstanceId: 'other-browser', connectionId: 'c1', generation: 'g1', target: { launchId: 'fixture-launch' },
    live: true, reconciliationRequired: true, inputMayHaveOccurred: true, bytes: 5, createdAt: now, updatedAt: now, reason: 'Fixture input.', panes: [], runs: [], recoveryRequired: false, targets: [],
    writers: [{ connectionId: 'c1', clientInstanceId: 'other-browser', generation: 'g1', target: { launchId: 'fixture-launch' }, identity: null, sessionId: null, revision: 2, live: true, bytes: 5, inputMayHaveOccurred: true }] };
  state.manualSessions = [manual];
  await expect(acknowledgement).toContainText('Typing stops in launched terminal (another browser or tab)'); await expect(acknowledgement).not.toContainText('delivery');
  await replaced(() => { state.manualSessions = [{ ...manual, writers: [{ ...manual.writers[0]!, generation: 'g2' }] }]; });
  expect(writes).toEqual([]);
});
test('a squash refused for possible activity can be previewed anyway, and confirmation repeats that acknowledgement', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/batches', 'feature/batches'); project.worktrees.push(target);
  const previews: Record<string, unknown>[] = []; const confirms: Record<string, unknown>[] = []; const base = 'b'.repeat(40);
  let shown: Record<string, unknown> = {};
  await page.route('**/api/v1/projects/worktrees/integration/preview', (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    if (!input.acknowledgeActivity) return route.fulfill({ status: 409, json: { error: { code: 'INTEGRATION_WRITERS', message: 'Squash requires settled agents and clear process evidence in both checkouts.' } } });
    shown = { ...input, through: target.head, projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, dirty: false,
      targetRef: 'refs/heads/main', targetHead: base, target: project.worktrees[0]!.identity, mergeBase: base, previousCommit: null, commitCount: 1,
      commits: [{ sha: target.head, subject: 'change' }], tree: 'e'.repeat(40), message: 'Change\n', commands: ['Stage previewed changes', 'Commit'], consent: 'f'.repeat(64) };
    return route.fulfill({ json: shown });
  });
  await page.route('**/api/v1/projects/worktrees/integration', (route) => {
    confirms.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'integrated', message: 'Batch integrated.', updatedAt: new Date().toISOString(), commit: 'd'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/batches');
  await (await worktreeAction(page, 'Squash feature/batches into main')).click();
  const anyway = page.getByRole('group', { name: 'Squash despite activity' });
  await expect(anyway).toContainText('Squash requires settled agents'); await expect(anyway).toContainText('may still be working');
  const again = anyway.getByRole('button', { name: 'Preview batch anyway', exact: true }); await expect(again).toBeDisabled();
  await anyway.getByRole('checkbox', { name: 'Squash anyway', exact: true }).check(); await again.click();
  await expect(page.getByRole('region', { name: 'Squash feature/batches' })).toContainText('You accepted that agents or processes may still be working');
  await page.getByRole('button', { name: 'Confirm squash', exact: true }).click();
  await expect.poll(() => confirms.length).toBe(1);
  expect(previews.map((p) => p.acknowledgeActivity ?? false)).toEqual([false, true]);
  expect(confirms[0]).toMatchObject({ acknowledgeActivity: true, consent: 'f'.repeat(64) });
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/batches');
  await (await worktreeAction(page, 'Squash feature/batches into main')).click();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/advice');
  await (await worktreeAction(page, 'Squash feature/advice into main')).click();
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

test('editing a project path cancels an earlier inspection before it can add the old checkout', async ({ page, request }) => {
  await fixture(page, request);
  const adds: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let inspecting = false;
  await page.route('**/api/v1/directories', async (route) => {
    const path = route.request().postDataJSON().path;
    if (path === '/demo/old') { inspecting = true; await held; }
    return route.fulfill({ json: { path, parent: '/demo', home: '/demo', entries: [], truncated: false, checkoutError: null,
      checkout: { root: path, commonDir: `${path}/.git`, kind: 'main', branch: 'main', head: 'a'.repeat(40), defaultBranch: 'main', mainCheckout: null, mainCheckoutNote: null } } });
  });
  await page.route('**/api/v1/projects', (route) => { adds.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  const path = page.getByLabel('Main/default starting checkout');
  try {
    await path.fill('/demo/old'); await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect.poll(() => inspecting).toBe(true);
    await path.fill('/demo/new'); release();
    await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
    expect(adds).toEqual([]); await expect(path).toHaveValue('/demo/new');
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect.poll(() => adds).toEqual([{ path: '/demo/new', expected: { root: '/demo/new', commonDir: '/demo/new/.git', branch: 'main' } }]);
  } finally { release(); }
});

test('adding a project browses host folders, shows the checkout it will add, and sends exactly that identity', async ({ page, request }) => {
  await fixture(page, request);
  const adds: unknown[] = []; page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/projects') adds.push(r.postDataJSON()); });
  await page.getByRole('button', { name: 'Browse…', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Choose a directory' });
  await expect(picker.getByRole('list', { name: 'Folders' })).toContainText('project');
  await expect(picker.getByRole('button', { name: 'Select this directory' })).toBeDisabled();
  await picker.getByRole('button', { name: 'other Git candidate', exact: true }).click();
  await expect(picker).toContainText('Main checkout /demo/other · branch main');
  await picker.getByRole('button', { name: 'Select this directory' }).click();
  const chosen = page.getByRole('region', { name: 'Chosen checkout' });
  await expect(chosen).toContainText('Main checkout /demo/other'); await expect(chosen).toContainText('default branch not recorded');
  await expect(page.getByLabel('Main/default starting checkout')).toHaveValue('/demo/other');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => adds).toEqual([{ path: '/demo/other', expected: { root: '/demo/other', commonDir: '/demo/other/.git', branch: 'main' } }]);
});
test('a typed linked worktree or non-default branch is shown before adding, and the verified main checkout is one click away', async ({ page, request }) => {
  await fixture(page, request);
  const listing = (path: string, checkout: Partial<DirectoryListing['checkout']>): DirectoryListing => ({ path, parent: '/home/fixture', home: '/home/fixture', entries: [], truncated: false, checkoutError: null,
    checkout: { root: path, commonDir: '/home/fixture/repo/.git', kind: 'main', branch: 'main', head: 'a'.repeat(40), defaultBranch: 'main', mainCheckout: null, mainCheckoutNote: null, ...checkout } });
  await page.route('**/api/v1/directories', (route) => { const { path } = route.request().postDataJSON();
    return route.fulfill({ json: path === '/home/fixture/tasks/login' ? listing(path, { kind: 'linked', branch: 'feature/login', mainCheckout: '/home/fixture/repo' }) : listing(path, { branch: 'feature/other' }) }); });
  const adds: unknown[] = [];
  await page.route('**/api/v1/projects', (route) => { adds.push(route.request().postDataJSON()); return route.fulfill({ json: { id: 'project-x', name: 'repo', commonDir: '/home/fixture/repo/.git', directoryName: 'repo' } }); });
  await page.getByLabel('Main/default starting checkout').fill('/home/fixture/tasks/login');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const chosen = page.getByRole('region', { name: 'Chosen checkout' });
  await expect(chosen).toContainText('linked task worktree'); expect(adds).toEqual([]);
  await chosen.getByRole('button', { name: 'Use main checkout /home/fixture/repo instead' }).click();
  await expect(chosen).toContainText('It is on feature/other, not the default branch main.');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => adds).toEqual([{ path: '/home/fixture/repo', expected: { root: '/home/fixture/repo', commonDir: '/home/fixture/repo/.git', branch: 'feature/other' } }]);
});
test('Finish branch inspection stays reachable after its Git step removed the worktree card', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished');
  const requestId = crypto.randomUUID(), childId = crypto.randomUUID();
  const op: TaskFinish = { requestId, input: { requestId, digest: 'd'.repeat(64), outcome: 'remove', stopActive: true, confirm: true },
    preview: { projectId: project.id, worktreeId: target.id, requestId, digest: 'd'.repeat(64), worktree: target.identity!, branch: target.branch!, sessions: [], others: [], run: null, blockers: [], active: false,
      git: { branch: target.branch!, head: target.head!, targetRef: 'refs/heads/main', targetHead: target.head!, ahead: 0, behind: 0, dirty: false, changeCount: 0,
        integration: 'integrated', integratedBy: 'ancestry', integratedCommit: target.head, note: null } },
    status: 'git_uncertain', step: 'git', revision: 4, message: 'Inspect the recorded removal.', sessions: [], child: { kind: 'removal', requestId: childId }, updatedAt: new Date().toISOString() };
  project.finishes = [op]; // The worktree is already absent from discovery, but the parent still owns the project.
  const inspections: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/finish/reconcile', (route) => {
    inspections.push(route.request().postDataJSON()); op.status = 'done'; op.revision++; op.message = 'Removal verified; Finish branch complete.';
    return route.fulfill({ json: op });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const recovery = page.getByRole('region', { name: 'Finishing feature/finished', exact: true });
  await expect(recovery).toContainText('Inspect the recorded removal.');
  await page.screenshot({ path: info.outputPath('finish-recovery.png'), fullPage: true });
  await recovery.getByRole('button', { name: 'Inspect again', exact: true }).click();
  await expect.poll(() => inspections).toEqual([{ requestId, revision: 4, action: 'inspect' }]);
  await expect(recovery).toHaveCount(0); await expect(notice(page, 'Finish branch complete')).toBeVisible();
});

test('Finish branch previews app sessions, needs the stop acknowledgement, closes them, then removes through a fresh confirmation', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const proc = (pid: string, command: string) => ({ pid, command, started: `start-${pid}`, infrastructure: false });
  const shown: FinishPreview = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), digest: 'd'.repeat(64), worktree: target.identity!, branch: 'feature/finished',
    sessions: [{ launchId: crypto.randomUUID(), sessionName: 'CX-feature-finished', sessionId: '$3', windowId: '@3', server: { pid: '1', started: '2', socketPath: '/tmp/fixture' }, closable: true, reason: null, clients: 1,
      panes: [{ paneId: '%5', windowId: '@3', cwd: target.path, command: 'codex', dead: false, agent: 'CX-feature-finished', activity: 'working', root: proc('100', 'codex'), processes: [proc('100', 'codex'), proc('101', 'npm')] }] },
      { launchId: crypto.randomUUID(), sessionName: 'CC-feature-finished', sessionId: '$4', windowId: '@4', server: { pid: '1', started: '2', socketPath: '/tmp/fixture' }, closable: false, reason: 'A window is shared with another session. Close it yourself.', clients: 0, panes: [] }],
    others: [{ paneId: '%9', location: 'mine:0.0', command: 'zsh' }],
    git: { branch: 'feature/finished', head: target.head!, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), ahead: 2, behind: 1, dirty: false, changeCount: 0, integration: 'integrated', integratedBy: 'squash', integratedCommit: 'b'.repeat(40), note: null },
    run: null, blockers: [], active: true };
  const bodies: Record<string, unknown[]> = { confirm: [], continue: [] };
  const record = (status: TaskFinish['status'], message: string, revision: number): TaskFinish => ({ requestId: shown.requestId, input: { requestId: shown.requestId, digest: shown.digest, outcome: 'remove', stopActive: true, confirm: true },
    preview: shown, status, step: 'sessions', revision, message, child: null, updatedAt: new Date().toISOString(),
    sessions: [{ sessionId: '$3', sessionName: 'CX-feature-finished', launchId: shown.sessions[0]!.launchId, status: 'closed', retained: [], survivors: [], evidence: 'clear' }] });
  await page.route('**/api/v1/projects/worktrees/finish/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/finish', (route) => { bodies.confirm!.push(route.request().postDataJSON());
    const op = record('awaiting_git', '1 app session closed. Continue to preview the removal (branch kept), or stop here.', 3); project.finishes = [op]; return route.fulfill({ json: op }); });
  const removal = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: target.branch, head: target.head, targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), integratedBy: 'squash', integratedCommit: 'b'.repeat(40) };
  await page.route('**/api/v1/projects/worktrees/removal/preview', (route) => route.fulfill({ json: removal }));
  await page.route('**/api/v1/projects/worktrees/finish/continue', (route) => { bodies.continue!.push(route.request().postDataJSON());
    const op = record('done', 'Worktree removed. Its branch, commits and run history are retained.', 5); project.finishes = [op]; project.worktrees = project.worktrees.filter((w) => w.id !== target.id); return route.fulfill({ json: op }); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'feature/finished');
  const finish = await worktreeAction(page, 'Finish feature/finished'); await finish.click();
  const panel = page.getByRole('region', { name: 'Finish feature/finished', exact: true });
  await expect(panel).toContainText('CX-feature-finished'); await expect(panel).toContainText('running npm 101');
  await expect(finish).toBeVisible();
  expect((await panel.boundingBox())!.y).toBeGreaterThan((await finish.boundingBox())!.y);
  await expect(panel).toContainText('not closed: A window is shared with another session.'); await expect(panel).toContainText('zsh (mine:0.0)');
  await expect(panel).toContainText('2 ahead, 1 behind main'); await expect(panel).toContainText('Integration proven: squash commit');
  await expect(panel.getByRole('img', { name: 'Working' })).toBeVisible();
  const close = panel.getByRole('button', { name: 'Close 1 session', exact: true });
  await panel.getByLabel('Close the sessions, then remove the worktree (the branch is kept)').check();
  await expect(close).toBeDisabled(); expect(bodies.confirm).toEqual([]);
  await panel.getByRole('checkbox', { name: /Stop these sessions anyway/ }).check();
  await page.screenshot({ path: info.outputPath('finish-branch.png'), fullPage: true });
  await close.click();
  await expect.poll(() => bodies.confirm).toEqual([{ requestId: shown.requestId, digest: shown.digest, outcome: 'remove', stopActive: true, confirm: true }]);
  const holding = page.getByRole('region', { name: 'Finishing feature/finished', exact: true });
  await expect(holding).toContainText('awaiting git');
  // While Finish branch owns the worktree, entry buttons explain the hold without replacing it.
  await expect(finish).toBeEnabled(); await finish.click();
  await expect(finish.locator('..').getByRole('alert')).toContainText('Finish branch is awaiting git.');
  const check = await worktreeAction(page, 'Check removal of feature/finished');
  await expect(check).toBeEnabled(); await check.click();
  await expect(check.locator('..').getByRole('alert')).toHaveCount(0);
  const explanation = check.locator('xpath=ancestor::li[1]').getByText('A worktree operation is applying, uncertain or waiting (Finish branch). Inspect or complete it first.', { exact: true });
  await expect(explanation).toHaveCount(1); await expect(explanation).toBeFocused();
  await page.keyboard.press('Escape');
  await holding.getByRole('button', { name: 'Continue: check removal', exact: true }).click();
  await holding.getByRole('region', { name: 'Confirm removal of feature/finished' }).getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect.poll(() => bodies.continue).toEqual([{ requestId: shown.requestId, revision: 3, removal: { ...removal, confirm: true } }]);
  await expect(page.getByRole('button', { name: 'Open feature/finished', exact: true })).toHaveCount(0);
  expect(bodies.confirm).toHaveLength(1);
});
