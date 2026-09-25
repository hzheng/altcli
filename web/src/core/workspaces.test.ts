import { beforeEach, expect, test } from "vitest";
import type { PaneState, SessionRegistration } from "../contracts/api";
import type { WorktreeIdentity } from "../contracts/workflow";
import { classifyAgent, groupWorkspaces, type DirectoryInspection } from "./workspaces";
const socketPath = "/tmp/tmux-test";
let counter = 0;
beforeEach(() => { counter = 0; });
function pane(command: string, cwd: string, more: Partial<PaneState> = {}): PaneState & { location: string } {
  const n = counter++;
  return { identity: { paneId: `%${n}`, panePid: `${100 + n}`, serverPid: "20", serverStarted: "100", socketPath }, command, cwd,
    dead: false, inMode: false, synchronized: false, location: `main:0.${n}`, ...more };
}
const worktree = (root: string): WorktreeIdentity => ({ root, gitDir: `${root}/.git`, indexPath: `${root}/.git/index` });
const inspected = (entries: Record<string, DirectoryInspection>) => new Map(Object.entries(entries));
test("only a known coding CLI in a safe pane is eligible; shells and unknown runtimes are shown with a reason", () => {
  expect(classifyAgent(pane("codex", "/repo"), [])).toMatchObject({ kind: "codex", eligible: true, reason: null, label: "main", registeredAs: null });
  expect(classifyAgent(pane("2.1.272", "/repo"), [])).toMatchObject({ kind: "claude", eligible: true, label: "main" });
  expect(classifyAgent(pane("zsh", "/repo"), [])).toMatchObject({ kind: "shell", eligible: false, reason: expect.stringContaining("shell or generic interpreter"), label: "zsh %2" });
  expect(classifyAgent(pane("node", "/repo"), [])).toMatchObject({ kind: "shell", eligible: false });
  expect(classifyAgent(pane("aider", "/repo"), [])).toMatchObject({ kind: "other", eligible: false, reason: '"aider" is not a known coding CLI.', label: "aider %4" });
  expect(classifyAgent(pane("codex", "/repo", { inMode: true }), [])).toMatchObject({ kind: "codex", eligible: false, reason: "The pane is in copy mode." });
  expect(classifyAgent(pane("codex", "/repo", { synchronized: true }), [])).toMatchObject({ eligible: false, reason: expect.stringContaining("synchronized") });
  expect(classifyAgent(pane("codex", "/repo", { dead: true }), [])).toMatchObject({ eligible: false, reason: "The pane's process exited." });
});
test('copy mode and synchronized input block automation but preserve live CLI observation', () => {
  for (const flag of ['inMode', 'synchronized'] as const) {
    expect(classifyAgent(pane('claude', '/repo', { [flag]: true }), [])).toMatchObject({ eligible: false, observable: true });
    expect(classifyAgent(pane('zsh', '/repo', { [flag]: true }), [])).toMatchObject({ eligible: false, observable: false });
    expect(classifyAgent(pane('claude', '/repo', { [flag]: true, dead: true }), [])).toMatchObject({ eligible: false, observable: false });
  }
});
test("a registered pane keeps its registered label and id", () => {
  const p = pane("codex", "/repo");
  const session: SessionRegistration = { id: "main-codex", label: "Main Codex", agentType: "codex", repository: "/repo", expectedCommand: "codex", identity: p.identity, relayPrompt: "relay", registeredAt: "2026-09-19T00:00:00Z" };
  expect(classifyAgent(p, [session])).toMatchObject({ label: "Main Codex", registeredAs: "main-codex" });
  // Same pane id on another tmux server is a different pane.
  expect(classifyAgent({ ...p, identity: { ...p.identity, socketPath: "/tmp/other" } }, [session])).toMatchObject({ label: "main", registeredAs: null });
});
test("all eligible agents form the default group, including three or more", () => {
  const panes = [pane("codex", "/two"), pane("2.1.272", "/two"), pane("zsh", "/two"), pane("node", "/two"),
    pane("codex", "/one"), pane("zsh", "/one"),
    pane("codex", "/three"), pane("codex", "/three"), pane("2.1.272", "/three"),
    pane("zsh", "/none")];
  const { workspaces, skipped } = groupWorkspaces(panes, inspected({
    "/two": { cwd: "/two", worktree: worktree("/two"), branch: "feature/x" }, "/one": { cwd: "/one", worktree: worktree("/one"), branch: "main" },
    "/three": { cwd: "/three", worktree: worktree("/three"), branch: null }, "/none": { cwd: "/none", worktree: worktree("/none"), branch: "main" } }), []);
  expect(skipped).toEqual([]);
  expect(workspaces.map((w) => [w.cwd, w.branch, w.agents.length, w.group])).toEqual([
    ["/none", "main", 1, null], ["/one", "main", 2, ["%4"]], ["/three", null, 3, ["%6", "%7", "%8"]], ["/two", "feature/x", 4, ["%0", "%1"]]]);
  // A shell or dev server in the directory is visible but never counted.
  expect(workspaces.find((w) => w.cwd === "/two")!.agents.map((a) => a.eligible)).toEqual([true, true, false, false]);
});
test("equivalent spellings collapse into one card; subdirectories stay separate cards that share the index", () => {
  const panes = [pane("codex", "/repo"), pane("2.1.272", "/link/repo"), pane("codex", "/repo/web")];
  const { workspaces } = groupWorkspaces(panes, inspected({
    "/repo": { cwd: "/repo", worktree: worktree("/repo"), branch: "main" }, "/link/repo": { cwd: "/repo", worktree: worktree("/repo"), branch: "main" },
    "/repo/web": { cwd: "/repo/web", worktree: worktree("/repo"), branch: "main" } }), []);
  expect(workspaces.map((w) => [w.cwd, w.agents.map((a) => a.identity.paneId), w.group, w.sharesIndexWith])).toEqual([
    ["/repo", ["%0", "%1"], ["%0", "%1"], ["/repo/web"]], ["/repo/web", ["%2"], ["%2"], ["/repo"]]]);
});
test("linked worktrees are distinct cards that do not share an index", () => {
  const panes = [pane("codex", "/repo"), pane("codex", "/linked")];
  const { workspaces } = groupWorkspaces(panes, inspected({
    "/repo": { cwd: "/repo", worktree: worktree("/repo"), branch: "main" },
    "/linked": { cwd: "/linked", worktree: { root: "/linked", gitDir: "/repo/.git/worktrees/linked", indexPath: "/repo/.git/worktrees/linked/index" }, branch: null } }), []);
  expect(workspaces.map((w) => [w.cwd, w.branch, w.sharesIndexWith])).toEqual([["/linked", null, []], ["/repo", "main", []]]);
});
test("directories outside Git or that failed inspection are reported per directory, never guessed", () => {
  const panes = [pane("codex", "/home"), pane("zsh", "/home"), pane("codex", "/gone"), pane("codex", "/repo"), pane("codex", "/unlisted")];
  const { workspaces, skipped } = groupWorkspaces(panes, inspected({
    "/home": { cwd: "/home", worktree: null, branch: null }, "/gone": { error: "ENOENT: no such file or directory" }, "/repo": { cwd: "/repo", worktree: worktree("/repo"), branch: "main" } }), []);
  expect(workspaces.map((w) => w.cwd)).toEqual(["/repo"]);
  expect(skipped).toEqual([{ cwd: "/home", panes: 2, reason: "Not inside a Git worktree." }, { cwd: "/gone", panes: 1, reason: "ENOENT: no such file or directory" },
    { cwd: "/unlisted", panes: 1, reason: "The directory was not inspected." }]);
});
test("the same directory on two tmux servers is two cards", () => {
  const a = pane("codex", "/repo"); const b = { ...pane("codex", "/repo"), identity: { ...pane("codex", "/repo").identity, socketPath: "/tmp/other" } };
  const { workspaces } = groupWorkspaces([a, b], inspected({ "/repo": { cwd: "/repo", worktree: worktree("/repo"), branch: "main" } }), []);
  expect(workspaces.map((w) => [w.socketPath, w.agents.length, w.group])).toEqual([["/tmp/other", 1, ["%2"]], ["/tmp/tmux-test", 1, ["%0"]]]);
});

test("default names use the tmux session while pane identities and saved names stay independent", () => {
  const first = { ...pane("codex", "/repo"), location: "altcli-cc:1.1" };
  const second = { ...pane("2.1.272", "/repo"), location: "altcli-cc:1.2" };
  expect(classifyAgent(first, []).label).toBe("altcli-cc");
  expect(classifyAgent(second, []).label).toBe("altcli-cc");
  expect(first.identity.paneId).not.toBe(second.identity.paneId);
  expect(classifyAgent({ ...first, location: "renamed:1.1" }, []).label).toBe("renamed");
  expect(classifyAgent({ ...first, location: "" }, []).label).toBe("Codex %0");
});
