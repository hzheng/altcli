import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Group, ImplementationStart, StandaloneStart } from '../src/contracts/implementation';
import type { WorkflowState } from '../src/contracts/workflow';
import { editSettings, expand, openCard, pane } from './ui';
const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { headers, data }); expect(response.ok()).toBe(true); return response.json();
}
test.beforeEach(async ({ request, page }) => {
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { base: input.base ?? 'b'.repeat(40), baseSubject: 'Baseline change', head: input.head, since: input.base ? 'explicit' : 'task', commits: [{ sha: input.head, subject: 'Latest changes' }], candidates: [{ sha: input.base ?? 'b'.repeat(40), subject: 'Baseline change' }] } });
  });
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  for (const run of state.runs.filter((r) => ['running','waiting','paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const repository of [...new Set(state.sessions.map((session) => session.repository))]) await post(request, 'workspaces/reset', { repository, confirmReady: true });
  await post(request, 'sessions', { paneId: '%0', label: 'Codex' }); await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
});
// Finish intercepted polling requests before Playwright closes the page.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
async function unlock(page: Page) {
  await page.goto('/'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
}
async function openGroup(page: Page, group: Group) {
  await unlock(page);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: `Project ${group.repository.split('/').pop()}`, exact: true }).click();
  await page.getByRole('button', { name: `Open ${group.cwd!.split('/').pop()}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
}
/** A task branch with `changes` uncommitted paths, so committed follow-ups need no further branch choice. */
async function taskBranch(page: Page, changes = 0) {
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40), clean: !changes,
      changes: Array.from({ length: changes }, (_, i) => ({ status: ' M', path: `src/file${i}.ts`, originalPath: null })), changeCount: changes });
    await route.fulfill({ json: data });
  });
}
/** Records every request that could start or change work; previews and reads are not mutations. */
function mutations(page: Page) {
  const sent: string[] = [];
  page.on('request', (outgoing) => {
    const path = new URL(outgoing.url()).pathname;
    if (outgoing.method() !== 'GET' && !path.endsWith('/implementation/preview')) sent.push(`${outgoing.method()} ${path}`);
  });
  return sent;
}
test('each pane has its own action group; After send maps to a plain Send, work with commit, or work with commit and relay', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Card actions', members: ['codex','claude'] });
  await taskBranch(page, 2);
  const starts: ImplementationStart[] = []; const sent: StandaloneStart[] = [];
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/instructions', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  // The action group is the next thing under each pane's output.
  for (const name of ['Codex', 'Claude']) await expect(pane(page, name).locator('.pane-footer + .pane-actions')).toHaveCount(1);
  const claude = await openCard(page, 'Claude');
  await claude.getByLabel('Instruction for Claude').fill('Fix the parser.');
  await claude.getByLabel('After send').selectOption('commit');
  const sendCommit = claude.getByRole('button', { name: 'Send & commit Claude', exact: true });
  await expect(claude.locator('.pane-line')).toContainText('including the 2 uncommitted paths already present');
  await claude.getByLabel('Ready for implementation').check(); await sendCommit.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: 'claude', kind: 'work', text: 'Fix the parser.', handoff: false, autoContinue: false, policy: 'peer', branch: { branch: 'task/current', head: 'a'.repeat(40) } });
  expect(starts[0]).not.toHaveProperty('reviewBase');
  await expect(claude.getByLabel('Instruction for Claude')).toHaveValue(''); // a started instruction clears only its own draft
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Add the retry.');
  await codex.getByLabel('After send').selectOption('commit_relay');
  await codex.getByLabel('Relay note for Claude').fill('Check the retry path first.');
  // New work is reviewed from the pre-send HEAD; no existing-commit baseline is attached to it.
  await expect(codex.getByLabel('Review baseline')).toBeHidden();
  await expect(codex.locator('.pane-line')).toContainText('Claude reviews only what Codex commits');
  await codex.getByLabel('Ready for implementation').check();
  await codex.getByRole('button', { name: 'Send & commit Codex → relay Claude', exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toMatchObject({ agentId: 'codex', kind: 'work', text: 'Add the retry.', handoff: true, autoContinue: true, policy: 'peer', reviewNote: 'Check the retry path first.' });
  expect(starts[1]).not.toHaveProperty('reviewBase');
  await expect(codex.getByLabel('Relay note for Claude')).toHaveValue(''); // consumed with the start
  await codex.getByLabel('Instruction for Codex').fill('Only explain.'); await codex.getByLabel('After send').selectOption('nothing');
  await codex.getByLabel('Ready for implementation').check(); await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ agentId: 'codex', text: 'Only explain.', policy: 'peer' }); expect(sent[0]).not.toHaveProperty('branch');
  // Fixed roles: only the worker's card sends; the reviewer's card only reviews.
  await editSettings(page); await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await expand(page, 'Collaboration settings'); await page.getByLabel('Automatic collaboration after the initial review').uncheck();
  const reviewer = await openCard(page, 'Codex');
  await expect(reviewer.getByLabel('After send')).toHaveCount(0); await expect(reviewer.getByRole('button', { name: /^Send / })).toHaveCount(0);
  await expect(reviewer).toContainText('Reviewer: reviews without editing project files');
  const worker = await openCard(page, 'Claude');
  await worker.getByLabel('Instruction for Claude').fill('Implement the fix.'); await worker.getByLabel('After send').selectOption('commit_relay');
  await worker.getByLabel('Ready for implementation').check(); await worker.getByRole('button', { name: 'Send & commit Claude → relay Codex', exact: true }).click();
  await expect.poll(() => starts.length).toBe(3);
  expect(starts[2]).toMatchObject({ agentId: 'claude', workerId: 'claude', policy: 'worker_reviewer', kind: 'work', handoff: true, autoContinue: false });
});
test('on an integration branch Send & commit waits for a task branch while plain Send does not', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'From main', members: ['codex','claude'] });
  const starts: ImplementationStart[] = []; let sent = 0;
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/instructions', async (route) => { sent++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const codex = await openCard(page, 'Codex'); const ready = codex.getByLabel('Ready for implementation');
  await codex.getByLabel('Instruction for Codex').fill('Start the task.');
  await codex.getByLabel('After send').selectOption('commit');
  await ready.check();
  const commit = codex.getByRole('button', { name: 'Send & commit Codex', exact: true });
  await expect(commit).toBeDisabled(); await expect(codex.locator('.pane-line')).toContainText('Choose the implementation branch in settings.');
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toContainText('Choose the implementation branch in settings.');
  // The Settings toggle stays where it is when the editor opens below the summary row.
  const toggle = page.getByRole('region', { name: 'Implementation settings' }).getByRole('button', { name: 'Settings', exact: true });
  const place = () => toggle.evaluate((element) => { const box = element.getBoundingClientRect(); return [Math.round(box.left + window.scrollX), Math.round(box.top + window.scrollY)]; });
  const before = await place(); await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await place()).toEqual(before); await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await codex.getByLabel('After send').selectOption('nothing'); await expect(ready).not.toBeChecked();
  await ready.check(); await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
  await codex.getByLabel('After send').selectOption('commit');
  // The reason names a settings gap, so the card links straight to the settings editor.
  await codex.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/from-send');
  await ready.check(); await commit.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ kind: 'work', handoff: false, branch: { branch: 'main', head: 'a'.repeat(40), newBranch: 'task/from-send' } }); expect(sent).toBe(0);
});
test('readiness is one slot, revoked by After send, view switches and runs, and old values never revive it', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'One slot', members: ['codex','claude'] });
  await taskBranch(page);
  await openGroup(page, group); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await (await openCard(page, 'Codex')).getByLabel('Ready for implementation').check();
  // Asserted by attribute: on a phone the unchosen card is hidden, but its checkbox state still matters.
  const codexReady = pane(page, 'Codex').getByLabel('Ready for implementation');
  // Two cards are visible side by side on a desktop; on a phone only the chosen one is, and choosing revokes readiness anyway.
  const claude = await openCard(page, 'Claude'); const ready = claude.getByLabel('Ready for implementation');
  await ready.check(); await expect(codexReady).not.toBeChecked();
  await claude.getByLabel('After send').selectOption('commit'); await expect(ready).not.toBeChecked();
  await claude.getByLabel('After send').selectOption('nothing'); await expect(ready).not.toBeChecked();
  await ready.check(); await page.getByRole('button', { name: 'Focus', exact: true }).click(); await expect(ready).not.toBeChecked();
  await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await ready.check();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
  await expect(ready).not.toBeChecked();
  await ready.check();
  // A run started elsewhere (another card or client) revokes it too, even after that run is released.
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Elsewhere', confirmReady: true });
  await expect(ready).not.toBeChecked({ timeout: 10000 }); await expect(ready).toBeDisabled();
  await post(request, 'runs', { runId: id, action: 'takeover', confirmReady: true });
  await expect(ready).toBeEnabled({ timeout: 10000 }); await expect(ready).not.toBeChecked();
});
test('drafts, choices and disclosures survive tab, layout, phase, section and workspace switches without sending anything', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Keep state', members: ['codex','claude'] });
  await taskBranch(page);
  const sent = mutations(page);
  await openGroup(page, group);
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Codex draft'); await codex.getByLabel('After send').selectOption('commit');
  await expand(codex, 'Committed review'); await codex.getByLabel('Review context for Codex (optional)').fill('Check the parser.');
  const claude = await openCard(page, 'Claude'); await claude.getByLabel('Instruction for Claude').fill('Claude draft');
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/draft');
  await page.getByRole('button', { name: '1 · Plan', exact: true }).click(); await page.getByLabel('Shared task brief').fill('Plan draft');
  await page.getByRole('button', { name: '2 · Implementation', exact: true }).click();
  await page.getByRole('button', { name: 'Focus', exact: true }).click(); await openCard(page, 'Codex'); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  // Visit another workspace and come back: each keeps its own drafts, never another's.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project other', exact: true }).click(); await page.getByRole('button', { name: 'Open other', exact: true }).click();
  await expect(page.getByLabel('Instruction for Codex')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project project', exact: true }).click(); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  const back = await openCard(page, 'Codex');
  await expect(back.getByLabel('Instruction for Codex')).toHaveValue('Codex draft'); await expect(back.getByLabel('After send')).toHaveValue('commit');
  await expect(back.getByLabel('Review context for Codex (optional)')).toBeVisible(); await expect(back.getByLabel('Review context for Codex (optional)')).toHaveValue('Check the parser.');
  await expect((await openCard(page, 'Claude')).getByLabel('Instruction for Claude')).toHaveValue('Claude draft');
  await expect(page.getByLabel('New branch name')).toBeVisible(); await expect(page.getByLabel('New branch name')).toHaveValue('task/draft');
  await page.getByRole('button', { name: '1 · Plan', exact: true }).click(); await expect(page.getByLabel('Shared task brief')).toHaveValue('Plan draft');
  // Projects keeps its own selection and creation draft across a Console round trip.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project other', exact: true }).click();
  await page.getByRole('button', { name: 'Create task worktree', exact: true }).click(); await page.getByLabel('New task branch').fill('feature/draft');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project other', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('New task branch')).toHaveValue('feature/draft');
  expect(sent).toEqual([]);
});
test('Lock forgets drafts and settings within the same document, and sends nothing', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Lock drafts', members: ['codex','claude'] });
  const sent = mutations(page);
  await openGroup(page, group);
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/locked-away');
  await expand(page, 'Collaboration settings'); await page.getByLabel('Pause on a reviewer objection').check();
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Secret draft'); await codex.getByLabel('After send').selectOption('commit');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  // Unlock in the same document, without navigating or reloading: hooks that stay mounted must not keep the old values.
  await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  const back = page.getByRole('region', { name: 'Actions for Codex' });
  await expect(back.getByLabel('Instruction for Codex')).toHaveValue(''); await expect(back.getByLabel('After send')).toHaveValue('nothing');
  await editSettings(page);
  await expect(page.getByLabel('Implementation branch')).toHaveValue(''); await expect(page.getByLabel('New branch name')).toHaveCount(0);
  await expand(page, 'Collaboration settings'); await expect(page.getByLabel('Pause on a reviewer objection')).not.toBeChecked();
  expect(sent).toEqual([]);
});
test('Settings shows the effective host configuration and the console preference; About holds the general explanation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Tabs', members: ['codex','claude'] });
  await openGroup(page, group);
  // Neither the deprecated toggle nor the general explanation belongs in the Console.
  await expect(page.locator('summary').filter({ hasText: /^(Advanced|How this works)$/ })).toHaveCount(0);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Settings', exact: true }).click();
  const host = page.getByRole('region', { name: 'Host configuration' });
  await expect(host).toContainText('READ AT START'); await expect(host).toContainText('restart the host');
  const row = (name: string) => host.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  await expect(row('Adapter')).toContainText('mock (simulated panes)'); await expect(row('Adapter')).toContainText('ALTCLI_ADAPTER (set)');
  await expect(row('Data store')).toContainText(/altcli-e2e-\d+-\d+\/mock/); await expect(row('Data store')).toContainText('ALTCLI_DATA_DIR (set)');
  await expect(row('tmux binary')).toContainText('ALTCLI_TMUX_BIN · default tmux from PATH');
  await expect(row('Integration branches')).toContainText(`main, master + each project's default branch`);
  await expect(row('Deprecated staging relay')).toContainText('allowed');
  await expect(host).not.toContainText('a'.repeat(64)); // the token never reaches the page
  const preferences = page.getByRole('region', { name: 'Console preferences' });
  await expect(preferences.getByLabel('Staging fallback', { exact: true })).toBeEnabled();
  await sections.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About AltCLI', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'How this works' })).toContainText('No effect in this page sends commands');
  await sections.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Actions for Codex' })).toBeVisible();
});
test('Stay unlocked is an explicit preference: reopening skips the token, Lock forgets it, a refused token is dropped', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Stay unlocked', members: ['codex','claude'] });
  await openGroup(page, group);
  // Off by default: a reload asks for the token.
  await page.reload(); await expect(page.getByLabel('Host access token')).toBeVisible();
  await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Stay unlocked on this device').check();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await expect(page.getByLabel('Host access token')).toHaveCount(0);
  // Lock always forgets the token; the preference itself stays on for the next unlock.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByLabel('Host access token')).toBeVisible(); await expect(page.getByText(/This device stays unlocked until you press Lock/)).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Host access token')).toBeVisible();
  await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  // A remembered token the host refuses is dropped rather than retried on every load.
  await page.evaluate(() => localStorage.setItem('altcli.token', 'b'.repeat(64)));
  await page.reload(); await expect(page.getByRole('alert').filter({ hasText: /access token/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('altcli.token'))).toBeNull();
  await page.reload(); await expect(page.getByLabel('Host access token')).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('altcli.stayUnlocked'));
});
test('a double click starts once, and a refused start stays in its own card with the text kept', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Refusal', members: ['codex','claude'] });
  let calls = 0;
  await page.route('**/api/v1/instructions', async (route) => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: { status: 'rejected', error: 'Another turn is starting.' } });
  });
  await openGroup(page, group);
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Do it once.'); await codex.getByLabel('Ready for implementation').check();
  await codex.getByRole('button', { name: 'Send Codex', exact: true }).dblclick();
  await expect(codex.getByRole('alert')).toHaveText('REJECTED: Another turn is starting.'); expect(calls).toBe(1);
  await expect(codex.getByLabel('Instruction for Codex')).toHaveValue('Do it once.');
  await expect(page.getByRole('region', { name: 'Actions for Claude' }).getByRole('alert')).toHaveCount(0);
});
test('every field ID is unique and every label points to exactly one control', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Unique IDs', members: ['codex','claude'] });
  await taskBranch(page, 1);
  await openGroup(page, group); await editSettings(page);
  for (const name of ['Codex', 'Claude']) await (await openCard(page, name)).getByLabel('After send').selectOption('commit_relay');
  const problems = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const orphans = [...document.querySelectorAll('label[for]')].map((label) => label.getAttribute('for')!).filter((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length !== 1);
    return { duplicates, orphans };
  });
  expect(problems).toEqual({ duplicates: [], orphans: [] });
});
test('both Send buttons are in the first desktop viewport, directly under their output', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The two-card viewport target applies to a desktop window.');
  await page.setViewportSize({ width: 1440, height: 900 });
  const group = await post(request, 'groups', { name: 'Viewport', members: ['codex','claude'] });
  await openGroup(page, group);
  for (const name of ['Codex', 'Claude']) {
    await expect(page.getByRole('region', { name: `Actions for ${name}` }).getByRole('button', { name: `Send ${name}`, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(pane(page, name).locator('.pane-footer + .pane-actions')).toHaveCount(1);
  }
  await page.screenshot({ path: info.outputPath('console-1440x900.png') });
});
test('the settings row wraps inside its panel at intermediate widths, with the Settings toggle reachable', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'Intermediate widths are resized from the desktop project.');
  const group = await post(request, 'groups', { name: 'Narrow desktop', members: ['codex','claude'] });
  // On the integration branch with no implementation branch chosen, the row also carries its warning badge.
  await openGroup(page, group);
  const settings = page.getByRole('region', { name: 'Implementation settings' });
  await expect(settings).toContainText('Choose the implementation branch in settings.');
  for (const width of [1100, 900, 800, 761]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `overflow at ${width}` }).toBeLessThanOrEqual(0);
    for (const name of ['Settings', /^Controller · /]) {
      const toggle = settings.getByRole('button', { name, exact: name === 'Settings' });
      await expect(toggle).toBeInViewport({ ratio: 1 });
      const box = (await toggle.boundingBox())!; const panel = (await settings.boundingBox())!;
      expect(box.x + box.width, `${String(name)} inside the panel at ${width}`).toBeLessThanOrEqual(panel.x + panel.width);
    }
    await settings.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Implementation branch')).toBeVisible(); await settings.getByRole('button', { name: 'Settings', exact: true }).click();
  }
});
test('a newly working agent never takes the chosen pane away', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Chosen pane', members: ['codex','claude'] });
  let working = false;
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = data.sessions.map((s) => ({ agentId: s.id, state: working && s.id === 'codex' ? 'working' : 'idle', updatedAt: new Date().toISOString(), detail: 'Native activity.' }));
    await route.fulfill({ json: data });
  });
  await openGroup(page, group); await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await openCard(page, 'Claude'); await expect(page.getByLabel('Claude output')).toBeVisible();
  working = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(pane(page, 'Codex').locator('.pane-status .state')).toHaveText('working');
  await expect(page.getByLabel('Claude output')).toBeVisible(); await expect(page.getByLabel('Codex output')).toBeHidden();
  await expect(page.getByRole('region', { name: 'Actions for Claude' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('the console has no horizontal overflow at phone widths', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'iphone', 'Phone widths only.');
  const group = await post(request, 'groups', { name: 'Narrow', members: ['codex','claude'] });
  await taskBranch(page, 1);
  await openGroup(page, group); await editSettings(page);
  const codex = await openCard(page, 'Codex'); await codex.getByLabel('After send').selectOption('commit_relay');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }
  await page.screenshot({ path: info.outputPath('console-320.png'), fullPage: true });
});
