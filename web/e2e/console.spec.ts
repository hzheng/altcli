import { expect, test, type Page } from "@playwright/test";
// One mock server and store back every test, so a failed test must not leak its state into the next one.
test.describe.configure({ mode: "serial" });
async function unlock(page: Page, token = "a".repeat(64)) {
  await page.goto("/");
  await page.getByLabel("Host access token").fill(token);
  await page.getByRole("button", { name: /Open console/ }).click();
}
const tabs = (page: Page) => page.getByRole("navigation", { name: "Command target" });
const projects = (page: Page) => page.getByRole("navigation", { name: "Project" });
async function register(page: Page, paneId: string, label: string) {
  await page.getByRole("button", { name: "+ Add pane" }).click();
  await page.getByRole("button", { name: "Change" }).click(); // leave the current project; %3 lives in another repository
  await page.getByRole("button", { name: `Select ${paneId}` }).click();
  await page.getByLabel("Label").fill(label);
  await page.getByRole("button", { name: "Register pane" }).click();
  await expect(page.getByRole("status")).toContainText(`Registered "${label}" at ${paneId}`);
}
async function removeSession(page: Page, label: string) {
  await page.getByRole("button", { name: `Remove ${label}`, exact: true }).click(); // inline two-step, no dialog
  await page.getByRole("button", { name: `Confirm remove ${label}`, exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`Removed the registration "${label}"`);
}
test("a delivered relay settles by itself; the next send only needs the readiness confirmation", async ({ page }) => {
  await unlock(page);
  await expect(page.getByText("MOCK MODE", { exact: true })).toBeVisible();
  // The main view shows panes and the composer only; forms are on demand.
  await expect(page.getByRole("heading", { name: /Choose the pane/ })).toHaveCount(0);
  await expect(page.getByLabel("Pair name")).toHaveCount(0);
  const relay = page.getByRole("button", { name: /Relay/ });
  // Nothing was ever sent to Codex from here, so it is presumed at its prompt and the box is pre-ticked.
  await expect(page.getByLabel("Ready to send", { exact: true })).toBeChecked();
  await expect(page.getByText(/presumed at its prompt/)).toBeVisible();
  await expect(relay).toBeEnabled();
  // Text in the box turns Relay into a relay with context, sent as one line.
  await page.getByLabel(/Instruction to/).fill("focus on the migration");
  await expect(page.getByRole("button", { name: "Relay with context ↗" })).toBeVisible();
  await relay.click();
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  await expect(page.getByLabel("Codex output")).toContainText("relay: focus on the migration");
  await expect(page.getByLabel(/Instruction to/)).toHaveValue("");
  await expect(page.getByText("MANUAL", { exact: true })).toBeVisible(); // nothing to release
  await expect(page.getByRole("button", { name: /release|I checked the terminal/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Codex", exact: true })).toBeEnabled();
  await expect(relay).toBeDisabled(); // readiness resets after every send
  await page.getByLabel("Ready to send", { exact: true }).check();
  await expect(relay).toBeEnabled();
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByLabel("Host access token")).toBeVisible();
});
test("an uncertain delivery holds the project until the terminal is checked, without a popup", async ({ page }) => {
  await unlock(page);
  await page.getByLabel(/Instruction to/).fill("mock:uncertain"); // the mock adapter's simulated transport failure
  await page.getByLabel("Ready to send", { exact: true }).check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("UNCERTAIN");
  await expect(page.getByText("CONFIRM DELIVERY", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove Codex", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "+ New pair" })).toBeDisabled();
  await page.getByRole("button", { name: "I checked the terminal" }).click();
  await expect(page.getByRole("status")).toContainText("Uncertain delivery acknowledged");
  await expect(page.getByText("MANUAL", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Codex", exact: true })).toBeEnabled();
});
test("add a spare mock pane through the two-step panel, then remove the registration", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: "+ Add pane" }).click();
  const list = page.getByRole("list", { name: "Live tmux panes" });
  await expect(list.getByRole("listitem")).toHaveCount(4);
  // Registered panes and shells explain themselves instead of offering a button.
  await expect(list.getByRole("listitem").filter({ hasText: "%0" })).toContainText("registered as codex");
  await expect(list.getByRole("listitem").filter({ hasText: "%2" })).toContainText("shell or interpreter");
  await expect(page.getByRole("button", { name: "Select %2" })).toHaveCount(0);
  // Opened from project "project", so a pane in another repository is blocked until the project is changed.
  await expect(page.getByText("PROJECT", { exact: true })).toBeVisible();
  await expect(list.getByRole("listitem").filter({ hasText: "%3" })).toContainText("outside project");
  await expect(page.getByRole("button", { name: "Select %3" })).toHaveCount(0);
  await page.getByRole("button", { name: "Change" }).click();
  await expect(page.getByLabel("Repository")).toBeVisible(); // two candidate repositories: project and other
  await expect(page.getByLabel("Label")).toHaveCount(0); // step 2 is hidden until a pane is chosen
  await page.getByRole("button", { name: "Select %3" }).click();
  await expect(page.locator(".project-line")).toContainText("/demo/other"); // the pane fixed the project
  await expect(page.getByLabel("Preview of %3")).toContainText("codex running in /demo/other");
  await expect(page.getByLabel("Agent type")).toHaveValue("codex");
  await expect(page.getByLabel("Label")).toHaveValue("Codex %3"); // "Codex" is taken, so the suggestion stays unique
  await expect(page.getByLabel("Repository root")).toHaveValue("/demo/other"); // inside the collapsed Advanced section
  await page.getByLabel("Label").fill("Codex");
  await expect(page.getByText(/will be re-pointed/)).toBeVisible();
  await page.getByLabel("Label").fill("Second Codex");
  await page.getByRole("button", { name: "Register pane" }).click();
  await expect(page.getByRole("status")).toContainText('Registered "Second Codex" at %3');
  // Its project has only one pane so far: the panel stays open and says what is missing.
  await expect(page.getByText(/1 of 2 panes in other/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: /Choose the pane/ })).toHaveCount(0);
  // A second repository root appears as a second project and becomes the current one.
  await expect(projects(page).getByRole("button")).toHaveCount(2);
  await expect(projects(page).getByRole("button", { name: /^other/ })).toHaveAttribute("aria-pressed", "true");
  await expect(tabs(page).getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Second Codex", exact: true })).toBeVisible();
  await expect(page.getByLabel("Second Codex output")).toContainText("simulated pane");
  await projects(page).getByRole("button", { name: /^project/ }).click();
  await expect(tabs(page).getByRole("button")).toHaveCount(2);
  await projects(page).getByRole("button", { name: /^other/ }).click();
  await removeSession(page, "Second Codex");
  await expect(projects(page)).toHaveCount(0);
  await expect(tabs(page).getByRole("button")).toHaveCount(2);
});
test("a pair groups two sessions of one project and filters the view", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: "+ New pair" }).click();
  // Exactly two sessions in the project: both are prefilled, only the name is asked for.
  await expect(page.getByLabel("First session")).toHaveValue("codex");
  await expect(page.getByLabel("Second session")).toHaveValue("claude");
  await page.getByLabel("Pair name").fill("Review loop");
  await page.getByRole("button", { name: "Create pair" }).click();
  await expect(page.getByRole("status")).toContainText('Pair "Review loop" created: Codex ⇄ Claude Code');
  await expect(page.getByLabel("Pair name")).toHaveCount(0); // form closed
  const pairs = page.getByRole("region", { name: "Relay pairs" });
  await expect(pairs.getByText("Codex ⇄ Claude Code")).toBeVisible();
  await pairs.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText('showing pair "Review loop"')).toBeVisible();
  await expect(tabs(page).getByRole("button")).toHaveCount(2);
  // A paired session cannot be removed while the pair exists.
  await page.getByRole("button", { name: "Remove Codex", exact: true }).click();
  await page.getByRole("button", { name: "Confirm remove Codex", exact: true }).click();
  await expect(page.getByRole("status")).toContainText('belongs to the pair "Review loop"');
  await pairs.getByRole("button", { name: "Remove pair Review loop" }).click();
  await pairs.getByRole("button", { name: "Confirm remove pair Review loop" }).click();
  await expect(page.getByRole("status")).toContainText('Pair "Review loop" removed');
  await expect(pairs.getByText("Codex ⇄ Claude Code")).toHaveCount(0);
});
test("an unacknowledged delivery in one project does not block another project", async ({ page }) => {
  await unlock(page);
  await page.getByLabel(/Instruction to/).fill("mock:uncertain");
  await page.getByLabel("Ready to send", { exact: true }).check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("CONFIRM DELIVERY", { exact: true })).toBeVisible();
  await register(page, "%3", "Second Codex"); // other worktree, allowed while this one is held
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(projects(page).getByRole("button", { name: /^other/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("MANUAL", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Second Codex", exact: true })).toBeEnabled();
  await removeSession(page, "Second Codex");
  await expect(page.getByText("CONFIRM DELIVERY", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "I checked the terminal" }).click();
  await expect(page.getByRole("status")).toContainText("Uncertain delivery acknowledged");
});
test("a CLI hook event marks the pane idle, hands the target to the relay partner, and pre-ticks readiness", async ({ page }) => {
  await unlock(page);
  const hook = (paneId: string, source: string, extra: Record<string, string> = {}) => page.request.post("/api/v1/events", { headers: { Authorization: `Bearer ${"a".repeat(64)}` }, data: { source, event: "turn_complete", paneId, socketPath: "", ...extra } });
  await expect(page.getByText("NO HOOK EVENTS YET")).toHaveCount(2);
  // No pair is needed: with exactly two sessions in the project the partner is the other one.
  await page.getByLabel("Ready to send", { exact: true }).check();
  await page.getByRole("button", { name: /Relay/ }).click();
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  await expect(page.getByText("NO HOOK EVENTS YET")).toHaveCount(2); // a pane is only called "working" once its hook has spoken before
  expect((await hook("%0", "codex")).ok()).toBe(true); // Codex's notify fires for the relay just sent
  await expect(page.getByRole("status")).toContainText("Codex finished its turn");
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/IDLE · turn ended/)).toHaveCount(1);
  await expect(page.getByLabel("Ready to send", { exact: true })).toBeChecked(); // nothing was ever sent to Claude Code: presumed at its prompt
  await expect(page.getByText(/presumed at its prompt/)).toBeVisible();
  await page.getByLabel("Ready to send", { exact: true }).uncheck(); // the human can always override the suggestion
  await expect(page.getByRole("button", { name: /Relay/ })).toBeDisabled();
  expect((await hook("%1", "claude")).ok()).toBe(true); // Claude Code's Stop hook fires
  await expect(page.getByLabel("Ready to send", { exact: true })).toBeChecked();
  await expect(page.getByText(/presumed at its prompt/)).toBeVisible(); // still never sent to; the hook just confirms
  await expect(page.getByRole("button", { name: /Relay/ })).toBeEnabled();
  // Back to Codex: known idle, so readiness is pre-ticked; after sending it is "working" until its hook speaks again.
  await tabs(page).getByRole("button", { name: /Codex/ }).click();
  await expect(page.getByLabel("Ready to send", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: /Relay/ }).click();
  await expect(page.getByText(/WORKING · since/)).toHaveCount(1);
  await expect(page.getByLabel("Ready to send", { exact: true })).not.toBeChecked();
  expect((await hook("%0", "codex")).ok()).toBe(true);
  await expect(page.getByText(/WORKING · since/)).toHaveCount(0);
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true"); // handed over again
  // A direct instruction is not a relay: its completion needs no outcome line and hands nothing off.
  await page.getByLabel(/Instruction to/).fill("Reply only READY without using tools or changing files.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%1", "claude")).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("Claude Code finished the instruction you sent");
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true"); // stays put
  await expect(page.getByLabel("Ready to send", { exact: true })).toBeChecked();
  // "Send, then relay": a work request whose result is the next thing for the partner to review.
  await expect(page.getByLabel("Auto-relay", { exact: true })).not.toBeChecked(); // the checkbox is irrelevant to Send & relay
  await page.getByLabel(/Instruction to/).fill("implement the change you both agreed on");
  await page.getByRole("button", { name: "Send & relay ↗" }).click();
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%1", "claude")).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("RELAYED AUTOMATICALLY, DELIVERED: the terminal accepted the text for Codex");
  await expect(tabs(page).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Codex output")).toContainText("relay");
  expect((await hook("%0", "codex", { outcome: "accept_and_improve" })).ok()).toBe(true); // Codex reviews; nothing continues: auto-relay is off
  await expect(page.getByRole("status")).toContainText("accepted and improved. Next: Claude Code.");
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true"); // handed over, not sent
  // Leftover text in the pane's input line turned the delivered "relay" into "xxxrelay": that turn answered a different
  // prompt, so the relay stays open, the pane says so, and nothing is handed off.
  await page.getByRole("button", { name: /Relay/ }).click(); // to Claude Code
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%1", "claude", { prompt: "xxxrelay" })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText('finished a turn that was not the one sent from here: its prompt was "xxxrelay"');
  await expect(page.locator(".outcome").filter({ hasText: "ANSWERED A DIFFERENT PROMPT" })).toContainText("xxxrelay");
  await expect(page.getByText(/WORKING · since/)).toHaveCount(1); // the relay is still open
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true"); // no hand-off
  await expect(page.getByLabel("Ready to send", { exact: true })).not.toBeChecked();
  // The human types "relay" in the terminal; that turn answers the open command.
  expect((await hook("%1", "claude", { prompt: "relay", outcome: "accept_and_improve", reason: "Recovered." })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("accepted and improved — Recovered. Next: Codex.");
  await tabs(page).getByRole("button", { name: /Claude Code/ }).click();
  // A relay whose outcome line is not readable yet stays pending: no hand-off, and the message says so.
  await page.getByRole("button", { name: /Relay/ }).click(); // to Claude Code
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%1", "claude", { settled: "false" as unknown as string })).ok()).toBe(false); // settled must be a boolean
  expect((await page.request.post("/api/v1/events", { headers: { Authorization: `Bearer ${"a".repeat(64)}` }, data: { source: "claude", event: "turn_complete", paneId: "%1", settled: false } })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("waiting for its RELAY-OUTCOME line");
  await expect(page.locator(".outcome.pending")).toContainText("READING ITS RELAY-OUTCOME LINE");
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true"); // not handed off
  expect((await page.request.post("/api/v1/events", { headers: { Authorization: `Bearer ${"a".repeat(64)}` }, data: { source: "claude", event: "outcome", paneId: "%1", settled: true, outcome: "accept_and_improve", reason: "Late but here." } })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("accepted and improved — Late but here. Next: Codex.");
  await expect(tabs(page).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true");
  await tabs(page).getByRole("button", { name: /Claude Code/ }).click();
  // The reviewer's RELAY-OUTCOME line decides what the hand-off does.
  await page.getByRole("button", { name: /Relay/ }).click(); // to Claude Code
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%1", "claude", { outcome: "strong_objection", reason: "The migration drops the events table without a backup." })).ok()).toBe(true);
  await expect(page.locator(".outcome").filter({ hasText: "OBJECTION" })).toContainText("The migration drops the events table");
  await expect(tabs(page).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true"); // back to the author
  await expect(page.getByLabel(/Instruction to/)).toHaveValue(/Claude Code rejected your handoff: The migration drops the events table without a backup\. Address it, then hand off again\./);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled(); // readiness pre-ticked, text prefilled; the human sends
  await page.getByLabel(/Instruction to/).fill("");
  await page.getByLabel("Ready to send", { exact: true }).check();
  await page.getByRole("button", { name: /Relay/ }).click(); // to Codex
  await expect(page.getByRole("status")).toContainText("DELIVERED");
  expect((await hook("%0", "codex", { outcome: "accept_without_improvement", reason: "Nothing left to hand off." })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("relay chain is complete");
  await expect(tabs(page).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true"); // no hand-off: the chain ended
  await expect(page.locator(".outcome").filter({ hasText: "ACCEPTED, NOTHING TO HAND OFF" })).toHaveCount(1);
  expect((await hook("%9", "claude")).ok()).toBe(true); // an unregistered pane is surfaced, not hidden
  await expect(page.getByText(/pane %9 .* is not registered/)).toBeVisible();
});
test("auto-relay continues on accept_and_improve without a click and stops itself on an objection", async ({ page }) => {
  await unlock(page);
  const hook = (paneId: string, source: string, extra: Record<string, string> = {}) => page.request.post("/api/v1/events", { headers: { Authorization: `Bearer ${"a".repeat(64)}` }, data: { source, event: "turn_complete", paneId, socketPath: "", ...extra } });
  const auto = page.getByLabel("Auto-relay", { exact: true });
  await auto.check();
  await expect(page.getByText(/0\/20 automatic turns/)).toBeVisible();
  await page.getByRole("button", { name: /Relay/ }).click(); // the first turn is always the human's
  await expect(page.getByRole("status")).toContainText("DELIVERED: the terminal accepted the text for Codex");
  expect((await hook("%0", "codex", { outcome: "accept_and_improve", reason: "Tightened a test." })).ok()).toBe(true);
  await expect(page.getByRole("status")).toContainText("RELAYED AUTOMATICALLY, DELIVERED: the terminal accepted the text for Claude Code");
  await expect(page.getByText(/1\/20 automatic turns/)).toBeVisible();
  await expect(tabs(page).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true");
  expect((await hook("%1", "claude", { outcome: "strong_objection", reason: "Index rewritten outside the contract." })).ok()).toBe(true);
  await expect(auto).not.toBeChecked();
  await expect(page.getByRole("status")).toContainText("Auto-relay stopped: the reviewer objected.");
  await expect(page.getByLabel(/Instruction to/)).toHaveValue(/Claude Code rejected your handoff: Index rewritten/);
  await expect(tabs(page).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true");
  // Nothing was sent automatically after the objection: the newest command is still the auto-relay to Claude Code.
  await page.locator("details.history summary").click();
  await expect(page.locator("details.history tbody tr").first()).toContainText("Claude Code");
  await expect(page.locator("details.history tbody tr").first()).toContainText("relay");
});
test("unknown token cannot read agent output", async ({ page }) => {
  await unlock(page, "b".repeat(64));
  // Next renders its own role="alert" route announcer, so filter to the console notice.
  await expect(page.getByRole("alert").filter({ hasText: /access token/ })).toBeVisible();
});
