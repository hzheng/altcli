import { expect, test } from "vitest";
import { paneRequest, sendAction, type PaneAction, type PaneRequestInput } from "./pane-actions";
const base: PaneRequestInput = { action: "send", requestId: "11111111-1111-4111-8111-111111111111", groupId: "g", groupRevision: 3, registrations: { codex: "r1", claude: "r2" },
  agentId: "codex", policy: "peer", text: " Do the task. ", branch: { branch: "task/x", head: "a".repeat(40) }, automatic: true, turnLimit: 20, pauseOnObjection: true, reviewBase: "b".repeat(40) };
const request = (action: PaneAction, more: Partial<PaneRequestInput> = {}) => paneRequest({ ...base, action, ...more });

test("After send maps to plain Send, work without relay, and work with relay", () => {
  expect([sendAction("nothing"), sendAction("commit"), sendAction("commit_relay")]).toEqual(["send", "send_commit", "send_commit_relay"]);
  const send = request("send");
  expect(send).toEqual({ path: "instructions", body: { requestId: base.requestId, groupId: "g", groupRevision: 3, registrations: base.registrations, agentId: "codex", text: "Do the task.", policy: "peer", confirmReady: true } });
  expect(request("send_commit")).toMatchObject({ path: "implementation", body: { kind: "work", text: "Do the task.", handoff: false, autoContinue: false, agentId: "codex", branch: base.branch } });
  expect(request("send_commit_relay")).toMatchObject({ path: "implementation", body: { kind: "work", handoff: true, autoContinue: true, pauseOnObjection: true } });
});
test("new work never carries a review baseline; snapshot relay and review do", () => {
  for (const action of ["send_commit", "send_commit_relay"] as const) expect(request(action).body).not.toHaveProperty("reviewBase");
  expect(request("commit").body).not.toHaveProperty("reviewBase");
  expect(request("commit_relay").body).toMatchObject({ kind: "commit", handoff: true, reviewBase: "b".repeat(40) });
  expect(request("relay", { agentId: "claude" }).body).toMatchObject({ kind: "review", handoff: true, agentId: "claude", reviewBase: "b".repeat(40) });
});
test("plain Commit stops, omits empty text, and only relays can continue automatically", () => {
  const commit = request("commit", { text: "  " }).body;
  expect(commit).toMatchObject({ kind: "commit", handoff: false, autoContinue: false }); expect(commit).not.toHaveProperty("text");
  expect(request("commit_relay", { automatic: false }).body).toMatchObject({ autoContinue: false });
});
test("solo never continues or pauses on objections, and only worker/reviewer names a worker", () => {
  expect(request("send_commit", { policy: "solo" }).body).toMatchObject({ policy: "solo", autoContinue: false, pauseOnObjection: false });
  expect(request("send", { policy: "worker_reviewer", workerId: "codex" }).body).toMatchObject({ workerId: "codex" });
  expect(request("send_commit").body).not.toHaveProperty("workerId");
  expect(request("commit", { logPath: "docs/log.jsonl" }).body).toMatchObject({ logPath: "docs/log.jsonl" });
  expect(request("commit").body).not.toHaveProperty("logPath");
});
