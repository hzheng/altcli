import { expect, type Locator, type Page } from '@playwright/test';
/** Opens a disclosure by its summary text unless it is already open; a remembered open state must not be toggled closed. */
export async function expand(scope: Page | Locator, summary: string | RegExp) {
  const toggle = scope.locator('summary').filter({ hasText: summary }).first();
  if (!await toggle.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await toggle.click();
}
/** Opens a worktree's controls while preserving an already expanded card and its form state. */
export async function expandWorktree(page: Page, name: string) {
  const toggle = page.getByLabel(`Worktree ${name}`, { exact: true });
  if (!await toggle.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await toggle.locator('.workspace-title').click();
}
/** Opens a worktree card and selects its Agents tab. */
export async function expandAgents(page: Page, name: string) {
  await expandWorktree(page, name);
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ has: page.getByLabel(`Worktree ${name}`, { exact: true }) });
  await card.getByRole('tab', { name: 'Agents', exact: true }).click();
}
/** On main or the default branch Implementation's Control starts on Stage relay; chooses Send options, whose branch-specific actions
 * and next-run settings the helpers below address. Elsewhere, and in Plan, there is no Relay mode and nothing changes. */
async function commitRelay(page: Page) {
  const commit = page.getByRole('group', { name: 'Relay mode', includeHidden: true }).getByRole('button', { name: 'Send options', exact: true, includeHidden: true });
  if (!await commit.count() || await commit.getAttribute('aria-pressed') === 'true') return;
  await showSurface(page, 'Control'); await commit.click();
}
/** Opens the next run's settings editor for the phase on screen unless it is already open. */
export async function editSettings(page: Page) {
  await commitRelay(page);
  const toggle = page.getByRole('region', { name: /^(Implementation|Plan) settings$/ }).getByRole('button', { name: 'Settings', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
/** Selects an agent, whom the single Control pane then addresses, and outside Plan switches the frame to Control. On main or the
 * default branch, where Control starts on Stage relay, it chooses Send options so the agent's actions are shown. This revokes readiness. */
export async function openCard(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name, exact: true }).click();
  await showSurface(page, 'Control'); await commitRelay(page);
  return page.getByRole('region', { name: `Actions for ${name}`, exact: true });
}
/** Outside Plan, shows the terminals or Control in the shared frame; in Plan there is no switch and both stay shown. */
export async function showSurface(page: Page, surface: 'Terminal' | 'Control') {
  const button = page.getByRole('group', { name: 'Terminal or Control' }).getByRole('button', { name: surface, exact: true });
  if (await button.count() && await button.getAttribute('aria-pressed') !== 'true') await button.click();
}
/** An accepted command from Control shows the terminals again. Waits for that switch, then shows Control to inspect what the command left
 * there. The switch is view state only and revokes readiness. */
export async function backToControl(page: Page) {
  await expect(page.getByRole('group', { name: 'Terminal or Control' }).getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showSurface(page, 'Control');
}
/** Opens the one Control access panel unless it is already open. Opening it changes no run and no confirmation. */
export async function openAccess(page: Page) {
  const entry = page.getByRole('button', { name: /^Control access · / });
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
  return page.getByRole('region', { name: 'Control access', exact: true });
}
/** The readiness check for the action on screen; it lives only in Control access, which this opens. */
export async function readiness(page: Page, label = 'Ready for implementation') {
  return (await openAccess(page)).getByLabel(label, { exact: true });
}
/** Takes control in Control access: one confirmation that lists its steps, then those steps in order. */
export async function takeControl(page: Page) {
  const access = await openAccess(page);
  await access.getByRole('group', { name: 'Take control' }).getByRole('button', { name: 'Take control…', exact: true }).click();
  await access.getByRole('region', { name: 'Confirm take control' }).getByRole('button', { name: 'Take control now', exact: true }).click();
}
/** An agent's pane by attribute, so a pane hidden by Focus or the phone layout can still be asserted on. */
export const pane = (page: Page, name: string) => page.locator(`article[aria-label="${name} pane"]`);
/** Opens Control access, where the controller's run card, pause and takeover live; its entry always summarizes who holds control. */
export const openController = openAccess;
/** Chooses the After-send follow-up in a card with the instruction left empty, so the primary button becomes the hand-off of the
 * current changes as they stand (Commit current changes …). */
export async function handOff(card: Locator, mode: 'commit' | 'commit_relay') {
  await card.getByLabel(/^Instruction for /).fill(''); await card.getByLabel('After send').selectOption(mode);
}

/** Viewing may open/resize/close observation transports. Grants, byte input, stop,
 * reconciliation and every workflow mutation remain visible to navigation tests. */
export function observationTransport(url: string) {
  return /^\/api\/v1\/terminals(?:\/[a-f0-9-]+\/(?:resize|close))?$/.test(new URL(url).pathname);
}
