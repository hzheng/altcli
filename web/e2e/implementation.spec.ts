import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { GitChange, Group, ImplementationStart, StandaloneStart } from '../src/contracts/implementation';
import type { WorkflowState } from '../src/contracts/workflow';
const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { headers, data }); expect(response.ok()).toBe(true); return response.json();
}
test.beforeEach(async ({ request, page }) => {
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { base: input.base ?? 'b'.repeat(40), baseSubject: 'Baseline change', head: input.head, since: input.base ? 'explicit' : 'recipient', commits: [{ sha: input.head, subject: 'Latest changes' }], candidates: [{ sha: input.base ?? 'b'.repeat(40), subject: 'Baseline change' }] } });
  });
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  for (const run of state.runs.filter((r) => ['running','waiting','paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const repository of [...new Set(state.sessions.map((session) => session.repository))]) await post(request, 'workspaces/reset', { repository, confirmReady: true });
  await post(request, 'sessions', { paneId: '%0', label: 'Codex' }); await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
});
// Finish intercepted polling requests before Playwright closes the page.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
test('the baseline selector lists every candidate, defaults to the earliest, and marks the latest', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Baseline choices', members: ['codex','claude'] });
  const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40) });
    await route.fulfill({ json: data });
  });
  const previews: { base?: string }[] = [];
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    const chain = [{ sha: 'b'.repeat(40), subject: 'Reviewed by Claude' }, { sha: 'c'.repeat(40), subject: 'First change' }, { sha: 'd'.repeat(40), subject: 'Second change' }, { sha: input.head, subject: 'Third change' }];
    const at = chain.findIndex((commit) => commit.sha === (input.base ?? 'b'.repeat(40)));
    await route.fulfill({ json: { base: chain[at]!.sha, baseSubject: chain[at]!.subject, head: input.head, since: input.base ? 'explicit' : 'recipient',
      commits: chain.slice(at + 1).reverse(), candidates: chain.slice(at, -1) } });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const baseline = page.getByLabel('Review baseline', { exact: true });
  await expect(baseline.getByRole('option')).toHaveText([
    `bbbbbb · Reviewed by Claude — earliest: all since Claude's last commit`, 'cccccc · First change', 'dddddd · Second change — latest: last commit only', 'Another commit…']);
  await expect(baseline).toHaveValue('b'.repeat(40));
  const line = page.getByText(/^Relay Claude: /);
  await expect(line).toContainText('3 commits after bbbbbb through aaaaaa'); await expect(line.locator('strong')).toHaveText(`earliest: all since Claude's last commit`);
  const relay = page.getByRole('button', { name: 'Relay Claude', exact: true });
  await page.getByLabel('Ready for implementation').check(); await expect(relay).toBeEnabled();
  await baseline.selectOption('d'.repeat(40));
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked(); await expect(relay).toBeDisabled(); expect(starts).toEqual([]);
  // A chosen baseline is previewed as its own exact range on the server, not estimated from list positions.
  await expect(line).toContainText('1 commit after dddddd through aaaaaa'); await expect(line.locator('strong')).toHaveText('latest: last commit only');
  expect(previews.at(-1)).toMatchObject({ base: 'd'.repeat(40) });
  await baseline.selectOption('c'.repeat(40)); await expect(line).toContainText('2 commits after cccccc'); await expect(line.locator('strong')).toHaveCount(0);
  expect(previews.at(-1)).toMatchObject({ base: 'c'.repeat(40) });
  await page.getByText('Collaboration settings', { exact: true }).click(); await page.getByLabel('Pause on a reviewer objection').check();
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked(); // agreement changes need fresh readiness
  await page.getByLabel('Ready for implementation').check();
  await page.screenshot({ path: info.outputPath('baseline-selector.png'), fullPage: true });
  await relay.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: 'claude', kind: 'review', reviewBase: 'c'.repeat(40), pauseOnObjection: true, branch: { head: 'a'.repeat(40) } });
});
test('cancelling a preset preview by choosing Another commit leaves the typed preview usable', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Cancelled preview', members: ['codex','claude'] });
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40) });
    await route.fulfill({ json: data });
  });
  let delayed = 0;
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    const chain = [{ sha: 'b'.repeat(40), subject: 'Reviewed by Claude' }, { sha: 'c'.repeat(40), subject: 'First change' }, { sha: 'd'.repeat(40), subject: 'Second change' }, { sha: input.head, subject: 'Third change' }];
    // The preset preview is slow enough to be cancelled by the next selection; the typed preview answers at once.
    if (input.base === 'd'.repeat(40)) { delayed++; await new Promise((resolve) => setTimeout(resolve, 1500)); }
    const at = chain.findIndex((commit) => commit.sha === (input.base ?? 'b'.repeat(40)));
    await route.fulfill({ json: { base: chain[at]!.sha, baseSubject: chain[at]!.subject, head: input.head, since: input.base ? 'explicit' : 'recipient', commits: chain.slice(at + 1).reverse(), candidates: chain.slice(at, -1) } });
  });
  await openGroup(page, group);
  const baseline = page.getByLabel('Review baseline', { exact: true }); await expect(baseline).toHaveValue('b'.repeat(40));
  await baseline.selectOption('d'.repeat(40)); await expect(page.getByText(/^Reading the commits after dddddd/)).toBeVisible();
  await baseline.selectOption('other'); expect(delayed).toBe(1);
  const other = page.getByRole('region', { name: 'Another baseline', exact: true });
  await other.getByLabel('Review baseline SHA').fill('c'.repeat(40));
  const preview = other.getByRole('button', { name: 'Preview commits', exact: true });
  await expect(preview).toBeEnabled(); await expect(preview).toHaveText('Preview commits');
  await preview.click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await expect(other).toContainText('Relay Claude: 2 commits after cccccc through aaaaaa');
  // Going back to a preset and returning also leaves nothing stuck.
  await baseline.selectOption('b'.repeat(40)); await expect(page.getByText(/^Relay Claude: 3 commits after bbbbbb/)).toBeVisible();
  await baseline.selectOption('other'); await expect(preview).toBeEnabled(); await expect(preview).toHaveText('Preview commits');
});
for (const dirty of [false, true]) test(`another baseline requires preview and confirmation and rejects stale HEAD, dirty=${dirty}`, async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Recent commits', members: ['codex','claude'] });
  let head = 'a'.repeat(40); const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { head, clean: !dirty, branch: 'task/current', integration: false, taskBase: 'b'.repeat(40) });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { base: input.base ?? 'b'.repeat(40), baseSubject: 'Baseline change', head: input.head, since: input.base ? 'explicit' : 'task',
      commits: [{ sha: input.head, subject: 'Latest change' }, ...(input.base ? [{ sha: 'c'.repeat(40), subject: 'Earlier change' }] : [])], candidates: [{ sha: input.base ?? 'b'.repeat(40), subject: 'Baseline change' }] } });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await expect(page.getByRole('button', { name: 'Send Codex', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name: 'Claude', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send Claude', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit Claude', exact: true })).toBeVisible();
  const send = page.getByRole('button', { name: dirty ? 'Commit current changes & relay Codex' : 'Relay Codex', exact: true }); const baseline = page.getByLabel('Review baseline', { exact: true });
  await expect(baseline.getByRole('option')).toHaveText([`bbbbbb · Baseline change — earliest: all since the task baseline · latest: ${dirty ? 'current changes only' : 'last commit only'}`, 'Another commit…']);
  await baseline.selectOption('other'); const other = page.getByRole('region', { name: 'Another baseline', exact: true });
  await page.getByLabel('Ready for implementation').check(); await expect(send).toBeDisabled(); await expect(send).toHaveAttribute('title', /Enter a baseline commit and preview it first/);
  await other.getByLabel('Review baseline SHA').fill('b'.repeat(40)); await other.getByRole('button', { name: 'Preview commits', exact: true }).click();
  await expect(other.getByRole('listitem')).toHaveCount(2); expect(starts).toEqual([]);
  await expect(other).toContainText(dirty ? 'Relay Codex: 2 commits plus current changes after bbbbbb through the new snapshot (current HEAD aaaaaa)' : 'Relay Codex: 2 commits after bbbbbb through aaaaaa');
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked(); // a new preview is a new range
  await page.getByLabel('Ready for implementation').check(); await expect(send).toBeEnabled();
  head = 'd'.repeat(40);
  await expect(other.getByRole('listitem')).toHaveCount(0, { timeout: 10000 }); await expect(page.getByLabel('Ready for implementation')).not.toBeChecked();
  await other.getByRole('button', { name: 'Preview commits', exact: true }).click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await page.getByLabel('Ready for implementation').check();
  await other.getByLabel('Review baseline SHA').fill('e'.repeat(40)); await expect(other.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked(); expect(starts).toEqual([]);
  await other.getByRole('button', { name: 'Preview commits', exact: true }).click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await page.getByLabel('Ready for implementation').check();
  await page.screenshot({ path: info.outputPath('explicit-recent-range.png'), fullPage: true });
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: dirty ? 'claude' : 'codex', kind: dirty ? 'commit' : 'review', reviewBase: 'e'.repeat(40), pauseOnObjection: false, branch: { head: 'd'.repeat(40) } });
  await expect(baseline).toHaveValue('b'.repeat(40)); // a delivered relay returns the selector to the earliest candidate
});
test('a log-only derived range has a disabled reason but recent commits can still be previewed', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Log only', members: ['codex','claude'] });
  await page.route('**/api/v1/implementation/preview', async (route) => {
    await route.fulfill({ status: 409, json: { error: { message: 'This range contains no project proposal to review.' } } });
  });
  await openGroup(page, group);
  await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/review');
  await page.getByLabel('Ready for implementation').check();
  const relay = page.getByRole('button', { name: 'Relay Claude', exact: true });
  await expect(relay).toBeDisabled(); await expect(page.getByRole('region', { name: 'Implementation setup' }).getByRole('alert')).toContainText('no project proposal');
  await expect(page.getByLabel('Review baseline', { exact: true })).toHaveValue('other');
  await expect(page.getByRole('region', { name: 'Another baseline', exact: true })).toBeVisible();
});
async function openGroup(page: Page, group: Group) {
  await page.goto('/'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: `Project ${group.repository.split('/').pop()}`, exact: true }).click();
  await page.getByRole('button', { name: `Open ${group.cwd!.split('/').pop()}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
}
async function snapshotAvailable(page: Page) {
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { clean: false, changes: [{ status: 'MM', path: 'app.ts', originalPath: null }], changeCount: 1 });
    await route.fulfill({ json: data });
  });
}
test('committed implementation is default and explicit branch consent carries fixed roles', async ({ page, request }, testInfo) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'Implementation', members: ['codex','claude'] });
  const starts: ImplementationStart[] = [];
  // Browser request contract only. Real Git/publication behavior is tested in implementation.test.ts.
  await page.route('**/api/v1/implementation', async (route) => {
    const input = route.request().postDataJSON() as ImplementationStart; starts.push(input);
    await route.fulfill({ json: { id: input.requestId, status: 'delivered', error: null } });
  });
  await openGroup(page, group);
  await expect(page.getByLabel('Staging fallback', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('region', { name: 'Implementation setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toBeDisabled();
  await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/browser-fixture');
  await page.getByLabel('Instruction or review context').fill('Implement the chosen task.');
  await page.getByLabel('Ready for implementation').check();
  await page.screenshot({ path: testInfo.outputPath('implementation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Commit Claude', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ groupId: group.id, agentId: 'claude', policy: 'worker_reviewer', workerId: 'claude', kind: 'commit', handoff: false, autoContinue: false,
    branch: { branch: 'main', head: 'a'.repeat(40), newBranch: 'task/browser-fixture' }, logPath: 'RELAY-LOG.jsonl', confirmReady: true });
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked();
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); expect(starts).toHaveLength(1);
});
test('solo implementation has one participant and no automatic review controls', async ({ page, request }) => {
  await post(request, 'sessions', { paneId: '%3', label: 'Solo worker' });
  const group = await post(request, 'groups', { name: 'Solo', members: ['solo-worker'] });
  let payload: StandaloneStart | null = null;
  await page.route('**/api/v1/instructions', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await expect(page.getByLabel('Collaboration', { exact: true })).toHaveValue('solo');
  await expect(page.getByRole('button', { name: 'Commit Solo worker', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Relay / })).toHaveCount(0);
  await expect(page.getByLabel('Automatic collaboration after the initial review')).toHaveCount(0);
  await page.getByLabel('Implementation branch').selectOption('stay'); await page.getByLabel('Instruction or review context').fill('Work once.');
  await page.getByLabel('Ready for implementation').check(); await page.getByRole('button', { name: 'Send Solo worker', exact: true }).click();
  await expect.poll(() => payload).toMatchObject({ policy: 'solo', agentId: 'solo-worker', text: 'Work once.' });
});
for (const policy of ['peer', 'worker_reviewer'] as const) test(`${policy} relay of new commits targets the named peer with the derived baseline`, async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Existing review', members: ['codex','claude'] });
  const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40) });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  const previews: { recipient?: string; taskBase?: string; base?: string }[] = [];
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    await route.fulfill({ json: { base: 'b'.repeat(40), baseSubject: 'Reviewed', head: input.head, since: 'recipient', commits: [{ sha: input.head, subject: 'Latest changes' }], candidates: [{ sha: 'b'.repeat(40), subject: 'Reviewed' }] } });
  });
  await openGroup(page, group); await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  await expect(page.getByText(/^Relay Claude: 1 commit after bbbbbb through aaaaaa — earliest: all since Claude's last commit · latest: last commit only\. Newest: Latest changes/)).toBeVisible();
  expect(previews.at(-1)).toMatchObject({ recipient: 'claude', taskBase: 'b'.repeat(40) }); expect(previews.at(-1)!.base).toBeUndefined();
  const review = page.getByRole('button', { name: 'Relay Claude', exact: true });
  await expect(review).toBeDisabled(); await expect(review).toHaveAttribute('title', /Confirm Ready/);
  await page.getByLabel('Ready for implementation').check(); await review.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ kind: 'review', agentId: 'claude', policy, reviewBase: 'b'.repeat(40), branch: { head: 'a'.repeat(40) } });
});
test('an integration branch is a starting point only: no continue option, and the task-branch path is explained', async ({ page, request }) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'On main', members: ['codex', 'claude'] }); let payload: ImplementationStart | null = null;
  await page.route('**/api/v1/implementation', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const picker = page.getByLabel('Implementation branch', { exact: true });
  await expect(picker).toHaveValue(''); await expect(picker.locator('option[value="stay"]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Implementation setup' })).toContainText('main is an integration branch');
  await expect(page.getByRole('region', { name: 'Implementation setup' })).toContainText('separate squash merge or pull request');
  await page.getByLabel('Instruction or review context').fill('Work on a task branch.');
  await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toBeDisabled();
  await picker.selectOption('new'); await page.getByLabel('New branch name').fill('task/from-main');
  await page.getByLabel('Ready for implementation').check(); await page.getByRole('button', { name: 'Commit Codex', exact: true }).click();
  await expect.poll(() => payload).toMatchObject({ branch: { branch: 'main', head: 'a'.repeat(40), newBranch: 'task/from-main' } });
  expect((payload as unknown as ImplementationStart).branch.taskBase).toBeUndefined();
});
test('reconciliation discovers the restarted peer for the next Commit without a workspace reset', async ({ page, request }, info) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'Recovery', members: ['codex', 'claude'] });
  const runId = crypto.randomUUID();
  await post(request, 'commands', { requestId: runId, agentId: 'codex', kind: 'instruction', text: 'Prior task', confirmReady: true });
  const starts: ImplementationStart[] = []; const resets: unknown[] = []; const renewed = crypto.randomUUID();
  // Discovery evidence is simulated; pause and takeover use the real API/store. Server tests cover actual rebinding.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    const owned = data.runs.some((run) => run.id === runId && run.status !== 'stopped');
    data.instances = data.instances.map((instance) => instance.agentId === 'claude' ? { ...instance, status: owned ? 'replaced' : 'current' } : instance);
    if (!owned) data.sessions = data.sessions.map((session) => session.id === 'claude' ? { ...session, registrationId: renewed } : session);
    await route.fulfill({ json: data });
  });
  page.on('request', (outgoing) => { if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/v1/workspaces/reset')) resets.push(outgoing.postDataJSON()); });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await expect(page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const warning = page.getByRole('region', { name: 'Agent identity changed' });
  await expect(warning).toContainText('CLI identity changed for Claude');
  await expect(warning).toContainText('rediscovered automatically, keeping names and group settings');
  await expect(warning.getByRole('button', { name: 'Reset workspace…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause / take over', exact: true }).click();
  await page.getByRole('button', { name: 'I checked every participant; release ownership', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause / take over', exact: true })).toHaveCount(0);
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'attention', exact: true })).toHaveCount(0);
  const send = page.getByRole('button', { name: 'Commit Codex', exact: true });
  expect(starts).toEqual([]); expect(resets).toEqual([]);
  await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/after-recovery');
  await page.getByLabel('Instruction or review context').fill('Finish the task and relay.');
  await expect(send).toBeDisabled(); await expect(page.getByLabel('Ready for implementation')).not.toBeChecked();
  await page.getByLabel('Ready for implementation').check();
  await page.screenshot({ path: info.outputPath('reconciled-peer-ready.png'), fullPage: true });
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ groupId: group.id, kind: 'commit', handoff: false, autoContinue: false, confirmReady: true, registrations: { claude: renewed } });
  expect(resets).toEqual([]);
  // Finish the post-send state/discovery refresh before teardown removes their route handlers.
  await expect(page.getByLabel('Ready for implementation')).toBeEnabled();
});
test('an unknown peer blocks sending and Recheck requires fresh readiness after identity recovers', async ({ page, request }) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'Peer identity', members: ['codex', 'claude'] });
  let unknown = false;
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.mode = 'tmux';
    data.instances = data.instances.map((instance) => ({ ...instance, status: unknown && instance.agentId === 'claude' ? 'unknown' : 'current' }));
    await route.fulfill({ json: data });
  });
  await openGroup(page, group);
  await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/identity');
  await page.getByLabel('Instruction or review context').fill('Wait for both identities.');
  const ready = page.getByLabel('Ready for implementation'); const send = page.getByRole('button', { name: 'Commit Codex', exact: true });
  await ready.check(); await expect(send).toBeEnabled(); unknown = true;
  await expect(ready).toBeDisabled({ timeout: 10000 }); await expect(ready).not.toBeChecked();
  await expect(send).toHaveAttribute('title', /^The host cannot confirm the CLI process for Claude/);
  await expect(page.getByRole('region', { name: 'Agent identity changed' })).toHaveCount(0);
  unknown = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); await expect(send).toBeDisabled();
  await ready.check(); await expect(send).toBeEnabled();
});
test('an existing task branch keeps its baseline: inferred values are confirmed, missing ones must be entered', async ({ page, request }) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'Existing task', members: ['codex', 'claude'] }); let payload: ImplementationStart | null = null;
  let taskBase: string | null = 'c'.repeat(40);
  await page.route('**/api/v1/workspaces', async (route) => { const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) if (workspace.cwd === '/demo/project') workspace.git = { ...workspace.git, branch: 'task/existing', integration: false, taskBase, clean: false };
    await route.fulfill({ json: data }); });
  await page.route('**/api/v1/implementation', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await expect(page.getByLabel('Implementation branch', { exact: true })).toHaveValue('stay');
  await expect(page.getByLabel('Task baseline commit')).toHaveValue('c'.repeat(40));
  await page.getByLabel('Instruction or review context').fill('Continue the task.');
  await page.getByLabel('Ready for implementation').check(); await page.getByRole('button', { name: 'Commit Codex', exact: true }).click();
  await expect.poll(() => payload).toMatchObject({ branch: { branch: 'task/existing', head: 'a'.repeat(40), taskBase: 'c'.repeat(40) } });
  // When no baseline can be inferred, relay waits for a full commit ID even after readiness is confirmed.
  taskBase = null; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await page.getByLabel('Instruction or review context').fill('Continue with a confirmed baseline.');
  await page.getByLabel('Ready for implementation').check();
  await expect(page.getByLabel('Task baseline commit')).toHaveValue(''); await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toBeDisabled();
  await page.getByLabel('Task baseline commit').fill('d'.repeat(40)); await page.getByLabel('Ready for implementation').check();
  await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toBeEnabled();
});
test('a changed branch tip invalidates the displayed readiness confirmation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Current group', members: ['codex', 'claude'] });
  let head = 'a'.repeat(40);
  await page.route('**/api/v1/workspaces', async (route) => { const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) workspace.git.head = head;
    await route.fulfill({ json: data }); });
  await openGroup(page, group); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/tip-check');
  await page.getByLabel('Ready for implementation').check(); head = 'b'.repeat(40);
  await expect(page.getByLabel('Ready for implementation')).not.toBeChecked({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Send Codex', exact: true })).toBeDisabled();
});
for (const phase of ['Plan', 'Implementation'] as const) test(`${phase} applies action-specific dirty-file gates and requires new consent after Recheck`, async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Clean start', members: ['codex','claude'] });
  const changes: GitChange[] = [
    { status: 'M ', path: 'src/staged.ts', originalPath: null },
    { status: ' M', path: 'src/unstaged.ts', originalPath: null },
    { status: 'MM', path: 'src/both.ts', originalPath: null },
    { status: '??', path: 'new <script>.txt', originalPath: null },
    { status: 'R ', path: 'new name.ts', originalPath: 'old name.ts' },
  ];
  let dirty = false; let starts = 0;
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { clean: !dirty, changes: dirty ? changes : [], changeCount: dirty ? changes.length : 0 });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/planning', async (route) => { starts++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await page.getByRole('button', { name: phase === 'Plan' ? '1 · Plan' : '2 · Implementation', exact: true }).click();
  await page.getByLabel('Implementation branch', { exact: true }).selectOption('new');
  await page.getByLabel('New branch name').fill('task/clean-start');
  await page.getByLabel(phase === 'Plan' ? 'Shared task brief' : 'Instruction or review context').fill('A scoped task.');
  const ready = page.getByLabel(phase === 'Plan' ? 'Ready for planning' : 'Ready for implementation');
  await ready.check(); dirty = true;
  // Let polling invalidate an existing confirmation, without a click clearing it for us.
  if (phase === 'Plan') await expect(ready).toBeDisabled({ timeout: 10000 });
  await expect(ready).not.toBeChecked({ timeout: 10000 });
  const warning = page.getByRole('region', { name: 'Uncommitted changes', exact: true });
  if (phase === 'Plan') {
    const files = warning.getByRole('list', { name: 'Blocking files' });
    await expect(files.getByRole('listitem')).toHaveCount(5);
    await expect(files.getByRole('listitem').filter({ hasText: 'src/staged.ts' })).toContainText('Staged');
    await expect(files.getByRole('listitem').filter({ hasText: 'src/unstaged.ts' })).toContainText('Unstaged');
    await expect(files.getByRole('listitem').filter({ hasText: 'src/both.ts' })).toContainText('Staged + Unstaged');
    await expect(files).toContainText('new <script>.txt'); await expect(files).toContainText('old name.ts → new name.ts');
    await expect(warning.locator('script')).toHaveCount(0);
    await expect(warning).toContainText('Creating a branch alone does not make the checkout clean');
    await expect(warning).toContainText('choose a Review baseline and use Relay'); await expect(warning).toContainText('Staging fallback');
  } else await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1 · Plan', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '2 · Implementation', exact: true })).toBeEnabled();
  const start = page.getByRole('button', { name: phase === 'Plan' ? 'Start Plan' : 'Commit Codex', exact: true });
  await expect(start).toBeDisabled();
  if (phase === 'Implementation') {
    await ready.check();
    await expect(page.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toHaveAttribute('title', /selected baseline through the new commit to Claude after validating/);
  }
  await page.screenshot({ path: info.outputPath('dirty-workspace.png'), fullPage: true });
  // Returning to the same clean branch/head via polling cannot resurrect the old confirmation.
  dirty = false; await expect(page.getByRole('region', { name: `${phase} setup` })).toContainText('· clean.', { timeout: 10000 });
  await expect(warning).toHaveCount(0);
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); await expect(start).toBeDisabled();
  await ready.check(); await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); expect(starts).toBe(0);
  if (phase === 'Implementation') {
    await ready.check(); await expect(start).toBeDisabled(); await expect(start).toHaveAttribute('title', /No uncommitted changes/);
    dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  }
  await ready.check(); await start.click(); await expect.poll(() => starts).toBe(1);
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  if (phase === 'Plan') await expect(warning).toBeVisible(); else await expect(warning).toHaveCount(0);
  await page.getByLabel('Staging fallback', { exact: true }).check();
  await expect(page.getByLabel('Ready to send', { exact: true })).toBeEnabled(); expect(starts).toBe(1);
});
test('failed Git recheck blocks cached clean consent until a successful read and fresh confirmation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Read failure', members: ['codex', 'claude'] }); let failure = false;
  await page.route('**/api/v1/workspaces', async (route) => {
    if (failure) await route.fulfill({ status: 503, json: { error: { message: 'Workspace inspection unavailable' } } });
    else await route.continue();
  });
  await openGroup(page, group); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/read-failure');
  await page.getByLabel('Instruction or review context').fill('Wait for reliable Git state.');
  const ready = page.getByLabel('Ready for implementation'); await ready.check(); failure = true;
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeDisabled(); await expect(ready).not.toBeChecked(); await expect(page.getByRole('region', { name: 'Implementation setup' }).getByRole('alert')).toContainText('Recheck before starting');
  failure = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Send Codex', exact: true })).toBeDisabled();
});

test('plain Send ignores branch setup and automation; all four actions explain their commit behavior', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Button help', members: ['codex','claude'] });
  const sent: StandaloneStart[] = []; let commits = 0;
  await page.route('**/api/v1/instructions', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/implementation', async (route) => { commits++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const send = page.getByRole('button', { name: /^Send (Codex|Claude)$/ });
  await expect(send).toHaveAttribute('title', /No automatic commit, branch change, or relay/);
  await expect(page.getByRole('button', { name: 'Commit Codex', exact: true })).toHaveAttribute('title', /Commit Codex:.*local handoff commit with Git hooks disabled/);
  await expect(page.getByRole('button', { name: 'Relay Claude', exact: true })).toHaveAttribute('title', /every commit after the chosen baseline.*everything new to Claude/);
  await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await expect(page.getByRole('button', { name: 'Commit Claude', exact: true })).toHaveAttribute('title', /Commit Claude:/);
  await expect(page.getByRole('button', { name: 'Relay Codex', exact: true })).toHaveAttribute('title', /reviewer changes only the log/);
  await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/not-created-by-send');
  await page.getByLabel('Instruction or review context').fill('Explain this code.');
  await page.getByLabel('Ready for implementation').check(); await send.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ agentId: 'claude', workerId: 'claude', policy: 'worker_reviewer', text: 'Explain this code.' });
  expect(sent[0]).not.toHaveProperty('branch'); expect(sent[0]).not.toHaveProperty('autoContinue'); expect(commits).toBe(0);
});

test('an active plain Send may dirty the checkout without displaying a clean-checkout warning', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Standalone edits', members: ['codex','claude'] });
  let dirty = false;
  // Git discovery is mocked; instruction delivery and ownership use the mock backend API.
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) if (workspace.cwd === '/demo/project') Object.assign(workspace.git, {
      clean: !dirty, changes: dirty ? [{ status: ' M', path: 'src/work.ts', originalPath: null }] : [], changeCount: dirty ? 1 : 0,
    });
    await route.fulfill({ json: data });
  });
  await openGroup(page, group);
  await page.getByLabel('Instruction or review context').fill('Make the requested edits without committing.');
  await page.getByLabel('Ready for implementation').check();
  await page.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause / take over', exact: true })).toBeVisible();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Implementation setup' })).toContainText('· uncommitted changes.');
  await expect(page.getByRole('region', { name: 'Uncommitted changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toHaveAttribute('title', /run|ownership/);
  await page.screenshot({ path: info.outputPath('send-in-progress.png'), fullPage: true });
  await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Uncommitted changes', exact: true })).toHaveCount(0);
});

for (const policy of ['peer', 'worker_reviewer'] as const) test(`Relay adapts to dirty input and snapshots before review with ${policy} roles`, async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Adaptive relay', members: ['codex','claude'] });
  let dirty = false; const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40), clean: !dirty,
      changes: dirty ? [{ status: 'MM', path: 'app.ts', originalPath: null }] : [], changeCount: dirty ? 1 : 0 });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON(); const base = input.base ?? 'b'.repeat(40);
    expect(input.commitPending).toBe(dirty);
    await route.fulfill({ json: { base, baseSubject: 'Baseline change', head: input.head, since: input.base ? 'explicit' : 'task',
      commits: base === input.head ? [] : [{ sha: input.head, subject: 'Latest changes' }],
      candidates: [{ sha: base, subject: 'Baseline change' }, ...(!input.base ? [{ sha: 'c'.repeat(40), subject: 'Earlier change' }] : []),
        ...(input.commitPending && base !== input.head ? [{ sha: input.head, subject: 'Latest changes' }] : [])] } });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  if (policy === 'worker_reviewer') await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  const peer = policy === 'peer' ? 'Claude' : 'Codex';
  const worker = policy === 'peer' ? 'codex' : 'claude';
  const ready = page.getByLabel('Ready for implementation');
  const baseline = page.getByLabel('Review baseline', { exact: true });
  await baseline.selectOption('c'.repeat(40));
  await expect(page.getByText(new RegExp(`Relay ${peer}: 1 commit after cccccc`))).toBeVisible();
  await ready.check(); await expect(page.getByRole('button', { name: `Relay ${peer}`, exact: true })).toBeEnabled();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const relay = page.getByRole('button', { name: `Commit current changes & relay ${peer}`, exact: true });
  await expect(relay).toBeVisible(); await expect(relay).toBeDisabled(); await expect(ready).not.toBeChecked();
  await expect(baseline).toHaveValue('c'.repeat(40));
  await baseline.selectOption('a'.repeat(40));
  await expect(page.getByText(new RegExp(`Relay ${peer}: 0 commits plus current changes after aaaaaa`))).toBeVisible();
  await ready.check(); await expect(relay).toBeEnabled();
  await baseline.selectOption('c'.repeat(40));
  await expect(page.getByText(new RegExp(`Relay ${peer}: 1 commit plus current changes after cccccc`))).toBeVisible();
  await expect(ready).not.toBeChecked();
  await page.getByText('Collaboration settings', { exact: true }).click();
  await page.getByLabel('Automatic collaboration after the initial review').uncheck();
  await ready.check(); await expect(relay).toBeEnabled();
  // A clean/dirty transition revokes snapshot consent before changing the action back to a committed-range review.
  dirty = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(relay).toHaveCount(0); await expect(ready).not.toBeChecked();
  await expect(page.getByRole('button', { name: `Relay ${peer}`, exact: true })).toBeDisabled();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(relay).toBeDisabled(); await expect(baseline).toHaveValue('c'.repeat(40));
  await expect(page.getByText(new RegExp(`Relay ${peer}: 1 commit plus current changes after cccccc`))).toBeVisible();
  await ready.check(); await relay.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: worker, kind: 'commit', handoff: true, autoContinue: false, policy, branch: { head: 'a'.repeat(40) } });
  expect(starts[0]).toHaveProperty('reviewBase', 'c'.repeat(40)); expect(starts[0]).not.toHaveProperty('text');
});
for (const policy of ['peer', 'worker_reviewer'] as const) test(`dirty Commit snapshots without an instruction with ${policy} roles`, async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Finish existing work', members: ['codex','claude'] });
  const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: workspace.git.head,
      clean: false, changes: [{ status: 'MM', path: 'src/work.ts', originalPath: null }], changeCount: 1 });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  if (policy === 'worker_reviewer') await page.getByLabel('Worker', { exact: true }).selectOption('codex');
  await expect(page.getByLabel('Instruction or review context')).toHaveValue('');
  await page.getByLabel('Ready for implementation').check();
  await expect(page.getByRole('region', { name: 'Uncommitted changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toBeEnabled();
  const send = page.getByRole('button', { name: 'Commit Codex', exact: true });
  await expect(send).toHaveAttribute('title', /snapshot all staged, unstaged and nonignored untracked changes as they stand/);
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]!.text).toBeUndefined();
  expect(starts[0]).toMatchObject({ kind: 'commit', handoff: false, autoContinue: false, policy, branch: { branch: 'task/current' } });
});
