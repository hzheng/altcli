import type { Locator, Page } from '@playwright/test';
/** Opens a disclosure by its summary text unless it is already open; a remembered open state must not be toggled closed. */
export async function expand(scope: Page | Locator, summary: string | RegExp) {
  const toggle = scope.locator('summary').filter({ hasText: summary }).first();
  if (!await toggle.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await toggle.click();
}
/** Opens a worktree's controls while preserving an already expanded card and its form state. */
export async function expandWorktree(page: Page, name: string) {
  const toggle = page.getByLabel(`Worktree ${name}`, { exact: true });
  if (!await toggle.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await toggle.click();
}
/** Opens a worktree card and its own Agents & group editor, preserving either disclosure when it is already open. */
export async function expandAgents(page: Page, name: string) {
  await expandWorktree(page, name);
  const card = page.getByRole('list', { name: 'Available worktrees' }).getByRole('listitem').filter({ has: page.getByLabel(`Worktree ${name}`, { exact: true }) });
  await expand(card, 'Agents & group');
}
/** Opens the next run's settings editor for the phase on screen unless it is already open. */
export async function editSettings(page: Page) {
  const toggle = page.getByRole('region', { name: /^(Implementation|Plan) settings$/ }).getByRole('button', { name: 'Settings', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
/** Selects an agent: its terminal is shown and the single Control pane addresses it. This revokes readiness. */
export async function openCard(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Agent' }).getByRole('button', { name, exact: true }).click();
  return page.getByRole('region', { name: `Actions for ${name}`, exact: true });
}
/** An agent's pane by attribute, so a pane hidden by Focus or the phone layout can still be asserted on. */
export const pane = (page: Page, name: string) => page.locator(`article[aria-label="${name} pane"]`);
/** Opens the Controller panel in the settings row unless it is already open; its toggle always shows the controller's state. */
export async function openController(page: Page) {
  const toggle = page.getByRole('button', { name: /^Controller · / });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
/** Chooses the After-send follow-up in a card with the instruction left empty, so the primary button becomes the hand-off of the
 * current changes as they stand (Commit current changes …). */
export async function handOff(card: Locator, mode: 'commit' | 'commit_relay') {
  await card.getByLabel(/^Instruction for /).fill(''); await card.getByLabel('After send').selectOption(mode);
}
