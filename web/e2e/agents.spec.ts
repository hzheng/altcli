import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AttentionFeed, AttentionItem } from '../src/contracts/attention';
import { BACKGROUND_LIMITS, type BackgroundView } from '../src/contracts/background';
import type { WorkflowState, WorkspaceDiscovery } from '../src/contracts/workflow';
import { openAgents } from './ui';
const TOKEN = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${TOKEN}` };
const MAIN = { branch: 'main', head: 'a'.repeat(40) };
test.describe.configure({ mode: 'serial' });
async function state(request: APIRequestContext): Promise<WorkflowState> {
  const response = await request.get('/api/v1/state', { headers }); expect(response.ok()).toBe(true); return response.json();
}
async function post(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`/api/v1/${path}`, { headers, data }); expect(response.ok()).toBe(true); return response.json();
}
async function unlock(page: Page, path = '/') {
  await page.goto(path); await page.getByLabel('Host access token').fill(TOKEN); await page.getByRole('button', { name: 'Open console' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { pressed: true })).toHaveCount(1);
}
/** Every request the page sends except reads and the one acknowledgement under test. Navigation must add none. */
function effects(page: Page) {
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && !r.url().endsWith('/api/v1/attention') && !r.url().includes('/terminals')) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return sent;
}
test.beforeEach(async ({ request }) => {
  // Supported API operations only: end owned runs, then register the simulated main checkout's two agents.
  const current = await state(request);
  for (const run of current.runs.filter((r) => ['running', 'waiting', 'paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const repository of [...new Set(current.sessions.map((s) => s.repository))]) await post(request, 'workspaces/reset', { repository, confirmReady: true });
  await post(request, 'sessions', { paneId: '%0', label: 'Codex' }); await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
});

test('a run paused on unknown background work becomes one Attention item; Mark seen and Open change no run', async ({ page, request }) => {
  const group = (await state(request)).groups.find((g) => g.cwd === '/demo/project')!;
  const requestId = crypto.randomUUID();
  await post(request, 'commands', { requestId, agentId: 'claude', kind: 'relay', confirmReady: true, pairId: group.id, stage: MAIN });
  const current = await state(request), run = current.runs.find((r) => r.id === requestId)!, session = current.sessions.find((s) => s.id === 'claude')!;
  const lifecycle = { source: 'claude', commandId: run.currentCommandId, paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: session.identity,
    sessionId: 'attention-claude', sourceTurnId: `turn-${run.currentCommandId}`, prompt: current.executions.find((e) => e.commandId === run.currentCommandId)!.wireText,
    settled: true, backgroundState: 'unknown' };
  await post(request, 'events', { ...lifecycle, event: 'turn_started' });
  await post(request, 'events', { ...lifecycle, event: 'turn_complete', outcome: 'accept_and_improve' });
  const feed = (await state(request)).attention!;
  const item = feed.items.find((i) => i.subject.type === 'run' && i.subject.runId === requestId)!;
  expect([item.kind, item.facets, item.revision, item.seenRevision]).toEqual(['run', ['paused'], 1, null]);
  expect(feed.items.filter((i) => i.key === item.key)).toHaveLength(1);

  await unlock(page); const sent = effects(page);
  const discovery = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  const other = discovery.projects!.find(p => p.name === 'other')!;
  await page.getByRole('combobox', { name: 'Switch project' }).selectOption(other.id);
  await expect(page.locator('.context-bar')).toContainText('/demo/other');
  // The heading entry, on every tab, counts items not yet seen and opens the list.
  const entry = page.locator('.page-heading').getByRole('button', { name: /^Attention · \d+ not seen$/ });
  await expect(entry).toBeVisible(); await entry.click();
  await expect(page.getByRole('navigation', { name: 'Agent kinds' }).getByRole('button', { name: /^Background assistant/ })).toHaveAttribute('aria-pressed', 'true');
  const list = page.getByRole('region', { name: 'Attention', exact: true });
  const card = list.getByRole('listitem').filter({ hasText: 'Paused run needs inspection · Stage relay' });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Completion or background-work state is unknown; inspect the workers.');
  await expect(card).toContainText('Codex ⇄ Claude');
  await card.getByRole('button', { name: 'Mark seen', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Mark seen', exact: true })).toHaveCount(0);
  const seen = (await state(request)).attention!.items.find((i) => i.id === item.id)!;
  expect(seen.seenRevision).toBe(1);
  // Open shows the existing control for that checkout and nothing else.
  await card.getByRole('button', { name: 'Open Control access', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Control access', exact: true })).toBeVisible();
  await expect(page.locator('.access-scope')).toContainText('/demo/project');
  await expect(page.getByRole('heading', { name: /^Controller paused/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Switch project' }).selectOption(other.id);
  await expect(page.getByRole('region', { name: 'Control access', exact: true })).toBeHidden();
  expect(sent).toEqual([]);
  expect((await state(request)).runs.find((r) => r.id === requestId)!.status).toBe('paused');
  // Taking control resolves the item with a truthful disposition; it is kept in recent history, not reopened.
  await post(request, 'runs', { runId: requestId, action: 'takeover', confirmReady: true });
  const after = (await state(request)).attention!;
  expect(after.items.some((i) => i.id === item.id)).toBe(false);
  expect(after.recent.find((i) => i.id === item.id)!.resolution).toBe('Control returned to you. Taking control neither stops an agent nor proves its work settled.');
});

function fixtureItem(more: Partial<AttentionItem>): AttentionItem {
  return { id: crypto.randomUUID(), key: `launch:${crypto.randomUUID()}`, kind: 'launch', facets: ['start_uncertain'], title: 'Launch needs inspection · codex-main',
    subject: { type: 'launch', launchId: 'l', projectId: 'p', worktreeId: 'w', repository: '/demo/project', sessionName: 'codex-main', profileLabel: 'Codex' },
    detail: 'Host restarted during startup. Inspect the original instance; nothing was retried.', destination: { surface: 'launch', projectId: 'p', worktreeId: 'w', repository: '/demo/project', launchId: 'l' },
    revision: 1, sourceVersion: 1, status: 'open', openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolvedAt: null, resolution: null,
    seenRevision: null, stale: false, ...more };
}
test('launch and Helper items open their own surfaces; Show all pages through every open item', async ({ page, request }) => {
  // Browser-only fixture of the attention feed; the server's derivation and paging have node coverage.
  const discovery = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  const project = discovery.projects!.find((p) => p.worktrees.some((w) => w.path === '/demo/project'))!, tree = project.worktrees.find((w) => w.path === '/demo/project')!;
  const launch = fixtureItem({ destination: { surface: 'launch', projectId: project.id, worktreeId: tree.id, repository: tree.path, launchId: 'l' } });
  const helper = fixtureItem({ key: 'helper:h', title: 'Helper start needs inspection', facets: ['start_uncertain'], subject: { type: 'helper', instanceId: 'h', sessionName: 'altcli-global-h', profileLabel: 'Helper' },
    destination: { surface: 'helper-session', instanceId: 'h' } });
  const extra = Array.from({ length: 22 }, (_, i) => fixtureItem({ title: `Launch needs inspection · fixture-${i}` }));
  const feed: AttentionFeed = { open: 24, unseen: 24, items: [launch, helper, ...extra.slice(0, 18)], recent: [], truncated: true, revision: 'r1', observedAt: new Date().toISOString() };
  await page.route('**/api/v1/state', async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), attention: feed } }); });
  const pages: string[] = [];
  await page.route((url) => url.pathname === '/api/v1/attention' && url.searchParams.has('status'), async (route) => {
    const url = new URL(route.request().url()); pages.push(url.search);
    await route.fulfill({ json: url.searchParams.get('cursor') ? { items: extra.slice(10), next: null, revision: 'r1', observedAt: feed.observedAt }
      : { items: [launch, helper, ...extra.slice(0, 10)], next: 'cursor-2', revision: 'r1', observedAt: feed.observedAt } });
  });
  await unlock(page); const sent = effects(page);
  await openAgents(page, 'Background assistant', 'Attention');
  const list = page.getByRole('region', { name: 'Attention', exact: true });
  await expect(list.getByRole('list', { name: 'Open attention items' }).getByRole('listitem')).toHaveCount(20);
  await list.getByRole('button', { name: 'Show all 24 open items', exact: true }).click();
  await expect(list.getByRole('list', { name: 'Open attention items' }).getByRole('listitem')).toHaveCount(24);
  expect(pages).toEqual(['?status=open', '?status=open&cursor=cursor-2']);
  await list.getByRole('listitem').filter({ hasText: 'Helper start needs inspection' }).getByRole('button', { name: 'Open Helper session', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Agent kinds' }).getByRole('button', { name: 'Helper', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Helper sections' }).getByRole('button', { name: 'Session', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await openAgents(page, 'Background assistant', 'Attention');
  await list.getByRole('listitem').filter({ hasText: 'Launch needs inspection · codex-main' }).getByRole('button', { name: 'Open launch card', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const revealed = page.locator(`[id="worktree-${tree.id}"]`);
  await expect(revealed.locator('details')).toHaveAttribute('open', '');
  await expect(revealed.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(sent).toEqual([]);
});
test('Show all follows the feed: another browser\'s Mark seen, a new revision, a change while paging, and resolution', async ({ page }) => {
  // Browser-only fixture whose feed and pages change under the open list; the server's revision has node coverage.
  let items = Array.from({ length: 24 }, (_, i) => fixtureItem({ title: `Launch needs inspection · item-${i}` }));
  let revision = 'r1', changeBeforePage2: string | null = null;
  const observedAt = new Date().toISOString();
  const feed = (): AttentionFeed => ({ open: items.length, unseen: items.filter((i) => i.seenRevision !== i.revision).length, items: items.slice(0, 20), recent: [],
    truncated: items.length > 20, revision, observedAt });
  await page.route('**/api/v1/state', async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: { ...(await response.json()), attention: feed() } }); });
  const reads: string[] = [];
  await page.route((url) => url.pathname === '/api/v1/attention' && url.searchParams.has('status'), async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor'); reads.push(cursor ?? 'first');
    // The open set changes after the first page was read.
    if (cursor && changeBeforePage2) { revision = changeBeforePage2; changeBeforePage2 = null; }
    await route.fulfill({ json: cursor ? { items: items.slice(12), next: null, revision, observedAt } : { items: items.slice(0, 12), next: 'page-2', revision, observedAt } });
  });
  await unlock(page); await openAgents(page, 'Background assistant', 'Attention');
  const list = page.getByRole('region', { name: 'Attention', exact: true }), cards = list.getByRole('list', { name: 'Open attention items' }).getByRole('listitem');
  await list.getByRole('button', { name: 'Show all 24 open items', exact: true }).click();
  await expect(cards).toHaveCount(24);
  // Another browser marks an item beyond the newest 20 seen: the copy is read again and its Mark seen goes away.
  items[23] = { ...items[23]!, seenRevision: 1 }; revision = 'r2';
  await expect(cards.filter({ hasText: 'item-23' }).getByRole('button', { name: 'Mark seen' })).toHaveCount(0);
  await expect(cards).toHaveCount(24);
  // A new revision beyond the newest 20 replaces the old text instead of showing both.
  items[22] = { ...items[22]!, title: 'Cleanup needs inspection · item-22', revision: 2 }; revision = 'r3';
  await expect(cards.filter({ hasText: 'Cleanup needs inspection · item-22' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Launch needs inspection · item-22' })).toHaveCount(0);
  // Pages that disagree were read across a change: the read starts again and never mixes the two states.
  reads.length = 0; items[21] = { ...items[21]!, title: 'Launch needs inspection · item-21 revised', revision: 2 }; revision = 'r4'; changeBeforePage2 = 'r5';
  await expect.poll(() => reads.slice(0, 3)).toEqual(['first', 'page-2', 'first']);
  await expect(cards.filter({ hasText: 'item-21 revised' })).toHaveCount(1);
  await expect(cards).toHaveCount(24);
  // Once every item resolves, nothing from the old copy stays on screen.
  items = []; revision = 'r6';
  await expect(list).toContainText('Nothing needs attention.'); await expect(cards).toHaveCount(0);
  await expect(list.getByRole('button', { name: /^Show / })).toHaveCount(0);
});
test('Agents holds three kinds with their own profiles; a Background profile stays out of agent and Helper lists', async ({ page, request }) => {
  const list = async () => (await (await request.get('/api/v1/launch-profiles', { headers })).json()) as { id: string; label: string; revision: number; purpose: string; args: string[] }[];
  try {
    await unlock(page);
    await openAgents(page, 'Workspace agents', 'Inventory');
    const inventory = page.getByRole('region', { name: 'Workspace agent inventory' });
    await expect(inventory.getByRole('list', { name: 'Agents in the selected checkout' }).getByRole('listitem')).toHaveCount(2);
    await inventory.getByRole('button', { name: 'Show Claude in Console', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await openAgents(page, 'Background assistant');
    await expect(page.getByRole('navigation', { name: 'Background assistant sections' }).getByRole('button')).toHaveText(['Attention', 'Activity', 'Log', 'Profiles', 'Settings']);
    await page.getByRole('navigation', { name: 'Background assistant sections' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Background assistant settings' })).toContainText('Background uses its own private tmux session');
    await expect(page.getByRole('button', { name: 'Preview enablement', exact: true })).toBeDisabled();
    await page.getByRole('navigation', { name: 'Background assistant sections' }).getByRole('button', { name: 'Profiles', exact: true }).click();
    const profiles = page.getByRole('region', { name: 'Background assistant profiles' });
    // Only the adapter that is the first to be verified is offered; Codex is named as not yet verified.
    await expect(profiles.getByRole('combobox', { name: 'CLI', exact: true }).locator('option')).toHaveText(['Claude Code']);
    await expect(profiles.getByLabel('Name', { exact: true })).toHaveValue('Background');
    await profiles.getByLabel('Model', { exact: true }).fill('sonnet'); await profiles.getByLabel('Reasoning effort').selectOption('high');
    await expect(profiles.getByLabel('Background command preview')).toHaveText(JSON.stringify(['claude', '--model', 'sonnet', '--effort', 'high'], null, 2));
    await profiles.getByRole('button', { name: 'Create Background profile', exact: true }).click();
    await expect(profiles.getByRole('status')).toContainText('nothing was launched or enabled');
    const saved = (await list()).find((p) => p.purpose === 'background')!;
    expect([saved.label, saved.args]).toEqual(['Background', ['--model', 'sonnet', '--effort', 'high']]);
    // Agent launch profiles and Helper list only their own purposes.
    await openAgents(page, 'Workspace agents', 'Profiles');
    await expect(page.getByRole('region', { name: 'Launch profiles' }).getByRole('group', { name: 'Saved profiles' }).getByRole('button', { name: 'Background', exact: true })).toHaveCount(0);
    await openAgents(page, 'Helper', 'Chat');
    await expect(page.getByLabel('Helper launch profile').locator('option', { hasText: 'Background' })).toHaveCount(0);
  } finally {
    for (const p of (await list()).filter((p) => p.purpose === 'background')) await request.delete(`/api/v1/launch-profiles/${p.id}`, { headers, data: { expectedRevision: p.revision } });
  }
});

test('Background enablement requires its exact preview and acknowledgement; viewing and switching tabs never enables it', async ({ page }) => {
  const profile = { id: 'background-fixture', revision: 1, purpose: 'background' as const, label: 'Incident analyst', executable: 'claude', args: ['--model', 'haiku'], adapterHint: 'claude' as const, enabled: true };
  const view: BackgroundView = { settings: { revision: 0, enabled: false, paused: false, needsInspection: false, failures: 0, instance: null, message: 'Background is disabled.' },
    profiles: [profile], attempts: [], explanations: [], available: true, limits: BACKGROUND_LIMITS, pending: 0 };
  const posts: string[] = [], id = crypto.randomUUID();
  await page.route('**/api/v1/background', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: view }); return; }
    const body = route.request().postDataJSON(); posts.push(body.action);
    if (body.action === 'preview') await route.fulfill({ json: { id, digest: 'bound-preview', profile, executable: '/installed/claude', args: profile.args,
      directory: '/private/background', sessionName: `altcli-background-${id}`, providerVersion: 'fixture', expiresAt: new Date(Date.now() + 120000).toISOString(),
      limits: BACKGROUND_LIMITS, disclosure: 'This fixture shares only scoped issue evidence with the selected provider.' } });
    else { expect(body).toMatchObject({ action: 'enable', id, digest: 'bound-preview', confirm: true }); view.settings.enabled = true; view.settings.message = 'Enabled; waiting for an eligible issue.'; await route.fulfill({ json: view }); }
  });
  await unlock(page); await openAgents(page, 'Background assistant', 'Settings');
  const settings = page.getByRole('region', { name: 'Background assistant settings' });
  await expect(settings.getByRole('button', { name: 'Preview enablement' })).toBeEnabled();
  expect(posts).toEqual([]);
  await settings.getByRole('button', { name: 'Preview enablement' }).click();
  await expect(settings.getByRole('button', { name: 'Enable Background', exact: true })).toBeDisabled();
  await settings.getByRole('checkbox', { name: /I confirm this profile/ }).check();
  await settings.getByRole('button', { name: 'Enable Background', exact: true }).click();
  await expect(settings).toContainText('Enabled; waiting for an eligible issue.'); expect(posts).toEqual(['preview', 'enable']);
  await openAgents(page, 'Background assistant', 'Activity'); await expect(page.getByRole('region', { name: 'Background activity' })).toContainText('No Background jobs have run.');
  expect(posts).toEqual(['preview', 'enable']);
});

test('Background explanation is plain text and disappears on semantic supersession even before its own poll refreshes', async ({ page }) => {
  const item = fixtureItem({ kind: 'run', title: 'Synthetic uncertainty' });
  const feed: AttentionFeed = { open: 1, unseen: 1, items: [item], recent: [], truncated: false, revision: 'v1', observedAt: new Date().toISOString() };
  await page.route('**/api/v1/state', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), attention: feed } }); });
  await page.route('**/api/v1/background', route => route.fulfill({ json: { settings: { enabled: true }, attempts: [], profiles: [],
    explanations: [{ id: 'attempt', itemId: item.id, itemRevision: 1, sourceVersion: 1, model: 'fixture', assessment: { summary: '<script>fixture</script>',
      likelyCause: 'A receipt is absent.', nextSteps: ['Inspect the original delivery.'], uncertainties: ['It may have run.'], evidence: [{ id: 'e', source: 'fixture', revision: 'r', note: 'Recorded receipt.' }] } }],
    available: true, pending: 0, limits: BACKGROUND_LIMITS } }));
  await unlock(page); await openAgents(page, 'Background assistant', 'Attention');
  await expect(page.getByRole('heading', { name: 'Background explanation' })).toBeVisible();
  await expect(page.getByText('<script>fixture</script>', { exact: true })).toBeVisible();
  expect(await page.locator('.background-assessment script').count()).toBe(0);
  item.sourceVersion = 3; feed.revision = 'v3';
  await expect(page.getByRole('heading', { name: 'Background explanation' })).toHaveCount(0);
  await expect(page.getByText('Synthetic uncertainty', { exact: true })).toBeVisible();
});

test('Background Log requires exact confirmation, renders requests as text, and navigation never approves', async ({ page }) => {
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const action = { id, requestKey: 'fixture', digest: 'exact-request', attemptId: 'job', instanceId: 'instance', enablement: 1, itemId: 'issue', itemRevision: 1, sourceVersion: 1, policyRevision: 0,
    operation: { kind: 'command', directory: '/synthetic', executable: '/bin/echo', args: ['<script>fixture</script>'] }, reason: 'Write the requested fixture output.', risk: false,
    status: 'pending', createdAt: now, expiresAt: new Date(Date.now() + 1800000).toISOString(), updatedAt: now, authorization: null, pid: null, result: null, message: 'Waiting for confirmation.' };
  const view = { permissions: { revision: 0, app: 'ask', command: 'ask', risk: 'ask' }, actions: [action], entries: [] as unknown[], next: null };
  const posts: unknown[] = [];
  await page.route('**/api/v1/background/actions', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: view }); return; }
    const body = route.request().postDataJSON(); posts.push(body);
    expect(body).toEqual({ action: 'approve', id, digest: 'exact-request', confirm: true });
    view.actions = []; view.entries = [{ id: 1, at: now, actor: 'owner', kind: 'running', actionId: id, attemptId: 'job', message: 'You approved this exact action.', detail: { operation: action.operation } }];
    await route.fulfill({ json: { ...action, status: 'running' } });
  });
  await unlock(page); await openAgents(page, 'Background assistant', 'Log');
  const log = page.getByRole('region', { name: 'Background action log' });
  await expect(log.getByRole('button', { name: 'Approve and run' })).toBeDisabled();
  await expect(log.getByLabel('Exact requested action')).toContainText('<script>fixture</script>');
  expect(await log.locator('script').count()).toBe(0);
  await openAgents(page, 'Background assistant', 'Activity'); await openAgents(page, 'Background assistant', 'Log');
  expect(posts).toEqual([]);
  await log.getByRole('checkbox', { name: /I reviewed this exact request/ }).check();
  await log.getByRole('button', { name: 'Approve and run' }).click();
  await expect(log).toContainText('You approved this exact action.'); expect(posts).toHaveLength(1);
  await expect(log.getByRole('button', { name: 'Approve and run' })).toHaveCount(0);
});

test('Background permissions need an explicit save and acknowledgement; another client invalidates the draft', async ({ page }) => {
  const view = { permissions: { revision: 0, app: 'ask', command: 'ask', risk: 'ask' }, actions: [], entries: [], next: null };
  const posts: unknown[] = [];
  await page.route('**/api/v1/background/actions', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: view }); return; }
    const body = route.request().postDataJSON(); posts.push(body);
    expect(body).toMatchObject({ action: 'permissions', expectedRevision: 0, app: 'ask', command: 'allow', risk: 'ask', confirm: true });
    view.permissions = { revision: 1, app: 'ask', command: 'allow', risk: 'ask' }; await route.fulfill({ json: view.permissions });
  });
  await unlock(page); await openAgents(page, 'Background assistant', 'Settings');
  const settings = page.getByRole('region', { name: 'Background action permissions' });
  await expect(settings.getByRole('combobox', { name: 'Host commands and file changes', exact: true })).toHaveValue('ask');
  await settings.getByRole('combobox', { name: 'Host commands and file changes', exact: true }).selectOption('allow');
  await expect(settings.getByRole('button', { name: 'Save action permissions' })).toBeDisabled(); expect(posts).toEqual([]);
  await settings.getByRole('checkbox', { name: /I authorize these permissions/ }).check();
  await settings.getByRole('button', { name: 'Save action permissions' }).click();
  await expect(settings.getByRole('status')).toContainText('Saved action permissions.'); expect(posts).toHaveLength(1);
  await settings.getByRole('combobox', { name: 'App actions', exact: true }).selectOption('allow');
  view.permissions = { ...view.permissions, revision: 2, command: 'ask' };
  await expect(settings).toContainText('Permissions changed in another client.');
  await expect(settings.getByRole('button', { name: 'Save action permissions' })).toBeDisabled(); expect(posts).toHaveLength(1);
});
