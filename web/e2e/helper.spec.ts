import { expect, test, type WebSocketRoute } from '@playwright/test';

for (const refused of [false, true]) test(`Helper always types without a mode switch and reconnects after ${refused ? 'a refused connection' : 'disconnecting'}`, async ({ page }) => {
  // Browser-only Helper transport fixture; real pane routing and hold independence have native/broker coverage.
  const streams = new Map<string, WebSocketRoute>(), typed: string[] = [];
  let opens = 0, acquires = 0;
  await page.route('**/api/v1/global-ai', async route => {
    const response = await route.fetch(), view = await response.json();
    const profile = { id: 'helper-profile', label: 'Helper', executable: 'codex', args: ['--no-daemon'], enabled: true };
    await route.fulfill({ response, json: { ...view, enabled: true, manualHeld: true, nativeState: 'alive', profiles: [profile],
      instance: { id: 'helper-fixture', profile, identity: { paneId: '%9' }, sessionId: '$9', status: 'started', args: [] } } });
  });
  await page.route('**/api/v1/terminals', async route => {
    if (route.request().postDataJSON().target.launchId !== 'helper-fixture') return route.continue();
    const id = `helper-${++opens}`;
    await route.fulfill({ json: { connectionId: id, ticket: id, bootId: 'helper-boot', label: 'Helper', paneId: '%9', sessionId: '$9' } });
  });
  await page.routeWebSocket('**/api/v1/terminals/socket', socket => {
    socket.onMessage(message => {
      const hello = JSON.parse(String(message));
      if (!String(hello.ticket).startsWith('helper-')) {
        const server = socket.connectToServer();
        server.onMessage(data => socket.send(data)); socket.onMessage(data => server.send(data)); server.send(message); return;
      }
      streams.set(hello.ticket, socket); socket.onMessage(() => {});
      socket.send(JSON.stringify({ type: 'reset', bootId: 'helper-boot', generation: `${hello.ticket}-observe`, native: true, cols: 80, rows: 24, reason: 'Observing.' }));
    });
  });
  await page.route('**/api/v1/terminals/helper-*/*', async route => {
    const [, id, action] = new URL(route.request().url()).pathname.match(/\/terminals\/([^/]+)\/([^/]+)$/)!;
    const body = route.request().postDataJSON();
    if (action === 'keyboard') {
      expect(body.action).toBe('acquire'); acquires++;
      if (refused && acquires === 1) return route.fulfill({ status: 409, json: { error: { code: 'FIXTURE_REFUSAL', message: 'Fixture connection refused.' } } });
      const generation = `${id}-write`, stream = streams.get(id!)!;
      stream.send(JSON.stringify({ type: 'reset', bootId: 'helper-boot', generation, native: true, cols: 80, rows: 24, reason: '' }));
      stream.send(JSON.stringify({ type: 'keyboard', generation, writer: true, manualSessionId: null, reason: 'Typing goes to Helper.' }));
      return route.fulfill({ json: { generation, writer: true, manualSession: null, reason: 'Typing goes to Helper.' } });
    }
    if (action === 'input') {
      typed.push(body.encoding === 'binary' ? Buffer.from(body.data, 'base64').toString() : body.data);
      return route.fulfill({ json: { generation: body.generation, seq: body.seq } });
    }
    await route.fulfill({ json: {} });
  });
  await page.goto('/global-ai'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  const helper = page.getByRole('region', { name: 'Helper terminal', exact: true });
  await expect.poll(() => acquires).toBe(1);
  await expect(helper.getByRole('button', { name: 'Terminal mode', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('img', { name: /Observing/ })).toHaveCount(0);
  await expect(page.getByText('Manual input in an agent terminal is holding automation', { exact: false })).toHaveCount(0);
  if (refused) {
    await expect(helper.getByRole('status')).toContainText('Reconnect to continue typing');
    await helper.getByRole('button', { name: 'Reconnect', exact: true }).click();
  }
  await expect(helper.getByRole('button', { name: 'Paste text', exact: true })).toBeVisible();
  await helper.locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText('é次');
  await expect.poll(() => typed.join('')).toBe('é次');
  const parts = page.getByRole('navigation', { name: 'Helper sections' });
  await parts.getByRole('button', { name: 'Session', exact: true }).click(); await parts.getByRole('button', { name: 'Chat', exact: true }).click();
  expect(opens).toBe(refused ? 2 : 1);
  streams.get(`helper-${opens}`)!.send(JSON.stringify({ type: 'closed', reason: 'Fixture disconnected.' }));
  await expect(helper.getByRole('status')).toContainText('Reconnect to continue typing');
  await helper.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(helper.getByRole('button', { name: 'Paste text', exact: true })).toBeVisible();
  await helper.locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText('again');
  await expect.poll(() => typed.join('')).toBe('é次again');
  expect(acquires).toBe(refused ? 3 : 2);
  await expect(helper.getByRole('button', { name: 'Terminal mode', exact: true })).toHaveCount(0);
});
for (const switched of [false, true]) test(`Helper names changed settings and offers /model only within one CLI (${switched ? 'CLI switched' : 'model changed'})`, async ({ page }) => {
  // Browser-only fixture: the launched profile differs from the saved one; no terminal identity, so nothing connects.
  await page.route('**/api/v1/global-ai', async route => {
    const response = await route.fetch(), view = await response.json();
    const launched = { id: 'helper-profile', revision: 1, label: 'Helper', executable: 'codex', args: ['--no-daemon', '-m', 'gpt-old'], adapterHint: 'codex', enabled: true };
    const saved = switched ? { ...launched, revision: 2, executable: 'claude', args: ['--model', 'sonnet'], adapterHint: 'claude' } : { ...launched, revision: 2, args: ['--no-daemon', '-m', 'gpt-new'] };
    await route.fulfill({ response, json: { ...view, enabled: true, nativeState: 'unavailable', profiles: [saved],
      instance: { id: 'helper-fixture', profile: launched, identity: null, sessionId: null, status: 'started', args: [] } } });
  });
  await page.goto('/global-ai'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Helper settings changed' });
  if (switched) {
    await expect(notice).toContainText('codex --no-daemon -m gpt-old → claude --model sonnet');
    await expect(notice).toContainText('applies them.'); await expect(notice).not.toContainText('/model');
  } else await expect(notice).toContainText('--no-daemon -m gpt-old → --no-daemon -m gpt-new. Restart with saved settings applies them, or type /model');
});
test('Session restarts the conversation with another chosen profile after one confirmation of its exact command', async ({ page }) => {
  // Browser-only fixture of the host's preview, retire and start responses; their server behavior has unit and native coverage.
  const launched = { id: 'helper-codex', revision: 1, label: 'Helper', executable: 'codex', args: ['--no-daemon', '-m', 'gpt-old'], adapterHint: 'codex', enabled: true };
  const other = { id: 'helper-claude', revision: 1, label: 'Claude Opus max', executable: 'claude', args: ['--model', 'opus', '--effort', 'max'], adapterHint: 'claude', enabled: true };
  const actions: Record<string, unknown>[] = [];
  await page.route('**/api/v1/global-ai', async route => {
    const response = await route.fetch(), view = await response.json();
    const json = { ...view, enabled: true, nativeState: 'unavailable', profiles: [launched, other],
      instance: { id: 'helper-fixture', profile: launched, identity: null, sessionId: null, status: 'started', args: launched.args, executable: 'codex' } };
    if (route.request().method() !== 'POST') return route.fulfill({ response, json });
    const body = route.request().postDataJSON(); actions.push(body);
    if (body.action === 'preview') return route.fulfill({ json: { id: crypto.randomUUID(), digest: 'fixture-digest', expiresAt: new Date(Date.now() + 60000).toISOString(),
      profile: other, executable: '/usr/local/bin/claude', args: [...other.args, '--permission-mode', 'manual'], directory: '/data/global-ai/next', sessionName: 'altcli-global-next' } });
    return route.fulfill({ json });
  });
  await page.goto('/global-ai'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click();
  await page.getByRole('navigation', { name: 'Helper sections' }).getByRole('button', { name: 'Session', exact: true }).click();
  const session = page.getByRole('region', { name: 'Helper session' }), choice = session.getByLabel('Restart Helper with');
  await expect(choice).toHaveValue(launched.id); await expect(choice.locator('option')).toHaveText(['Helper (this conversation)', 'Claude Opus max']);
  await choice.selectOption(other.id);
  let asked = ''; page.once('dialog', d => { asked = d.message(); void d.accept(); });
  await session.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restarted Helper with “Claude Opus max”' })).toBeVisible();
  expect(asked).toContain('/usr/local/bin/claude --model opus --effort max --permission-mode manual');
  expect(actions.map(a => a.action)).toEqual(['preview', 'retire', 'start']);
  expect(actions[0]).toEqual({ action: 'preview', profileId: other.id });
  expect(actions[1]).toEqual({ action: 'retire', instanceId: 'helper-fixture', confirm: true, stop: true });
});
