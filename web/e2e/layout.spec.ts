import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Group, ImplementationStart, StandaloneStart } from '../src/contracts/implementation';
import type { WorkflowState } from '../src/contracts/workflow';
import { observationTransport, backToControl, expandWorktree, editSettings, expand, openAccess, openCard, pane, readiness, showSurface } from './ui';
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
  await expandWorktree(page, group.repository.split('/').pop()!); await page.getByRole('button', { name: `Open ${group.cwd!.split('/').pop()}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
}
/** A task branch with `changes` uncommitted paths, so committed follow-ups need no further branch choice. */
async function taskBranch(page: Page, changes = 0) {
  await page.route('**/api/v1/workspaces', async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const workspace of data.workspaces) Object.assign(workspace.git, { branch: 'task/current', integration: false, stageRelay: { eligible: false, reason: 'A task branch uses committed handoffs.' }, taskBase: 'b'.repeat(40), clean: !changes,
      changes: Array.from({ length: changes }, (_, i) => ({ status: ' M', path: `src/file${i}.ts`, originalPath: null })), changeCount: changes });
    await route.fulfill({ json: data });
  });
}
/** Records every request that could start or change work; previews and reads are not mutations. */
function mutations(page: Page) {
  const sent: string[] = [];
  page.on('request', (outgoing) => {
    const path = new URL(outgoing.url()).pathname;
    if (outgoing.method() !== 'GET' && !observationTransport(outgoing.url()) && !path.endsWith('/implementation/preview')) sent.push(`${outgoing.method()} ${path}`);
  });
  return sent;
}
test('a typed instruction explains the disabled Send and readiness enables it without claiming keyboard', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Send readiness hint', members: ['codex','claude'] });
  await openGroup(page, group);
  const sent = mutations(page), actions = await openCard(page, 'Codex');
  const draft = actions.getByLabel('Instruction for Codex'), send = actions.getByRole('button', { name: 'Send Codex', exact: true });
  const hint = actions.getByRole('status');
  await expect(hint).toHaveCount(0);
  await draft.fill('Explain the change.'); await expect(send).toBeDisabled();
  await expect(hint).toContainText('Send Codex is disabled.');
  await expect(hint).toContainText('Ready for implementation” above');
  await expect(send).toHaveAccessibleDescription(/Ready for implementation” above/);
  await expect(page.locator('.page-heading').getByRole('img', { name: 'Input: 0 active', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('disabled-send-hint.png'), fullPage: true });
  await draft.fill('   '); await expect(hint).toHaveCount(0);
  await draft.fill('Explain the change.');
  // The check is beside the action; nothing in Control access is needed.
  await expect(hint.getByRole('button', { name: 'Go to Control access', exact: true })).toHaveCount(0);
  const ready = actions.getByLabel('Ready for implementation', { exact: true });
  await expect(ready).toBeVisible(); await expect(ready).not.toBeChecked();
  await expect(ready.locator('..')).toContainText('Ready for implementation'); // The name is visible, not just an accessibility label.
  await expect(send).toBeDisabled(); await expect(draft).toHaveValue('Explain the change.');
  await ready.check();
  await expect(send).toBeEnabled(); await expect(hint).toHaveCount(0); await expect(ready).toBeChecked();
  await expect(page.getByRole('region', { name: 'Control access', exact: true })).toBeHidden();
  await expect(draft).toHaveValue('Explain the change.');
  await expect(page.locator('.page-heading').getByRole('img', { name: 'Input: 0 active', exact: true })).toBeVisible();
  expect(sent).toEqual([]);
});
test('worktree recovery sits beside its selector while the heading keeps host status', async ({ page }, info) => {
  await unlock(page);
  const heading = page.locator('.page-heading'), context = page.locator('.context-bar');
  const entry = context.getByRole('button', { name: /^Control access · / }), keyboard = heading.getByRole('img', { name: /^Input: / });
  await expect(entry).toBeVisible(); await expect(keyboard).toBeVisible();
  await expect(heading.getByRole('button', { name: /^Control access/ })).toHaveCount(0);
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(entry).toBeVisible(); await expect(context.getByRole('combobox', { name: 'Switch worktree' })).toBeVisible();
    expect(await context.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
  await context.screenshot({ path: info.outputPath('worktree-control-access.png') });
});
test('the Agent selector switches the shown terminal and Control together and keeps each draft', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Agent selector', members: ['codex','claude'] });
  await taskBranch(page, 2); await openGroup(page, group); await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const sent = mutations(page);
  const agents = page.getByRole('navigation', { name: 'Agent' }), control = page.getByRole('region', { name: 'Control', exact: true });
  for (const [name, other] of [['Codex', 'Claude'], ['Claude', 'Codex']] as const) {
    await agents.getByRole('button', { name, exact: true }).click(); await showSurface(page, 'Terminal');
    await expect(agents.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel(`${name} native output`)).toBeVisible(); await expect(page.getByLabel(`${other} native output`)).toBeHidden();
    // The same selection is the Control recipient; the switch shows Control in place of the terminals.
    const section = await openCard(page, name);
    await expect(page.getByLabel(`${name} native output`)).toBeHidden();
    await expect(control.locator('.control-heading h2')).toHaveText(`Control · ${name}`);
    await section.getByLabel(`Instruction for ${name}`).fill(`${name} draft`);
  }
  // Control has no recipient picker of its own, and no card offers a separate retarget shortcut.
  await expect(control.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /in control pane$/ })).toHaveCount(0);
  await expect((await openCard(page, 'Codex')).getByLabel('Instruction for Codex')).toHaveValue('Codex draft');
  await expect((await openCard(page, 'Claude')).getByLabel('Instruction for Claude')).toHaveValue('Claude draft');
  expect(sent).toEqual([]);
  await control.screenshot({ path: info.outputPath('control-agent.png') });
});
for (const mode of ['send', 'stage'] as const) test(`Parallel Control shows both agents with separate drafts and readiness (${mode})`, async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Parallel controls', members: ['codex','claude'] });
  const sent: StandaloneStart[] = [];
  await page.route('**/api/v1/instructions', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  if (mode === 'send') await taskBranch(page);
  await openGroup(page, group); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  if (mode === 'send') await openCard(page, 'Codex'); else await showSurface(page, 'Control');
  const draft = (name: string) => page.getByLabel(`${mode === 'send' ? 'Instruction for' : 'Instruction to'} ${name}`, { exact: true });
  const codex = draft('Codex'), claude = draft('Claude');
  await expect(codex).toBeVisible(); await expect(claude).toBeVisible();
  const a = (await codex.boundingBox())!, b = (await claude.boundingBox())!;
  if (info.project.name === 'desktop') { expect(Math.abs(a.y - b.y)).toBeLessThan(3); expect(b.x).toBeGreaterThan(a.x + a.width); }
  else { expect(b.y).toBeGreaterThan(a.y + a.height); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }
  await codex.fill('Codex only'); await claude.fill('Claude only');
  const ready = await readiness(page, mode === 'send' ? 'Ready for implementation' : 'Ready to send');
  await expect(ready).toHaveCount(1); await ready.check();
  await expect(page.getByRole('button', { name: 'Send Claude', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send Codex', exact: true })).toBeDisabled();
  await codex.click(); await expect(ready).not.toBeChecked();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(codex).toBeVisible(); await expect(claude).toBeHidden();
  await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await expect(codex).toHaveValue('Codex only'); await expect(claude).toHaveValue('Claude only');
  expect(sent).toEqual([]);
  await page.getByRole('region', { name: 'Control', exact: true }).screenshot({ path: info.outputPath(`parallel-${mode}.png`) });
  await ready.check(); await page.getByRole('button', { name: 'Send Codex', exact: true }).click(); await backToControl(page);
  expect(sent).toMatchObject([{ agentId: 'codex', text: 'Codex only' }]);
  await expect(codex).toHaveValue(''); await expect(claude).toHaveValue('Claude only');
  await claude.click(); await ready.check(); await page.getByRole('button', { name: 'Send Claude', exact: true }).click(); await backToControl(page);
  expect(sent).toMatchObject([{ agentId: 'codex', text: 'Codex only' }, { agentId: 'claude', text: 'Claude only' }]);
});
test('outside Plan one frame shows the terminals or Control; the hidden surface stays mounted and switching sends nothing', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'One frame', members: ['codex','claude'] });
  await taskBranch(page);
  await openGroup(page, group);
  const sent = mutations(page);
  const surface = page.getByRole('group', { name: 'Terminal or Control' });
  await expect(surface.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Pane layout' })).toBeVisible(); await expect(page.getByRole('region', { name: 'Control', exact: true })).toHaveCount(0);
  const codex = await openCard(page, 'Codex');
  // Control replaces the terminals: they stay mounted but leave the page and the accessibility tree. Parallel/Focus applies to both surfaces.
  await expect(page.getByRole('group', { name: 'Pane layout' })).toBeVisible();
  await expect(page.locator('section.panes')).toHaveAttribute('hidden', ''); await expect(page.getByRole('region', { name: 'Agent output' })).toHaveCount(0);
  await expect(page.locator('article.pane')).toHaveCount(2);
  await expect(page.getByRole('group', { name: 'Codex status' })).toBeVisible(); // the selected agent's activity stays on screen
  await codex.getByLabel('Instruction for Codex').fill('Keep this draft');
  const ready = await readiness(page); await ready.check();
  await showSurface(page, 'Terminal'); await expect(ready).toBeHidden();
  await expect(page.locator('section#altcli-control')).toHaveAttribute('hidden', ''); await expect(page.getByRole('region', { name: 'Control', exact: true })).toHaveCount(0);
  await expect((await openCard(page, 'Codex')).getByLabel('Instruction for Codex')).toHaveValue('Keep this draft');
  await expect(ready).not.toBeChecked(); // switching surfaces revoked it
  // Plan keeps its own layout: no switch, and Control follows the stage.
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(surface).toHaveCount(0); await expect(page.getByRole('region', { name: 'Agent output' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plan setup' })).toBeVisible();
  expect(sent).toEqual([]);
});
test('Control access stays in the worktree console; viewing it sends nothing, and readiness stays beside the action', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Access', members: ['codex','claude'] });
  await taskBranch(page);
  await openGroup(page, group);
  const sent = mutations(page);
  const entry = page.getByRole('button', { name: /^Control access · / });
  await expect(entry).toHaveAccessibleName('Control access · you'); await expect(entry).toHaveAttribute('aria-expanded', 'false');
  const access = await openAccess(page); await expect(access).toBeFocused();
  // Control access explains holds; it hosts no readiness check. With the terminals shown it offers Show Control, itself a view change.
  await expect(access.getByRole('checkbox')).toHaveCount(0);
  await expect(access.getByRole('region', { name: 'Action readiness' }).or(access.locator('[aria-label="Action readiness"]'))).toContainText('Readiness is checked next to each action');
  await access.getByRole('button', { name: 'Show Control', exact: true }).click();
  const codex = page.getByRole('region', { name: 'Actions for Codex', exact: true });
  await codex.getByLabel('Instruction for Codex').fill('Explain the change.');
  // The composer's one check, with what it authorizes, is beside its Send.
  const ready = codex.getByLabel('Ready for implementation', { exact: true });
  await expect(codex.getByRole('checkbox')).toHaveCount(1); await expect(codex.getByRole('status')).toContainText('Ready for implementation” above');
  await ready.check(); await expect(codex.getByRole('group', { name: 'Readiness for Codex' })).toContainText('Send Codex');
  // Closing, reopening and returning to the already visible action keep a current confirmation.
  await entry.click(); await expect(access).toBeHidden(); await expect(entry).toBeFocused();
  await entry.click(); await expect(ready).toBeChecked();
  await access.getByRole('button', { name: 'Return to action', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Control', exact: true })).toBeFocused(); await expect(ready).toBeChecked();
  await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
  // Worktree recovery leaves the page on global tabs; switching tabs revokes readiness.
  const sections = page.getByRole('navigation', { name: 'Sections' });
  for (const name of ['Projects', 'Settings', 'Agents']) {
    await sections.getByRole('button', { name, exact: true }).click();
    await expect(access).toBeHidden(); await expect(entry).toBeHidden(); await expect(ready).toBeHidden();
  }
  await sections.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(access).toBeVisible(); await expect(codex).toBeVisible(); await expect(ready).not.toBeChecked();
  expect(sent).toEqual([]);
});
test('one control pane keeps per-target drafts; After send maps to a plain Send, work with commit, or work with commit and relay', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Card actions', members: ['codex','claude'] });
  await taskBranch(page, 2);
  const starts: ImplementationStart[] = []; const sent: StandaloneStart[] = [];
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/instructions', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  // One mounted Control section, shown in the frame only when Control is selected.
  await expect(page.locator('section#altcli-control')).toHaveCount(1); await expect(page.getByRole('region', { name: 'Control', exact: true })).toHaveCount(0);
  await expect(page.locator('article.pane .pane-actions')).toHaveCount(0);
  const claude = await openCard(page, 'Claude');
  await expect(page.getByRole('region', { name: 'Control', exact: true })).toHaveCount(1);
  await claude.getByLabel('Instruction for Claude').fill('Fix the parser.');
  await claude.getByLabel('After send').selectOption('commit');
  const sendCommit = claude.getByRole('button', { name: 'Send & commit Claude', exact: true });
  await expect(claude.locator('.pane-line')).toContainText('including the 2 uncommitted paths already present');
  await (await readiness(page)).check(); await sendCommit.click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: 'claude', kind: 'work', text: 'Fix the parser.', handoff: false, autoContinue: false, policy: 'peer', branch: { branch: 'task/current', head: 'a'.repeat(40) } });
  expect(starts[0]).not.toHaveProperty('reviewBase');
  // An accepted start shows the terminals again; Control keeps its drafts behind the switch.
  await backToControl(page); await expect(claude.getByLabel('Instruction for Claude')).toHaveValue(''); // a started instruction clears only its own draft
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Add the retry.');
  await codex.getByLabel('After send').selectOption('commit_relay');
  await codex.getByLabel('Relay note for Claude').fill('Check the retry path first.');
  // New work is reviewed from the pre-send HEAD; no existing-commit baseline is attached to it.
  await expect(codex.getByLabel('Review baseline')).toBeHidden();
  await expect(codex.locator('.pane-line')).toContainText('Claude reviews only what Codex commits');
  await (await readiness(page)).check();
  await codex.getByRole('button', { name: 'Send & commit Codex → relay Claude', exact: true }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toMatchObject({ agentId: 'codex', kind: 'work', text: 'Add the retry.', handoff: true, autoContinue: true, policy: 'peer', reviewNote: 'Check the retry path first.' });
  expect(starts[1]).not.toHaveProperty('reviewBase');
  await backToControl(page); await expect(codex.getByLabel('Relay note for Claude')).toHaveValue(''); // consumed with the start
  await codex.getByLabel('Instruction for Codex').fill('Only explain.'); await codex.getByLabel('After send').selectOption('nothing');
  await (await readiness(page)).check(); await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ agentId: 'codex', text: 'Only explain.', policy: 'peer' }); expect(sent[0]).not.toHaveProperty('branch');
  // Fixed roles: only the worker's card sends; the reviewer's card only reviews.
  await editSettings(page); await page.getByLabel('Collaboration', { exact: true }).selectOption('worker_reviewer');
  await page.getByLabel('Worker', { exact: true }).selectOption('claude');
  await page.getByLabel('Automatic collaboration after the initial review').uncheck();
  const reviewer = await openCard(page, 'Codex');
  await expect(reviewer.getByLabel('After send')).toHaveCount(0); await expect(reviewer.getByRole('button', { name: /^Send / })).toHaveCount(0);
  await expect(reviewer).toContainText('Reviewer: reviews without editing project files');
  const worker = await openCard(page, 'Claude');
  await worker.getByLabel('Instruction for Claude').fill('Implement the fix.'); await worker.getByLabel('After send').selectOption('commit_relay');
  await (await readiness(page)).check(); await worker.getByRole('button', { name: 'Send & commit Claude → relay Codex', exact: true }).click();
  await expect.poll(() => starts.length).toBe(3);
  expect(starts[2]).toMatchObject({ agentId: 'claude', workerId: 'claude', policy: 'worker_reviewer', kind: 'work', handoff: true, autoContinue: false });
});
test('on main After send offers only Nothing and Stage relay, even with a new branch prepared', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'From main', members: ['codex','claude'] });
  const starts: ImplementationStart[] = []; let sent = 0;
  await page.route('**/api/v1/implementation', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await page.route('**/api/v1/instructions', async (route) => { sent++; await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group);
  const codex = await openCard(page, 'Codex'); const ready = (await readiness(page));
  await codex.getByLabel('Instruction for Codex').fill('Start the task.');
  const after = codex.getByLabel('After send');
  await expect(after.locator('option')).toHaveText(['Nothing', 'Stage relay']);
  await after.selectOption('stage_relay'); await ready.check();
  await expect(codex.getByRole('button', { name: 'Send Codex & stage-relay to Claude', exact: true })).toBeEnabled();
  // The Settings toggle stays where it is when the editor opens below the summary row.
  const toggle = page.getByRole('region', { name: 'Implementation settings' }).getByRole('button', { name: 'Settings', exact: true });
  const place = () => toggle.evaluate((element) => { const box = element.getBoundingClientRect(); return [Math.round(box.left + window.scrollX), Math.round(box.top + window.scrollY)]; });
  const before = await place(); await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await place()).toEqual(before); await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await after.selectOption('nothing'); await expect(ready).not.toBeChecked();
  await ready.check(); await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
  await toggle.click();
  await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/from-send');
  await expect(after.locator('option')).toHaveText(['Nothing', 'Stage relay']);
  await ready.check(); await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect.poll(() => sent).toBe(1); expect(starts).toEqual([]);
});
test('readiness is one slot, revoked by After send, view switches and runs, and old values never revive it', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'One slot', members: ['codex','claude'] });
  await taskBranch(page);
  await openGroup(page, group); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await openCard(page, 'Codex'); const ready = await readiness(page);
  await expect(ready).toHaveCount(1); await ready.check();
  // Both composers are mounted, but only the selected agent's card shows its check; choosing another agent revokes it.
  const claude = await openCard(page, 'Claude');
  await expect(ready).toHaveCount(1); await expect(ready).not.toBeChecked();
  await ready.check();
  await claude.getByLabel('After send').selectOption('commit'); await expect(ready).not.toBeChecked();
  await claude.getByLabel('After send').selectOption('nothing'); await expect(ready).not.toBeChecked();
  // The Terminal/Control switch is a view change, and the check is offered only while Control shows its action.
  await ready.check(); await showSurface(page, 'Terminal'); await expect(ready).toBeHidden();
  await (await openAccess(page)).getByRole('button', { name: 'Show Control', exact: true }).click();
  await expect(ready).not.toBeChecked(); await ready.check();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
  await expect(ready).not.toBeChecked();
  await ready.check();
  // A run started elsewhere (another card or client) revokes it too, even after that run is released. The run does not block:
  // the fresh check lists that proceeding ends it.
  const id = crypto.randomUUID();
  await post(request, 'commands', { requestId: id, agentId: 'codex', kind: 'instruction', text: 'Elsewhere', confirmReady: true, pairId: group.id, stage: { branch: 'main', head: 'a'.repeat(40) } });
  await expect(ready).not.toBeChecked({ timeout: 10000 }); await expect(ready).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Control', exact: true }).getByRole('list', { name: 'Consequences of proceeding' })).toContainText('run for Codex ⇄ Claude ends');
  await ready.check();
  await post(request, 'runs', { runId: id, action: 'takeover', confirmReady: true });
  await expect(ready).not.toBeChecked({ timeout: 10000 }); await expect(ready).toBeEnabled();
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
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click(); await page.getByLabel('Shared task brief').fill('Plan draft');
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Implementation', exact: true }).click();
  await showSurface(page, 'Terminal'); await page.getByRole('button', { name: 'Focus', exact: true }).click(); await openCard(page, 'Codex');
  await showSurface(page, 'Terminal'); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  // Visit another workspace and come back: each keeps its own drafts, never another's.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project other', exact: true }).click(); await expandWorktree(page, 'other'); await page.getByRole('button', { name: 'Open other', exact: true }).click();
  await expect(page.getByLabel('Instruction for Codex')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Project project', exact: true }).click(); await expandWorktree(page, 'project'); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  const back = await openCard(page, 'Codex');
  await expect(back.getByLabel('Instruction for Codex')).toHaveValue('Codex draft'); await expect(back.getByLabel('After send')).toHaveValue('commit');
  await expect(back.getByLabel('Review context for Codex (optional)')).toBeVisible(); await expect(back.getByLabel('Review context for Codex (optional)')).toHaveValue('Check the parser.');
  await expect((await openCard(page, 'Claude')).getByLabel('Instruction for Claude')).toHaveValue('Claude draft');
  await expect(page.getByLabel('New branch name')).toBeVisible(); await expect(page.getByLabel('New branch name')).toHaveValue('task/draft');
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click(); await expect(page.getByLabel('Shared task brief')).toHaveValue('Plan draft');
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
test('Lock forgets drafts and settings within the same document and revokes terminal connections', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Lock drafts', members: ['codex','claude'] });
  const sent = mutations(page);
  await openGroup(page, group);
  await editSettings(page); await page.getByLabel('Implementation branch').selectOption('new'); await page.getByLabel('New branch name').fill('task/locked-away');
  await page.getByLabel('Pause on a reviewer objection').check();
  const codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Secret draft'); await codex.getByLabel('After send').selectOption('stage_relay');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  // Unlock in the same document, without navigating or reloading: hooks that stay mounted must not keep the old values.
  await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  // Lock also forgets the Terminal/Control choice: the frame starts on Terminal again.
  await expect(page.getByRole('group', { name: 'Terminal or Control' }).getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const back = await openCard(page, 'Codex');
  await expect(back.getByLabel('Instruction for Codex')).toHaveValue(''); await expect(back.getByLabel('After send')).toHaveValue('nothing');
  await editSettings(page);
  await expect(page.getByLabel('Implementation branch')).toHaveValue(''); await expect(page.getByLabel('New branch name')).toHaveCount(0);
  await expect(page.getByLabel('Pause on a reviewer objection')).not.toBeChecked();
  expect(sent).toEqual(['POST /api/v1/terminals/revoke']);
});
test('Settings shows the effective host configuration and the console preference; Helper holds the general explanation', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Tabs', members: ['codex','claude'] });
  await openGroup(page, group);
  // Neither the deprecated toggle nor the general explanation belongs in the Console.
  await expect(page.locator('summary').filter({ hasText: /^(Advanced|How this works)$/ })).toHaveCount(0);
  const sections = page.getByRole('navigation', { name: 'Sections', exact: true });
  await sections.getByRole('button', { name: 'Settings', exact: true }).click();
  // Console preferences is the first subtab and opens by default; Host configuration is one click away.
  const subtabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(subtabs.getByRole('button')).toHaveText(['Console preferences', 'Host configuration']);
  await expect(subtabs.getByRole('button', { name: 'Console preferences', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const host = page.getByRole('region', { name: 'Host configuration' });
  await expect(page.getByRole('region', { name: 'Console preferences' })).toBeVisible(); await expect(host).toBeHidden();
  await subtabs.getByRole('button', { name: 'Host configuration', exact: true }).click();
  await expect(host).toContainText('READ AT START'); await expect(host).toContainText('restart the host');
  const row = (name: string) => host.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  await expect(row('Adapter')).toContainText('mock (simulated panes)'); await expect(row('Adapter')).toContainText('ALTCLI_ADAPTER (set)');
  await expect(row('Data store')).toContainText(/altcli-e2e-\d+-\d+\/mock/); await expect(row('Data store')).toContainText('ALTCLI_DATA_DIR (set)');
  await expect(row('tmux binary')).toContainText('ALTCLI_TMUX_BIN · default tmux from PATH');
  await expect(row('Integration branches')).toContainText(`main, master + each project's default branch`);
  await expect(row('Stage relay')).toContainText('enabled on main and each project\'s default branch'); await expect(row('Stage relay')).toContainText('ALTCLI_ENABLE_LEGACY_RELAY (set)');
  await expect(host).not.toContainText('a'.repeat(64)); // the token never reaches the page
  await subtabs.getByRole('button', { name: 'Console preferences', exact: true }).click();
  const preferences = page.getByRole('region', { name: 'Console preferences' });
  await expect(preferences.getByLabel('Staging fallback', { exact: true })).toHaveCount(0); // Stage relay is offered in Control on main, not as a preference
  // Settings keeps no profile editor: each kind's profiles live under Agents, which the preferences link to.
  await expect(preferences.getByRole('region', { name: 'Launch profiles' })).toHaveCount(0);
  await expect(preferences.getByRole('button', { name: /^Agents → / })).toHaveText(['Agents → Workspace agents → Profiles', 'Agents → Helper → Profiles', 'Agents → Background assistant → Profiles']);
  await sections.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  const kinds = page.getByRole('navigation', { name: 'Agent kinds' });
  // The Background kind also shows how many attention items are not yet seen.
  await expect(kinds.getByRole('button')).toHaveText(['Workspace agents', 'Helper', /^Background assistant/]);
  await kinds.getByRole('button', { name: 'Helper', exact: true }).click();
  // Helper opens on Chat; Guide explains worktree controls without showing them globally.
  const helper = page.getByRole('navigation', { name: 'Helper sections' });
  await expect(helper.getByRole('button')).toHaveText(['Chat', 'Session', 'Profiles', 'Evidence', 'Guide']);
  await expect(helper.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await helper.getByRole('button', { name: 'Guide', exact: true }).click();
  await expect(page.getByRole('region', { name: 'How this works' })).toContainText('No effect in this page sends commands');
  await expect(page.getByRole('button', { name: /^Control access/ })).toHaveCount(0);
  await sections.getByRole('button', { name: 'Console', exact: true }).click(); await showSurface(page, 'Control');
  await expect(page.getByRole('region', { name: 'Stage relay', exact: true })).toBeVisible(); // main's default Control action
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
  await codex.getByLabel('Instruction for Codex').fill('Do it once.'); await (await readiness(page)).check();
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
test('each agent has a Send control in the shared Control frame', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The two-card viewport target applies to a desktop window.');
  await page.setViewportSize({ width: 1440, height: 900 });
  const group = await post(request, 'groups', { name: 'Viewport', members: ['codex','claude'] });
  await openGroup(page, group);
  for (const name of ['Codex', 'Claude']) {
    const send = (await openCard(page, name)).getByRole('button', { name: `Send ${name}`, exact: true });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('region', { name: 'Control', exact: true }).locator('.pane-actions')).toHaveCount(2);
    // A safety margin, so added chrome above the panes fails here before it clips a Send button.
    const box = (await send.boundingBox())!;
    expect(900 - (box.y + box.height), `${name} Send margin`).toBeGreaterThanOrEqual(16);
  }
  await page.screenshot({ path: info.outputPath('console-1440x900.png') });
});
test('terminal captures are taller, grow with the window, and stand apart from settings and commands', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'Window heights are resized from the desktop project.');
  await page.setViewportSize({ width: 1440, height: 900 });
  const group = await post(request, 'groups', { name: 'Stage', members: ['codex','claude'] });
  await openGroup(page, group);
  const height = (name: string) => page.getByLabel(`${name} output`).evaluate((el) => el.clientHeight);
  const background = (element: Locator) => element.evaluate((el) => getComputedStyle(el).backgroundColor);
  const stage = page.locator('.terminal-stage');
  await expect(stage.getByRole('heading', { name: /^Native terminals/ })).toBeVisible(); // the e2e hosts enable ALTCLI_ENABLE_TERMINAL
  await expect(stage.getByRole('navigation', { name: 'Agent' })).toBeVisible();
  // Guards only: the watch, command and settings surfaces differ; exact colours are a design choice.
  expect(await background(stage)).not.toBe(await background(page.getByRole('region', { name: 'Implementation settings' })));
  for (const name of ['Codex', 'Claude']) {
    await stage.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name, exact: true }).click(); await showSurface(page, 'Terminal');
    await page.getByRole('region',{name:`${name} terminal`,exact:true}).getByRole('button',{name:'Captured text',exact:true}).click();
    expect(await height(name), `${name} capture at 1440×900`).toBeGreaterThanOrEqual(252);
    const actions = await openCard(page, name);
    expect(await background(page.getByLabel(`${name} output`))).not.toBe(await background(actions));
    await expect(actions.locator('.zone-label')).toHaveText(`⌨️ Command · Send to ${name}`);
  }
  await showSurface(page, 'Terminal'); const parallel = await height('Codex');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect.poll(() => page.locator('article.pane:not([hidden]) pre').evaluate((el) => el.clientHeight)).toBeGreaterThan(parallel);
  await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await expect.poll(() => height('Codex')).toBeGreaterThan(parallel);
});
test('terminal tool help starts at its control and stays inside the pane', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Hover bubbles are measured in a desktop window.');
  await unlock(page);
  const tools = page.getByRole('region', { name: 'Codex terminal', exact: true }).locator('.terminal-tools > .hint');
  const card = (await pane(page, 'Codex').boundingBox())!;
  await expect(tools.last().getByRole('button', { name: 'Terminal tools help' })).toBeVisible();
  for (const hint of await tools.all()) {
    const control = hint.locator('> :first-child'); await control.hover();
    const at = (await control.boundingBox())!, bubble = (await hint.getByRole('tooltip').boundingBox())!;
    const name = await control.getAttribute('aria-label');
    expect(Math.abs(bubble.x - at.x), `${name} bubble starts at its control`).toBeLessThanOrEqual(1);
    expect(bubble.x + bubble.width, `${name} bubble fits the pane`).toBeLessThanOrEqual(card.x + card.width);
  }
});
test('Plan setup sits below the terminal stage, behind a command divider', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'The Plan screenshot is taken on a desktop window.');
  await page.setViewportSize({ width: 1440, height: 900 });
  const group = await post(request, 'groups', { name: 'Plan divider', members: ['codex','claude'] });
  await openGroup(page, group); await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Plan setup' });
  await expect(setup).toBeVisible();
  // Plan setup is the one control addressed to the whole group, whichever agent is selected.
  await expect(page.locator('.control-heading h2')).toHaveText('Control · All agents');
  expect(await setup.evaluate((el) => ({
    outside: !el.closest('.terminal-stage'),
    after: !!(document.querySelector('.terminal-stage')!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
    divider: !!el.previousElementSibling?.matches('.command-divider[aria-hidden="true"]'),
    zone: el.classList.contains('command-zone'),
  }))).toEqual({ outside: true, after: true, divider: true, zone: true });
  await page.screenshot({ path: info.outputPath('console-plan-1440x900.png') });
});
test('the settings row wraps inside its panel at intermediate widths, with the Settings toggle reachable', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'Intermediate widths are resized from the desktop project.');
  const group = await post(request, 'groups', { name: 'Narrow desktop', members: ['codex','claude'] });
  // On the integration branch with no implementation branch chosen, the row also carries its warning badge once Send options is chosen.
  await openGroup(page, group); await showSurface(page, 'Control');
  await page.getByRole('group', { name: 'Relay mode' }).getByRole('button', { name: 'Send options', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Implementation settings' });
  await expect(settings).toContainText('Choose the implementation branch in settings.');
  for (const width of [1100, 900, 800, 761]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), { message: `overflow at ${width}` }).toBeLessThanOrEqual(0);
    // The checkout row keeps both local toggles reachable as its summary wraps.
    await expect(page.getByRole('button', { name: /^Control access · / })).toBeInViewport({ ratio: 1 });
    for (const name of ['Agents', 'Settings']) {
      const toggle = settings.getByRole('button', { name, exact: true });
      await expect(toggle).toBeInViewport({ ratio: 1 });
      const box = (await toggle.boundingBox())!; const panel = (await settings.boundingBox())!;
      expect(box.x + box.width, `${String(name)} inside the panel at ${width}`).toBeLessThanOrEqual(panel.x + panel.width);
    }
    await settings.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Implementation branch')).toBeVisible(); await settings.getByRole('button', { name: 'Settings', exact: true }).click();
  }
});
test('the console starts on a working agent; in Focus the terminal and Control follow the next agent that starts working', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Start on working', members: ['codex','claude'] });
  let busy = 'claude';
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = data.sessions.map((s) => ({ agentId: s.id, state: s.id === busy ? 'working' : 'idle', updatedAt: new Date().toISOString(), detail: 'Native activity.' }));
    await route.fulfill({ json: data });
  });
  await openGroup(page, group); await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const sent = mutations(page);
  const agents = page.getByRole('navigation', { name: 'Agent' });
  await expect(agents.getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByLabel('Claude native output')).toBeVisible();
  await expect(page.locator('.control-heading h2')).toHaveText('Control · Claude');
  // No click was made: Codex starting work shows its terminal and retargets Control, on whichever surface is shown.
  await showSurface(page, 'Control'); await expect(page.getByRole('group', { name: 'Pane layout' })).toBeVisible();
  busy = 'codex'; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(agents.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.control-heading h2')).toHaveText('Control · Codex');
  await expect(page.getByRole('group', { name: 'Terminal or Control' }).getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showSurface(page, 'Terminal');
  await expect(page.getByLabel('Codex native output')).toBeVisible(); await expect(page.getByLabel('Claude native output')).toBeHidden();
  // A click holds until the working agent changes again.
  await agents.getByRole('button', { name: 'Claude', exact: true }).click(); await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(pane(page, 'Codex').locator('.pane-status .state')).toHaveText('working');
  await expect(agents.getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toEqual([]);
});
test('Focus follows a new worker while its peer remains busy, and a completion does not retarget Control', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Overlapping work', members: ['codex','claude'] });
  let working = ['codex'];
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = data.sessions.map((s) => ({ agentId: s.id, state: working.includes(s.id) ? 'working' : 'idle', updatedAt: new Date().toISOString(), detail: 'Native activity.' }));
    await route.fulfill({ json: data });
  });
  await openGroup(page, group); await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const sent = mutations(page), agents = page.getByRole('navigation', { name: 'Agent' });
  await expect(agents.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showSurface(page, 'Control');
  working = ['codex','claude']; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(agents.getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.control-heading h2')).toHaveText('Control · Claude');
  await showSurface(page, 'Terminal'); await expect(page.getByLabel('Claude native output')).toBeVisible();
  await agents.getByRole('button', { name: 'Codex', exact: true }).click();
  working = ['claude']; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(pane(page, 'Codex').locator('.pane-status .state')).toHaveText('idle');
  await expect(agents.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toEqual([]);
});
test('in Parallel a newly working agent never takes the chosen agent away', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Chosen pane', members: ['codex','claude'] });
  let working = false;
  await page.route('**/api/v1/state', async (route) => {
    const response = await route.fetch(); const data: WorkflowState = await response.json();
    data.activities = data.sessions.map((s) => ({ agentId: s.id, state: working && s.id === 'codex' ? 'working' : 'idle', updatedAt: new Date().toISOString(), detail: 'Native activity.' }));
    await route.fulfill({ json: data });
  });
  await openGroup(page, group); await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await openCard(page, 'Claude'); await expect(page.getByRole('region', { name: 'Actions for Claude' })).toBeVisible();
  working = true; await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(pane(page, 'Codex').locator('.pane-status .state')).toHaveText('working');
  // Neither the selection nor the Terminal/Control switch follows the newly working agent.
  await expect(page.getByRole('group', { name: 'Terminal or Control' }).getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Actions for Claude' })).toBeVisible();
  await showSurface(page, 'Terminal');
  await expect(pane(page, 'Claude')).toHaveClass(/\bactive\b/); await expect(pane(page, 'Codex')).not.toHaveClass(/\bactive\b/);
  await expect(page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('an accepted command from Control shows the recipient terminal again; a refused one stays on Control', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Back to terminal', members: ['codex','claude'] });
  let status = 'rejected';
  await page.route('**/api/v1/instructions', async (route) => { await route.fulfill({ json: { status, error: status === 'rejected' ? 'Refused for this test.' : null } }); });
  await taskBranch(page); await openGroup(page, group); await page.getByRole('button', { name: 'Focus', exact: true }).click();
  const surface = page.getByRole('group', { name: 'Terminal or Control' });
  const codex = await openCard(page, 'Codex'); await codex.getByLabel('Instruction for Codex').fill('Show me the terminal');
  const ready = await readiness(page); await ready.check();
  await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect(codex.getByRole('alert')).toContainText('REJECTED: Refused for this test.');
  await expect(surface.getByRole('button', { name: 'Control', exact: true })).toHaveAttribute('aria-pressed', 'true');
  status = 'delivered'; await ready.check(); await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect(surface.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Codex native output')).toBeVisible(); await expect(page.locator('section#altcli-control')).toHaveAttribute('hidden', '');
});
test('Agents sits left of local Settings, including Stage relay, and lists this checkout with home paths as ~', async ({ page, request }, info) => {
  const group = await post(request, 'groups', { name: 'Agents tab', members: ['codex','claude'] });
  // Only the home directory is simulated, so the mock checkout /demo/project lies under it.
  await page.route('**/api/v1/config', async (route) => { const response = await route.fetch(); await route.fulfill({ json: { ...(await response.json()), homeDir: '/demo' } }); });
  await openGroup(page, group);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveText(['Console', 'Projects', 'Agents', 'Settings']);
  const path = page.locator('.context-project > .mono');
  await expect(path).toHaveText('~/project'); await expect(path).toHaveAttribute('title', '/demo/project');
  const sent = mutations(page), local = page.getByRole('region', { name: 'Implementation settings', exact: true });
  const toggle = local.getByRole('button', { name: 'Agents', exact: true }), settings = local.getByRole('button', { name: 'Settings', exact: true });
  await expect(local.locator('.row-toggles button')).toHaveText(['▸ Agents', '▸ Settings']);
  expect((await toggle.boundingBox())!.x).toBeLessThan((await settings.boundingBox())!.x);
  // Stage relay used to hide the local Settings toggle entirely.
  await expect(local).toContainText('Stage relay:'); await settings.click();
  await expect(page.getByLabel('Implementation branch')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collaboration settings', exact: true })).toBeVisible();
  await settings.click();
  await expect(page.getByRole('heading', { name: 'Agents in this checkout' })).toHaveCount(0);
  await toggle.click();
  const agents = page.getByRole('region', { name: 'Agents in this checkout' });
  await expect(agents).toContainText('~/project');
  for (const name of [/^Codex\b/, /^Claude\b/]) await expect(agents.getByRole('cell', { name })).toBeVisible();
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  const plan = page.getByRole('region', { name: 'Plan settings', exact: true });
  await expect(plan.getByRole('button', { name: 'Agents', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await plan.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('After planning: collaboration')).toBeVisible();
  await expect(agents).toBeVisible();
  expect(sent).toEqual([]);
  await page.screenshot({ path: info.outputPath('local-agents-settings.png'), fullPage: true });
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
  // The single visible capture is taller than the former fixed 320 px phone height.
  await showSurface(page, 'Terminal');
  expect(await page.getByLabel('Codex native output').evaluate((el) => el.clientHeight)).toBeGreaterThan(320);
  await page.screenshot({ path: info.outputPath('console-320.png'), fullPage: true });
});

test('in Parallel, clicking a card heading selects that agent for the terminal and Control and sends nothing', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'Parallel cards sit side by side in a desktop window.');
  await unlock(page);
  const commands = async () => ((await (await request.get('/api/v1/state', { headers })).json()) as WorkflowState).commands.length;
  const before = await commands();
  await page.getByRole('button', { name: 'Parallel', exact: true }).click();
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Codex', exact: true }).click();
  await pane(page, 'Claude').locator('.pane-heading h2').click();
  await expect(pane(page, 'Claude')).toHaveClass(/\bactive\b/); await expect(pane(page, 'Codex')).not.toHaveClass(/\bactive\b/);
  await expect(page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showSurface(page, 'Control');
  await expect(page.locator('.control-heading h2')).toHaveText('Control · All agents');
  await expect(page.getByRole('button', { name: 'Select Claude controls', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Control', exact: true })).toHaveCount(1);
  expect(await commands()).toBe(before);
});
test('in Plan on wide screens the one control pane can sit beside the stage; the choice is remembered and narrower windows stack it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The side placement applies from 1280 CSS pixels.');
  await page.setViewportSize({ width: 1440, height: 900 }); await unlock(page);
  const stage = page.locator('.terminal-stage'), control = page.getByRole('region', { name: 'Control', exact: true });
  const placement = page.getByRole('group', { name: 'Control pane placement' });
  const plan = () => page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  // Outside Plan the switch replaces the placements.
  await expect(placement).toHaveCount(0); await plan();
  await placement.getByRole('button', { name: 'Control beside', exact: true }).click();
  const beside = async () => { const s = (await stage.boundingBox())!, c = (await control.boundingBox())!; return c.x >= s.x + s.width && c.y < s.y + s.height; };
  await expect.poll(beside).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(control).toHaveCount(1);
  await unlock(page); await plan();
  await expect(placement.getByRole('button', { name: 'Control beside', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(beside).toBe(true);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(placement).toBeHidden();
  await expect.poll(async () => (await control.boundingBox())!.y >= (await stage.boundingBox())!.y + (await stage.boundingBox())!.height).toBe(true);
});
test('in Plan on phones the one control pane opens as a bottom drawer and returns focus to its toggle', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'The drawer placement applies at phone widths.');
  await unlock(page);
  // Outside Plan the switch replaces the drawer.
  await expect(page.getByRole('button', { name: 'Open control drawer', exact: true })).toHaveCount(0);
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  const control = page.getByRole('region', { name: 'Control', exact: true });
  await page.getByRole('button', { name: 'Open control drawer', exact: true }).click();
  await expect(control).toBeFocused();
  expect(await control.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await expect(control.getByRole('heading', { name: /^Control · / })).toBeInViewport();
  await expect(control).toHaveCount(1); await expect(page.getByRole('textbox', { name: 'Shared task brief' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open control drawer', exact: true })).toBeFocused();
  expect(await control.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');
  await page.getByRole('button', { name: 'Open control drawer', exact: true }).click();
  await control.getByRole('button', { name: 'Close drawer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open control drawer', exact: true })).toBeFocused();
});
test('Plan drawer can open Control access without covering the readiness check beside Start Plan', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'The drawer applies at phone widths.');
  await unlock(page);
  await page.getByRole('group', { name: 'Phase' }).getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Open control drawer', exact: true }).click();
  const control = page.getByRole('region', { name: 'Control', exact: true });
  await control.getByLabel('Shared task brief').fill('Plan the drawer flow.');
  await page.locator('.context-bar').getByRole('button', { name: /^Control access · / }).click();
  expect(await control.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');
  const access = page.getByRole('region', { name: 'Control access', exact: true });
  await expect(access.getByRole('checkbox')).toHaveCount(0);
  await control.getByLabel('Ready for planning', { exact: true }).check({ timeout: 3000 });
  await access.getByRole('button', { name: 'Return to action', exact: true }).click();
  await expect(control).toBeFocused();await expect(control.getByRole('button', { name: 'Start Plan', exact: true })).toBeEnabled();
});
