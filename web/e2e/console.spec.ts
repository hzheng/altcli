import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WorkflowState, HookEvent } from '../src/contracts/workflow';
const TOKEN = 'a'.repeat(64);
const headers = { Authorization: `Bearer ${TOKEN}` };
test.describe.configure({ mode: 'serial' });
async function state(request: APIRequestContext): Promise<WorkflowState> {
  const response = await request.get('/api/v1/state', { headers }); expect(response.ok()).toBe(true); return response.json();
}
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1/${path}`, { headers, data }); expect(response.ok()).toBe(true); return response.json();
}
async function unlock(page: Page, token = TOKEN) {
  await page.goto('/'); await page.getByLabel('Host access token').fill(token); await page.getByRole('button', { name: 'Open console' }).click();
}
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
  for (const run of current.runs.filter((r) => ['running', 'paused'].includes(r.status))) await post(request, 'runs', { runId: run.id, action: 'takeover', confirmReady: true });
  for (const pair of current.pairs) expect((await request.delete(`/api/v1/pairs/${pair.id}`, { headers })).ok()).toBe(true);
  for (const session of current.sessions.filter((s) => !['codex', 'claude'].includes(s.id))) expect((await request.delete(`/api/v1/sessions/${session.id}`, { headers })).ok()).toBe(true);
});
test('readiness is explicit and a delivered command retains execution ownership', async ({ page, request }) => {
  await unlock(page); await expect(page.getByText('MOCK MODE', { exact: true })).toBeVisible();
  const ready = page.getByLabel('Ready to send', { exact: true }); await expect(ready).not.toBeChecked();
  const relay = page.getByRole('button', { name: 'Relay ↗', exact: true }); await expect(relay).toBeDisabled();
  await ready.check(); await relay.click();
  await expect(page.getByRole('status')).toContainText('DELIVERED'); await expect(page.getByRole('region', { name: 'Active run' })).toBeVisible();
  await expect(relay).toBeDisabled();
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  await complete(request, run.currentCommandId, 'accept_without_improvement');
  await expect(page.getByRole('region', { name: 'Active run' })).toHaveCount(0);
  await expect(ready).not.toBeChecked();
});
test('registration previews panes, rejects shells, and groups projects', async ({ page }) => {
  await unlock(page); await page.getByRole('button', { name: '+ Add pane' }).click();
  await expect(page.getByRole('button', { name: 'Select %2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select %3', exact: true }).click();
  await expect(page.getByLabel('Preview of %3')).toContainText('codex running in /demo/other');
  await page.getByLabel('Label', { exact: true }).fill('Other Codex'); await page.getByRole('button', { name: 'Register pane', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Registered "Other Codex"');
  await expect(page.getByRole('navigation', { name: 'Project', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Other Codex output')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Other Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove Other Codex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Removed Other Codex');
});
test('a pair tab shows its project and selects the pair directly', async ({ page, request }) => {
  await post(request, 'pairs', { name: 'Main review', sessions: ['codex', 'claude'] });
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await unlock(page);
  const pair = page.getByRole('navigation', { name: 'Relay pairs' }).getByRole('button', { name: 'Main review (project)', exact: true });
  await expect(pair).toHaveAttribute('aria-pressed', 'false'); await page.getByRole('button', { name: '+ New pair' }).click();
  await page.getByLabel('Pair name').fill('Discard this draft'); await pair.click();
  await expect(page.getByLabel('Pair name')).toHaveCount(0);
  await expect(pair).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Codex output')).toHaveCount(1); await expect(page.getByLabel('Claude Code output')).toHaveCount(1);
  await expect(page.getByLabel('Other Codex output')).toHaveCount(0);
});
test('a project without a pair stays reachable beside pair tabs, so its pair can still be created', async ({ page, request }) => {
  await post(request, 'pairs', { name: 'Main review', sessions: ['codex', 'claude'] });
  await post(request, 'sessions', { paneId: '%3', label: 'Other Codex' });
  await unlock(page);
  const tabs = page.getByRole('navigation', { name: 'Relay pairs' });
  await tabs.getByRole('button', { name: 'Main review (project)', exact: true }).click();
  await expect(page.getByLabel('Other Codex output')).toHaveCount(0);
  const other = tabs.getByRole('button', { name: 'other (no pair)', exact: true });
  await expect(other).toHaveAttribute('aria-pressed', 'false'); await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Other Codex output')).toHaveCount(1); await expect(page.getByLabel('Codex output', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New pair' })).toBeDisabled();
});
test('command history filters by pair and orders by time', async ({ page, request }) => {
  const main = await post(request, 'pairs', { name: 'All', sessions: ['codex', 'claude'] });
  await post(request, 'commands', { requestId: '11111111-1111-4111-8111-111111111111', agentId: 'codex', kind: 'instruction', text: 'solo first', confirmReady: true });
  await complete(request, '11111111-1111-4111-8111-111111111111'); // a finished instruction releases the worktree for the next start
  await post(request, 'commands', { requestId: '22222222-2222-4222-8222-222222222222', agentId: 'claude', kind: 'instruction', text: 'paired second', confirmReady: true, pairId: main.id });
  await unlock(page); await page.getByText('Command history').click();
  // History persists across tests, so assert relative order of these two rows rather than absolute counts.
  const rows = page.locator('details.history tbody tr');
  const position = async (text: string) => (await rows.allTextContents()).findIndex((row) => row.includes(text));
  await expect(rows.filter({ hasText: 'paired second' })).toContainText('All');
  await expect.poll(async () => (await position('paired second')) < (await position('solo first'))).toBe(true);
  await page.getByRole('button', { name: 'Toggle history order' }).click();
  await expect.poll(async () => (await position('solo first')) < (await position('paired second'))).toBe(true);
  await page.getByLabel('History pair filter').selectOption(`pair:${main.id}`);
  await expect(rows.filter({ hasText: 'paired second' })).toHaveCount(1); await expect(rows.filter({ hasText: 'solo first' })).toHaveCount(0);
  await complete(request, '22222222-2222-4222-8222-222222222222', 'accept_without_improvement');
  const remove = page.getByRole('button', { name: 'Remove pair All' }); await expect(remove).toBeEnabled(); await remove.click();
  await page.getByRole('button', { name: 'Confirm remove pair All' }).click(); await expect(page.getByRole('status')).toContainText('Pair "All" removed');
  await expect(page.getByLabel('History pair filter')).toHaveValue('pair:all'); await expect(rows.filter({ hasText: 'paired second' })).toHaveCount(1);
});
test('history follows the selected pair by default, reads all while none is selected, and follows the next selection', async ({ page, request }) => {
  const loop = await post(request, 'pairs', { name: 'Loop', sessions: ['codex', 'claude'] });
  await post(request, 'commands', { requestId: '33333333-3333-4333-8333-333333333333', agentId: 'codex', kind: 'instruction', text: 'loop command', confirmReady: true, pairId: loop.id });
  await complete(request, '33333333-3333-4333-8333-333333333333');
  await unlock(page); await page.getByRole('navigation', { name: 'Relay pairs' }).getByRole('button', { name: 'Loop (project)', exact: true }).click();
  await page.getByText('Command history').click(); const filter = page.getByLabel('History pair filter');
  await expect(filter).toHaveValue(`pair:${loop.id}`);
  await expect(filter.locator('option', { hasText: 'Loop (project) *' })).toHaveCount(1);
  await expect(filter.locator('option', { hasText: 'Selected pair' })).toHaveCount(0);
  const rows = page.locator('details.history tbody tr'); await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove pair Loop' }).click(); await page.getByRole('button', { name: 'Confirm remove pair Loop' }).click();
  await expect(page.getByRole('status')).toContainText('Pair "Loop" removed');
  await expect(filter).toHaveValue('all'); await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(1);
  await page.getByRole('button', { name: '+ New pair' }).click(); await page.getByLabel('Pair name').fill('Replacement');
  await page.getByRole('button', { name: 'Create pair' }).click(); await expect(page.getByRole('status')).toContainText('Pair "Replacement" created');
  await expect(filter).toHaveValue('pair:replacement');
  await expect(filter.locator('option', { hasText: 'Replacement (project) *' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(0);
  await filter.selectOption('all'); await expect(rows.filter({ hasText: 'loop command' })).toHaveCount(1);
});
test('a plain Send with a pair selected leaves the partner idle; only a handoff makes it wait', async ({ page, request }) => {
  const main = await post(request, 'pairs', { name: 'Main', sessions: ['codex', 'claude'] });
  await unlock(page);
  const row = (label: string) => page.locator('details.status tbody tr').filter({ has: page.locator('td:first-child', { hasText: label }) });
  await post(request, 'commands', { requestId: '44444444-4444-4444-8444-444444444444', agentId: 'codex', kind: 'instruction', text: 'plain work', confirmReady: true, pairId: main.id });
  await expect(row('Codex')).toContainText('working'); await expect(row('Codex')).toContainText('Working on "plain work"');
  await expect(row('Claude Code')).toContainText('idle'); await expect(row('Claude Code')).toContainText('Not part of this turn');
  await complete(request, '44444444-4444-4444-8444-444444444444', 'accept_without_improvement');
  await post(request, 'commands', { requestId: '55555555-5555-4555-8555-555555555555', agentId: 'codex', kind: 'instruction', text: 'reviewed work', handoff: true, confirmReady: true, pairId: main.id });
  await expect(row('Claude Code')).toContainText('waiting'); await expect(row('Claude Code')).toContainText('Waiting for Codex to finish');
});
test('an explicitly selected pair creates a persistent run without browser scheduling', async ({ page, request }) => {
  await unlock(page); await page.getByRole('button', { name: '+ New pair' }).click();
  await page.getByLabel('Pair name').fill('Main review'); await page.getByRole('button', { name: 'Create pair' }).click();
  await expect(page.getByRole('status')).toContainText('Pair "Main review" created');
  await expect(page.getByRole('navigation', { name: 'Relay pairs' }).getByRole('button', { name: 'Main review (project)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Auto-relay', { exact: true }).check(); await page.getByLabel('Ready to send', { exact: true }).check();
  await page.getByRole('button', { name: 'Relay ↗', exact: true }).click(); await expect(page.getByRole('status')).toContainText('DELIVERED');
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  expect(run.pairId).toBe('main-review');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await complete(request, run.currentCommandId);
  const after = (await state(request)).runs.find((r) => r.id === run.id)!;
  expect(after.automaticTurns).toBe(1); expect(after.currentCommandId).not.toBe(run.currentCommandId);
  await unlock(page); await expect(page.getByText('1/20 automatic turns', { exact: true })).toBeVisible();
  await complete(request, after.currentCommandId, 'strong_objection', 'The delete path can remove records outside the selected project.');
  await expect(page.getByRole('heading', { name: 'Run active', exact: true })).toBeVisible();
  await expect(page.getByText('Reviewer objected; correction scheduled for Codex.', { exact: true })).toBeVisible();
  const correction = (await state(request)).executions.find((e) => e.runId === run.id)!;
  expect(correction.agentId).toBe('codex'); expect(correction.input.kind).toBe('instruction'); expect(correction.input.handoff).toBe(true);
  expect(correction.input.text).toContain('Address objection: The delete path can remove records outside the selected project.');
  // The reviewer's turn is over: its objection stays labeled on its pane while the author's correction is in flight.
  await page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name: /Claude Code/ }).click();
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
    await expect(page.getByText('1/20 automatic turns', { exact: true })).toBeVisible(); await expect(second.getByText('1/20 automatic turns', { exact: true })).toBeVisible();
    const run = (await state(request)).runs.find((r) => r.id === record.id)!;
    expect(run.automaticTurns).toBe(1); expect((await state(request)).executions.filter((e) => e.runId === run.id)).toHaveLength(1);
  } finally { await second.close(); }
});
test('pause and takeover are distinct and uncertain transport is not retried', async ({ page }) => {
  await unlock(page); await page.getByLabel(/Instruction to/).fill('mock:uncertain');
  await page.getByLabel('Ready to send', { exact: true }).check(); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('UNCERTAIN'); await expect(page.getByRole('heading', { name: 'Run paused', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause / take over', exact: true }).click();
  await expect(page.getByText(/Pause does not interrupt any process/)).toBeVisible();
  await page.getByRole('button', { name: 'I checked every participant; release ownership', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Active run' })).toHaveCount(0); await expect(page.getByRole('status')).toContainText('Nothing was replayed');
});
test('a rejected completion does not label the active pane with an older accepted outcome', async ({ page, request }) => {
  const previous = crypto.randomUUID();
  await post(request, 'commands', { requestId: previous, agentId: 'codex', kind: 'relay', confirmReady: true });
  await complete(request, previous, 'accept_without_improvement', 'Previous accepted review.');
  await unlock(page);
  await expect(page.getByText('accept_without_improvement: Previous accepted review.', { exact: true })).toBeVisible();

  const currentId = crypto.randomUUID();
  await post(request, 'commands', { requestId: currentId, agentId: 'codex', kind: 'relay', confirmReady: true });
  const current = await state(request); const execution = current.executions.find((e) => e.commandId === currentId)!;
  const session = current.sessions.find((s) => s.id === 'codex')!;
  await post(request, 'events', { source: 'codex', event: 'turn_complete', commandId: currentId,
    paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: session.identity,
    sessionId: 'changed-codex-session', sourceTurnId: `turn-${currentId}`, prompt: execution.wireText,
    settled: true, backgroundState: 'clear', outcome: 'accept_without_improvement', reason: 'Current rejected review.' });

  const active = page.getByRole('region', { name: 'Active run' });
  await expect(active.getByText('CLI session changed; explicitly re-register the worker.', { exact: true })).toBeVisible();
  await expect(page.getByText('accept_without_improvement: Previous accepted review.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('accept_without_improvement: Current rejected review.', { exact: true })).toHaveCount(0);
});
test('unknown Claude background status pauses instead of treating a response as idle', async ({ page, request }) => {
  await unlock(page); await page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name: /Claude Code/ }).click();
  await page.getByLabel('Ready to send', { exact: true }).check(); await page.getByRole('button', { name: 'Relay ↗', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('DELIVERED');
  const current = await state(request); const run = current.runs.find((r) => r.status === 'running')!;
  const session = current.sessions.find((s) => s.id === 'claude')!;
  const lifecycle = { source: 'claude', commandId: run.currentCommandId, paneId: session.identity.paneId,
    socketPath: session.identity.socketPath, identity: session.identity, sessionId: 'test-claude', sourceTurnId: `turn-${run.currentCommandId}`,
    prompt: current.executions.find((e) => e.commandId === run.currentCommandId)!.wireText, settled: true, backgroundState: 'unknown' };
  await post(request, 'events', { ...lifecycle, event: 'turn_started' });
  await post(request, 'events', { ...lifecycle, event: 'turn_complete', outcome: 'accept_and_improve' });
  await expect(page.getByRole('heading', { name: 'Run paused', exact: true })).toBeVisible();
  await expect(page.getByText('Completion or background-work state is unknown; inspect the workers.', { exact: true })).toBeVisible();
});
test('wrong token cannot read agent output', async ({ page }) => {
  await unlock(page, 'b'.repeat(64)); await expect(page.getByRole('alert').filter({ hasText: /access token/ })).toBeVisible();
  await expect(page.getByLabel('Codex output')).toHaveCount(0);
});
