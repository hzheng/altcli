import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { WorkspaceDiscovery, WorkflowState } from '../src/contracts/workflow';
import type { DirectoryListing, FinishPreview, ProjectWorktree, TaskFinish, WorktreeCreateInput, WorktreeCreation, WorktreeDiscard, WorktreePreview } from '../src/contracts/projects';
import { expandAgents, expandWorktree } from './ui';

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

test('worktrees fill one column, put the main checkout first and toggle independently without actions', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const main = project.worktrees[0]!;
  project.worktrees = [tree('/home/fixture/tasks/login', 'feature/login'), main, tree('/home/fixture/tasks/fix', 'fix/issue')];
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const list = page.getByRole('list', { name: 'Available worktrees' }), cards = list.locator(':scope > li');
  const summary = (card: typeof cards) => card.locator(':scope > details > summary'); // not the nested Agents & group disclosure
  await expect(cards).toHaveCount(3); await expect(summary(cards.first())).toContainText('Main checkout');
  await expect(cards.locator('details[open]')).toHaveCount(0);
  const bounds = await list.boundingBox();
  for (let i = 0; i < 3; i++) {
    const box = await cards.nth(i).boundingBox(); expect(box!.width).toBeGreaterThan(bounds!.width - 2);
    if (i) expect(box!.y).toBeGreaterThan((await cards.nth(i - 1).boundingBox())!.y);
  }
  const first = cards.first(), second = cards.nth(1);
  await expandWorktree(page, main.path.split('/').pop()!); await expandWorktree(page, 'login');
  await first.getByRole('button', { name: 'Launch agents…' }).click();
  const form = first.getByRole('region', { name: `Launch agents in ${main.path}` }); await expect(form).toBeVisible();
  await summary(first).click(); await expect(first.locator('details').first()).not.toHaveAttribute('open');
  await expect(form).not.toBeVisible(); await expect(second.getByRole('button', { name: 'Launch agents…' })).toBeVisible();
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(form).not.toBeVisible();
  await summary(first).focus(); await page.keyboard.press('Enter'); await expect(form).toBeVisible();
  await summary(second).click(); await expect(second.getByRole('button', { name: 'Open login', exact: true })).not.toBeVisible();
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

test('each worktree keeps its buttons on one row, with reasons and opened forms below it', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/tasks/login', 'feature/login'), tree('/home/fixture/tasks/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const cards = page.getByRole('list', { name: 'Available worktrees' }).locator(':scope > li');
  const card = (name: string) => cards.filter({ has: page.locator('summary', { hasText: `/home/fixture/tasks/${name}` }) });
  const rows = async (name: string) => card(name).locator('.worktree-controls button').evaluateAll((all) => all.map((b) => { const r = b.getBoundingClientRect(); return { middle: Math.round((r.top + r.bottom) / 2), bottom: r.bottom }; }));
  const topOf = async (name: string, selector: string) => card(name).locator(selector).evaluateAll((all) => all.map((e) => e.getBoundingClientRect().top));
  for (const name of ['login', 'inspect']) {
    await expandWorktree(page, name);
    await expect(card(name).locator('.worktree-controls button')).toHaveText(['Open console', 'Squash into main', 'Update from main', 'Rename…', 'Finish branch…', 'Check removal', 'Discard…', 'Launch agents…']);
    const buttons = await rows(name), bottom = Math.max(...buttons.map((b) => b.bottom));
    // A phone may wrap the row, but never overflows it; the desktop card is wide enough for one row.
    if (info.project.name === 'desktop') expect(new Set(buttons.map((b) => b.middle)).size).toBe(1);
    expect(await card(name).evaluate((li) => li.scrollWidth <= li.clientWidth)).toBe(true);
    for (const top of await topOf(name, '.worktree-controls .fine')) expect(top).toBeGreaterThanOrEqual(bottom);
  }
  await expect(card('inspect').locator('.worktree-controls .fine')).not.toHaveCount(0);
  await card('login').getByRole('button', { name: 'Launch agents…' }).click();
  const form = card('login').getByRole('region', { name: 'Launch agents in /home/fixture/tasks/login' }); await expect(form).toBeVisible();
  const buttons = await rows('login');
  if (info.project.name === 'desktop') expect(new Set(buttons.slice(0, 8).map((b) => b.middle)).size).toBe(1);
  expect((await form.boundingBox())!.y).toBeGreaterThanOrEqual(Math.max(...buttons.slice(0, 8).map((b) => b.bottom)));
  await page.screenshot({ path: info.outputPath('worktree-button-row.png'), fullPage: true });
});

