import type { Locator, Page } from '@playwright/test';
/** Opens a disclosure by its summary text unless it is already open; a remembered open state must not be toggled closed. */
export async function expand(scope: Page | Locator, summary: string | RegExp) {
  const toggle = scope.locator('summary').filter({ hasText: summary }).first();
  if (!await toggle.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await toggle.click();
}
/** Opens the next run's settings editor for the phase on screen unless it is already open. */
export async function editSettings(page: Page) {
  const toggle = page.getByRole('region', { name: /^(Implementation|Plan) settings$/ }).getByRole('button', { name: 'Settings', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
/** The action group under an agent's pane. Only the displayed pane is visible on a phone, so choose it through its tab first;
 * like every view switch, that revokes readiness, so tests confirm readiness after opening the card. */
export async function openCard(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name, exact: true }).click();
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
