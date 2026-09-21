import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Group } from '../src/contracts/implementation';
import type { PlanDecision, PlanStart } from '../src/contracts/planning';
import type { RelayRun, WorkflowState } from '../src/contracts/workflow';
import { newPlanning } from '../src/server/planning-state';
const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { headers, data }); expect(response.ok()).toBe(true); return response.json();
}
test.beforeEach(async ({ request }) => {
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json();
  for (const run of state.runs.filter((r) => ['running','waiting','paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const repository of [...new Set(state.sessions.map((session) => session.repository))]) await post(request, 'workspaces/reset', { repository, confirmReady: true });
  await post(request, 'sessions', { paneId: '%0', label: 'Codex' }); await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
});
// Finish intercepted polling requests before Playwright closes the page.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
async function openGroup(page: Page, group: Group) {
  await page.goto('/'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: `Project ${group.repository.split('/').pop()}`, exact: true }).click();
  await page.getByRole('button', { name: `Open ${group.cwd!.split('/').pop()}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
}
test('Plan and Implementation are explicit readonly choices; Plan collects independent gate and branch settings', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Planners', members: ['codex','claude'] });
  const starts: PlanStart[] = [];
  await page.route('**/api/v1/planning', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Plan setup' })).toBeVisible();
  await expect(page.getByLabel('Require my approval before implementation')).toBeChecked();
  await page.getByRole('button', { name: '2 · Implementation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Implementation setup' })).toBeVisible(); expect(starts).toHaveLength(0);
  await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  await expect(page.getByLabel('After planning: implementation group')).toHaveCount(0);
  await page.getByLabel('Shared task brief').fill('Plan a scoped feature with verifiable acceptance checks.');
  await page.getByText('Collaboration settings', { exact: true }).click(); // the settings panel is collapsed until opened
  await page.getByLabel('Automatic collaboration across both phases').uncheck();
  await expect(page.getByLabel('Require my approval before implementation')).toBeChecked();
  await expect(page.getByLabel('Pause on a reviewer objection')).not.toBeChecked();
  await page.getByLabel('Ready for planning').check();
  await page.screenshot({ path: info.outputPath('planning-setup.png'), fullPage: true });
  await page.getByRole('button', { name: 'Start Plan', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ groupId: group.id, autoContinue: false, requireApproval: true, pauseOnObjection: false, confirmReady: true, implementation: { groupId: group.id, policy: 'peer', handoff: true, branch: null } });
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); expect(starts).toHaveLength(1);
});
test('Start Plan explains why it is disabled, including a confirmation cleared by editing the brief', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Planners', members: ['codex','claude'] }); let starts = 0;
  await page.route('**/api/v1/planning', async (route) => { starts++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group); await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  const start = page.getByRole('button', { name: 'Start Plan', exact: true }); const ready = page.getByLabel('Ready for planning');
  const reason = page.getByRole('region', { name: 'Plan setup' }).getByRole('status');
  await expect(start).toBeDisabled(); await expect(reason).toHaveText('Enter the shared task brief.');
  await expect(start).toHaveAccessibleDescription('Enter the shared task brief.');
  // Ticking Ready first and typing afterwards is the sequence that used to fail silently.
  await ready.check(); await page.getByLabel('Shared task brief').fill('Plan a scoped feature.');
  await expect(ready).not.toBeChecked(); await expect(start).toBeDisabled();
  await expect(reason).toHaveText(/Confirm Ready for planning\. Changing the brief, a setting or the checkout clears an earlier confirmation\./);
  await expect(start).toHaveAccessibleDescription(/Confirm Ready for planning/); await expect(start).toHaveAttribute('title', /Confirm Ready for planning.*Start document-only planning\./);
  await ready.check(); await expect(reason).toHaveCount(0); await expect(start).toBeEnabled(); await expect(start).toHaveAttribute('title', 'Start document-only planning.');
  await page.getByText('Collaboration settings', { exact: true }).click(); await page.getByLabel('Maximum automatic turns across both phases').fill('0');
  await expect(ready).not.toBeChecked(); await expect(reason).toHaveText('Set the maximum automatic turns to a whole number from 1 to 200.');
  await page.getByLabel('Maximum automatic turns across both phases').fill('20'); await ready.check(); await expect(reason).toHaveCount(0);
  await start.click(); await expect.poll(() => starts).toBe(1);
});
test('a refused Start Plan shows the server reason beside its button and Recheck clears it', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Planners', members: ['codex','claude'] }); let starts = 0;
  await page.route('**/api/v1/planning', async (route) => { starts++; await route.fulfill({ status: 409, json: { error: { message: 'Planning must preserve its clean branch and code baseline.' } } }); });
  await openGroup(page, group); await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Plan setup' });
  await page.getByLabel('Shared task brief').fill('Plan a scoped feature.'); await page.getByLabel('Ready for planning').check();
  await page.getByRole('button', { name: 'Start Plan', exact: true }).click(); await expect.poll(() => starts).toBe(1);
  // The refusal appears beside Start Plan, not only in the console message below the history.
  await expect(setup.getByRole('alert')).toHaveText('Planning must preserve its clean branch and code baseline.');
  await expect(page.getByRole('status').filter({ hasText: 'Planning must preserve' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recheck', exact: true }).click(); await expect(setup.getByRole('alert')).toHaveCount(0);
});
test('solo Plan can preauthorize automatic Implementation without creating a second planner', async ({ page, request }) => {
  await post(request, 'sessions', { paneId: '%3', label: 'Solo worker' });
  const group = await post(request, 'groups', { name: 'Solo plan', members: ['solo-worker'] }); let start: PlanStart | null = null;
  await page.route('**/api/v1/planning', async (route) => { start = route.request().postDataJSON(); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group); await page.getByRole('button', { name: '1 · Plan', exact: true }).click();
  await page.getByLabel('Shared task brief').fill('Plan first, then implement.');
  await page.getByText('Collaboration settings', { exact: true }).click(); await page.getByLabel('Require my approval before implementation').uncheck();
  await page.getByLabel('Pause on a reviewer objection').check();
  await page.getByLabel('Implementation branch', { exact: true }).selectOption('new'); await page.getByLabel('New branch name').fill('task/after-plan');
  await page.getByLabel('Ready for planning').check(); await page.getByRole('button', { name: 'Start Plan', exact: true }).click();
  await expect.poll(() => start).toMatchObject({ autoContinue: true, requireApproval: false, pauseOnObjection: true, implementation: { policy: 'solo', branch: { newBranch: 'task/after-plan' } } });
});
async function checkpoint(page: Page, request: APIRequestContext, consent: 'upfront' | 'deferred' = 'upfront') {
  const group = await post(request, 'groups', { name: 'Plan checkpoint', members: ['codex', 'claude'] }) as Group;
  const state: WorkflowState = await (await request.get('/api/v1/state', { headers })).json(); const participants = group.members.map((id) => state.sessions.find((s) => s.id === id)!);
  const id = randomUUID(); const baseline = { branch: 'main', head: 'a'.repeat(40) };
  const registrations = Object.fromEntries(participants.map((p) => [p.id, p.registrationId]));
  const input: PlanStart = { requestId: id, groupId: group.id, groupRevision: 1, registrations, text: 'Plan the feature.', baseline, autoContinue: true, requireApproval: true, turnLimit: 20,
    // main is an integration branch, so recorded consent is always a new task branch; deferred consent is collected at the checkpoint.
    implementation: { groupId: group.id, groupRevision: 1, registrations, agentId: 'codex', policy: 'peer', handoff: true, branch: consent === 'upfront' ? { ...baseline, newBranch: 'task/planned' } : null }, confirmReady: true };
  const plan = newPlanning(input, group, participants, participants, '/demo/project', '/demo/data/plans');
  plan.current = { text: '# Shared plan\nImplement the scoped feature and test recovery.\n', hash: 'b'.repeat(64), path: plan.planPath, revision: 1, briefRevision: 1, author: 'codex', commandId: id };
  for (const member of group.members) { plan.drafts[member]!.status = 'finalized'; plan.drafts[member]!.document = { text: `Initial ${member} approach`, hash: 'c'.repeat(64) }; }
  plan.endorsements = { codex: 1, claude: 1 }; plan.step = 'checkpoint'; plan.next = null;
  const run: RelayRun = { id, repository: '/demo/project', lockKey: '/demo/project/.git/index', pairId: null, participants, planning: plan, status: 'waiting', reason: 'Plan agreed. Awaiting your approval before Implementation.',
    autoContinue: true, pauseOnObjection: false, pauseRequested: false, currentCommandId: id, automaticTurns: 3, turnLimit: 20, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await page.route('**/api/v1/state', async (route) => { const response = await route.fetch(); const data = await response.json(); await route.fulfill({ json: { ...data, runs: [run], executions: [] } }); });
  await openGroup(page, group); return run;
}
test('deferred checkpoint consent on an integration branch offers only a new task branch', async ({ page, request }) => {
  await checkpoint(page, request, 'deferred'); const decisions: PlanDecision[] = [];
  await page.route('**/api/v1/planning/decision', async (route) => { decisions.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  const consent = page.getByLabel('Implementation branch consent', { exact: true });
  await expect(consent.locator('option[value="stay"]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Plan progress' })).toContainText('main is an integration branch');
  await page.getByLabel('Ready for plan decision').check();
  await expect(page.getByRole('button', { name: 'Approve & implement', exact: true })).toBeDisabled();
  // Choosing the branch changes the consent key, so readiness must be confirmed again against the displayed choice.
  await consent.selectOption('new'); await page.getByLabel('New implementation branch').fill('task/after-checkpoint');
  await expect(page.getByLabel('Ready for plan decision')).not.toBeChecked(); await page.getByLabel('Ready for plan decision').check();
  await page.getByRole('button', { name: 'Approve & implement', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1); expect(decisions[0]).toMatchObject({ action: 'approve', branch: { branch: 'main', head: 'a'.repeat(40), newBranch: 'task/after-checkpoint' } });
});
test('checkpoint shows the captured version; a changed version revokes UI confirmation before approval', async ({ page, request }, info) => {
  const run = await checkpoint(page, request); const decisions: PlanDecision[] = [];
  await page.route('**/api/v1/planning/decision', async (route) => { decisions.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await expect(page.getByLabel('Captured shared plan')).toContainText('test recovery');
  await page.getByLabel('Ready for plan decision').check();
  run.planning!.current!.revision = 2; run.planning!.current!.hash = 'd'.repeat(64); run.planning!.endorsements = { codex: 2, claude: 2 };
  await expect(page.getByLabel('Ready for plan decision')).not.toBeChecked({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Approve & implement', exact: true })).toBeDisabled();
  await page.getByLabel('Ready for plan decision').check();
  await page.screenshot({ path: info.outputPath('plan-checkpoint.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve & implement', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1); expect(decisions[0]).toMatchObject({ action: 'approve', expectedRevision: 2, expectedHash: 'd'.repeat(64), expectedBriefRevision: 1, confirmReady: true });
});
test('checkpoint changes name a planner; disagreement requires an explicit override reason', async ({ page, request }) => {
  const run = await checkpoint(page, request); run.planning!.objections = { claude: 'Scope remains unclear.' }; delete run.planning!.endorsements.claude;
  const decisions: PlanDecision[] = []; await page.route('**/api/v1/planning/decision', async (route) => { decisions.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  await expect(page.getByLabel('Plan override reason')).toBeVisible(); await page.getByLabel('Ready for plan decision').check();
  await expect(page.getByRole('button', { name: 'Override & implement', exact: true })).toBeDisabled();
  await page.getByText('Request changes to the plan', { exact: true }).click(); await page.getByLabel('Planner for changes').selectOption('claude');
  await page.getByLabel('Requested plan changes').fill('Clarify the supported scope.'); await page.getByLabel('Ready for plan decision').check();
  await page.getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(1); expect(decisions[0]).toMatchObject({ action: 'changes', agentId: 'claude', text: 'Clarify the supported scope.' });
});