test('project navigation keeps linked, detached and empty worktrees visible without starting a task', async ({ page, request }, info) => {
  const inventory = await fixture(page, request);
  inventory.projects![0]!.worktrees.push(tree('/home/fixture/.altcli/project/login', 'fix/login'), tree('/home/fixture/.altcli/project/inspect', null));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(1);
  await expandWorktree(page, 'inspect');
  await expect(page.getByRole('button', { name: 'Check removal of inspect', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.locator('summary').filter({ hasText: '/home/fixture/.altcli/project/inspect' })).toContainText('detached HEAD');
  await page.screenshot({ path: info.outputPath('project-worktrees.png'), fullPage: true });
  await expandWorktree(page, 'login'); await page.getByRole('button', { name: 'Open login', exact: true }).click();
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
  await expect(page.locator('summary').filter({ hasText: '/feature/login' })).toContainText('No agents');
  await expandWorktree(page, 'login'); await page.getByRole('button', { name: 'Open login', exact: true }).click();
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
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  await shortcut.click(); await expect(heading).toBeInViewport();
  await summary.click(); await expect(form).not.toBeVisible();
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
    await expandAgents(page, name);
    await expect(cards.filter({ has: page.getByLabel(`Worktree ${name}`, { exact: true }) }).getByRole('region', { name: `Workspace ${name}`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Open login', exact: true }).click();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  // The lifecycle actions read left to right: squash, update, rename, finish branch, removal check, discard; the branch is not repeated in the visible labels.
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ hasText: 'finished' });
  await expect(card.locator('.worktree-controls').getByRole('button')).toHaveText(['Open console', 'Squash into main', 'Update from main', 'Rename…', 'Finish branch…', 'Check removal', 'Discard…', 'Launch agents…']);
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
test('Update from main previews the replay and the kept old tip, and confirms only the previewed consent', async ({ page, request }, info) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished', head: target.head,
    targetRef: 'refs/heads/main', targetHead: 'b'.repeat(40), boundaryBy: 'squash', boundary: 'c'.repeat(40), replay: [{ sha: 'd'.repeat(40), subject: 'later task work', tree: 'e'.repeat(40) }],
    tree: 'e'.repeat(40), fastForward: false, commands: ['git -C /home/fixture/tasks/finished checkout --no-overwrite-ignore --no-recurse-submodules -B feature/finished <last replayed commit>'], consent: 'f'.repeat(64) };
  const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/update/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/update', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, recoveryRef: `refs/altcli/preserved/${shown.requestId}`, confirm: true }, status: 'updated', message: 'Updated feature/finished by replaying 1 commit onto main.', updatedAt: new Date().toISOString(), commit: '0'.repeat(40) } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  await page.getByRole('button', { name: 'Update feature/finished from main', exact: true }).click();
  const region = page.getByRole('region', { name: 'Update feature/finished', exact: true });
  await expect(region).toContainText('Replay 1 commit of feature/finished onto main at bbbbbbbbbbbb, without conflicts.');
  await expect(region).toContainText('main already contains the task commits through cccccccccccc as a squash.');
  await expect(region).toContainText('later task work'); await expect(region).toContainText('kept under refs/altcli/preserved');
  await expect(region).toContainText('Agents here must be idle'); expect(posted).toEqual([]);
  await page.screenshot({ path: info.outputPath('update-worktree.png'), fullPage: true });
  await region.getByRole('button', { name: 'Confirm update', exact: true }).click();
  await expect(notice(page, 'Updated feature/finished by replaying 1 commit onto main.')).toBeVisible();
  expect(posted).toEqual([{ projectId: project.id, worktreeId: target.id, requestId: shown.requestId, consent: shown.consent, confirm: true }]);
});
test('Rename previews the unchanged directory and uncommitted work, and editing the name revokes the preview', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const previews: { newBranch: string }[] = []; const posted: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/rename/preview', (route) => {
    const body = route.request().postDataJSON() as { newBranch: string }; previews.push(body);
    return route.fulfill({ json: { projectId: project.id, worktreeId: target.id, newBranch: body.newBranch, requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished',
      head: target.head, fingerprint: '1'.repeat(64), dirty: true, checkpoints: 1, commands: [`git -C /home/fixture/tasks/finished branch -m feature/finished ${body.newBranch}`] } });
  });
  await page.route('**/api/v1/projects/worktrees/rename', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: route.request().postDataJSON(), status: 'renamed', message: 'Renamed feature/finished to feature/next.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  await page.getByRole('button', { name: 'Rename branch feature/finished', exact: true }).click();
  const field = page.getByLabel('New branch name', { exact: true }); await expect(field).toHaveValue('feature/finished');
  await expect(page.getByRole('button', { name: 'Preview rename', exact: true })).toBeDisabled(); // the same name renames nothing
  await field.fill('feature/draft'); await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  const region = page.getByRole('region', { name: 'Rename feature/finished', exact: true });
  await expect(region).toContainText('Rename feature/finished to feature/draft');
  await expect(region).toContainText('including your uncommitted changes'); await expect(region).toContainText('1 recorded squash batch carries over');
  await field.fill('feature/next'); await expect(region).toHaveCount(0); expect(posted).toEqual([]); // editing the name revokes the preview
  await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await expect(notice(page, 'Renamed feature/finished to feature/next.')).toBeVisible();
  expect(previews.map((p) => p.newBranch)).toEqual(['feature/draft', 'feature/next']);
  expect(posted).toEqual([expect.objectContaining({ newBranch: 'feature/next', branch: 'feature/finished', fingerprint: '1'.repeat(64), confirm: true })]);
});
test('a lost rename response stays inspectable after a view change, and is never resent', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/finished', 'feature/finished'); project.worktrees.push(target);
  const shown = { projectId: project.id, worktreeId: target.id, newBranch: 'feature/next', requestId: crypto.randomUUID(), worktree: target.identity, branch: 'feature/finished',
    head: target.head, fingerprint: '1'.repeat(64), dirty: false, checkpoints: 0, commands: ['git -C /home/fixture/tasks/finished branch -m feature/finished feature/next'] };
  let renames = 0; const inspected: unknown[] = [];
  await page.route('**/api/v1/projects/worktrees/rename/preview', (route) => route.fulfill({ json: shown }));
  await page.route('**/api/v1/projects/worktrees/rename', (route) => { renames++; return route.abort(); });
  await page.route('**/api/v1/projects/worktrees/rename/reconcile', (route) => {
    inspected.push(route.request().postDataJSON());
    return route.fulfill({ json: { input: { ...shown, confirm: true }, status: 'renamed', message: 'Rename to feature/next verified; no Git changes were made by inspection.', updatedAt: new Date().toISOString() } });
  });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  await page.getByRole('button', { name: 'Rename branch feature/finished', exact: true }).click();
  await page.getByLabel('New branch name', { exact: true }).fill('feature/next');
  await page.getByRole('button', { name: 'Preview rename', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  const inspect = page.getByRole('button', { name: 'Inspect this rename result', exact: true }); await expect(inspect).toBeVisible();
  // Changing views revokes the confirmation, not the identity of the request already sent.
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Console', exact: true }).click(); await sections.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rename feature/finished', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview rename', exact: true })).toBeDisabled();
  await inspect.click();
  await expect(notice(page, 'Rename to feature/next verified')).toBeVisible();
  expect(inspected).toEqual([{ requestId: shown.requestId }]); expect(renames).toBe(1);
  await expect(inspect).toHaveCount(0); await expect(page.getByRole('button', { name: 'Rename branch feature/finished', exact: true })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  await page.getByRole('button', { name: 'Open finished', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'busy');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
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
  await expandWorktree(page, 'login'); await page.getByRole('button', { name: 'Open login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toBeVisible();
  await page.getByRole('button', { name: 'Open Projects', exact: true }).click();
  await expandWorktree(page, 'moved'); await page.getByRole('button', { name: 'Open moved', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  // The Projects section stays mounted while hidden and lists the same reason, so assert the text the Console shows.
  await expect(page.getByText('This pane moved from /demo/project').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Start coding CLIs in')).toHaveCount(0);
});

test('idle source agents permit squash and leave deletion clickable with an occupant hint; disabled squash explains host and ownership blockers', async ({ page, request }) => {
  const inventory = await fixture(page, request); const project = inventory.projects![0]!;
  const target = tree('/home/fixture/tasks/batches', 'feature/batches'); project.worktrees.push(target);
  inventory.workspaces.push({ ...inventory.workspaces[0]!, cwd: target.path, worktree: target.identity!, branch: target.branch });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'batches');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'batches');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'advice');
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
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expandWorktree(page, 'finished');
  await page.getByRole('button', { name: 'Finish feature/finished', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Finish feature/finished', exact: true });
  await expect(panel).toContainText('CX-feature-finished'); await expect(panel).toContainText('running npm 101');
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
  // While Finish branch owns the worktree, the separate end-of-task actions wait for it.
  await expect(page.getByRole('button', { name: 'Check removal of feature/finished', exact: true })).toBeDisabled();
  await holding.getByRole('button', { name: 'Continue: check removal', exact: true }).click();
  await holding.getByRole('region', { name: 'Confirm removal of feature/finished' }).getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect.poll(() => bodies.continue).toEqual([{ requestId: shown.requestId, revision: 3, removal: { ...removal, confirm: true } }]);
  await expect(page.getByRole('button', { name: 'Open finished', exact: true })).toHaveCount(0);
  expect(bodies.confirm).toHaveLength(1);
});
