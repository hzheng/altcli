import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { GitChange, Group, ImplementationStart, StandaloneStart } from '../src/contracts/implementation';
import type { WorkflowState } from '../src/contracts/workflow';
import { editSettings, expand, handOff, openCard, openController, pane } from './ui';
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
  // An existing-commit review is asked of its recipient, so Relay Claude sits in Claude's own card.
  const claude = await openCard(page, 'Claude'); await expand(claude, 'Committed review');
  const baseline = claude.getByLabel('Review baseline', { exact: true });
  await expect(baseline.getByRole('option')).toHaveText([
    `bbbbbb · Reviewed by Claude — earliest: all since Claude's last commit`, 'cccccc · First change', 'dddddd · Second change — latest: last commit only', 'Another commit…']);
  await expect(baseline).toHaveValue('b'.repeat(40));
  const line = claude.getByText(/^Relay Claude: /);
  await expect(line).toContainText('3 commits after bbbbbb through aaaaaa'); await expect(line.locator('strong')).toHaveText(`earliest: all since Claude's last commit`);
  const relay = claude.getByRole('button', { name: 'Relay Claude', exact: true }); const ready = claude.getByLabel('Ready for implementation');
  await ready.check(); await expect(relay).toBeEnabled();
  await baseline.selectOption('d'.repeat(40));
  await expect(ready).not.toBeChecked(); await expect(relay).toBeDisabled(); expect(starts).toEqual([]);
  // A chosen baseline is previewed as its own exact range on the server, not estimated from list positions.
  await expect(line).toContainText('1 commit after dddddd through aaaaaa'); await expect(line.locator('strong')).toHaveText('latest: last commit only');
  expect(previews.at(-1)).toMatchObject({ base: 'd'.repeat(40) });
  await baseline.selectOption('c'.repeat(40)); await expect(line).toContainText('2 commits after cccccc'); await expect(line.locator('strong')).toHaveCount(0);
  expect(previews.at(-1)).toMatchObject({ base: 'c'.repeat(40) });
  await editSettings(page); await expand(page, 'Collaboration settings'); await page.getByLabel('Pause on a reviewer objection').check();
  await expect(ready).not.toBeChecked(); // agreement changes need fresh readiness
  await ready.check();
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
  const claude = await openCard(page, 'Claude'); await expand(claude, 'Committed review');
  const baseline = claude.getByLabel('Review baseline', { exact: true }); await expect(baseline).toHaveValue('b'.repeat(40));
  await baseline.selectOption('d'.repeat(40)); await expect(claude.getByText(/^Reading the commits after dddddd/)).toBeVisible();
  await baseline.selectOption('other'); expect(delayed).toBe(1);
  const other = claude.getByRole('region', { name: 'Another baseline', exact: true });
  await other.getByLabel('Review baseline SHA').fill('c'.repeat(40));
  const preview = other.getByRole('button', { name: 'Preview commits', exact: true });
  await expect(preview).toBeEnabled(); await expect(preview).toHaveText('Preview commits');
  await preview.click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await expect(other).toContainText('Relay Claude: 2 commits after cccccc through aaaaaa');
  // Going back to a preset and returning also leaves nothing stuck.
  await baseline.selectOption('b'.repeat(40)); await expect(claude.getByText(/^Relay Claude: 3 commits after bbbbbb/)).toBeVisible();
  await baseline.selectOption('other'); await expect(preview).toBeEnabled(); await expect(preview).toHaveText('Preview commits');
});
for (const dirty of [false, true]) test(`another baseline requires preview and confirmation and rejects stale HEAD, dirty=${dirty}`, async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Recent commits', members: ['codex','claude'] });
  let head = 'a'.repeat(40); const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { head, clean: !dirty, changes: dirty ? [{ status: 'MM', path: 'app.ts', originalPath: null }] : [], changeCount: dirty ? 1 : 0,
      branch: 'task/current', integration: false, taskBase: 'b'.repeat(40) });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { base: input.base ?? 'b'.repeat(40), baseSubject: 'Baseline change', head: input.head, since: input.base ? 'explicit' : 'task',
      commits: [{ sha: input.head, subject: 'Latest change' }, ...(input.base ? [{ sha: 'c'.repeat(40), subject: 'Earlier change' }] : [])], candidates: [{ sha: input.base ?? 'b'.repeat(40), subject: 'Baseline change' }] } });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  // Every card carries its own Send, including one the phone layout currently hides.
  await expect(pane(page, 'Codex').locator('button', { hasText: /^Send Codex$/ })).toBeAttached();
  // A dirty checkout is snapshotted by Claude and relayed to Codex from Claude's card; a clean range is reviewed in Codex's own card.
  const scope = await openCard(page, dirty ? 'Claude' : 'Codex');
  await expect(pane(page, 'Claude').locator('button', { hasText: /^Send Claude$/ })).toBeAttached();
  if (dirty) await handOff(scope, 'commit_relay'); else await expand(scope, 'Committed review');
  const send = scope.getByRole('button', { name: dirty ? 'Commit current changes & relay Codex' : 'Relay Codex', exact: true }); const baseline = scope.getByLabel('Review baseline', { exact: true });
  const ready = scope.getByLabel('Ready for implementation');
  await expect(baseline.getByRole('option')).toHaveText([`bbbbbb · Baseline change — earliest: all since the task baseline · latest: ${dirty ? 'current changes only' : 'last commit only'}`, 'Another commit…']);
  await baseline.selectOption('other'); const other = scope.getByRole('region', { name: 'Another baseline', exact: true });
  await ready.check(); await expect(send).toBeDisabled(); await expect(send).toHaveAttribute('title', /Enter a baseline commit and preview it first/);
  await other.getByLabel('Review baseline SHA').fill('b'.repeat(40)); await other.getByRole('button', { name: 'Preview commits', exact: true }).click();
  await expect(other.getByRole('listitem')).toHaveCount(2); expect(starts).toEqual([]);
  await expect(other).toContainText(dirty ? 'Relay Codex: 2 commits plus current changes after bbbbbb through the new snapshot (current HEAD aaaaaa)' : 'Relay Codex: 2 commits after bbbbbb through aaaaaa');
  await expect(ready).not.toBeChecked(); // a new preview is a new range
  await ready.check(); await expect(send).toBeEnabled();
  head = 'd'.repeat(40);
  await expect(other.getByRole('listitem')).toHaveCount(0, { timeout: 10000 }); await expect(ready).not.toBeChecked();
  await other.getByRole('button', { name: 'Preview commits', exact: true }).click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await ready.check();
  await other.getByLabel('Review baseline SHA').fill('e'.repeat(40)); await expect(other.getByRole('listitem')).toHaveCount(0);
  await expect(ready).not.toBeChecked(); expect(starts).toEqual([]);
  await other.getByRole('button', { name: 'Preview commits', exact: true }).click(); await expect(other.getByRole('listitem')).toHaveCount(2);
  await ready.check();
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
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/review');
  const claude = await openCard(page, 'Claude'); await expand(claude, 'Committed review');
  await claude.getByLabel('Ready for implementation').check();
  const relay = claude.getByRole('button', { name: 'Relay Claude', exact: true });
  await expect(relay).toBeDisabled(); await expect(claude.getByRole('alert')).toContainText('no project proposal');
  await expect(claude.getByLabel('Review baseline', { exact: true })).toHaveValue('other');
  await expect(claude.getByRole('region', { name: 'Another baseline', exact: true })).toBeVisible();
});
for (const dirty of [false, true]) test(`a refused derived range still relays a successfully previewed typed baseline, dirty=${dirty}`, async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Typed after refusal', members: ['codex','claude'] });
  const starts: ImplementationStart[] = [];
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, taskBase: 'b'.repeat(40), clean: !dirty,
      changes: dirty ? [{ status: 'MM', path: 'app.ts', originalPath: null }] : [], changeCount: dirty ? 1 : 0 });
    await route.fulfill({ json: data });
  });
  // The derived range holds no project proposal; an older typed baseline does.
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON();
    if (!input.base) return route.fulfill({ status: 409, json: { error: { message: 'This range contains no project proposal to review.' } } });
    await route.fulfill({ json: { base: input.base, baseSubject: 'Older change', head: input.head, since: 'explicit', commits: [{ sha: input.head, subject: 'Journal only' }, { sha: 'd'.repeat(40), subject: 'Project change' }], candidates: [{ sha: input.base, subject: 'Older change' }] } });
  });
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  // A dirty checkout snapshots in Codex's card and relays to Claude; a clean one is reviewed in Claude's own card.
  const scope = await openCard(page, dirty ? 'Codex' : 'Claude');
  if (dirty) await handOff(scope, 'commit_relay'); else await expand(scope, 'Committed review');
  const send = scope.getByRole('button', { name: dirty ? 'Commit current changes & relay Claude' : 'Relay Claude', exact: true }); const ready = scope.getByLabel('Ready for implementation');
  await expect(scope.getByLabel('Review baseline', { exact: true })).toHaveValue('other'); await expect(scope.getByRole('alert')).toContainText('no project proposal');
  await ready.check(); await expect(send).toBeDisabled(); await expect(send).toHaveAttribute('title', /Enter a baseline commit and preview it first/);
  const other = scope.getByRole('region', { name: 'Another baseline', exact: true });
  await other.getByLabel('Review baseline SHA').fill('c'.repeat(40)); await other.getByRole('button', { name: 'Preview commits', exact: true }).click();
  await expect(other.getByRole('listitem')).toHaveCount(2); await expect(ready).not.toBeChecked(); // a new preview is a new range
  await expect(scope.getByRole('alert')).toHaveCount(0); // the successful typed preview supersedes the refused derived range
  await ready.check(); await expect(send).toBeEnabled(); await expect(send).not.toHaveAttribute('title', /no project proposal/);
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: dirty ? 'codex' : 'claude', kind: dirty ? 'commit' : 'review', handoff: true, reviewBase: 'c'.repeat(40), branch: { head: 'a'.repeat(40) } });
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
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.getByLabel('Staging fallback', { exact: true })).not.toBeChecked();
  await sections.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toBeVisible();
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit');
  await expect(codex.getByRole('button', { name: 'Commit current changes Codex', exact: true })).toBeDisabled();
  await editSettings(page);
  await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/browser-fixture');
  const claude = await openCard(page, 'Claude'); await handOff(claude, 'commit');
  await claude.getByLabel('Ready for implementation').check();
  await page.screenshot({ path: testInfo.outputPath('implementation.png'), fullPage: true });
  await claude.getByRole('button', { name: 'Commit current changes Claude', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ groupId: group.id, agentId: 'claude', policy: 'worker_reviewer', workerId: 'claude', kind: 'commit', handoff: false, autoContinue: false,
    branch: { branch: 'main', head: 'a'.repeat(40), newBranch: 'task/browser-fixture' }, confirmReady: true });
  expect(starts[0]).not.toHaveProperty('text'); // a hand-off as it stands carries no instruction
  expect(starts[0]).not.toHaveProperty('logPath'); // the journal stays in AltCLI unless the project opts into a tracked mirror
  await expect(claude.getByLabel('Ready for implementation')).not.toBeChecked();
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); expect(starts).toHaveLength(1);
});
test('a tracked relay log is an explicit opt-in whose path is sent only when enabled', async ({ page, request }) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'Tracked log', members: ['codex','claude'] });
  const starts: ImplementationStart[] = []; const previews: { logPath?: string }[] = [];
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    await route.fulfill({ json: { base: input.base ?? 'b'.repeat(40), baseSubject: 'Baseline change', head: input.head, since: 'task', commits: [], candidates: [{ sha: input.base ?? 'b'.repeat(40), subject: 'Baseline change' }, { sha: input.head, subject: 'Current' }] } });
  });
  await openGroup(page, group);
  // A snapshot relay previews its range, so the log preference must reach that preview.
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit_relay');
  await editSettings(page); await expand(page, 'Collaboration settings');
  await expect(page.getByLabel('Tracked relay log')).toHaveCount(0);
  await expect(page.getByText(/journal stays in AltCLI/)).toBeVisible();
  await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/tracked');
  await expect.poll(() => previews.length).toBeGreaterThan(0); expect(previews.at(-1)).not.toHaveProperty('logPath');
  await page.getByLabel('Also track the journal in the repository').check();
  const path = page.getByLabel('Tracked relay log'); await expect(path).toHaveValue('RELAY-LOG.jsonl');
  await path.fill('docs/relay-log.jsonl');
  await expect.poll(() => previews.at(-1)?.logPath).toBe('docs/relay-log.jsonl');
  await handOff(codex, 'commit'); await codex.getByLabel('Ready for implementation').check();
  await codex.getByRole('button', { name: 'Commit current changes Codex', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ kind: 'commit', logPath: 'docs/relay-log.jsonl' });
});
test('solo implementation has one participant and no automatic review controls', async ({ page, request }) => {
  await post(request, 'sessions', { paneId: '%3', label: 'Solo worker' });
  const group = await post(request, 'groups', { name: 'Solo', members: ['solo-worker'] });
  let payload: StandaloneStart | null = null;
  await page.route('**/api/v1/instructions', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await editSettings(page);
  await expect(page.getByLabel('Collaboration', { exact: true })).toHaveValue('solo');
  const solo = page.getByRole('region', { name: 'Actions for Solo worker' });
  // A clean checkout has nothing to snapshot, and a solo card never offers a relay or a peer.
  await expect(solo.getByRole('button', { name: 'Commit current changes Solo worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Relay / })).toHaveCount(0);
  await expect(solo.getByLabel('After send').locator('option')).toHaveText(['Nothing', 'Commit']);
  await expect(page.getByLabel('Automatic collaboration after the initial review')).toHaveCount(0);
  await page.getByLabel('Implementation branch').selectOption('stay'); await solo.getByLabel('Instruction for Solo worker').fill('Work once.');
  await solo.getByLabel('Ready for implementation').check(); await solo.getByRole('button', { name: 'Send Solo worker', exact: true }).click();
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
  const previews: { recipient?: string; taskBase?: string; base?: string; commitPending?: boolean }[] = [];
  await page.route('**/api/v1/implementation/preview', async (route) => {
    const input = route.request().postDataJSON(); previews.push(input);
    await route.fulfill({ json: { base: 'b'.repeat(40), baseSubject: 'Reviewed', head: input.head, since: 'recipient', commits: [{ sha: input.head, subject: 'Latest changes' }], candidates: [{ sha: 'b'.repeat(40), subject: 'Reviewed' }] } });
  });
  await openGroup(page, group); await editSettings(page); await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  const afterPolicy = previews.length;
  const claude = await openCard(page, 'Claude'); await expand(claude, 'Committed review');
  await expect(claude.getByText(/^Relay Claude: 1 commit after bbbbbb through aaaaaa — earliest: all since Claude's last commit · latest: last commit only\. Newest: Latest changes/)).toBeVisible();
  // Each card previews the range its own agent would review; Claude's card asks for Claude.
  expect(previews.filter((preview) => preview.recipient === 'claude').at(-1)).toMatchObject({ recipient: 'claude', taskBase: 'b'.repeat(40), commitPending: false });
  expect(previews.filter((preview) => preview.recipient === 'claude').at(-1)!.base).toBeUndefined();
  if (policy === 'worker_reviewer') expect(previews.slice(afterPolicy).some((preview) => preview.recipient === 'codex')).toBe(false); // the fixed worker never reviews
  const review = claude.getByRole('button', { name: 'Relay Claude', exact: true });
  await expect(review).toBeDisabled(); await expect(review).toHaveAttribute('title', /Confirm Ready/);
  await claude.getByLabel('Ready for implementation').check(); await review.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ kind: 'review', agentId: 'claude', policy, reviewBase: 'b'.repeat(40), branch: { head: 'a'.repeat(40) } });
});
test('an integration branch is a starting point only: no continue option, and the task-branch path is explained', async ({ page, request }) => {
  await snapshotAvailable(page);
  const group = await post(request, 'groups', { name: 'On main', members: ['codex', 'claude'] }); let payload: ImplementationStart | null = null;
  await page.route('**/api/v1/implementation', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group); await editSettings(page);
  const picker = page.getByLabel('Implementation branch', { exact: true });
  await expect(picker).toHaveValue(''); await expect(picker.locator('option[value="stay"]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toContainText('main is an integration branch');
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toContainText('separate squash merge or pull request');
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit');
  await expect(codex.getByRole('button', { name: 'Commit current changes Codex', exact: true })).toBeDisabled();
  await picker.selectOption('new'); await page.getByLabel('New branch name').fill('task/from-main');
  await codex.getByLabel('Ready for implementation').check(); await codex.getByRole('button', { name: 'Commit current changes Codex', exact: true }).click();
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
  await openController(page); await page.getByRole('button', { name: 'Pause the controller', exact: true }).click();
  await page.getByRole('button', { name: 'I checked every participant; give me control', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(Pause the controller|Take over from the controller…)$/ })).toHaveCount(0);
  await expect(warning).toHaveCount(0);
  await expect(pane(page, 'Claude').locator('.pane-status .state')).not.toHaveText('attention');
  expect(starts).toEqual([]); expect(resets).toEqual([]);
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/after-recovery');
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit');
  const send = codex.getByRole('button', { name: 'Commit current changes Codex', exact: true }); const ready = codex.getByLabel('Ready for implementation');
  await expect(send).toBeDisabled(); await expect(ready).not.toBeChecked();
  await ready.check();
  await page.screenshot({ path: info.outputPath('reconciled-peer-ready.png'), fullPage: true });
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ groupId: group.id, kind: 'commit', handoff: false, autoContinue: false, confirmReady: true, registrations: { claude: renewed } });
  expect(resets).toEqual([]);
  // Finish the post-send state/discovery refresh before teardown removes their route handlers.
  await expect(ready).toBeEnabled();
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
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/identity');
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit');
  const ready = codex.getByLabel('Ready for implementation'); const send = codex.getByRole('button', { name: 'Commit current changes Codex', exact: true });
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
    for (const workspace of data.workspaces) if (workspace.cwd === '/demo/project') workspace.git = { ...workspace.git, branch: 'task/existing', integration: false, taskBase, clean: false, changes: [{ status: 'MM', path: 'app.ts', originalPath: null }], changeCount: 1 };
    await route.fulfill({ json: data }); });
  await page.route('**/api/v1/implementation', async (route) => { payload = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group); await editSettings(page);
  await expect(page.getByLabel('Implementation branch', { exact: true })).toHaveValue('stay');
  await expect(page.getByLabel('Task baseline commit')).toHaveValue('c'.repeat(40));
  const codex = await openCard(page, 'Codex'); await handOff(codex, 'commit');
  const commit = codex.getByRole('button', { name: 'Commit current changes Codex', exact: true }); const ready = codex.getByLabel('Ready for implementation');
  await ready.check(); await commit.click();
  await expect.poll(() => payload).toMatchObject({ branch: { branch: 'task/existing', head: 'a'.repeat(40), taskBase: 'c'.repeat(40) } });
  // When no baseline can be inferred, relay waits for a full commit ID even after readiness is confirmed.
  taskBase = null; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await ready.check();
  await expect(page.getByLabel('Task baseline commit')).toHaveValue(''); await expect(commit).toBeDisabled();
  await page.getByLabel('Task baseline commit').fill('d'.repeat(40)); await ready.check();
  await expect(commit).toBeEnabled();
});
test('a changed branch tip invalidates the displayed readiness confirmation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Current group', members: ['codex', 'claude'] });
  let head = 'a'.repeat(40);
  await page.route('**/api/v1/workspaces', async (route) => { const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) workspace.git.head = head;
    await route.fulfill({ json: data }); });
  await openGroup(page, group); await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/tip-check');
  const codex = await openCard(page, 'Codex'); await codex.getByLabel('Instruction for Codex').fill('Check the tip.');
  const ready = codex.getByLabel('Ready for implementation'); const send = codex.getByRole('button', { name: 'Send Codex', exact: true });
  await ready.check(); await expect(send).toBeEnabled(); head = 'b'.repeat(40);
  await expect(ready).not.toBeChecked({ timeout: 10000 });
  await expect(send).toBeDisabled();
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
  // Choose the card before confirming anything: choosing a pane is a view switch that revokes readiness.
  const codex = await openCard(page, 'Codex');
  await page.getByRole('button', { name: phase === 'Plan' ? '1 · Plan' : '2 · Implementation', exact: true }).click();
  await editSettings(page);
  await page.getByLabel('Implementation branch', { exact: true }).selectOption('new');
  await page.getByLabel('New branch name').fill('task/clean-start');
  if (phase === 'Plan') await page.getByLabel('Shared task brief').fill('A scoped task.'); else await handOff(codex, 'commit');
  const ready = phase === 'Plan' ? page.getByLabel('Ready for planning') : codex.getByLabel('Ready for implementation');
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
  const start = phase === 'Plan' ? page.getByRole('button', { name: 'Start Plan', exact: true }) : codex.getByRole('button', { name: 'Commit current changes Codex', exact: true });
  await expect(start).toBeDisabled();
  if (phase === 'Implementation') {
    await ready.check(); await expect(start).toBeEnabled();
    // Dirty input never blocks an instruction: with text the same button does the work first, and a plain Send needs no branch at all.
    await codex.getByLabel('Instruction for Codex').fill('A scoped task.'); await ready.check();
    await expect(codex.getByRole('button', { name: 'Send & commit Codex', exact: true })).toBeEnabled();
    await codex.getByLabel('After send').selectOption('nothing'); await ready.check();
    await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
    await handOff(codex, 'commit_relay'); await ready.check();
    const relay = codex.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true });
    await expect(relay).toBeEnabled();
    await expect(relay).toHaveAttribute('title', /selected baseline through the new commit to Claude after validating/);
    await handOff(codex, 'commit');
  }
  await page.screenshot({ path: info.outputPath('dirty-workspace.png'), fullPage: true });
  // Returning to the same clean branch/head via polling cannot resurrect the old confirmation.
  dirty = false; await expect(page.locator('.context-bar')).toContainText('· clean', { timeout: 10000 });
  await expect(warning).toHaveCount(0);
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked();
  // A clean checkout has nothing to snapshot, so the Implementation card offers no Commit at all.
  if (phase === 'Plan') await expect(start).toBeDisabled(); else await expect(start).toHaveCount(0);
  await ready.check(); await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); expect(starts).toBe(0);
  if (phase === 'Implementation') { dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(start).toBeVisible(); }
  await ready.check(); await start.click(); await expect.poll(() => starts).toBe(1);
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  if (phase === 'Plan') await expect(warning).toBeVisible(); else await expect(warning).toHaveCount(0);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByLabel('Staging fallback', { exact: true }).check();
  await sections.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(page.getByLabel('Ready to send', { exact: true })).toBeEnabled(); expect(starts).toBe(1);
});
test('failed Git recheck blocks cached clean consent until a successful read and fresh confirmation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Read failure', members: ['codex', 'claude'] }); let failure = false;
  await page.route('**/api/v1/workspaces', async (route) => {
    if (failure) await route.fulfill({ status: 503, json: { error: { message: 'Workspace inspection unavailable' } } });
    else await route.continue();
  });
  await openGroup(page, group); await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/read-failure');
  const codex = await openCard(page, 'Codex'); await codex.getByLabel('Instruction for Codex').fill('Wait for reliable Git state.');
  const ready = codex.getByLabel('Ready for implementation'); await ready.check(); failure = true;
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeDisabled(); await expect(ready).not.toBeChecked(); await expect(page.getByRole('alert').filter({ hasText: 'Workspace inspection unavailable' })).toContainText('Recheck before starting');
  failure = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(ready).toBeEnabled(); await expect(ready).not.toBeChecked(); await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeDisabled();
});

