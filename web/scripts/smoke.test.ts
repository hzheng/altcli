/** Dependency-free smoke suite. Node >=22.6 with --experimental-strip-types. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentId, label, parseCommand, parseEvent, parsePair, parseRegistration, promptText, singleLine, slugify } from "../src/core/validation.ts";
import { assertAgentCommand, assertIdentity, sameRequest, suggestAgentType } from "../src/core/policy.ts";
import { authorize } from "../src/server/auth.ts";
import { describeConfig, loadConfig, resolveExecutable } from "../src/server/config.ts";
import { ENTER_SETTLE_MS, inputArgs, inspectPane, listPanes, createRunner, TmuxAdapter } from "../src/server/adapters/tmux.ts";
import { MockAdapter, mockPanes, mockSessions } from "../src/server/adapters/mock.ts";
import { jsonBody } from "../src/server/http.ts";
import { isWithin } from "../src/server/paths.ts";
import { isCodexHelper, processesForPane } from "../src/server/processes.ts";
import type { PaneState, SessionRegistration } from "../src/contracts/api.ts";
const id = "d2007c18-13e5-48d3-85e5-1f5b73c804f2";
const token = "a".repeat(64);
const origins = ["http://127.0.0.1:8787"];
function request(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:8787/api/v1/state", { headers: { authorization: `Bearer ${token}`, ...headers } });
}
const session: SessionRegistration = { id: "codex", label: "Codex", agentType: "codex", repository: "/tmp", expectedCommand: "codex", relayPrompt: "relay", registeredAt: "2026-09-14T00:00:00Z",
  identity: { paneId: "%1", panePid: "11", serverPid: "22", serverStarted: "123", socketPath: "/tmp/tmux-test" } };
const pane: PaneState = { identity: session.identity, command: "codex", cwd: "/tmp", dead: false, inMode: false, synchronized: false };
test("valid manual command keeps explicit destination and UUID", () => {
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "relay", confirmReady: true }).requestId, id);
});
test("readiness must be explicitly true", () => {
  assert.throws(() => parseCommand({ requestId: id, agentId: "codex", kind: "relay" }), /Confirm/);
});
test("a relay may carry multi-line context; an instruction must carry text", () => {
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "relay", confirmReady: true }).text, undefined);
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "relay", text: "", confirmReady: true }).text, undefined);
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "relay", text: "focus on the migration", confirmReady: true }).text, "focus on the migration");
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "relay", text: "a\nb", confirmReady: true }).text, "a\nb");
  assert.throws(() => parseCommand({ requestId: id, agentId: "codex", kind: "relay", text: "a\u001bb", confirmReady: true }), /control/);
  assert.throws(() => parseCommand({ requestId: id, agentId: "codex", kind: "instruction", confirmReady: true }), /nonempty/);
  assert.equal(parseCommand({ requestId: id, agentId: "codex", kind: "instruction", text: "do it", handoff: true, confirmReady: true }).handoff, true);
  assert.throws(() => parseCommand({ requestId: id, agentId: "codex", kind: "instruction", text: "do it", handoff: "yes", confirmReady: true }), /boolean/);
});
test("agent IDs are lowercase slugs, never tmux targets or shell fragments", () => {
  for (const value of ["codex; kill-server", "Codex", "%1", "-codex", "a".repeat(33), "", 3]) assert.throws(() => agentId(value));
  assert.equal(agentId("claude-2"), "claude-2");
});
test("labels derive stable ids and reject empty or control-character text", () => {
  assert.equal(slugify("Claude Code"), "claude-code");
  assert.equal(slugify("  Codex #2 (review) "), "codex-2-review");
  assert.throws(() => slugify("中文"), /at least one ASCII letter/);
  assert.equal(label("  Codex  "), "Codex");
  for (const value of ["", "   ", "a".repeat(41), "bad\u0007label", 7]) assert.throws(() => label(value));
});
test("registration input requires an exact pane and label and rejects unknown fields and relative repositories", () => {
  assert.deepEqual(parseRegistration({ paneId: "%3", label: "Codex" }), { paneId: "%3", label: "Codex" });
  assert.deepEqual(parseRegistration({ paneId: "%3", label: "Codex", repository: "/srv/repo", relayPrompt: "relay" }), { paneId: "%3", label: "Codex", repository: "/srv/repo", relayPrompt: "relay" });
  assert.throws(() => parseRegistration({ paneId: "agent:0", label: "Codex" }), /exact pane ID/);
  assert.throws(() => parseRegistration({ paneId: "%3", label: "Codex", repository: "repo" }), /absolute/);
  assert.throws(() => parseRegistration({ paneId: "%3", label: "Codex", relayPrompt: "a\nb" }));
  assert.throws(() => parseRegistration({ paneId: "%3", label: "Codex", expectedCommand: "zsh" }), /Unknown field/);
  assert.equal(parseRegistration({ paneId: "%3", label: "Codex", agentType: "claude" }).agentType, "claude");
  assert.throws(() => parseRegistration({ paneId: "%3", label: "Codex", agentType: "gpt" }), /codex, claude, or other/);
});
test("agent type is suggested from the observed process name but never from a shell", () => {
  assert.equal(suggestAgentType("codex"), "codex");
  assert.equal(suggestAgentType("claude"), "claude");
  assert.equal(suggestAgentType("2.1.272"), "claude");
  for (const command of ["zsh", "node", "aider", ""]) assert.equal(suggestAgentType(command), "other");
});
test("hook events are validated like any other input", () => {
  assert.deepEqual(parseEvent({ source: "claude", event: "turn_complete", paneId: "%3", socketPath: "/tmp/tmux-501/default", cwd: "/repo", sessionId: "abc" }),
    { source: "claude", event: "turn_complete", paneId: "%3", socketPath: "/tmp/tmux-501/default", cwd: "/repo", sessionId: "abc" });
  assert.deepEqual(parseEvent({ source: "codex", event: "turn_complete", paneId: "%3", socketPath: "", cwd: "", sessionId: "" }), { source: "codex", event: "turn_complete", paneId: "%3" });
  assert.throws(() => parseEvent({ source: "codex", event: "done", paneId: "%3" }), /turn_complete/);
  assert.throws(() => parseEvent({ source: "gpt", event: "turn_complete", paneId: "%3" }), /codex, claude, or other/);
  assert.throws(() => parseEvent({ source: "codex", event: "turn_complete", paneId: "agent:0" }), /exact pane ID/);
  assert.throws(() => parseEvent({ source: "codex", event: "turn_complete", paneId: "%3", socketPath: "relative" }), /absolute/);
  assert.throws(() => parseEvent({ source: "codex", event: "turn_complete", paneId: "%3", sessionId: "bad\u0007" }), /plain text/);
  assert.throws(() => parseEvent({ source: "codex", event: "turn_complete", paneId: "%3", text: "relay done" }), /Unknown field/);
  assert.deepEqual(parseEvent({ source: "claude", event: "turn_complete", paneId: "%3", outcome: "strong_objection", reason: "Drops the events table." }),
    { source: "claude", event: "turn_complete", paneId: "%3", outcome: "strong_objection", reason: "Drops the events table." });
  assert.deepEqual(parseEvent({ source: "claude", event: "turn_complete", paneId: "%3", outcome: null, reason: null }), { source: "claude", event: "turn_complete", paneId: "%3" });
  assert.throws(() => parseEvent({ source: "claude", event: "turn_complete", paneId: "%3", outcome: "approved" }), /four review-handoff outcomes/);
  assert.throws(() => parseEvent({ source: "claude", event: "turn_complete", paneId: "%3", outcome: "strong_objection", reason: "x".repeat(501) }), /at most 500/);
});
test("pair input names two different registered ids", () => {
  assert.deepEqual(parsePair({ name: "Review loop", sessions: ["codex", "claude"] }), { name: "Review loop", sessions: ["codex", "claude"] });
  assert.throws(() => parsePair({ name: "x", sessions: ["codex"] }), /exactly two/);
  assert.throws(() => parsePair({ name: "x", sessions: ["codex", "codex"] }), /two different/);
  assert.throws(() => parsePair({ name: "x", sessions: ["codex", "Claude"] }), /lowercase slug/);
  assert.throws(() => parsePair({ name: "x", sessions: ["codex", "claude"], repository: "/x" }), /Unknown field/);
});
test("command text rejects every low control character and line separator", () => {
  for (let i = 0; i < 32; i++) assert.throws(() => singleLine(`hello${String.fromCharCode(i)}world`));
  for (const c of ["\u007f", "\u0085", "\u2028", "\u2029"]) assert.throws(() => singleLine(`hello${c}world`));
});
test("text size is bounded in UTF-8 bytes, not JavaScript character count", () => {
  assert.equal(singleLine("界".repeat(666)).length, 666);
  assert.throws(() => singleLine("界".repeat(667)), /2,000/);
});
test("empty and whitespace-only commands are rejected", () => {
  for (const value of ["", "  ", null, 3]) assert.throws(() => singleLine(value));
});
test("only Codex's own helper binaries are exempt from background-work evidence", () => {
  for (const command of ["/opt/homebrew/Caskroom/codex/0.154.0/bin/codex-code-mode-host", "codex-app-server", "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"]) assert.ok(isCodexHelper(command), command);
  for (const command of ["codex", "codex-fake", "node", "/usr/bin/tail", "/tmp/codex-fake/evil", "node_repl", "/Users/x/codex-notes/run.sh"]) assert.ok(!isCodexHelper(command), command);
});
test("pane process evidence retains tty-attached work after its parent exits", () => {
  const rows = [
    { pid: "10", ppid: "1", tty: "ttys001", command: "-zsh" },
    { pid: "20", ppid: "10", tty: "ttys001", command: "codex" },
    { pid: "30", ppid: "1", tty: "ttys001", command: "sleep" },
    { pid: "40", ppid: "1", tty: "??", command: "unrelated" },
  ];
  assert.deepEqual(processesForPane(rows, "10"), [{ pid: "20", command: "codex" }, { pid: "30", command: "sleep" }]);
  // A root with no controlling terminal (Linux "?", macOS "??") keeps only its descendants; daemons are not its work.
  for (const none of ["?", "??"]) {
    const detached = [{ pid: "10", ppid: "1", tty: none, command: "-zsh" }, { pid: "20", ppid: "10", tty: none, command: "codex" }, { pid: "50", ppid: "1", tty: none, command: "launchd-helper" }];
    assert.deepEqual(processesForPane(detached, "10"), [{ pid: "20", command: "codex" }]);
  }
});
test('persistent browser REPL infrastructure is excluded but its task workers remain visible', () => {
  const app = '/Applications/ChatGPT.app/Contents/Resources';
  const codex = `${app}/codex`; const node = `${app}/cua_node/bin/node`;
  const rows = [
    { pid: '1', ppid: '0', tty: 'ttys001', command: '-zsh' },
    { pid: '2', ppid: '1', tty: 'ttys001', command: 'codex' },
    { pid: '3', ppid: '2', tty: 'ttys001', command: `${app}/cua_node/bin/node_repl` },
    { pid: '4', ppid: '3', tty: 'ttys001', command: codex, args: `${codex} app-server --listen stdio://` },
    { pid: '5', ppid: '3', tty: 'ttys001', command: codex, args: `${codex} sandbox -c fixture=true -- ${node} --experimental-vm-modules /tmp/fixture/kernel.js` },
    { pid: '6', ppid: '5', tty: 'ttys001', command: node, args: `${node} --experimental-vm-modules /tmp/fixture/kernel.js` },
    { pid: '7', ppid: '6', tty: 'ttys001', command: 'sleep', args: 'sleep 100' },
    { pid: '8', ppid: '3', tty: 'ttys001', command: codex, args: `${codex} exec actual-work` },
    { pid: '9', ppid: '3', tty: 'ttys001', command: node, args: `${node} worker.js` },
  ];
  const selected = processesForPane(rows, '1');
  assert.deepEqual(selected.map(p => p.pid), ['2', '3', '7', '8', '9']);
  assert.ok(selected.every(p => !('args' in p))); // Arguments never leave process inspection.
  assert.ok(processesForPane(rows.map(p => ({ ...p, args: undefined })), '1').some(p => p.pid === '4'));
  assert.ok(processesForPane(rows.map(p => p.pid === '3' ? { ...p, command: 'node' } : p), '1').some(p => p.pid === '4'));
});
test("prompt text keeps line breaks, normalizes CRLF, and refuses other controls", () => {
  assert.equal(promptText("first\r\nsecond\rthird"), "first\nsecond\nthird");
  for (const value of ["a\tb", "a\u001bb", "a\u0085b", "", "  ", null]) assert.throws(() => promptText(value));
  assert.throws(() => promptText("x".repeat(2001)), /2,000/);
});
test("a multi-line prompt is delivered as one bracketed paste, then Enter; a single line is still typed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "altcli-smoke-"));
  try {
    const calls: { args: string[]; input?: string }[] = [];
    const run = async (args: string[], input?: string) => { calls.push({ args, input }); return args[0] === "display-message" ? `%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t${directory}\t0\t0\t0\n` : ""; };
    const testSession = { ...session, repository: directory };
    await new TmuxAdapter(run).send(testSession, "line one; $(x)\nline two");
    assert.deepEqual(calls.map((c) => c.args[0]), ["display-message", "load-buffer", "paste-buffer", "display-message", "send-keys"]);
    const [, load, paste] = calls; const name = load!.args[2]!;
    assert.deepEqual(load!.args, ["load-buffer", "-b", name, "-"]); assert.equal(load!.input, "line one; $(x)\nline two");
    assert.deepEqual(paste!.args, ["paste-buffer", "-p", "-d", "-b", name, "-t", "%1"]);
    assert.deepEqual(calls.at(-1)!.args, ["send-keys", "-t", "%1", "Enter"]);
    calls.length = 0; await new TmuxAdapter(run).send(testSession, "one line");
    assert.deepEqual(calls.map((c) => c.args[0]), ["display-message", "send-keys", "display-message", "send-keys"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("hex transport preserves punctuation, semicolons and Unicode literally", () => {
  const text = "Review $(echo hi); path\\name 中文;";
  const args = inputArgs("%1", text);
  assert.deepEqual(args.slice(0, 4), ["send-keys", "-H", "-t", "%1"]);
  assert.ok(args.slice(4).every((arg) => /^[a-f0-9]{2}$/.test(arg)));
  assert.equal(Buffer.from(args.slice(4).map((arg) => parseInt(arg, 16))).toString("utf8"), text);
});
test("only exact numeric pane IDs reach the adapter", () => {
  for (const value of ["%1;", "agent:0", "-t", "1"]) assert.throws(() => inputArgs(value, "relay"));
});
test("all registered identity fields are checked", () => {
  assert.doesNotThrow(() => assertIdentity(session, pane));
  for (const key of Object.keys(session.identity) as (keyof typeof session.identity)[]) {
    assert.throws(() => assertIdentity(session, { ...pane, identity: { ...pane.identity, [key]: "changed" } }), /identity changed/);
  }
});
test("dead, copy-mode, and synchronized-input panes are refused", () => {
  for (const key of ["dead", "inMode", "synchronized"] as const) assert.throws(() => assertIdentity(session, { ...pane, [key]: true }));
});
test("shells and generic interpreters cannot be registered or matched, even when they are the foreground process", () => {
  for (const command of ["zsh", "bash", "sh", "fish", "login", "tmux", "node", "bun", "python", "python3.12", ""]) {
    assert.throws(() => assertAgentCommand(command), /generic interpreter/);
    assert.throws(() => assertIdentity({ ...session, expectedCommand: command }, { ...pane, command }));
  }
  for (const command of ["codex", "2.1.272", "claude"]) assert.doesNotThrow(() => assertAgentCommand(command));
});
test("the process name observed at registration must still be in the foreground", () => {
  const claude = { ...session, expectedCommand: "2.1.272" };
  assert.doesNotThrow(() => assertIdentity(claude, { ...pane, command: "2.1.272" }));
  for (const command of ["zsh", "codex", "2.1.273", "claude"]) assert.throws(() => assertIdentity(claude, { ...pane, command }), /not in the foreground/);
});
test("duplicate request equivalence includes agent, kind, resolved text and handoff policy", () => {
  const a = { agentId: "codex", kind: "relay", text: "relay" };
  assert.equal(sameRequest(a, { ...a }), true);
  for (const key of ["agentId", "kind", "text"] as const) assert.equal(sameRequest(a, { ...a, [key]: "changed" }), false);
  assert.equal(sameRequest({ ...a, handoff: false }, { ...a, handoff: true }), false);
});
test("bearer authentication is required even for mock reads", () => {
  assert.doesNotThrow(() => authorize(request(), token, origins));
  assert.throws(() => authorize(request({ authorization: "" }), token, origins));
  assert.throws(() => authorize(request({ authorization: `Bearer ${"b".repeat(64)}` }), token, origins));
});
test("cross-site origin and foreign host are rejected", () => {
  assert.throws(() => authorize(request({ origin: "https://evil.example" }), token, origins));
  assert.throws(() => authorize(request({ host: "evil.example" }), token, origins));
  assert.throws(() => authorize(request({ "sec-fetch-site": "cross-site" }), token, origins));
});
test("native-style Origin omission still requires the bearer token", () => {
  assert.doesNotThrow(() => authorize(request(), token, origins));
});
test("configuration rejects invalid tokens, relative data paths and public HTTP origins", () => {
  const env = { ALTCLI_TOKEN: token };
  assert.equal(loadConfig(env).mode, "tmux");
  assert.equal(loadConfig(env).inputEnabled, true);
  assert.equal(loadConfig({ ...env, ALTCLI_ENABLE_INPUT: "false" }).inputEnabled, false);
  assert.equal(loadConfig({ ...env, ALTCLI_ADAPTER: "mock" }).mode, "mock");
  assert.throws(() => loadConfig({ ...env, ALTCLI_ADAPTER: "ssh" }));
  assert.throws(() => loadConfig({ ...env, ALTCLI_TOKEN: "secret" }));
  assert.throws(() => loadConfig({ ...env, ALTCLI_DATA_DIR: "./data" }));
  assert.throws(() => loadConfig({ ...env, ALTCLI_ALLOWED_ORIGINS: "http://public.example" }));
  assert.throws(() => loadConfig({ ...env, ALTCLI_ALLOWED_ORIGINS: "https://host.example/path" }));
});
test("directory boundaries are not string-prefix comparisons", () => {
  assert.equal(isWithin("/tmp/repo", "/tmp/repo/data"), true);
  assert.equal(isWithin("/tmp/repo", "/tmp/repo-other"), false);
  assert.equal(isWithin("/tmp/repo", "/tmp/other"), false);
});
test("tmux metadata parsing is strict and does not infer missing identity", async () => {
  const data = "%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t/tmp\t0\t0\t0\n";
  assert.deepEqual(await inspectPane(async () => data, "%1"), pane);
  await assert.rejects(inspectPane(async () => "partial", "%1"));
  await assert.rejects(inspectPane(async () => data, "agent:0"), /exact pane ID/);
});
test("pane listing covers every pane with its location and stays strict", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return "work\t1\t0\t%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t/tmp\t0\t0\t0\nwork\t2\t1\t%4\t44\t22\t123\t/tmp/tmux-test\tzsh\t/tmp\t0\t1\t0\n"; };
  const panes = await listPanes(run);
  assert.deepEqual(calls[0]?.slice(0, 2), ["list-panes", "-a"]);
  assert.deepEqual(panes.map((p) => [p.location, p.identity.paneId, p.command, p.inMode]), [["work:1.0", "%1", "codex", false], ["work:2.1", "%4", "zsh", true]]);
  assert.deepEqual(panes[0], { ...pane, location: "work:1.0" });
  assert.deepEqual(await listPanes(async () => ""), []);
  await assert.rejects(listPanes(async () => "work\t1\t0\t%1\tshort\n"), /Unexpected tmux metadata/);
});
test("tmux failures surface tmux's own first stderr line", async () => {
  await assert.rejects(createRunner(process.execPath)(["-e", "console.error('no server running on /tmp/sock\\nmore'); process.exit(1)"]), /tmux -e failed: no server running on \/tmp\/sock\. Inspect tmux/);
});
test("process adapter executes argument arrays without a shell", async () => {
  assert.equal(await createRunner(process.execPath)(["-e", "process.stdout.write('adapter-ok')"]), "adapter-ok");
});
test("pane preview is a bounded capture with a validated pane id and no identity check", async () => {
  const calls: string[][] = [];
  await new TmuxAdapter(async (args) => { calls.push(args); return "screen"; }).peek("%7");
  assert.deepEqual(calls, [["capture-pane", "-p", "-J", "-S", "-12", "-t", "%7"]]);
  await assert.rejects(new TmuxAdapter(async () => "").peek("agent:0"), /exact pane ID/);
});
test("tmux send revalidates and sends text, waits out Codex's paste window, then presses Enter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "altcli-smoke-"));
  try {
    const calls: { args: string[]; at: number }[] = [];
    const testSession = { ...session, repository: directory };
    const run = async (args: string[]) => { calls.push({ args, at: performance.now() }); return args[0] === "display-message" ? `%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t${directory}\t0\t0\t0\n` : ""; };
    await new TmuxAdapter(run).send(testSession, "relay");
    assert.deepEqual(calls.map((call) => call.args[0]), ["display-message", "send-keys", "display-message", "send-keys"]);
    assert.deepEqual(calls.at(-1)!.args, ["send-keys", "-t", "%1", "Enter"]);
    assert.ok(calls[3]!.at - calls[1]!.at >= ENTER_SETTLE_MS - 5, "Enter must not follow the text inside Codex's 120 ms paste-suppression window");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("tmux send stops before Enter if foreground ownership changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "altcli-smoke-"));
  try {
    let reads = 0; const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); if (args[0] !== "display-message") return "";
      reads++; return `%1\t11\t22\t123\t/tmp/tmux-test\t${reads === 1 ? "codex" : "zsh"}\t${directory}\t0\t0\t0\n`; };
    await assert.rejects(new TmuxAdapter(run).send({ ...session, repository: directory }, "relay"));
    assert.equal(calls.filter((call) => call.includes("Enter")).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("wrong repository is refused even when the process matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "altcli-smoke-"));
  try {
    await mkdir(join(directory, "repo"));
    const run = async () => `%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t${directory}\t0\t0\t0\n`;
    await assert.rejects(new TmuxAdapter(run).preflight({ ...session, repository: join(directory, "repo") }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("mock sends never invoke an external process or claim a real review", async () => {
  const adapter = new MockAdapter(); const sample = mockSessions()[0]!;
  await adapter.send(sample, "relay");
  assert.match(await adapter.capture(sample), /No review or code change was performed/);
});
test("mock panes include a shell to demonstrate refusal and a spare CLI to register", async () => {
  const adapter = new MockAdapter();
  assert.deepEqual((await adapter.listPanes()).map((p) => p.command), ["codex", "2.1.272", "zsh", "codex"]);
  assert.equal((await adapter.inspect("%3")).cwd, "/demo/other");
  await assert.rejects(adapter.inspect("%9"), /does not exist/);
  assert.match(await adapter.peek("%2"), /MOCK preview of %2 at demo:1\.0/);
  await assert.rejects(adapter.peek("%9"), /does not exist/);
  assert.ok(mockPanes().every((p) => mockSessions().every((s) => s.identity.paneId !== p.identity.paneId || s.expectedCommand === p.command)));
});
test("Claude hooks bind the actual prompt and current Stop response without reading a lagging transcript", { timeout: 10000 }, async () => {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "altcli-hook-"));
  const posts: Record<string, unknown>[] = [];
  const server = createServer((req, res) => { let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
    const event = JSON.parse(body); posts.push(event);
    res.end(JSON.stringify({ accepted: true, completion: event.backgroundState === 'clear' ? 'finished' : 'pending' }));
  }); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(join(directory, "tmux"), "#!/bin/sh\nprintf '%s\\n' '%7\t11\t12\t13\t/tmp/tmux-fixture'\n", { mode: 0o700 });
    await writeFile(join(directory, "env"), `ALTCLI_TOKEN=${token}\n`);
    const transcript = join(directory, "lagging.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: "RELAY-OUTCOME: accept_and_improve" } }));
    const invoke = (payload: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL("../../hooks/altcli-turn-complete.mjs", import.meta.url)), "claude"],
        { env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`, TMUX: "/tmp/tmux-fixture,12,0", TMUX_PANE: "%7",
          ALTCLI_ENV: join(directory, "env"), ALTCLI_URL: `http://127.0.0.1:${port}` }, timeout: 5000 },
        (error) => error ? reject(error) : resolve());
      child.stdin!.end(JSON.stringify({ session_id: "test-session", ...payload }));
    });
    await invoke({ hook_event_name: "UserPromptSubmit", prompt: `relay: [altcli-command:${id}]` });
    await invoke({ hook_event_name: "Stop", transcript_path: transcript, last_assistant_message: "RELAY-OUTCOME: strong_objection - Current rejection.", background_tasks: [], session_crons: [] });
    assert.equal(posts.length, 2); assert.equal(posts[0]!.event, "turn_started");
    assert.equal(posts[1]!.outcome, "strong_objection"); assert.equal(posts[1]!.commandId, id);
    assert.equal(posts[0]!.sourceTurnId, posts[1]!.sourceTurnId); assert.equal(posts[1]!.backgroundState, "clear");
    await invoke({ hook_event_name: "Stop", transcript_path: transcript }); assert.equal(posts.length, 2);
    await invoke({ hook_event_name: "UserPromptSubmit", prompt: `relay: [altcli-command:${id}]` });
    await invoke({ hook_event_name: "UserPromptSubmit", prompt: `relay: [altcli-command:${id}]` });
    assert.equal(posts.at(-1)!.commandId, undefined);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
test("JSON boundary rejects wrong media type and oversized request bodies", async () => {
  await assert.rejects(jsonBody(new Request("http://localhost", { method: "POST", body: "{}" })));
  await assert.rejects(jsonBody(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(17000) }) })));
  assert.deepEqual(await jsonBody(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: '{"ok":true}' })), { ok: true });
});
test("the host configuration description resolves the tmux binary, names the variables that were set and never carries the token", () => {
  const env = { ALTCLI_TOKEN: token, ALTCLI_ADAPTER: "mock", ALTCLI_DATA_DIR: "/tmp/altcli-smoke", ALTCLI_TMUX_BIN: process.execPath, PATH: process.env.PATH };
  const described = describeConfig(loadConfig(env), env);
  assert.equal(described.tmuxBin, process.execPath); assert.equal(described.tmuxPath, process.execPath);
  assert.equal(described.dataDir, "/tmp/altcli-smoke/mock"); assert.equal(described.tmuxSocket, null); assert.deepEqual(described.integrationBranches, ["main", "master"]);
  assert.deepEqual(described.environment, ["ALTCLI_ADAPTER", "ALTCLI_DATA_DIR", "ALTCLI_TMUX_BIN"]);
  assert.ok(!JSON.stringify(described).includes(token));
  assert.equal(resolveExecutable("no-such-binary-for-altcli", { PATH: dirname(process.execPath) }), null);
  assert.equal(resolveExecutable("node", { PATH: dirname(process.execPath) }), join(dirname(process.execPath), "node"));
  assert.equal(resolveExecutable("/no/such/tmux", env), null);
});

test('key-only transport has a closed enum, checks modes and sends Escape without a following Enter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'altcli-key-'));
  try {
    const calls: string[][] = []; let mode = '0';
    const run = async (args: string[]) => { calls.push(args); return args[0] === 'display-message' ? `%1\t11\t22\t123\t/tmp/tmux-test\tcodex\t${directory}\t0\t${mode}\t0\n` : ''; };
    const adapter = new TmuxAdapter(run); const target = { ...session, repository: directory };
    await adapter.press(target, 'Escape');
    assert.deepEqual(calls.map((c) => c[0]), ['display-message','send-keys']);
    assert.deepEqual(calls[1], ['send-keys','-t','%1','Escape']);
    calls.length = 0; mode = '1'; await assert.rejects(adapter.press(target, 'Enter'), /copy mode/);
    assert.equal(calls.length, 1); calls.length = 0;
    await assert.rejects(adapter.press(target, 'C-c' as 'Enter'), /Unsupported terminal key/); assert.equal(calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
