import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WorkflowState, HookEvent, WorkspaceDiscovery } from '../src/contracts/workflow';
import { observationTransport, expandAgents, expandWorktree, editSettings, expand, openCard, openController, pane, readiness, openAccess, takeControl, showSurface, backToControl } from './ui';
const TOKEN = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${TOKEN}` };
test.describe.configure({ mode: 'serial' });
async function state(request: APIRequestContext): Promise<WorkflowState> {
  const response = await request.get('/api/v1/state', { headers }); expect(response.ok()).toBe(true); return response.json();
}
/** The simulated main checkout's branch and commit, which every Stage relay start confirms. */
const MAIN = { branch: 'main', head: 'a'.repeat(40) };
async function post(request: APIRequestContext, path: string, data: object) {
  // Stage relay runs as the main checkout's two-member group unless a test names another pair.
  const body = path === 'commands' ? { stage: MAIN, ...data, pairId: (data as { pairId?: string }).pairId ?? (await state(request)).groups.find((g) => g.cwd === '/demo/project')!.id } : data;
  const response = await request.post(`/api/v1/${path}`, { headers, data: body }); expect(response.ok()).toBe(true); return response.json();
}
/** Plain Send on an agent's current group: the only way to start work on a task branch such as /demo/other without branch setup. */
async function instruct(request: APIRequestContext, agentId: string, text: string, requestId: string = crypto.randomUUID()) {
  const current = await state(request); const group = current.groups.find((g) => g.members.includes(agentId))!;
  return post(request, 'instructions', { requestId, groupId: group.id, groupRevision: group.revision, agentId, policy: group.members.length === 1 ? 'solo' : 'peer', text, confirmReady: true,
    registrations: Object.fromEntries(group.members.map((id) => [id, current.sessions.find((s) => s.id === id)!.registrationId])) });
}
async function unlock(page: Page, token = TOKEN, useFallback = true) {
  await page.goto('/'); await page.getByLabel('Host access token').fill(token); await page.getByRole('button', { name: 'Open console' }).click();
  // This suite preserves the frozen staging behavior, now offered as Stage relay on the simulated main checkout.
  if (token === TOKEN) {
    await expect(page.getByRole('heading', { name: /Agent console|Projects and agents/, exact: true })).toBeVisible();
    // The heading renders before the first state response selects a view.
    await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { pressed: true })).toHaveCount(1);
    if (useFallback && await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).getAttribute('aria-pressed') === 'true') {
      // Stage relay is Control's default on main, which shares the frame with the terminals outside Plan. Discovery can arrive after the first state.
      await showSurface(page, 'Control'); await expect(page.getByRole('region', { name: 'Stage relay', exact: true })).toBeVisible();
    }
  }
}
async function openTab(page: Page, name: 'Console' | 'Projects' | 'Helper' | 'Settings') { await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true }).click(); }
async function editWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: `Project ${name}`, exact: true }).click();
  await expandWorktree(page, name); await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await openTab(page, 'Projects'); await expandAgents(page, name);
}
const workspace = (page: Page, name: string) => page.getByRole('region', { name: `Workspace ${name}`, exact: true });
async function complete(request: APIRequestContext, commandId: string, outcome = 'accept_and_improve', reason?: string) {
  const current = await state(request); const execution = current.executions.find((e) => e.commandId === commandId)!;
  const session = current.sessions.find((s) => s.id === execution.agentId)!;
  const event = { source: session.agentType, paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: session.identity,
    prompt: execution.wireText, sessionId: `test-${session.id}`, sourceTurnId: `turn-${commandId}`, commandId, settled: true, backgroundState: 'clear', outcome, ...(reason ? { reason } : {}) };
  if (session.agentType === 'claude') await post(request, 'events', { ...event, event: 'turn_started' });
  return post(request, 'events', { ...event, event: 'turn_complete' });
}
test.beforeEach(async ({ request }) => {
  // Reset through supported API operations only. These are normalized evidence fixtures, not real CLI payloads.
  const current = await state(request);
  for (const run of current.runs.filter((r) => ['running', 'waiting', 'paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const repository of [...new Set(current.sessions.map((session) => session.repository))]) await post(request, 'workspaces/reset', { repository, confirmReady: true });
  await post(request, 'sessions', { paneId: '%0', label: 'Codex' });
  const { session } = await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
  expect((await request.patch('/api/v1/sessions/claude', { headers, data: { label: 'Claude Code', expectedLabel: 'Claude', expectedRegistrationId: session.registrationId } })).ok()).toBe(true);
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
test('Clear context confirms the exact agent, sends a bare native command, and creates no run', async ({ page, request }, info) => {
  await unlock(page, TOKEN, false); await showSurface(page, 'Terminal');
  const card = pane(page, 'Codex'), clear = card.getByRole('button', { name: 'Clear context…', exact: true });
  const before = await state(request), commands = before.commands.length;
  await clear.click();
  const confirmation = card.getByRole('region', { name: 'Clear context for Codex', exact: true });
  await expect(confirmation).toContainText('/clear'); await expect(confirmation).toContainText('/demo/project');
  await page.screenshot({ path: info.outputPath('clear-context.png'), fullPage: true });
  expect((await state(request)).commands.length).toBe(commands);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(confirmation).toHaveCount(0);
  await clear.click(); await showSurface(page, 'Control'); await showSurface(page, 'Terminal'); await expect(confirmation).toHaveCount(0);
  await clear.click(); await confirmation.getByRole('button', { name: 'Clear Codex context', exact: true }).click();
  await expect(card.getByRole('status').filter({ hasText: '/clear sent to Codex' })).toBeVisible();
  const after = await state(request), fresh = after.commands.filter(c => !before.commands.some(old => old.id === c.id));
  expect(fresh).toHaveLength(1); expect(fresh[0]).toMatchObject({ agentId: 'codex', text: '/clear', status: 'delivered', handoff: false });
  expect(after.runs).toEqual(before.runs); expect(after.reservations).toEqual([]);
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Claude Code', exact: true }).click();
  const claude = pane(page, 'Claude Code'); await claude.getByRole('button', { name: 'Clear context…', exact: true }).click();
  await expect(claude.getByRole('region', { name: 'Clear context for Claude Code', exact: true })).toContainText('/clear');
  await claude.getByRole('button', { name: 'Clear Claude Code context', exact: true }).click();
  await expect.poll(async () => (await state(request)).commands[0]?.text).toBe('/clear');
});
test('Clear context is blocked by ownership and working activity; an uncertain response is never resent', async ({ page, request }) => {
  await unlock(page, TOKEN, false); await showSurface(page, 'Terminal');
  const card = pane(page, 'Codex'), clear = card.getByRole('button', { name: 'Clear context…', exact: true });
  const record = await post(request, 'commands', { requestId: crypto.randomUUID(), agentId: 'codex', kind: 'relay', confirmReady: true });
  await expect(clear).toBeDisabled(); await expect(card.locator('.clear-context')).toContainText('take control');
  await post(request, 'runs', { runId: record.id, action: 'takeover', confirmReady: true }); await expect(clear).toBeEnabled();
  await page.route('**/api/v1/state', async route => {
    const response = await route.fetch(), body = await response.json();
    body.activities = body.activities.map((a: { agentId: string }) => a.agentId === 'codex' ? { ...a, state: 'working' } : a);
    await route.fulfill({ response, json: body });
  });
  await expect(clear).toBeDisabled(); await expect(card.locator('.clear-context')).toContainText('Wait for this agent');
  await page.unroute('**/api/v1/state'); await expect(clear).toBeEnabled();
  let sends = 0;
  await page.route('**/api/v1/sessions/clear-context', async route => { sends++; await route.abort('failed'); });
  await clear.click(); await card.getByRole('button', { name: 'Clear Codex context', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'uncertain HTTP result' })).toBeVisible(); await expect(clear).toBeDisabled();
  await showSurface(page, 'Control'); await showSurface(page, 'Terminal'); expect(sends).toBe(1);
});
test('Console switches projects and worktrees without writes, keeps drafts and revokes readiness', async ({ page, request }, info) => {
  const inventory = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  const project = inventory.projects!.find(p => p.name === 'project')!, other = inventory.projects!.find(p => p.name === 'other')!;
  const main = project.worktrees[0]!;
  const linked = { ...main, id: 'empty-linked', path: '/demo/tasks/a-long-feature-branch-name', branch: 'feature/a-long-feature-branch-name', main: false, identity: null };
  project.worktrees = [linked, main];
  const otherAgentTree = { ...other.worktrees[0]!, main: false };
  other.worktrees = [{ ...otherAgentTree, id: 'empty-main', path: '/demo/other-main', main: true, identity: null }, otherAgentTree];
  inventory.projects!.push({ ...project, id: 'empty-project', name: 'empty', worktrees: [{ ...linked, id: 'empty-tree', path: '/demo/empty' }] });
  const shell = inventory.workspaces.find(w => w.worktree.root === '/demo/other')!;
  inventory.workspaces.push({ ...shell, cwd: '/demo/empty', worktree: { ...shell.worktree, root: '/demo/empty' }, agents: shell.agents.filter(a => a.kind === 'shell') });
  await page.route('**/api/v1/workspaces', route => route.fulfill({ json: inventory }));
  await unlock(page, TOKEN, false);
  const context = page.locator('.context-bar'), projects = context.getByRole('combobox', { name: 'Switch project' }), trees = context.getByRole('combobox', { name: 'Switch worktree' });
  await expect(projects).toHaveValue(project.id); await expect(trees).toHaveValue(main.id);
  await expect(trees.locator('option').first()).toContainText('Main checkout');
  // The branch is shown to the right of the selector, so its options name each checkout by path only.
  await expect(trees.locator('option')).toHaveText([`Main checkout · ${main.path}`, linked.path]);
  await expect(context).toContainText('Branch main');
  await expect(projects.getByRole('option', { name: 'empty — no agents', exact: true })).toHaveAttribute('disabled');
  const card = await openCard(page, 'Codex'); await card.getByLabel('Instruction for Codex').fill('Keep this project draft');
  await (await readiness(page)).check();
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  await trees.selectOption(linked.id);
  await expect(context).toContainText(linked.path); await expect(page.getByRole('heading', { name: 'No eligible agents here yet' })).toBeVisible();
  await expect(page.getByLabel('Instruction for Codex')).toHaveCount(0);
  expect(await context.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await context.screenshot({ path: info.outputPath('console-worktree-switches.png') });
  await projects.selectOption(other.id); await expect(trees).toHaveValue(otherAgentTree.id);
  await expect(trees.locator('option')).toHaveCount(other.worktrees.length); await expect(context).toContainText('/demo/other');
  await projects.selectOption(project.id); await expect(trees).toHaveValue(main.id);
  await expect(card.getByLabel('Instruction for Codex')).toHaveValue('Keep this project draft');
  await expect((await readiness(page))).not.toBeChecked(); expect(writes).toEqual([]);
  expect((await state(request)).manualSessions??[]).toEqual([]);
  await page.reload(); await page.getByLabel('Host access token').fill(TOKEN); await page.getByRole('button', { name: 'Open console' }).click();
  await expect(trees).toHaveValue(main.id);
});
test('Console keeps the project when the selected worktree disappears, including after reload', async ({ page, request }) => {
  const inventory = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  const project = inventory.projects!.find(p => p.name === 'project')!, main = project.worktrees[0]!;
  const linked = { ...main, id: 'layout-tree', path: '/demo/tasks/layout', branch: 'feature/layout', main: false, identity: null };
  project.worktrees.push(linked);
  await page.route('**/api/v1/workspaces', route => route.fulfill({ json: inventory }));
  await unlock(page, TOKEN, false);
  const projects = page.getByRole('combobox', { name: 'Switch project' }), trees = page.getByRole('combobox', { name: 'Switch worktree' });
  await trees.selectOption(linked.id);
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  // No retained operation record: the browser must remember the canonical project independently of the worktree path.
  project.worktrees = [main];
  await page.locator('.context-bar').getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(projects).toHaveValue(project.id); await expect(trees).toHaveValue('');
  await expect(page.locator('.empty-console')).toContainText('This worktree is no longer available. Choose another worktree in project.');
  await expect(page.locator('.empty-console')).not.toContainText('Start coding CLIs in');
  await page.reload(); await page.getByLabel('Host access token').fill(TOKEN); await page.getByRole('button', { name: 'Open console' }).click();
  await expect(projects).toHaveValue(project.id); await expect(trees).toHaveValue('');
  await trees.selectOption(main.id); await expect(page.locator('.context-bar')).toContainText(main.path);
  expect(writes).toEqual([]);
});
for (const operation of ['discard', 'removal'] as const) test(`Console recovers an older saved selection from its retained ${operation} record`, async ({ page, request }) => {
  const inventory = await (await request.get('/api/v1/workspaces', { headers })).json() as WorkspaceDiscovery;
  const project = inventory.projects!.find(p => p.name === 'project')!, main = project.worktrees[0]!;
  const root = '/demo/tasks/layout';
  const input = { projectId: project.id, worktreeId: 'layout-tree', requestId: crypto.randomUUID(),
    worktree: { ...main.identity!, root }, branch: 'feature/layout', head: main.head!, targetRef: 'refs/heads/main', targetHead: main.head!, confirm: true as const };
  const record = { message: 'The worktree was deleted.', updatedAt: new Date().toISOString() };
  if (operation === 'discard') project.discards = [{ ...record, status: 'discarded', input: { ...input, dirty: false, changeCount: 0, fingerprint: 'e'.repeat(64), unmergedCommits: 0, confirmBranch: input.branch } }];
  else project.removals = [{ ...record, status: 'removed', input: { ...input, integratedBy: 'ancestry', integratedCommit: main.head! } }];
  await page.route('**/api/v1/workspaces', route => route.fulfill({ json: inventory }));
  await page.addInitScript(saved => localStorage.setItem('altcli.workspace', JSON.stringify(saved)), { key: 'worktree:layout-tree', root });
  await unlock(page, TOKEN, false);
  const projects = page.getByRole('combobox', { name: 'Switch project' }), trees = page.getByRole('combobox', { name: 'Switch worktree' });
  await expect(projects).toHaveValue(project.id); await expect(trees).toHaveValue('');
  await expect(projects.getByRole('option', { name: 'layout', exact: true })).toHaveCount(0);
  await expect(page.locator('.empty-console')).toContainText('This worktree is no longer available. Choose another worktree in project.');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('altcli.workspace')!).projectId)).toBe(project.id);
  await trees.selectOption(main.id); await expect(page.locator('.context-bar')).toContainText(main.path);
});
test('Console project switching leaves an active run intact', async ({ page, request }) => {
  const command = await post(request, 'commands', { requestId: crypto.randomUUID(), agentId: 'codex', kind: 'instruction', text: 'Keep running while browsing', confirmReady: true });
  await unlock(page, TOKEN, false);
  const before = await state(request), projects = page.getByRole('combobox', { name: 'Switch project' });
  await expect(projects).not.toHaveValue('');
  const original = await projects.inputValue();
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && !observationTransport(r.url())) writes.push(r.url()); });
  await projects.selectOption({ label: 'other' }); await expect(page.locator('.context-bar')).toContainText('/demo/other');
  await projects.selectOption(original); await expect(page.locator('.context-bar')).toContainText('/demo/project');
  const after = await state(request); expect(after.commands).toEqual(before.commands);
  expect(after.runs.find(r => r.currentCommandId === command.id)).toEqual(before.runs.find(r => r.currentCommandId === command.id));
  expect(writes).toEqual([]);
});
test('an interrupted worker displays Interrupted, including durable execution evidence after backend restart', async ({ page, request }) => {
  // State presentation fixture; exact native correlation and ownership are exercised in server/hook tests.
  const pair = await post(request, 'pairs', { name: 'Interrupt fixture', sessions: ['codex', 'claude'] });
  const command = await post(request, 'commands', { requestId: crypto.randomUUID(), agentId: 'codex', kind: 'instruction', text: 'Review current changes', handoff: true, pairId: pair.id, autoContinue: true, confirmReady: true });
  let native: 'working' | 'interrupted' | 'unknown' = 'working'; let interrupted = false;
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const body = await response.json() as WorkflowState;
    body.activities = [{ agentId: 'codex', state: native, updatedAt: '2026-09-20T20:00:00.000Z', detail: native === 'working' ? 'Native turn started.' : 'The CLI reported this turn was interrupted.' }];
    if (interrupted) {
      body.runs = body.runs.map((run) => run.currentCommandId === command.id ? { ...run, status: 'paused', reason: 'The assigned CLI turn was interrupted. No handoff was accepted.' } : run);
      body.executions = body.executions.map((turn) => turn.commandId === command.id ? { ...turn, status: 'interrupted' } : turn);
    }
    await route.fulfill({ response, json: body });
  });
  await unlock(page, TOKEN, false);
  const row = pane(page, 'Codex').locator('.pane-status');
  await expect(row.locator('.state')).toHaveText('working');
  native = 'interrupted'; interrupted = true;
  await expect(row.locator('.state')).toHaveText('interrupted');
  await expect(page.getByRole('button', { name: /^Control access · system · paused/ })).toBeVisible(); // the entry carries the state while the panel is closed
  await openController(page); await expect(page.getByRole('heading', { name: /^Controller paused/ })).toBeVisible();
  native = 'unknown'; // The persisted interrupted execution remains visible if native observations were lost.
  await expect(row).toContainText('No handoff was accepted');
  await expect(row.locator('.state')).toHaveText('interrupted');
  const current = await state(request);
  expect(current.executions.filter((turn) => turn.runId === command.id)).toHaveLength(1);
});
test('Unknown offers an explicit status reset beside the warning, preserving the workspace', async ({ page, request }) => {
  // Browser interaction uses a current-CLI fixture; real identity/ownership rejection is covered by server tests.
  let recovered = false; let resets = 0; let displayed: WorkflowState;
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const body = await response.json() as WorkflowState;
    body.sessions = body.sessions.map((s) => s.id === 'claude' ? { ...s, cliPid: '101' } : s);
    body.instances = body.instances.map((i) => i.agentId === 'claude' ? { ...i, status: 'current' } : i);
    body.activities = body.sessions.map((s) => ({ agentId: s.id, state: s.id === 'claude' && recovered ? 'ready' : 'unknown', updatedAt: recovered ? '2026-09-20T12:00:00.000Z' : null,
      detail: recovered ? 'Ready confirmed by you after inspecting the terminal.' : 'No current lifecycle evidence.' }));
    displayed = body; await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/activities/reset', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ agentId: 'claude', registrationId: displayed.sessions.find((s) => s.id === 'claude')!.registrationId, expectedUpdatedAt: null, confirmReady: true });
    resets++; recovered = true;
    await route.fulfill({ json: { agentId: 'claude', state: 'ready', updatedAt: '2026-09-20T12:00:00.000Z', detail: 'Ready confirmed by you.' } });
  });
  const before = await state(request);
  await unlock(page, TOKEN, false);
  // The agent's status line keeps the warning and opens Control access, where the reset is confirmed; choose its pane first so it is shown on narrow screens too.
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Claude Code', exact: true }).click();
  const row = pane(page, 'Claude Code').locator('.pane-status');
  await expect(row).toContainText('A backend restart can clear activity evidence.');
  await expect(row.getByRole('button', { name: 'Reset status', exact: true })).toHaveCount(0);
  await expect(row).toContainText('Reset status in Control access.');
  // The note says what to check; marking Ready is then one click, with no second confirmation.
  const access = await openAccess(page);
  await expect(access.getByRole('list', { name: 'What to notice' })).toContainText('may still be working');
  const status = access.getByRole('group', { name: 'Status of Claude Code' });
  const reset = status.getByRole('button', { name: 'Mark Claude Code Ready', exact: true });
  await expect(reset).toBeEnabled(); await expect(reset).toHaveAttribute('title', /empty prompt with no background writers/); expect(resets).toBe(0);
  await reset.click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Status reset to Ready');
  await expect(row.locator('.state')).toHaveText('ready'); await expect(row).toContainText('confirmed by you');
  await expect(reset).toHaveCount(0); expect(resets).toBe(1);
  const after = await state(request);
  expect(after.sessions).toEqual(before.sessions); expect(after.groups).toEqual(before.groups); expect(after.commands).toEqual(before.commands);
});
test('readiness is explicit and a delivered command retains execution ownership', async ({ page, request }) => {
  await unlock(page); await expect(page.getByText('MOCK MODE', { exact: true })).toBeVisible();
  const ready = (await readiness(page, 'Ready to send')); await expect(ready).not.toBeChecked();
  const relay = page.getByRole('button', { name: 'Stage-relay review by Codex ↗', exact: true }); await expect(relay).toBeDisabled();
  await ready.check(); await relay.click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('DELIVERED'); await openController(page); await expect(page.getByRole('region', { name: 'Who controls the agents' })).toBeVisible();
  await backToControl(page); await expect(relay).toBeDisabled(); // Control keeps the action, now disabled
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  await complete(request, run.currentCommandId, 'accept_without_improvement');
  await expect(page.getByRole('region', { name: 'Who controls the agents' })).toHaveCount(0);
  await expect(ready).not.toBeChecked();
});
test('an unresolved squash into this checkout disables Stage relay and says where to inspect it', async ({ page }) => {
  // The server refuses work on both checkouts of an applying or uncertain squash; Console must not offer a start it will refuse.
  await page.route('**/api/v1/workspaces', async (route) => {
    const data = await (await route.fetch()).json() as WorkspaceDiscovery;
    const project = data.projects!.find((p) => p.worktrees.some((tree) => tree.path === '/demo/project'))!;
    const identity = (root: string) => ({ root, gitDir: `${root}/.git`, indexPath: `${root}/.git/index` });
    project.integrations = [{ status: 'uncertain', message: 'The squash commit step failed.', updatedAt: new Date().toISOString(), commit: null, input: {
      projectId: project.id, worktreeId: 'tree-ui', requestId: crypto.randomUUID(), worktree: identity('/demo/ui'), branch: 'feature/ui', head: 'b'.repeat(40), through: 'b'.repeat(40),
      previousCommit: null, dirty: false, targetRef: 'refs/heads/main', targetHead: MAIN.head, target: identity('/demo/project'), mergeBase: MAIN.head, commitCount: 1, commits: [],
      tree: 'c'.repeat(40), message: 'feat: ui', commands: [], consent: 'd'.repeat(64), confirm: true } }];
    await route.fulfill({ json: data });
  });
  const writes: string[] = []; page.on('request', (sent) => { if (sent.method() !== 'GET' && !observationTransport(sent.url())) writes.push(sent.url()); });
  await unlock(page);
  const reason = 'Squash of feature/ui into main is uncertain. Inspect it in Projects before starting work.';
  await expect(page.locator('.notice:visible').filter({ hasText: reason })).toBeVisible();
  const stage = page.getByRole('region', { name: 'Stage relay', exact: true });
  await expect(stage.getByRole('status').filter({ hasText: reason }).first()).toBeVisible();
  await expect(await readiness(page, 'Ready to send')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stage-relay review by Codex ↗', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});
test('history export downloads this worktree\'s runs and journal as JSON through the authorized API', async ({ page, request }) => {
  await unlock(page);
  await (await readiness(page, 'Ready to send')).check(); await page.getByRole('button', { name: 'Stage-relay review by Codex ↗', exact: true }).click();
  await openController(page); await expect(page.getByRole('region', { name: 'Who controls the agents' })).toBeVisible();
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  await complete(request, run.currentCommandId, 'accept_without_improvement');
  await expect(page.getByRole('region', { name: 'Who controls the agents' })).toHaveCount(0);
  const requests: string[] = [];
  page.on('request', (sent) => { if (sent.url().includes('/api/v1/history/export')) requests.push(sent.url()); });
  const download = page.waitForEvent('download');
  await expand(page, 'Command history'); await page.getByRole('button', { name: 'Export history', exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toMatch(/^altcli-history-.*\.json$/);
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8'));
  expect(exported).toMatchObject({ schema: 1, repository: run.repository });
  expect(exported.runs.map((r: { id: string }) => r.id)).toContain(run.id);
  expect(exported.turns.map((t: { commandId: string }) => t.commandId)).toContain(run.currentCommandId);
  expect(Array.isArray(exported.journal)).toBe(true);
  expect(requests).toHaveLength(1); expect(decodeURIComponent(requests[0]!)).toContain(`repository=${run.repository}`);
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText(/Exported \d+ runs? and \d+ journal entr(y|ies)/);
  // The endpoint is bearer-gated like every other route.
  expect((await request.get('/api/v1/history/export')).status()).toBe(401);
  expect((await request.get('/api/v1/history/export?repository=relative', { headers })).status()).toBe(400);
});
test('workspace cards automatically group two eligible agents; selection is read-only and needs no group form', async ({ page, request }) => {
  await unlock(page); await openTab(page, 'Projects');
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Project project', exact: true }).click();
  const cards = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem');
  await expect(cards).toHaveCount(1);
  const other = cards.filter({ hasText: '/demo/other' }); const project = cards.filter({ hasText: '/demo/project' });
  await expect(project).toContainText('2 AGENTS'); await expect(project).toContainText('Main checkout · main');
  await expect(project.locator(':scope > details > summary .muted')).toHaveCount(0);
  await page.getByRole('button', { name: 'Project other', exact: true }).click();
  await expect(other).toContainText('1 AGENTS'); await expect(other.locator(':scope > details > summary .muted')).toHaveCount(0);
  await editWorkspace(page, 'other');
  await expect(workspace(page, 'other')).toContainText('"zsh" is a shell or generic interpreter');
  await expect(workspace(page, 'other')).toContainText('Solo · 1 agent');
  await editWorkspace(page, 'project');
  await expect(workspace(page, 'other')).toHaveCount(0);
  await expect(workspace(page, 'project').getByLabel('Name for Codex %0')).toHaveValue('Codex'); await expect(project.getByRole('region', { name: 'Workspace project', exact: true })).toBeVisible();
  await expect(page.getByLabel('Workspace group members')).toHaveText('Codex ⇄ Claude Code');
  await expect(page.getByLabel('Group name')).toHaveCount(0);
  await expect(workspace(page, 'project').getByRole('checkbox')).toHaveCount(2);
  await expect(project.getByText('Selected', { exact: true })).toHaveCount(0);
  await expect(project).toHaveClass('selected');
  await expect(page.getByRole('button', { name: 'Create group', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(workspace(page, 'project')).toBeVisible();
  // Discovery and selection are read-only: no run, no reservation, no new registration, no group.
  const after = await state(request);
  expect(after.runs.filter((r) => r.status === 'running' || r.status === 'paused')).toEqual([]); expect(after.reservations).toEqual([]); expect(after.sessions).toHaveLength(3); expect(after.panes.filter((pane) => pane.registeredAs)).toHaveLength(2); expect(after.pairs).toEqual([]);
  await openTab(page, 'Console');
  const context = page.locator('.context-bar');
  await expect(context).toContainText('/demo/project'); await expect(context).toContainText('Branch main'); await expect(context).toContainText('Codex ⇄ Claude Code');
  await showSurface(page, 'Terminal');
  await expect(page.getByLabel('Codex native output', { exact: true })).toBeVisible(); await expect(page.getByLabel('Claude Code native output')).toHaveCount(1);
});
test('unregistered agents are immediately usable; inline name saves on Enter and blur, Escape cancels', async ({ page, request }, info) => {
  await unlock(page); await openTab(page, 'Projects');
  await editWorkspace(page, 'other');
  const detail = workspace(page, 'other');
  await expect(detail.getByRole('button', { name: /Register|Rename|Remove/ })).toHaveCount(0);
  await expect(detail.getByLabel('Include zsh %2')).toBeDisabled();
  await expect(detail.getByLabel('Include demo')).toBeChecked();
  const original = (await state(request)).sessions.find((session) => session.identity.paneId === '%3')!;
  const name = detail.getByLabel('Name for Codex %3'); await expect(name).toHaveValue('demo');
  await name.fill('Other Codex'); await name.press('Enter');
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Renamed "demo" to "Other Codex"');
  await name.fill('Cancelled'); await name.press('Escape'); await expect(name).toHaveValue('Other Codex');
  expect((await state(request)).sessions.find((session) => session.id === original.id)!.label).toBe('Other Codex');
  await name.fill('Renamed Codex'); await name.blur();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Renamed "Other Codex" to "Renamed Codex"');
  expect((await state(request)).sessions.find((session) => session.id === original.id)).toEqual({ ...original, label: 'Renamed Codex' });
  await page.screenshot({ path: info.outputPath('workspace-inline-name.png'), fullPage: true });
  await openTab(page, 'Console');
  await expect(page.getByLabel('Renamed Codex native output')).toBeVisible(); await expect(page.getByLabel('Codex native output', { exact: true })).toHaveCount(0);
});
test('the group in use narrows the console to its members', async ({ page, request }) => {
  await post(request, 'pairs', { name: 'Main review', sessions: ['codex', 'claude'] });
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await unlock(page); await openTab(page, 'Projects');
  await editWorkspace(page, 'project');
  await expect(page.getByLabel('Workspace group members')).toHaveText('Codex ⇄ Claude Code');
  await openTab(page, 'Console');
  await expect(page.locator('.context-bar')).toContainText('Main review'); await expect(page.locator('.context-bar')).toContainText('Codex ⇄ Claude Code');
  await expect(page.getByLabel('Codex native output', { exact: true })).toHaveCount(1); await expect(page.getByLabel('Claude Code native output')).toHaveCount(1);
  await expect(page.getByLabel('Other Codex native output')).toHaveCount(0);
  await expect(page.getByLabel('Auto-relay', { exact: true })).toBeVisible();
  const ready = (await readiness(page, 'Ready to send')); await ready.check();
  const codex = (await state(request)).sessions.find((session) => session.id === 'codex')!;
  expect((await request.patch('/api/v1/sessions/codex', { headers, data: { label: 'Primary Codex', expectedLabel: codex.label, expectedRegistrationId: codex.registrationId } })).ok()).toBe(true);
  await expect(ready).not.toBeChecked({ timeout: 10000 });
  expect((await request.patch('/api/v1/sessions/codex', { headers, data: { label: codex.label, expectedLabel: 'Primary Codex', expectedRegistrationId: codex.registrationId } })).ok()).toBe(true);
});
test('a workspace with one registered eligible agent automatically forms a solo group', async ({ page, request }) => {
  await post(request, 'pairs', { name: 'Main review', sessions: ['codex', 'claude'] });
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await unlock(page); await openTab(page, 'Projects');
  await editWorkspace(page, 'other');
  await expect(page.getByLabel('Workspace group members')).toHaveText('Other Codex');
  await expect(workspace(page, 'other').getByRole('checkbox')).toHaveCount(2);
  await openTab(page, 'Console');
  await expect(page.locator('.context-bar')).toContainText('Other Codex');
  await expect(page.getByLabel('Other Codex native output')).toHaveCount(1); await expect(page.getByLabel('Codex native output', { exact: true })).toHaveCount(0);
  await editSettings(page); await expect(page.getByLabel('Collaboration', { exact: true })).toHaveValue('solo');
  await expect(page.getByRole('button', { name: 'Relay Claude', exact: true })).toHaveCount(0);
});
test('command history shows only this checkout\'s commands and orders by time', async ({ page, request }) => {
  const main = await post(request, 'pairs', { name: 'All', sessions: ['codex', 'claude'] });
  await post(request, 'commands', { requestId: '11111111-1111-4111-8111-111111111111', agentId: 'codex', kind: 'instruction', text: 'solo first', confirmReady: true });
  await complete(request, '11111111-1111-4111-8111-111111111111'); // a finished instruction releases the worktree for the next start
  await post(request, 'commands', { requestId: '22222222-2222-4222-8222-222222222222', agentId: 'claude', kind: 'instruction', text: 'paired second', confirmReady: true, pairId: main.id });
  // A command on another checkout never appears in this one's history.
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await instruct(request, 'other-codex', 'elsewhere', '66666666-6666-4666-8666-666666666666');
  await unlock(page); await expand(page, 'Command history');
  await expect(page.getByLabel('History pair filter')).toHaveCount(0);
  // History persists across tests, so assert relative order of these two rows rather than absolute counts.
  const rows = page.locator('details.history tbody tr');
  const position = async (text: string) => (await rows.allTextContents()).findIndex((row) => row.includes(text));
  await expect(rows.filter({ hasText: 'paired second' })).toContainText('All');
  await expect(rows.filter({ hasText: 'solo first' })).toHaveCount(1); await expect(rows.filter({ hasText: 'elsewhere' })).toHaveCount(0);
  await expect.poll(async () => (await position('paired second')) < (await position('solo first'))).toBe(true);
  await page.getByRole('button', { name: 'Toggle history order' }).click();
  await expect.poll(async () => (await position('solo first')) < (await position('paired second'))).toBe(true);
  await complete(request, '22222222-2222-4222-8222-222222222222', 'accept_without_improvement');
  expect((await request.delete(`/api/v1/groups/${main.id}`, { headers })).ok()).toBe(true);
  await expect(rows.filter({ hasText: 'paired second' })).toHaveCount(1); // removing the group does not hide the checkout's history
});
test('command history follows the selected checkout', async ({ page, request }) => {
  const loop = await post(request, 'pairs', { name: 'Loop', sessions: ['codex', 'claude'] });
  await post(request, 'commands', { requestId: '33333333-3333-4333-8333-333333333333', agentId: 'codex', kind: 'instruction', text: 'loop command', confirmReady: true, pairId: loop.id });
  await complete(request, '33333333-3333-4333-8333-333333333333');
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'project');
  await openTab(page, 'Console'); await expand(page, 'Command history');
  const rows = page.locator('details.history tbody tr'); await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(1);
  await expect(page.locator('.history-tools')).toContainText('Commands on project');
  await openTab(page, 'Projects');
  await post(request, 'sessions', { paneId: '%3', label: 'Replacement' });
  await editWorkspace(page, 'other');
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByLabel('Workspace group members')).toHaveText('Replacement');
  await openTab(page, 'Console'); await expand(page, 'Command history');
  await expect(page.locator('.history-tools')).toContainText('Commands on other');
  await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(0);
  await openTab(page, 'Projects'); await editWorkspace(page, 'project');
  await openTab(page, 'Console'); await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(1);
});
test('a plain Send leaves partner activity untracked; only a handoff makes it wait', async ({ page, request }) => {
  const main = await post(request, 'pairs', { name: 'Main', sessions: ['codex', 'claude'] });
  await unlock(page);
  const row = (label: string) => pane(page, label).locator('.pane-status');
  await post(request, 'commands', { requestId: '44444444-4444-4444-8444-444444444444', agentId: 'codex', kind: 'instruction', text: 'plain work', confirmReady: true, pairId: main.id });
  await expect(row('Codex')).toContainText('waiting'); await expect(row('Codex')).toContainText('Delivered "plain work"');
  await expect(row('Claude Code')).toContainText('unknown'); await expect(row('Claude Code')).toContainText('Not part of this turn');
  await complete(request, '44444444-4444-4444-8444-444444444444', 'accept_without_improvement');
  await post(request, 'commands', { requestId: '55555555-5555-4555-8555-555555555555', agentId: 'codex', kind: 'instruction', text: 'reviewed work', handoff: true, confirmReady: true, pairId: main.id });
  await expect(row('Claude Code')).toContainText('waiting'); await expect(row('Claude Code')).toContainText('Waiting for Codex to finish');
});
test('native inactive agents wait for their relay turn and return to idle after the chain', async ({ page, request }) => {
  const pair = await post(request, 'pairs', { name: 'Relay activity', sessions: ['codex', 'claude'] });
  const activities: Record<string, 'working' | 'idle' | 'ready'> = { codex: 'working', claude: 'idle' };
  // Simulate native activity while the real mock controller owns and advances the relay.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = Object.entries(activities).map(([agentId, activity]) => ({ agentId, state: activity, updatedAt: new Date().toISOString(), detail: `Native activity: ${activity}.` }));
    await route.fulfill({ json: data });
  });
  const row = (label: string) => pane(page, label).locator('.pane-status');
  const badge = (label: string) => row(label).locator('.state');
  const plain = crypto.randomUUID();
  await post(request, 'commands', { requestId: plain, agentId: 'codex', kind: 'instruction', text: 'plain work', confirmReady: true, pairId: pair.id });
  await unlock(page, TOKEN, false);
  await expect(badge('Codex')).toHaveText('working'); await expect(badge('Claude Code')).toHaveText('idle');
  // Native completion may be visible before the controller accepts its correlated completion.
  activities.codex = 'idle'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(badge('Codex')).toHaveText('idle');
  expect((await state(request)).executions.find((execution) => execution.commandId === plain)!.status).toBe('delivered');
  await complete(request, plain, 'accept_without_improvement');
  activities.codex = 'working';
  const relay = crypto.randomUUID();
  await post(request, 'commands', { requestId: relay, agentId: 'codex', kind: 'relay', confirmReady: true, pairId: pair.id, autoContinue: true });
  await expect(badge('Claude Code')).toHaveText('waiting'); await expect(row('Claude Code')).toContainText('Waiting for Codex to finish');
  activities.claude = 'ready'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(badge('Claude Code')).toHaveText('waiting');
  activities.claude = 'working'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(badge('Claude Code')).toHaveText('working'); // Real activity must not be hidden by its relay role.
  activities.codex = 'idle';
  await complete(request, relay, 'accept_and_improve');
  await expect(badge('Codex')).toHaveText('waiting'); await expect(row('Codex')).toContainText('Waiting for Claude Code to finish');
  await expect(badge('Claude Code')).toHaveText('working');
  const run = (await state(request)).runs.find((candidate) => candidate.id === relay)!;
  activities.claude = 'idle'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(badge('Claude Code')).toHaveText('idle'); // A delivered relay command is not evidence of unfinished native work.
  expect((await state(request)).executions.find((execution) => execution.commandId === run.currentCommandId)!.status).toBe('delivered');
  await complete(request, run.currentCommandId, 'accept_without_improvement');
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(badge('Codex')).toHaveText('idle'); await expect(badge('Claude Code')).toHaveText('idle');
});
test('a finished response under a controller paused for background-work safety shows the pause with its idle activity', async ({ page, request }) => {
  const pair = await post(request, 'pairs', { name: 'Background safety', sessions: ['codex', 'claude'] });
  let activity: 'working' | 'idle' = 'working';
  // Native CLI evidence is simulated here; server integration tests exercise the lifecycle tracker and process gates.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    // The quiet peer has no evidence at all, as after a host restart.
    data.activities = [{ agentId: 'codex', state: activity, updatedAt: new Date().toISOString(), detail: `Native turn is ${activity}.` },
      { agentId: 'claude', state: 'unknown', updatedAt: null, detail: 'No current lifecycle evidence.' }];
    data.sessions = data.sessions.map((s) => s.id === 'claude' ? { ...s, cliPid: '101' } : s);
    await route.fulfill({ json: data });
  });
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Start the development server', handoff: true, confirmReady: true, pairId: pair.id });
  await unlock(page, TOKEN, false);
  const row = pane(page, 'Codex').locator('.pane-status');
  await expect(row.locator('.state')).toHaveText('working');
  const snapshot = await state(request); const execution = snapshot.executions.find((e) => e.commandId === id)!;
  const session = snapshot.sessions.find((s) => s.id === 'codex')!;
  await post(request, 'events', { event: 'turn_complete', source: 'codex', commandId: id, prompt: execution.wireText,
    paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: session.identity,
    sessionId: 'background-service-session', sourceTurnId: `turn-${id}`, settled: true, backgroundState: 'active' });
  activity = 'idle'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(row.locator('.state')).toHaveText('attention'); await expect(row).toContainText('Controller paused'); await expect(row).toContainText('Native turn is idle.');
  await openController(page); await expect(page.getByRole('region', { name: 'Who controls the agents' })).toContainText(/background work/i);
  const run = (await state(request)).runs.find((r) => r.id === id)!;
  expect(run.status).toBe('paused'); expect(run.currentCommandId).toBe(id);
  // While the paused controller still holds the command, no status reset is offered; the notes say the agents may still be working
  // and Take control comes first.
  const access = page.getByRole('region', { name: 'Control access', exact: true });
  await expect(access.getByRole('button', { name: 'Mark Claude Code Ready', exact: true })).toHaveCount(0);
  await expect(access.getByRole('list', { name: 'What to notice' })).toContainText('may still be working');
  await expect(access.getByRole('button', { name: 'Take control…', exact: true })).toBeEnabled();
});
test('every member of a keyboard-held relay shows the pause, and a missing checkpoint points to takeover', async ({ page, request }) => {
  const pair = await post(request, 'pairs', { name: 'Held relay', sessions: ['codex', 'claude'] });
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Held work', handoff: true, confirmReady: true, pairId: pair.id });
  // The keyboard hold and native activity are simulated; server tests exercise the hold, the Stop-hook wait and checkpoint capture.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.runs = data.runs.map((r) => r.id === id ? { ...r, status: 'paused', reason: 'Original turn validated. Review the terminal input before continuing.',
      interaction: { revision: 1, active: true, fault: false, origin: 'keyboard', disposition: 'automatic' } } : r);
    data.executions = data.executions.map((e) => e.commandId === id ? { ...e, status: 'finished' } : e);
    data.activities = [{ agentId: 'codex', state: 'idle', updatedAt: new Date().toISOString(), detail: 'Native turn is idle.' },
      { agentId: 'claude', state: 'unknown', updatedAt: null, detail: 'No current lifecycle evidence.' }];
    data.checkpoints = [];
    await route.fulfill({ json: data });
  });
  await unlock(page, TOKEN, false);
  const codex = pane(page, 'Codex').locator('.pane-status'), claude = pane(page, 'Claude Code').locator('.pane-status');
  await expect(codex.locator('.state')).toHaveText('attention'); await expect(codex).toContainText('Controller paused'); await expect(codex).toContainText('Native turn is idle.');
  await expect(claude.locator('.state')).toHaveText('attention'); await expect(claude).toContainText('nothing is being sent to this agent');
  await expect(claude).not.toContainText('Waiting for Codex to finish');
  await openController(page);
  const card = page.getByRole('region', { name: 'Who controls the agents' });
  await expect(card).toContainText('No input checkpoint to review yet'); await expect(card).toContainText('(not yet: Claude Code)');
  await expect(page.getByRole('button', { name: 'Take control…', exact: true })).toBeEnabled();
});
test('takeover does not claim a still-running worker is idle and late completion cannot revive ownership', async ({ page, request }) => {
  let activity: 'ready' | 'working' | 'idle' | 'unknown' = 'unknown';
  // Native activity is simulated; server integration tests exercise real lifecycle correlation separately from ownership.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = [{ agentId: 'codex', state: activity, updatedAt: new Date().toISOString(), detail: `Native activity: ${activity}.` }];
    await route.fulfill({ json: data });
  });
  await unlock(page, TOKEN, false);
  const row = pane(page, 'Codex').locator('.pane-status');
  await expect(row).toContainText('unknown'); await expect(row).not.toContainText('Idle');
  activity = 'ready'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(row).toContainText('ready'); await expect(row).toContainText('Not driven by the controller');
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Still working after takeover', confirmReady: true });
  activity = 'working';
  await expect(row).toContainText('working');
  const before = await state(request); const execution = before.executions.find((e) => e.commandId === id)!;
  const session = before.sessions.find((s) => s.id === 'codex')!;
  await openController(page); await expect(page.getByRole('button', { name: 'Control access · system', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause the controller', exact: true }).click();
  await expect(row).toContainText('working'); await expect(row).toContainText('paused but still holds');
  // A paused run offers only the takeover: one confirmation that lists what it does, with no checkboxes.
  await expect(page.getByRole('button', { name: 'Pause the controller', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Take control…', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Control access', exact: true }).getByRole('checkbox')).toHaveCount(0);
  await takeControl(page);
  await expect(row).toContainText('working'); await expect(row).toContainText('Not driven by the controller');
  await expect(row).not.toContainText('Idle');
  await expect(page.getByRole('button', { name: /^(Pause the controller|Take control…)$/ })).toHaveCount(0);
  await post(request, 'events', { commandId: id, source: session.agentType, event: 'turn_complete', sessionId: 'late-session', sourceTurnId: 'late-turn',
    identity: session.identity, paneId: session.identity.paneId, socketPath: session.identity.socketPath, prompt: execution.wireText,
    settled: true, backgroundState: 'clear', outcome: 'accept_without_improvement' });
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(row).toContainText('working'); await expect(row).toContainText('Not driven by the controller');
  expect((await state(request)).runs.find((run) => run.id === id)?.status).toBe('stopped');
  activity = 'idle'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(row).toContainText('idle'); await expect(row).toContainText('Not driven by the controller');
  await expect(page.getByRole('button', { name: /^(Pause the controller|Take control…)$/ })).toHaveCount(0);
});
test('an automatic workspace group creates a persistent run without browser scheduling', async ({ page, request }) => {
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'project');
  const group = (await state(request)).groups.find((candidate) => candidate.cwd === '/demo/project')!;
  await expect(page.getByLabel('Workspace group members')).toHaveText('Codex ⇄ Claude Code');
  await openTab(page, 'Console');
  await page.getByLabel('Auto-relay', { exact: true }).check(); await (await readiness(page, 'Ready to send')).check();
  await page.getByRole('button', { name: 'Stage-relay review by Codex ↗', exact: true }).click(); await expect(page.locator('.feedback[role="status"]:visible')).toContainText('DELIVERED');
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  expect(run.pairId).toBe(group.id);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await complete(request, run.currentCommandId);
  const after = (await state(request)).runs.find((r) => r.id === run.id)!;
  expect(after.automaticTurns).toBe(1); expect(after.currentCommandId).not.toBe(run.currentCommandId);
  await unlock(page); await openController(page); await expect(page.getByText('1/20 automatic turns', { exact: true })).toBeVisible();
  await complete(request, after.currentCommandId, 'strong_objection', 'The delete path can remove records outside the selected project.');
  await expect(page.getByRole('heading', { name: 'Controller is driving the agents', exact: true })).toBeVisible();
  await expect(page.getByText('Reviewer objected; correction scheduled for Codex.', { exact: true })).toBeVisible();
  const correction = (await state(request)).executions.find((e) => e.runId === run.id)!;
  expect(correction.agentId).toBe('codex'); expect(correction.input.kind).toBe('instruction'); expect(correction.input.handoff).toBe(true);
  expect(correction.input.text).toContain('Address objection: The delete path can remove records outside the selected project.');
  // The reviewer's turn is over: its objection stays labeled on its pane while the author's correction is in flight.
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: /Claude Code/ }).click(); await showSurface(page, 'Terminal');
  await expect(page.getByText('strong_objection: The delete path can remove records outside the selected project.', { exact: true })).toBeVisible();
});
test('two browser pages cannot create two continuations from the same event', async ({ page, context, request }) => {
  const pair = await post(request, 'pairs', { name: 'Two clients', sessions: ['codex', 'claude'] });
  const record = await post(request, 'commands', { requestId: crypto.randomUUID(), agentId: 'codex', kind: 'relay', confirmReady: true, pairId: pair.id, autoContinue: true });
  await unlock(page); const second = await context.newPage(); await unlock(second);
  try {
    const current = await state(request); const session = current.sessions.find((s) => s.id === 'codex')!;
    const event: HookEvent = { source: 'codex', event: 'turn_complete', commandId: record.id, paneId: session.identity.paneId,
      socketPath: session.identity.socketPath, identity: session.identity, sessionId: 'test-codex', sourceTurnId: `turn-${record.id}`,
      prompt: current.executions.find((e) => e.commandId === record.id)!.wireText, settled: true, backgroundState: 'clear', outcome: 'accept_and_improve' };
    await Promise.all([post(request, 'events', event), post(request, 'events', event)]);
    await openController(page); await openController(second);
    await expect(page.getByText('1/20 automatic turns', { exact: true })).toBeVisible(); await expect(second.getByText('1/20 automatic turns', { exact: true })).toBeVisible();
    const run = (await state(request)).runs.find((r) => r.id === record.id)!;
    expect(run.automaticTurns).toBe(1); expect((await state(request)).executions.filter((e) => e.runId === run.id)).toHaveLength(1);
  } finally { await second.close(); }
});
test('plain Send from Stage relay starts a standalone instruction even with Auto-relay selected', async ({ page, request }) => {
  await unlock(page); await page.getByLabel('Auto-relay', { exact: true }).check();
  await page.getByLabel('Instruction to Codex', { exact: true }).fill('Commit the staged fix');
  await (await readiness(page, 'Ready to send')).check();
  await page.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('DELIVERED');
  const current = await state(request); const run = current.runs.find((r) => r.status === 'running')!;
  expect(run.standalone).toMatchObject({ agentId: 'codex', text: 'Commit the staged fix', policy: 'peer' });
  expect(run.stage).toBeUndefined(); expect(run.autoContinue).toBe(false);
  await complete(request, run.currentCommandId);
  const finished = await state(request);
  expect(finished.runs.find((r) => r.id === run.id)!.status).toBe('completed');
  expect(finished.commands.filter((command) => command.runId === run.id)).toHaveLength(1);
});
test('pause and takeover are distinct and uncertain transport is not retried', async ({ page }) => {
  await unlock(page); await page.getByLabel('Instruction to Codex', { exact: true }).fill('mock:uncertain');
  await (await readiness(page, 'Ready to send')).check(); await page.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('UNCERTAIN'); await openController(page); await expect(page.getByRole('heading', { name: /^Controller paused/ })).toBeVisible();
  // The card says which command it owns, so a paused run is recognisable without guessing.
  await expect(page.getByRole('region', { name: 'Who controls the agents' })).toContainText('Codex: “mock:uncertain”');
  await expect(page.getByRole('region', { name: 'Who controls the agents' })).toContainText('Agents: Codex'); await expect(page.getByRole('region', { name: 'Who controls the agents' })).toContainText('The controller is paused, not the agents');
  await expect(page.getByRole('button', { name: 'Pause the controller', exact: true })).toHaveCount(0); // already paused: nothing to pause again
  // The notes say what taking control cannot undo; its one confirmation lists the steps.
  await expect(page.getByRole('list', { name: 'What to notice' })).toContainText('may still be working');
  await takeControl(page);
  await expect(page.getByRole('region', { name: 'Who controls the agents' })).toHaveCount(0); await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Nothing was replayed');
});
test('a rejected completion does not label the active pane with an older accepted outcome', async ({ page, request }) => {
  const previous = crypto.randomUUID();
  await post(request, 'commands', { requestId: previous, agentId: 'codex', kind: 'relay', confirmReady: true });
  await complete(request, previous, 'accept_without_improvement', 'Previous accepted review.');
  await unlock(page); await showSurface(page, 'Terminal');
  await expect(page.getByText('accept_without_improvement: Previous accepted review.', { exact: true })).toBeVisible();

  const currentId = crypto.randomUUID();
  await post(request, 'commands', { requestId: currentId, agentId: 'codex', kind: 'relay', confirmReady: true });
  const current = await state(request); const execution = current.executions.find((e) => e.commandId === currentId)!;
  const session = current.sessions.find((s) => s.id === 'codex')!;
  // A replaced pane process is a different physical worker; its completion is rejected. (A new chat in the same CLI is not.)
  await post(request, 'events', { source: 'codex', event: 'turn_complete', commandId: currentId,
    paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: { ...session.identity, panePid: '999999' },
    sessionId: 'test-codex', sourceTurnId: `turn-${currentId}`, prompt: execution.wireText,
    settled: true, backgroundState: 'clear', outcome: 'accept_without_improvement', reason: 'Current rejected review.' });

  await openController(page); const active = page.getByRole('region', { name: 'Who controls the agents' });
  await expect(active.getByText('Worker instance changed. Reconcile and re-register before continuing.', { exact: true })).toBeVisible();
  await expect(page.getByText('accept_without_improvement: Previous accepted review.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('accept_without_improvement: Current rejected review.', { exact: true })).toHaveCount(0);
});
test('unknown Claude background status pauses instead of treating a response as idle', async ({ page, request }) => {
  await unlock(page); await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: /Claude Code/ }).click();
  await (await readiness(page, 'Ready to send')).check(); await page.getByRole('button', { name: 'Stage-relay review by Claude Code ↗', exact: true }).click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('DELIVERED');
  const current = await state(request); const run = current.runs.find((r) => r.status === 'running')!;
  const session = current.sessions.find((s) => s.id === 'claude')!;
  const lifecycle = { source: 'claude', commandId: run.currentCommandId, paneId: session.identity.paneId,
    socketPath: session.identity.socketPath, identity: session.identity, sessionId: 'test-claude', sourceTurnId: `turn-${run.currentCommandId}`,
    prompt: current.executions.find((e) => e.commandId === run.currentCommandId)!.wireText, settled: true, backgroundState: 'unknown' };
  await post(request, 'events', { ...lifecycle, event: 'turn_started' });
  await post(request, 'events', { ...lifecycle, event: 'turn_complete', outcome: 'accept_and_improve' });
  await openController(page); await expect(page.getByRole('heading', { name: /^Controller paused/ })).toBeVisible();
  await expect(page.getByText('Completion or background-work state is unknown; inspect the workers.', { exact: true })).toBeVisible();
});
test('a finished run of forgotten agents leaves the Status headline but stays in Command history', async ({ page, request }) => {
  // Pin the project checkout first so the console does not silently follow the first discovered session after the reset.
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'project'); await openTab(page, 'Console');
  await (await readiness(page, 'Ready to send')).check(); await page.getByRole('button', { name: 'Stage-relay review by Codex ↗', exact: true }).click();
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  await complete(request, run.currentCommandId, 'accept_without_improvement');
  // A finished command is not the console's centre: it sits inside Control access, collapsed until opened.
  await expect(page.getByRole('button', { name: 'Control access · you', exact: true })).toBeVisible(); await openController(page);
  const status = page.getByRole('region', { name: 'Control access', exact: true }).locator('details.latest-run');
  await expect(status).toContainText('COMPLETED · 0/20 automatic turns'); await expect(status).toContainText('Codex ⇄ Claude Code');
  await expect(status).not.toHaveAttribute('open', /.*/);
  // Forgetting the agents does not delete the run; the same live panes come back as new discovered identities.
  await post(request, 'workspaces/reset', { repository: '/demo/project', confirmReady: true }); await showSurface(page, 'Terminal');
  await expect(page.getByLabel('demo native output').first()).toBeVisible(); await expect(page.locator('.context-bar')).toContainText('/demo/project');
  await expect(status).toHaveCount(0); await expect(page.locator('details.latest-run')).toHaveCount(0);
  await expand(page, 'Command history');
  await expect(page.locator('details.history')).toContainText('relay');
});
test('reset clears saved names and selection without hiding live agents or touching other workspaces', async ({ page, request }) => {
  await post(request, 'pairs', { name: 'Main review', sessions: ['codex', 'claude'] });
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'other');
  const detail = workspace(page, 'other');
  await detail.getByRole('button', { name: 'Reset other', exact: true }).click();
  await expect(detail).toContainText('Reset saved names and group selection on this checkout?');
  await detail.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(detail.getByRole('button', { name: 'Confirm reset other', exact: true })).toHaveCount(0);
  await expect(detail.getByLabel('Name for Codex %3')).toHaveValue('Other Codex');
  await detail.getByRole('button', { name: 'Reset other', exact: true }).click();
  await detail.getByRole('button', { name: 'Confirm reset other', exact: true }).click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Reset other: cleared 1 saved name(s) and 0 group setting(s)');
  await expect(detail.getByLabel('Name for Codex %3')).toHaveValue('demo');
  await expect(detail.getByLabel('Include demo')).toBeChecked();
  // Only that checkout was forgotten: the project workspace keeps its agents and group, and history is untouched.
  const after = await state(request);
  expect(after.sessions.filter((session) => session.repository === '/demo/project').map((s) => s.id)).toEqual(['codex', 'claude']); expect(after.pairs.map((p) => p.id)).toEqual(['main-review']);
  expect(after.panes.find((pane) => pane.identity.paneId === '%3')!.registeredAs).toBeNull();
  await detail.getByLabel('Name for Codex %3').fill('Fresh Codex'); await detail.getByLabel('Name for Codex %3').press('Enter');
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('Renamed "demo" to "Fresh Codex"');
  await openTab(page, 'Console'); await expect(page.getByLabel('Fresh Codex native output')).toBeVisible();
});
test('checkboxes save solo, pair and larger groups without silently truncating selection', async ({ page, request }, info) => {
  await post(request, 'sessions', { paneId: '%3', label: 'Third' });
  const before = await state(request); const group = before.groups.find((candidate) => candidate.cwd === '/demo/project')!;
  const saved: { members: string[]; expectedRevision: number }[] = [];
  // This exercises browser selection only; the workflow suite validates real server-side updates.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    data.groups = data.groups.map((candidate: { id: string }) => candidate.id === group.id ? group : candidate);
    const third = data.sessions.find((session: { id: string }) => session.id === 'third');
    Object.assign(third, { repository: '/demo/project', cwd: '/demo/project' });
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    const other = data.workspaces.find((workspace: { cwd: string }) => workspace.cwd === '/demo/other');
    const third = other.agents.find((agent: { registeredAs: string }) => agent.registeredAs === 'third');
    other.agents = other.agents.filter((agent: { registeredAs: string }) => agent.registeredAs !== 'third');
    data.workspaces.find((workspace: { cwd: string }) => workspace.cwd === '/demo/project').agents.push(third);
    await route.fulfill({ json: data });
  });
  await page.route(`**/api/v1/groups/${group.id}`, async (route) => {
    const input = route.request().postDataJSON(); saved.push(input); group.members = input.members; group.revision++;
    await route.fulfill({ json: group });
  });
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'project');
  const detail = workspace(page, 'project');
  await expect(detail.getByRole('checkbox')).toHaveCount(3);
  await expect(detail.getByLabel('Include Codex', { exact: true })).toBeChecked();
  await expect(detail.getByLabel('Include Claude Code', { exact: true })).toBeChecked();
  await detail.getByLabel('Include Third', { exact: true }).check();
  await expect.poll(() => saved.length).toBe(1); expect(saved[0]!.members).toEqual(['codex', 'claude', 'third']);
  await expect(detail).toContainText('Group · 3 agents');
  await openTab(page, 'Console');
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toContainText('larger-group execution is not enabled yet');
  await expect(page.getByRole('button', { name: /^Send / })).toHaveCount(0);
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Plan setup' })).toContainText('Your selection is saved');
  await openTab(page, 'Projects');
  await detail.getByLabel('Include Claude Code', { exact: true }).uncheck();
  await expect.poll(() => saved.length).toBe(2); expect(saved[1]!.members).toEqual(['codex', 'third']);
  await expect(page.getByLabel('Workspace group members')).toHaveText('Codex ⇄ Third');
  await detail.getByLabel('Include Third', { exact: true }).uncheck();
  await expect.poll(() => saved.length).toBe(3); await expect(detail).toContainText('Solo · 1 agent');
  await detail.getByLabel('Include Third', { exact: true }).check();
  await expect(detail).toContainText('Pair · 2 agents');
  await expect(detail.getByRole('button', { name: 'Create group', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Save selection', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('workspace-selection.png'), fullPage: true });
});
test('two live agents can be changed to solo or an empty selection through real checkbox saves', async ({ page, request }) => {
  await unlock(page); await openTab(page, 'Projects'); await editWorkspace(page, 'project');
  const detail = workspace(page, 'project');
  await detail.getByLabel('Include Claude Code', { exact: true }).uncheck();
  await expect(detail).toContainText('Solo · 1 agent');
  await openTab(page, 'Console'); await editSettings(page);
  await expect(page.getByLabel('Collaboration', { exact: true })).toHaveValue('solo');
  await expect(page.getByLabel('Claude Code native output')).toHaveCount(0);
  await openTab(page, 'Projects'); await detail.getByLabel('Include Codex', { exact: true }).uncheck();
  await expect(detail).toContainText('Select at least one agent before starting.');
  await openTab(page, 'Console');
  await expect(page.getByRole('region', { name: 'Implementation settings' })).toContainText('Select at least one agent');
  await expect(page.getByRole('button', { name: /^Send / })).toHaveCount(0);
  // No recipient tab or input section: the joined tab body must not leave an empty bordered strip.
  await expect(page.locator('#altcli-control > .control-body')).toBeHidden();
  const current = await state(request); expect(current.groups.find((group) => group.cwd === '/demo/project')!.members).toEqual([]);
  expect(current.executions).toEqual([]);
  await page.reload(); await page.getByLabel('Host access token').fill(TOKEN); await page.getByRole('button', { name: 'Open console' }).click();
  await openTab(page, 'Projects'); await expandAgents(page, 'project');
  await expect(detail.getByLabel('Include Codex', { exact: true })).not.toBeChecked();
  await expect(detail.getByLabel('Include Claude Code', { exact: true })).not.toBeChecked();
});
test('with no saved registrations a workspace opens directly into a usable read-only console', async ({ page, request }) => {
  for (const id of ['codex', 'claude']) expect((await request.delete(`/api/v1/sessions/${id}`, { headers })).ok()).toBe(true);
  await unlock(page, TOKEN, false);
  await openTab(page, 'Projects');
  await expect(page.getByRole('list', { name: 'Available projects' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Project project', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '/demo/project' })).toContainText('Main checkout · main');
  await expandWorktree(page, 'project'); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent console', exact: true })).toBeVisible();
  await expect(page.getByLabel('demo native output').first()).toBeVisible();
  // The existing narrow-screen layout shows only the active pane, even with Parallel selected.
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'demo', exact: true }).nth(1).click();
  await expect(page.getByLabel('demo native output').last()).toBeVisible();
  const after = await state(request); expect(after.panes.every((pane) => !pane.registeredAs)).toBe(true);
  expect(after.executions).toEqual([]);
});
test('wrong token cannot read agent output', async ({ page }) => {
  await unlock(page, 'b'.repeat(64)); await expect(page.getByRole('alert').filter({ hasText: /access token/ })).toBeVisible();
  await expect(page.getByLabel('Codex native output')).toHaveCount(0);
});

test('the stale-agent warning offers a confirmed workspace reset when no run owns the checkout', async ({ page, request }, info) => {
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  const before = await state(request); const resets: unknown[] = [];
  // Only process-identity evidence is mocked; reset uses the real API and store.
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    data.instances = data.instances.map((instance: { agentId: string }) => ['codex', 'claude'].includes(instance.agentId) ? { ...instance, status: 'replaced' } : instance);
    await route.fulfill({ json: data });
  });
  page.on('request', (outgoing) => { if (outgoing.method() === 'POST' && outgoing.url().endsWith('/api/v1/workspaces/reset')) resets.push(outgoing.postDataJSON()); });
  await unlock(page);
  const warning = page.getByRole('region', { name: 'Agent identity changed' });
  await expect(warning).toBeVisible(); await expect(warning).toContainText('The controller is not driving this checkout');
  await expect(page.getByRole('button', { name: /^(Pause the controller|Take control…)$/ })).toHaveCount(0);
  // The warning explains; the reset itself is confirmed once, in Control access.
  await expect(warning.getByRole('button', { name: 'Reset workspace…', exact: true })).toHaveCount(0);
  await expect(warning).toContainText('reset the workspace, in Control access');
  const reset = (await openAccess(page)).getByRole('group', { name: 'Workspace reset' });
  await reset.getByRole('button', { name: 'Reset workspace…', exact: true }).click();
  await expect(reset).toContainText('Files, commits, running CLIs and command history are kept');
  await reset.getByRole('button', { name: 'Keep configuration', exact: true }).click(); expect(resets).toHaveLength(0);
  await reset.getByRole('button', { name: 'Reset workspace…', exact: true }).click();
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Claude Code', exact: true }).click();
  await expect(reset.getByRole('button', { name: 'Confirm workspace reset', exact: true })).toHaveCount(0);
  await reset.getByRole('button', { name: 'Reset workspace…', exact: true }).click();
  await page.screenshot({ path: info.outputPath('inline-workspace-reset.png'), fullPage: true });
  await reset.getByRole('button', { name: 'Confirm workspace reset', exact: true }).click();
  await expect(page.locator('.feedback[role="status"]:visible')).toContainText('cleared 2 saved name(s)'); await expect(warning).toHaveCount(0);
  expect(resets).toEqual([{ repository: '/demo/project', confirmReady: true }]);
  const after = await state(request);
  expect(after.panes.filter((pane) => ['%0','%1'].includes(pane.identity.paneId)).every((pane) => !pane.registeredAs)).toBe(true);
  expect(after.sessions.find((session) => session.id === 'other-codex')!.label).toBe('Other Codex');
  expect(after.commands.map((command) => command.id)).toEqual(before.commands.map((command) => command.id));
});
test('the inline reset stays blocked while a run owns the checkout and points to takeover', async ({ page, request }) => {
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Fixture work', confirmReady: true });
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    data.instances = data.instances.map((instance: { agentId: string }) => instance.agentId === 'codex' ? { ...instance, status: 'replaced' } : instance);
    await route.fulfill({ json: data });
  });
  await unlock(page);
  const warning = page.getByRole('region', { name: 'Agent identity changed' });
  await expect(warning).toContainText('The controller is still driving the agents in this checkout');
  const reset = (await openAccess(page)).getByRole('group', { name: 'Workspace reset' });
  await expect(reset.getByRole('button', { name: 'Reset workspace…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Take control…', exact: true })).toBeVisible();
  await complete(request, id, 'accept_without_improvement');
  await expect(reset.getByRole('button', { name: 'Reset workspace…', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^(Pause the controller|Take control…)$/ })).toHaveCount(0);
});