test('plain Send ignores branch setup and automation; every action explains its commit behavior', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Button help', members: ['codex','claude'] });
  const sent: StandaloneStart[] = []; let commits = 0; let dirty = false;
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { clean: !dirty, changes: dirty ? [{ status: 'MM', path: 'app.ts', originalPath: null }] : [], changeCount: dirty ? 1 : 0 });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/instructions', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/implementation', async (route) => { commits++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const codex = await openCard(page, 'Codex');
  await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toHaveAttribute('title', /No automatic commit, branch change, or relay/);
  await codex.getByLabel('After send').selectOption('commit');
  await expect(codex.getByRole('button', { name: 'Send & commit Codex', exact: true })).toHaveAttribute('title', /publishes one handoff commit.*and stops/);
  await codex.getByLabel('After send').selectOption('commit_relay');
  await expect(codex.getByRole('button', { name: 'Send & commit Codex → relay Claude', exact: true })).toHaveAttribute('title', /relays that commit to Claude for review.*Claude reviews only what Codex commits/);
  await codex.getByLabel('After send').selectOption('nothing');
  const claude = await openCard(page, 'Claude'); await expand(claude, 'Committed review');
  await expect(claude.getByRole('button', { name: 'Relay Claude', exact: true })).toHaveAttribute('title', /every commit after the chosen baseline.*everything new to Claude/);
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await handOff(await openCard(page, 'Codex'), 'commit');
  await expect(codex.getByRole('button', { name: 'Commit current changes Codex', exact: true })).toHaveAttribute('title', /Commit current changes Codex:.*local handoff commit with Git hooks disabled/);
  await editSettings(page);
  await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await handOff(await openCard(page, 'Claude'), 'commit');
  await expect(claude.getByRole('button', { name: 'Commit current changes Claude', exact: true })).toHaveAttribute('title', /Commit current changes Claude:/);
  // The fixed reviewer's card only reviews: no Send and no snapshot of its own.
  await expect(page.getByRole('region', { name: 'Actions for Codex' }).getByRole('button', { name: /^Send / })).toHaveCount(0);
  dirty = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  const reviewer = await openCard(page, 'Codex'); await expand(reviewer, 'Committed review');
  await expect(reviewer.getByRole('button', { name: 'Relay Codex', exact: true })).toHaveAttribute('title', /reviewer reports without changing project content/);
  await page.getByLabel('Implementation branch').selectOption('new');
  await page.getByLabel('New branch name').fill('task/not-created-by-send');
  const worker = await openCard(page, 'Claude'); await worker.getByLabel('After send').selectOption('nothing');
  await worker.getByLabel('Instruction for Claude').fill('Explain this code.');
  await worker.getByLabel('Ready for implementation').check(); await worker.getByRole('button', { name: 'Send Claude', exact: true }).click();
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
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Make the requested edits without committing.');
  await codex.getByLabel('Ready for implementation').check();
  await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await openController(page); await expect(page.getByRole('button', { name: /^(Pause the controller|Take over from the controller…)$/ })).toBeVisible();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.locator('.context-bar')).toContainText('· 1 uncommitted');
  await expect(page.getByRole('region', { name: 'Uncommitted changes', exact: true })).toHaveCount(0);
  // Owned work has a contextual draft; starting a second assignment or changing follow-up is unavailable.
  const update = page.getByRole('region', { name: 'Input for Codex', exact: true });
  await update.getByLabel('Add detail for Codex').fill('Keep this draft while native acknowledgment is pending.');
  await expect(update.getByRole('button', { name: 'Send update to Codex' })).toBeDisabled();
  await expect(update.getByLabel('After send')).toHaveCount(0);
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
  await openGroup(page, group); await editSettings(page);
  await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  if (policy === 'worker_reviewer') await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  const peer = policy === 'peer' ? 'Claude' : 'Codex';
  const worker = policy === 'peer' ? 'codex' : 'claude';
  // On a clean checkout the peer's own card reviews committed work.
  const reviewer = await openCard(page, peer); await expand(reviewer, 'Committed review');
  await reviewer.getByLabel('Review baseline', { exact: true }).selectOption('c'.repeat(40));
  await expect(reviewer.getByText(new RegExp(`Relay ${peer}: 1 commit after cccccc`))).toBeVisible();
  await reviewer.getByLabel('Ready for implementation').check(); await expect(reviewer.getByRole('button', { name: `Relay ${peer}`, exact: true })).toBeEnabled();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(reviewer.getByLabel('Ready for implementation')).not.toBeChecked();
  // On a dirty checkout the worker's card snapshots the current changes, then relays them to the same peer.
  const author = await openCard(page, worker === 'codex' ? 'Codex' : 'Claude'); await handOff(author, 'commit_relay');
  const ready = author.getByLabel('Ready for implementation'); const baseline = author.getByLabel('Review baseline', { exact: true });
  const relay = author.getByRole('button', { name: `Commit current changes & relay ${peer}`, exact: true });
  await expect(relay).toBeVisible(); await expect(relay).toBeDisabled(); await expect(ready).not.toBeChecked();
  await expect(baseline).toHaveValue('b'.repeat(40));
  await baseline.selectOption('a'.repeat(40));
  await expect(author.getByText(new RegExp(`Relay ${peer}: 0 commits plus current changes after aaaaaa`))).toBeVisible();
  await ready.check(); await expect(relay).toBeEnabled();
  await baseline.selectOption('c'.repeat(40));
  await expect(author.getByText(new RegExp(`Relay ${peer}: 1 commit plus current changes after cccccc`))).toBeVisible();
  await expect(ready).not.toBeChecked();
  await editSettings(page); await expand(page, 'Collaboration settings');
  await page.getByLabel('Automatic collaboration after the initial review').uncheck();
  await ready.check(); await expect(relay).toBeEnabled();
  // A clean/dirty transition revokes snapshot consent before changing the action back to a committed-range review.
  dirty = false; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(relay).toHaveCount(0); await expect(ready).not.toBeChecked();
  await expect((await openCard(page, peer)).getByRole('button', { name: `Relay ${peer}`, exact: true })).toBeDisabled();
  dirty = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await openCard(page, worker === 'codex' ? 'Codex' : 'Claude');
  await expect(relay).toBeDisabled(); await expect(baseline).toHaveValue('c'.repeat(40));
  await expect(author.getByText(new RegExp(`Relay ${peer}: 1 commit plus current changes after cccccc`))).toBeVisible();
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
  await openGroup(page, group); await editSettings(page);
  await page.getByLabel('Collaboration', { exact: true }).selectOption(policy);
  if (policy === 'worker_reviewer') await page.getByLabel('Worker', { exact: true }).selectOption('codex');
  const codex = await openCard(page, 'Codex'); await codex.getByLabel('After send').selectOption('commit');
  // With an instruction the button does that work first; only an empty instruction hands the changes off as they stand.
  await codex.getByLabel('Instruction for Codex').fill('Implement retry support later.');
  await expect(codex.getByRole('button', { name: 'Send & commit Codex', exact: true })).toBeVisible();
  await handOff(codex, 'commit_relay'); await codex.getByLabel('Ready for implementation').check();
  await expect(page.getByRole('region', { name: 'Uncommitted changes', exact: true })).toHaveCount(0);
  await expect(codex.getByRole('button', { name: 'Commit current changes & relay Claude', exact: true })).toBeEnabled();
  await handOff(codex, 'commit'); await codex.getByLabel('Ready for implementation').check();
  const send = codex.getByRole('button', { name: 'Commit current changes Codex', exact: true });
  await expect(send).toHaveAttribute('title', /snapshot all staged, unstaged and nonignored untracked changes as they stand/);
  await send.click(); await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]!.text).toBeUndefined();
  expect(starts[0]).toMatchObject({ kind: 'commit', handoff: false, autoContinue: false, policy, branch: { branch: 'task/current' } });
});

