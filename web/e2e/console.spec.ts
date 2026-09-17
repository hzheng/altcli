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
async function complete(request: APIRequestContext, commandId: string, outcome = 'accept_and_improve') {
  const current = await state(request); const execution = current.executions.find((e) => e.commandId === commandId)!;
  const session = current.sessions.find((s) => s.id === execution.agentId)!;
  const event = { source: session.agentType, paneId: session.identity.paneId, socketPath: session.identity.socketPath, identity: session.identity,
    prompt: execution.wireText, sessionId: `test-${session.id}`, sourceTurnId: `turn-${commandId}`, commandId, settled: true, backgroundState: 'clear', outcome };
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
  await expect(page.getByRole('navigation', { name: 'Project', exact: true }).getByRole('button')).toHaveCount(2);
  await expect(page.getByLabel('Other Codex output')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Other Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove Other Codex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Removed Other Codex');
});
test('an explicitly selected pair creates a persistent run without browser scheduling', async ({ page, request }) => {
  await unlock(page); await page.getByRole('button', { name: '+ New pair' }).click();
  await page.getByLabel('Pair name').fill('Main review'); await page.getByRole('button', { name: 'Create pair' }).click();
  await expect(page.getByRole('status')).toContainText('Pair "Main review" created');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.getByLabel('Auto-relay', { exact: true }).check(); await page.getByLabel('Ready to send', { exact: true }).check();
  await page.getByRole('button', { name: 'Relay ↗', exact: true }).click(); await expect(page.getByRole('status')).toContainText('DELIVERED');
  const run = (await state(request)).runs.find((r) => r.status === 'running')!;
  expect(run.pairId).toBe('main-review');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await complete(request, run.currentCommandId);
  const after = (await state(request)).runs.find((r) => r.id === run.id)!;
  expect(after.automaticTurns).toBe(1); expect(after.currentCommandId).not.toBe(run.currentCommandId);
  await unlock(page); await expect(page.getByText('1/20 automatic turns')).toBeVisible();
  await complete(request, after.currentCommandId, 'strong_objection'); await expect(page.getByRole('heading', { name: 'Run paused', exact: true })).toBeVisible();
  await expect(page.getByText(/Reviewer objected/)).toBeVisible();
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
    await expect(page.getByText('1/20 automatic turns')).toBeVisible(); await expect(second.getByText('1/20 automatic turns')).toBeVisible();
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
test('unknown background status pauses instead of treating a response as idle', async ({ page, request }) => {
  await unlock(page); await page.getByLabel('Ready to send', { exact: true }).check(); await page.getByRole('button', { name: 'Relay ↗', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('DELIVERED');
  const current = await state(request); const run = current.runs.find((r) => r.status === 'running')!;
  const session = current.sessions.find((s) => s.id === 'codex')!;
  await post(request, 'events', { source: 'codex', event: 'turn_complete', commandId: run.currentCommandId, paneId: session.identity.paneId,
    socketPath: session.identity.socketPath, identity: session.identity, sessionId: 'test-codex', sourceTurnId: `turn-${run.currentCommandId}`,
    prompt: current.executions.find((e) => e.commandId === run.currentCommandId)!.wireText, settled: true, outcome: 'accept_and_improve', backgroundState: 'unknown' });
  await expect(page.getByRole('heading', { name: 'Run paused', exact: true })).toBeVisible(); await expect(page.getByText(/background-work state is unknown/)).toBeVisible();
});
test('wrong token cannot read agent output', async ({ page }) => {
  await unlock(page, 'b'.repeat(64)); await expect(page.getByRole('alert').filter({ hasText: /access token/ })).toBeVisible();
  await expect(page.getByLabel('Codex output')).toHaveCount(0);
});
