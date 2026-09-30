import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AttachmentReceipt } from '../src/contracts/attachments';
import type { PlanStart } from '../src/contracts/planning';
import type { StandaloneStart } from '../src/contracts/implementation';
import type { WorkflowState } from '../src/contracts/workflow';
import { openCard, readiness, showSurface } from './ui';

// Real uploads to the mock host's private storage; browser start requests are intercepted where noted. Synthetic ClipboardEvents
// prove the handlers only, not operating-system clipboard support.
const headers = { Authorization: `Bearer ${'a'.repeat(64)}` };
async function state(request: APIRequestContext): Promise<WorkflowState> { return (await request.get('/api/v1/state', { headers })).json(); }
async function post(request: APIRequestContext, path: string, data: unknown) { const r = await request.post(`/api/v1/${path}`, { headers, data }); expect(r.ok(), await r.text()).toBe(true); return r.json(); }
const totalBytes = async (page: Page) => ((await state(page.request)).manualSessions ?? []).reduce((n, m) => n + m.bytes, 0);
async function reconcileKeyboard(request: APIRequestContext) {
  for (const m of (await state(request)).manualSessions ?? []) {
    for (const w of m.writers.filter((w) => w.live)) await post(request, 'terminals/revoke', { clientInstanceId: w.clientInstanceId });
    const fresh = (await state(request)).manualSessions?.find((x) => x.id === m.id);
    if (fresh) await post(request, 'terminals/reconcile', { requestId: crypto.randomUUID(), manualSessionId: m.id, expectedRevision: fresh.revision, confirmReady: true });
  }
}
test.beforeEach(async ({ request }) => {
  const s = await state(request); for (const r of s.runs.filter((r) => ['running', 'waiting', 'paused'].includes(r.status))) await post(request, 'runs', { runId: r.id, action: 'takeover', confirmReady: true });
  await reconcileKeyboard(request);
  await post(request, 'workspaces/reset', { repository: '/demo/project', confirmReady: true }); await post(request, 'sessions', { paneId: '%0', label: 'Codex' }); await post(request, 'sessions', { paneId: '%1', label: 'Claude' });
});
test.afterEach(async ({ page, request }) => { await page.unrouteAll({ behavior: 'wait' }); await reconcileKeyboard(request); });
async function unlock(page: Page) { await page.goto('/'); await page.getByLabel('Host access token').fill('a'.repeat(64)); await page.getByRole('button', { name: 'Open console' }).click(); }
async function terminalMode(page: Page, name = 'Codex') {
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name, exact: true }).click(); await showSurface(page, 'Terminal');
  const card = page.getByRole('region', { name: `${name} terminal`, exact: true });
  await card.getByRole('button', { name: 'Terminal mode', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Terminal mode', exact: true, pressed: true })).toBeVisible();
  return card;
}
/** A real image encoded by the browser (PNG or JPEG), as the bytes a picker or clipboard would supply. */
async function encoded(page: Page, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (type) => {
    const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 12;
    const context = canvas.getContext('2d')!; context.fillStyle = '#c00'; context.fillRect(0, 0, 12, 12); context.fillStyle = '#00c'; context.fillRect(12, 0, 12, 12);
    return canvas.toDataURL(type).split(',')[1]!;
  }, type), 'base64');
}
/** Dispatches a paste of an encoded image (and optional text) at `target`. */
async function pasteImage(target: Locator, bytes: Buffer, more: { type?: string; name?: string; text?: string } = {}) {
  await target.evaluate((element, { data, type, name, text }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type }));
    if (text) transfer.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { data: bytes.toString('base64'), type: more.type ?? 'image/png', name: more.name ?? 'shot.png', text: more.text ?? '' });
}
/** Opens a worktree group from Projects, as a user choosing its phase would. */
async function openGroup(page: Page, group: { repository: string; cwd: string }) {
  await unlock(page);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: `Project ${group.repository.split('/').pop()}`, exact: true }).click();
  const worktree = page.getByLabel(`Worktree ${group.repository.split('/').pop()}`, { exact: true });
  if (!await worktree.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await worktree.locator('.workspace-title').click();
  await page.getByRole('button', { name: `Open ${group.cwd.split('/').pop()}`, exact: true }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Console', exact: true }).click();
}
const phase = (page: Page, name: 'Plan' | 'Implementation') => page.getByRole('group', { name: 'Phase' }).getByRole('button', { name, exact: true }).click();
const uploads = (page: Page) => { const seen: string[] = []; page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/v1/attachments')) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); }); return seen; };

test('an image pasted in Terminal mode uploads to the tray; Insert types one quoted bracketed-paste reference and never Enter', async ({ page, request }) => {
  await unlock(page); const card = await terminalMode(page), textarea = card.locator('.xterm-helper-textarea');
  const before = await totalBytes(page), bytes = await encoded(page);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/attachments' && r.request().method() === 'POST');
  await pasteImage(textarea, bytes);
  const receipt: AttachmentReceipt = await (await response).json();
  expect(receipt).toMatchObject({ mediaType: 'image/png', width: 24, height: 12, workspace: '/demo/project', name: 'shot.png' });
  const tray = card.getByRole('list', { name: 'Images for Codex' });
  await expect(tray.getByRole('status')).toHaveText('Ready to insert');
  expect(await totalBytes(page)).toBe(before); // uploading typed nothing
  const { dataDir } = await (await request.get('/api/v1/config', { headers })).json() as { dataDir: string };
  const path = join(realpathSync(join(dataDir, 'attachments')), `${receipt.id}.png`);
  await tray.getByRole('button', { name: 'Insert image reference shot.png', exact: true }).click();
  await expect(tray.getByRole('status')).toContainText('Reference inserted');
  await expect.poll(() => totalBytes(page)).toBe(before + Buffer.byteLength(`\x1b[200~'${path}'\x1b[201~`));
  await expect(tray.getByRole('button', { name: /^Insert image reference/ })).toHaveCount(0);
  // Removing an inserted preview only hides it; the host copy may already have been read.
  await tray.getByRole('button', { name: 'Remove shot.png', exact: true }).click();
  await expect(card.getByText('Removing the preview does not retract the reference already sent to the terminal.')).toBeVisible();
  await expect(tray).toHaveCount(0); expect(existsSync(path)).toBe(true);
});
test('Display mode uploads nothing; a mixed clipboard asks, and Cancel pastes only the text', async ({ page }) => {
  await unlock(page); await showSurface(page, 'Terminal');
  const seen = uploads(page), card = page.getByRole('region', { name: 'Codex terminal', exact: true }), bytes = await encoded(page);
  await expect(card.getByRole('button', { name: 'Terminal mode', exact: true, pressed: false })).toBeVisible();
  await pasteImage(card.locator('.xterm-helper-textarea'), bytes);
  await expect(card.getByText(/Switch this terminal to Terminal mode to attach images\. Nothing was uploaded\./)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Attach image', exact: true })).toHaveCount(0);
  await terminalMode(page); const before = await totalBytes(page);
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('Attach the image? Cancel pastes the text instead.'); void dialog.dismiss(); });
  await pasteImage(card.locator('.xterm-helper-textarea'), bytes, { text: 'abc' });
  await expect.poll(() => totalBytes(page)).toBe(before + 3);
  page.once('dialog', (dialog) => void dialog.accept());
  await pasteImage(card.locator('.xterm-helper-textarea'), bytes, { text: 'abc' });
  await expect(card.getByRole('list', { name: 'Images for Codex' }).getByRole('status')).toHaveText('Ready to insert');
  expect(await totalBytes(page)).toBe(before + 3);
  expect(seen).toEqual(['POST /api/v1/attachments']);
});
test('the picker reports unsupported files, attaches a JPEG, and Remove deletes an unused upload from the host', async ({ page }) => {
  await unlock(page); const card = await terminalMode(page), seen = uploads(page), jpeg = await encoded(page, 'image/jpeg');
  const chooser = page.waitForEvent('filechooser');
  await card.getByRole('button', { name: 'Attach image', exact: true }).click();
  await (await chooser).setFiles([{ name: '截屏 1.jpg', mimeType: 'image/jpeg', buffer: jpeg }, { name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') }]);
  await expect(card.getByText(/anim\.gif: only PNG and JPEG images can be attached/)).toBeVisible();
  const tray = card.getByRole('list', { name: 'Images for Codex' });
  await expect(tray.getByRole('listitem')).toHaveCount(1); await expect(tray.getByRole('status')).toHaveText('Ready to insert');
  await expect(tray.getByText('截屏 1.jpg', { exact: true })).toBeVisible();
  await tray.getByRole('button', { name: 'Remove 截屏 1.jpg', exact: true }).click();
  await expect(tray).toHaveCount(0);
  await expect.poll(() => seen.filter((line) => line.startsWith('DELETE'))).toHaveLength(1);
  expect(seen.filter((line) => line.startsWith('POST'))).toHaveLength(1);
});
test('plain Send carries uploaded draft images; Stage relay and pending uploads block before anything is sent', async ({ page }) => {
  const starts: StandaloneStart[] = [];
  await page.route('**/api/v1/instructions', async (route) => { const input = route.request().postDataJSON() as StandaloneStart; starts.push(input); await route.fulfill({ json: { id: input.requestId, status: 'delivered', error: null } }); });
  await unlock(page); const codex = await openCard(page, 'Codex'); const bytes = await encoded(page);
  await codex.getByLabel('Instruction for Codex').fill('Describe the screenshot');
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/attachments', async (route) => { await held; await route.continue(); });
  await pasteImage(codex.getByLabel('Instruction for Codex'), bytes);
  const tray = codex.getByRole('list', { name: 'Images for Codex' });
  await expect(tray.getByRole('status')).toHaveText('Uploading…');
  await (await readiness(page)).check();
  await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeDisabled();
  await expect(codex.getByText('Wait for the images to finish uploading.')).toBeVisible();
  release(); await expect(tray.getByRole('status')).toHaveText('Uploaded');
  const after = codex.getByLabel('After send');
  // The mock checkout is on main, where After send offers Stage relay: its frozen protocol refuses images before anything is sent.
  await after.selectOption('stage_relay');
  await expect(codex.getByText('Stage relay sends text only. Remove the images or choose another After send.')).toBeVisible();
  await after.selectOption('nothing');
  await (await readiness(page)).check();
  await codex.getByRole('button', { name: 'Send Codex', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ agentId: 'codex', text: 'Describe the screenshot' }); expect(starts[0]!.attachments).toHaveLength(1);
  // The accepted start consumed exactly this draft: its text and images are cleared.
  const reopened = await openCard(page, 'Codex');
  await expect(reopened.getByLabel('Instruction for Codex')).toHaveValue('');
  await expect(reopened.getByRole('list', { name: 'Images for Codex' })).toHaveCount(0);
});
test('a Plan brief carries its images to Start Plan and needs a brief to go with them', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Planners', members: ['codex', 'claude'] });
  const starts: PlanStart[] = [];
  await page.route('**/api/v1/planning', async (route) => { starts.push(route.request().postDataJSON()); await route.fulfill({ json: { status: 'delivered', error: null } }); });
  await openGroup(page, group); await phase(page, 'Plan');
  const setup = page.getByRole('region', { name: 'Plan setup' });
  await pasteImage(page.getByLabel('Shared task brief'), await encoded(page));
  await expect(setup.getByRole('list', { name: 'Images for the shared brief' }).getByRole('status')).toHaveText('Uploaded');
  await expect(setup.getByText('Enter the shared task brief to go with the images.')).toBeVisible();
  await page.getByLabel('Shared task brief').fill('Match the attached layout.');
  await (await readiness(page, 'Ready for planning')).check();
  await page.getByRole('button', { name: 'Start Plan', exact: true }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ text: 'Match the attached layout.' }); expect(starts[0]!.attachments).toHaveLength(1);
  await expect(setup.getByRole('list', { name: 'Images for the shared brief' })).toHaveCount(0);
});
test('an upload that finishes after its composer unmounted reaches the restored draft', async ({ page, request }) => {
  const group = await post(request, 'groups', { name: 'Implementers', members: ['codex', 'claude'] });
  await openGroup(page, group); const bytes = await encoded(page);
  let codex = await openCard(page, 'Codex');
  await codex.getByLabel('Instruction for Codex').fill('Describe the screenshot');
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let requested = 0;
  await page.route('**/api/v1/attachments', async (route) => { requested++; await held; await route.continue(); });
  await pasteImage(codex.getByLabel('Instruction for Codex'), bytes);
  await expect(codex.getByRole('list', { name: 'Images for Codex' }).getByRole('status')).toHaveText('Uploading…');
  // The composer unmounts while the upload is held, then a new one shows the same draft.
  await phase(page, 'Plan'); await expect(page.getByRole('region', { name: 'Plan setup' })).toBeVisible();
  await phase(page, 'Implementation'); codex = await openCard(page, 'Codex');
  await expect(codex.getByRole('list', { name: 'Images for Codex' }).getByRole('status')).toHaveText('Uploading…');
  release();
  await expect(codex.getByRole('list', { name: 'Images for Codex' }).getByRole('status')).toHaveText('Uploaded');
  expect(requested).toBe(1);
  await (await readiness(page)).check();
  await expect(codex.getByRole('button', { name: 'Send Codex', exact: true })).toBeEnabled();
});
test('implementation readiness is revoked by adding, removing or replacing an image and by upload completion', async ({ page }) => {
  await unlock(page); const codex = await openCard(page, 'Codex'), ready = await readiness(page), bytes = await encoded(page);
  const send = codex.getByRole('button', { name: 'Send Codex', exact: true }), tray = codex.getByRole('list', { name: 'Images for Codex' });
  await codex.getByLabel('Instruction for Codex').fill('Describe the screenshot');
  await ready.check(); await expect(send).toBeEnabled();
  let release!: () => void; let held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/attachments', async (route) => { await held; await route.continue(); });
  // Adding an image revokes readiness; a confirmation given while it uploads is revoked when the upload finishes.
  await pasteImage(codex.getByLabel('Instruction for Codex'), bytes, { name: 'first.png' });
  await expect(ready).not.toBeChecked(); await expect(tray.getByRole('status')).toHaveText('Uploading…');
  await ready.check(); await expect(send).toBeDisabled();
  release(); await expect(tray.getByRole('status')).toHaveText('Uploaded');
  await expect(ready).not.toBeChecked(); await expect(send).toBeDisabled();
  await ready.check(); await expect(send).toBeEnabled();
  // Removing it revokes readiness; attaching a replacement revokes it again, so an earlier confirmation never returns.
  held = Promise.resolve();
  await tray.getByRole('button', { name: 'Remove first.png', exact: true }).click();
  await expect(tray).toHaveCount(0); await expect(ready).not.toBeChecked();
  await ready.check(); await expect(send).toBeEnabled();
  await pasteImage(codex.getByLabel('Instruction for Codex'), bytes, { name: 'second.png' });
  await expect(ready).not.toBeChecked();
  await expect(tray.getByRole('status')).toHaveText('Uploaded'); await expect(ready).not.toBeChecked(); await expect(send).toBeDisabled();
  await ready.check(); await expect(send).toBeEnabled();
});