test('owned composer sends literal input only to the acknowledged holder and checkpoints final release', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Input controls', members: ['codex','claude'] });
  await openGroup(page, group); const initial = await openCard(page, 'Codex');
  await initial.getByLabel('Instruction for Codex').fill('Explain the current task.');
  await initial.getByLabel('Ready for implementation').check(); await initial.getByRole('button', { name: 'Send Codex', exact: true }).click();
  const update = page.getByRole('region', { name: 'Input for Codex', exact: true });
  await update.getByLabel('Add detail for Codex').fill('Explain empty input.');
  await expect(update.getByRole('button', { name: 'Send update to Codex' })).toBeDisabled();
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  const run = state.runs.find((r) => r.status === 'running' && r.standalone)!;
  const turn = state.executions.find((e) => e.commandId === run.currentCommandId)!; const agent = run.participants.find((p) => p.id === turn.agentId)!;
  const lifecycle = { commandId: turn.commandId, source: agent.agentType, paneId: agent.identity.paneId, socketPath: agent.identity.socketPath, identity: agent.identity,
    sessionId: 'fixture-input', sourceTurnId: 'fixture-input-turn', prompt: turn.wireText, settled: true, backgroundState: 'clear' };
  await post(request, 'events', { ...lifecycle, event: 'turn_started' });
  const inspected = update.getByRole('checkbox', { name: /I inspected Codex/ }); await expect(inspected).toBeEnabled({ timeout: 8000 });
  await inspected.check(); await update.getByRole('button', { name: 'Send update to Codex' }).click();
  await expect(update.getByLabel('Add detail for Codex')).toHaveValue('');
  await expand(update, 'Terminal controls'); await update.getByLabel('Literal answer for Codex').fill('1');
  await inspected.check(); await update.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(update.getByLabel('Literal answer for Codex')).toHaveValue('');
  await inspected.check(); await update.getByRole('button', { name: 'Esc…', exact: true }).click();
  await expect(update.getByRole('button', { name: 'Send Escape', exact: true })).toBeVisible();
  await update.getByRole('button', { name: 'Cancel', exact: true }).click();
  const current: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  expect(current.interactions!.filter((r) => r.input.runId === run.id).map((r) => r.input.text)).toEqual(['Explain empty input.', '1']);
  await post(request, 'events', { ...lifecycle, event: 'turn_complete' }); await openController(page);
  const checkpoint = page.getByRole('region', { name: 'Input checkpoint' });
  await expect(checkpoint.getByRole('button', { name: 'Review input and continue' })).toBeDisabled();
  await checkpoint.getByRole('checkbox').check();
  await page.screenshot({ path: info.outputPath('input-checkpoint.png'), fullPage: true });
  await checkpoint.getByRole('button', { name: 'Review input and continue' }).click();
  await expect(page.getByRole('button', { name: 'Controller · idle', exact: true })).toBeVisible();
});
