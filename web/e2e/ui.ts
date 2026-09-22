import type { Locator, Page } from '@playwright/test';
/** Opens a disclosure by its summary text unless it is already open; a remembered open state must not be toggled closed. */
export async function expand(scope: Page | Locator, summary: string | RegExp) {
  const toggle = scope.locator('summary').filter({ hasText: summary }).first();
  if (!await toggle.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await toggle.click();
}
/** The collapsed editor of the next run's settings for the phase on screen. */
export const editSettings = (page: Page) => expand(page.getByRole('region', { name: /^(Implementation|Plan) settings$/ }), 'Edit settings');
/** The action group under an agent's pane. Only the displayed pane is visible on a phone, so choose it through its tab first;
 * like every view switch, that revokes readiness, so tests confirm readiness after opening the card. */
export async function openCard(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Command target' }).getByRole('button', { name, exact: true }).click();
  return page.getByRole('region', { name: `Actions for ${name}`, exact: true });
}
/** An agent's pane by attribute, so a pane hidden by Focus or the phone layout can still be asserted on. */
export const pane = (page: Page, name: string) => page.locator(`article[aria-label="${name} pane"]`);
