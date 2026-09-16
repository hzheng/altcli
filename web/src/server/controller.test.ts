import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandInput } from "../contracts/api";
import { MockAdapter, mockSessions } from "./adapters/mock";
import { Controller } from "./controller";
import { Store } from "./store";
import { loadConfig } from "./config";
let directory: string;
let store: Store;
let adapter: MockAdapter;
let controller: Controller;
const PROJECT = "/demo/project";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codercrew-test-"));
  store = new Store(directory);
  for (const session of mockSessions()) store.saveSession(session);
  adapter = new MockAdapter();
  controller = new Controller(loadConfig({ CODERCREW_TOKEN: "a".repeat(64), CODERCREW_ADAPTER: "mock", CODERCREW_DATA_DIR: directory }), store, adapter);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function command(agentId = "codex"): CommandInput { return { requestId: randomUUID(), agentId, kind: "relay", confirmReady: true }; }
/** Makes every send fail after it began, which the controller must record as an uncertain delivery. */
function failSends(): void { adapter.send = async () => { throw new Error("transport interrupted"); }; }
test("a clean delivery settles the worktree; it asserts nothing about completion", async () => {
  const result = await controller.submit(command());
  expect(result.status).toBe("delivered");
  expect(result.releasedAt).not.toBeNull();
  expect(store.reservations()).toEqual([]);
  // The next send's readiness confirmation is the reconciliation; nothing else is required.
  expect((await controller.submit(command("claude"))).status).toBe("delivered");
});
test("an uncertain delivery holds its worktree until a human acknowledges it", async () => {
  failSends();
  const result = await controller.submit(command());
  expect(result.status).toBe("uncertain"); expect(result.releasedAt).toBeNull();
  expect(store.reservations()).toEqual([{ repository: PROJECT, activeCommandId: result.id }]);
  await expect(controller.submit(command())).rejects.toThrow(/uncertain delivery/);
  await expect(controller.submit(command("claude"))).rejects.toThrow(/uncertain delivery/); // same worktree, other agent
  store.release(result.id);
  expect(store.reservations()).toEqual([]);
  expect(store.get(result.id)?.releasedAt).not.toBeNull();
});
test("different worktrees hold independently", async () => {
  await controller.register({ paneId: "%3", label: "Second Codex" }); // /demo/other
  failSends();
  const first = await controller.submit(command());
  const second = await controller.submit(command("second-codex"));
  expect(store.reservations().map((r) => [r.repository, r.activeCommandId])).toEqual([[PROJECT, first.id], ["/demo/other", second.id]]);
  store.release(second.id);
  expect(store.activeFor(PROJECT)).toBe(first.id); expect(store.activeFor("/demo/other")).toBeNull();
});
test("a relay sends the registered prompt, and with context sends one line of prompt plus context", async () => {
  const sent: string[] = [];
  adapter.send = async (_session, text) => { sent.push(text); };
  await controller.submit(command());
  await controller.submit({ ...command(), text: "focus on the migration" });
  await controller.register({ paneId: "%3", label: "Second Codex", relayPrompt: "Use the review-handoff skill." });
  await controller.submit({ ...command("second-codex"), text: "the index rules" });
  expect(sent).toEqual(["relay", "relay: focus on the migration", "Use the review-handoff skill.: the index rules"]);
  await expect(controller.submit({ ...command(), text: "x".repeat(2000) })).rejects.toThrow(/2,000/); // prompt plus context is one bounded line
});
test("a relay always hands off; an instruction only when asked", async () => {
  expect((await controller.submit(command())).handoff).toBe(true);
  expect((await controller.submit({ ...command(), kind: "instruction", text: "reply READY" })).handoff).toBe(false);
  expect((await controller.submit({ ...command(), kind: "instruction", text: "implement the agreed change", handoff: true })).handoff).toBe(true);
});
test("a duplicate command ID never sends twice", async () => {
  let sends = 0;
  adapter.send = async () => { sends++; };
  const input = command();
  await controller.submit(input); await controller.submit(input);
  expect(sends).toBe(1);
});
test("reuse of an ID with a different payload conflicts", async () => {
  const input = command(); await controller.submit(input);
  await expect(controller.submit({ ...input, agentId: "claude" })).rejects.toThrow(/different command/);
});
test("a transport failure is recorded as uncertain and never replayed, even for the same request ID", async () => {
  let sends = 0;
  adapter.send = async () => { sends++; throw new Error("transport interrupted"); };
  const input = command(); const result = await controller.submit(input);
  expect(result.status).toBe("uncertain"); expect(store.activeFor(PROJECT)).toBe(result.id);
  expect((await controller.submit(input)).status).toBe("uncertain"); expect(sends).toBe(1);
});
test("preflight rejection records the attempt without delivering or keeping ownership", async () => {
  adapter.preflight = async () => { throw new Error("wrong process"); };
  const result = await controller.submit(command());
  expect(result.status).toBe("rejected"); expect(store.reservations()).toEqual([]); expect(result.releasedAt).not.toBeNull();
});
test("startup settles holds left by delivered commands and drops holds whose command is gone", async () => {
  const now = new Date().toISOString(); const id = randomUUID();
  store.reserve({ id, agentId: "codex", kind: "relay", text: "relay", handoff: true, status: "recorded", createdAt: now, updatedAt: now, error: null, releasedAt: null }, PROJECT);
  store.update({ ...store.get(id)!, status: "delivered" }); // the pre-ADR-0008 shape: delivered but still holding
  store.db.prepare("INSERT INTO reservations(repository, active_id) VALUES (?,?)").run("/gone", randomUUID());
  store.recoverInterrupted();
  expect(store.reservations()).toEqual([]);
  expect(store.get(id)?.releasedAt).not.toBeNull();
});
test("crash recovery marks every in-flight command uncertain without replaying", async () => {
  await controller.register({ paneId: "%3", label: "Second Codex" });
  const now = new Date().toISOString();
  const ids = [randomUUID(), randomUUID()];
  store.reserve({ id: ids[0]!, agentId: "codex", kind: "relay", text: "relay", handoff: true, status: "sending", createdAt: now, updatedAt: now, error: null, releasedAt: null }, PROJECT);
  store.reserve({ id: ids[1]!, agentId: "second-codex", kind: "relay", text: "relay", handoff: true, status: "recorded", createdAt: now, updatedAt: now, error: null, releasedAt: null }, "/demo/other");
  store.recoverInterrupted();
  expect(ids.map((id) => store.get(id)?.status)).toEqual(["uncertain", "uncertain"]);
  expect(store.reservations()).toHaveLength(2);
});
test("acknowledging a settled or older command cannot clear a newer hold", async () => {
  const delivered = await controller.submit(command());
  expect(() => store.release(delivered.id)).toThrow(/no longer holds/); // already settled by delivery
  failSends();
  const first = await controller.submit(command()); store.release(first.id);
  const second = await controller.submit(command());
  expect(() => store.release(first.id)).toThrow(/no longer holds/);
  expect(store.activeFor(PROJECT)).toBe(second.id);
});
test("registering a live pane records its observed process, a confirmed agent type, and shows it in the pane list", async () => {
  const result = await controller.register({ paneId: "%3", label: "Second Codex" });
  expect(result).toMatchObject({ replaced: false, session: { id: "second-codex", label: "Second Codex", agentType: "codex", expectedCommand: "codex", repository: "/demo/other", relayPrompt: "relay" } });
  expect(result.session.identity.paneId).toBe("%3");
  const state = await controller.state();
  expect(state.sessions.map((s) => s.id)).toEqual(["codex", "claude", "second-codex"]);
  expect(state.panes.map((p) => [p.identity.paneId, p.registeredAs])).toEqual([["%0", "codex"], ["%1", "claude"], ["%2", null], ["%3", "second-codex"]]);
  expect(state.panesError).toBeNull(); expect(state.pairs).toEqual([]); expect(state.reservations).toEqual([]);
  expect(state.snapshots.map((s) => s.agentId)).toContain("second-codex");
  store.removeSession("second-codex");
  expect((await controller.register({ paneId: "%3", label: "Second Codex", agentType: "other" })).session.agentType).toBe("other");
});
test("a shell pane, an already registered pane, and a missing pane cannot be registered", async () => {
  await expect(controller.register({ paneId: "%2", label: "Shell" })).rejects.toThrow(/generic interpreter/);
  await expect(controller.register({ paneId: "%0", label: "Codex again" })).rejects.toThrow(/already registered as "Codex"/);
  await expect(controller.register({ paneId: "%9", label: "Ghost" })).rejects.toThrow(/does not exist/);
  expect(store.sessions()).toHaveLength(2);
});
test("re-registering a label re-points it at a new pane and keeps its history position", async () => {
  const result = await controller.register({ paneId: "%3", label: "Codex", relayPrompt: "Use the review-handoff skill." });
  expect(result.replaced).toBe(true);
  expect(store.sessions().map((s) => [s.id, s.identity.paneId, s.relayPrompt])).toEqual([["codex", "%3", "Use the review-handoff skill."], ["claude", "%1", "relay"]]);
});
test("registrations in a worktree with an unacknowledged delivery cannot change, while other worktrees can", async () => {
  failSends();
  const active = await controller.submit(command());
  await expect(controller.register({ paneId: "%3", label: "Codex" })).rejects.toThrow(/\/demo\/project has a command in flight or an uncertain delivery/); // moves codex away
  expect(() => controller.remove("claude")).toThrow(/uncertain delivery/);
  const other = await controller.register({ paneId: "%3", label: "Second Codex" }); // /demo/other is free
  expect(other.session.repository).toBe("/demo/other");
  store.release(active.id);
  controller.remove("claude");
  expect(store.sessions().map((s) => s.id)).toEqual(["codex", "second-codex"]);
  expect(() => controller.remove("claude")).toThrow(/No registration/);
});
test("a pair needs two registered sessions on the same worktree", async () => {
  await controller.register({ paneId: "%3", label: "Second Codex" });
  const pair = controller.createPair({ name: "Review loop", sessions: ["codex", "claude"] });
  expect(pair).toMatchObject({ id: "review-loop", name: "Review loop", repository: PROJECT, sessions: ["codex", "claude"] });
  expect(() => controller.createPair({ name: "Cross", sessions: ["codex", "second-codex"] })).toThrow(/do not share a worktree/);
  expect(() => controller.createPair({ name: "Ghost", sessions: ["codex", "nobody"] })).toThrow(/not a registered session/);
  expect(() => controller.createPair({ name: "Review loop", sessions: ["claude", "codex"] })).toThrow(/already exists/);
  expect((await controller.state()).pairs).toEqual([pair]);
});
test("a paired session cannot be removed or moved to another worktree until the pair is removed", async () => {
  controller.createPair({ name: "Review loop", sessions: ["codex", "claude"] });
  expect(() => controller.remove("codex")).toThrow(/belongs to the pair "Review loop"/);
  await expect(controller.register({ paneId: "%3", label: "Codex" })).rejects.toThrow(/Remove the pair before moving/);
  expect(() => controller.removePair("nope")).toThrow(/No pair/);
  controller.removePair("review-loop");
  controller.remove("codex");
  expect(store.sessions().map((s) => s.id)).toEqual(["claude"]);
});
test("pairs cannot change while their worktree has an unacknowledged delivery", async () => {
  failSends();
  const active = await controller.submit(command());
  expect(() => controller.createPair({ name: "Review loop", sessions: ["codex", "claude"] })).toThrow(/uncertain delivery/);
  store.release(active.id);
  controller.createPair({ name: "Review loop", sessions: ["codex", "claude"] });
  const again = await controller.submit(command());
  expect(() => controller.removePair("review-loop")).toThrow(/uncertain delivery/);
  store.release(again.id);
});
test("pane preview reads any live pane without registering it", async () => {
  const preview = await controller.preview("%2");
  expect(preview.paneId).toBe("%2"); expect(preview.text).toMatch(/zsh running in \/demo\/other/);
  await expect(controller.preview("%9")).rejects.toThrow(/does not exist/);
  await expect(controller.preview("demo:1.0")).rejects.toThrow(/exact pane ID/);
});
test("a CLI hook event is matched to the registered pane by exact tmux identity and tied to the last delivery", async () => {
  const relay = await controller.submit(command());
  const event = controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0", socketPath: "mock", sessionId: "thread-1", outcome: "accept_and_improve", reason: "Tightened the test." });
  expect(event).toMatchObject({ agentId: "codex", paneId: "%0", source: "codex", sessionId: "thread-1", commandId: relay.id, outcome: "accept_and_improve", reason: "Tightened the test." });
  // A reason without an outcome is meaningless and is dropped.
  expect(controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0", reason: "stray" })).toMatchObject({ outcome: null, reason: null });
  // Same pane id on another tmux server is a different pane.
  expect(controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0", socketPath: "/tmp/other-server" }).agentId).toBeNull();
  // Without a socket the pane id alone decides; an unknown pane is kept as unmatched for troubleshooting.
  expect(controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%1" })).toMatchObject({ agentId: "claude", commandId: null, sessionId: null });
  expect(controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%9" }).agentId).toBeNull();
  const turns = (await controller.state()).turns;
  expect(turns.map((t) => [t.agentId, t.paneId])).toEqual([["codex", "%0"], ["claude", "%1"], [null, "%9"]]); // latest per session, latest unmatched
});
test("a turn is tied to the command whose text it was prompted with, so an altered or foreign prompt leaves the command open", async () => {
  const relay = await controller.submit(command());
  // Leftover input in the pane turned "relay" into "xxxrelay": that turn answered nothing sent from here.
  const foreign = controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%0", prompt: "xxxrelay", settled: true });
  expect(foreign).toMatchObject({ agentId: "codex", commandId: null, prompt: "xxxrelay", outcomeState: "none" });
  // The real relay, typed by the human or queued, closes the command when its prompt matches.
  const real = controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%0", prompt: "relay", settled: true, outcome: "accept_and_improve" });
  expect(real).toMatchObject({ commandId: relay.id, outcomeState: "reported" });
  // A relay with context matches its full line; whitespace differences do not matter.
  const ctx = await controller.submit({ ...command(), text: "focus on the migration" });
  expect(controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0", prompt: "relay: focus on the migration " }).commandId).toBe(ctx.id);
  // Without a prompt (an older hook) the latest delivery is assumed, as before.
  expect(controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0" }).commandId).toBe(ctx.id);
});
test("a relay that ends before its outcome line is readable stays pending until the follow-up completes it", async () => {
  await controller.submit(command());
  const first = controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%0", settled: false });
  expect(first).toMatchObject({ agentId: "codex", outcome: null, outcomeState: "pending" });
  const done = controller.recordEvent({ source: "claude", event: "outcome", paneId: "%0", outcome: "accept_and_improve", reason: "Tightened.", settled: true });
  expect(done).toMatchObject({ agentId: "codex", outcome: "accept_and_improve", reason: "Tightened.", outcomeState: "reported", receivedAt: first.receivedAt });
  expect((await controller.state()).turns.filter((t) => t.agentId === "codex")).toHaveLength(1); // completed in place, not appended
  // A follow-up that found no line settles the question as "none"; a settled turn with no line is "none" at once.
  await controller.submit(command("claude"));
  expect(controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%1", settled: false }).outcomeState).toBe("pending");
  expect(controller.recordEvent({ source: "claude", event: "outcome", paneId: "%1", settled: true }).outcomeState).toBe("none");
  expect(controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0", settled: true }).outcomeState).toBe("none");
  // An instruction expects no line, so an unsettled transcript is not "pending" for it.
  await controller.submit({ ...command(), kind: "instruction", text: "reply READY" });
  expect(controller.recordEvent({ source: "claude", event: "turn_complete", paneId: "%0", settled: false }).outcomeState).toBe("none");
});
test("events never authorize anything: the worktree hold and the readiness rule are untouched by them", async () => {
  failSends();
  const held = await controller.submit(command());
  controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0" });
  expect(store.activeFor(PROJECT)).toBe(held.id);
  await expect(controller.submit(command())).rejects.toThrow(/uncertain delivery/);
});
test("the events table stays bounded and survives reopen", async () => {
  for (let i = 0; i < 520; i++) controller.recordEvent({ source: "codex", event: "turn_complete", paneId: "%0" });
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 500 });
  store.close(); store = new Store(directory);
  expect(store.latestTurns()).toHaveLength(1);
  expect(store.db.pragma("user_version", { simple: true })).toBe(3);
});
test("a listing failure leaves sessions readable and reports the error", async () => {
  adapter.listPanes = async () => { throw new Error("no server running"); };
  const state = await controller.state();
  expect(state.panes).toEqual([]); expect(state.panesError).toBe("no server running"); expect(state.sessions).toHaveLength(2);
});
test("session metadata, pairs and command history survive store reopen", async () => {
  controller.createPair({ name: "Review loop", sessions: ["codex", "claude"] });
  const result = await controller.submit(command());
  store.close(); store = new Store(directory);
  expect(store.sessions()).toHaveLength(2); expect(store.pairs()).toHaveLength(1);
  expect(store.get(result.id)?.status).toBe("delivered"); expect(store.activeFor(PROJECT)).toBeNull();
});
test("a version 1 store migrates its global reservation and untyped sessions", () => {
  store.close();
  rmSync(directory, { recursive: true, force: true }); directory = mkdtempSync(join(tmpdir(), "codercrew-test-"));
  const db = new Database(join(directory, "codercrew.sqlite3"));
  const { agentType: _codexType, ...codex } = mockSessions()[0]!;
  const { agentType: _claudeType, ...claude } = mockSessions()[1]!;
  const id = randomUUID(); const now = new Date().toISOString();
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE commands (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), active_id TEXT); PRAGMA user_version = 1;");
  db.prepare("INSERT INTO sessions VALUES (?,?)").run("codex", JSON.stringify(codex));
  db.prepare("INSERT INTO sessions VALUES (?,?)").run("claude", JSON.stringify({ ...claude, expectedCommand: "claude" }));
  db.prepare("INSERT INTO commands VALUES (?,?)").run(id, JSON.stringify({ id, agentId: "claude", kind: "relay", text: "relay", handoff: true, status: "sending", createdAt: now, updatedAt: now, error: null, releasedAt: null }));
  db.prepare("INSERT INTO control VALUES (1, ?)").run(id);
  db.close();
  store = new Store(directory);
  expect(store.db.pragma("user_version", { simple: true })).toBe(3);
  expect(store.sessions().map((s) => [s.id, s.agentType])).toEqual([["codex", "codex"], ["claude", "claude"]]);
  expect(store.reservations()).toEqual([{ repository: PROJECT, activeCommandId: id }]);
  store.recoverInterrupted();
  expect(store.get(id)?.status).toBe("uncertain");
  expect(() => store.db.prepare("SELECT * FROM control").get()).toThrow(/no such table/);
});
