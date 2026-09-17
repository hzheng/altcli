import type { AgentId, PaneState, SessionRegistration } from "../../contracts/api.ts";
import { AppError } from "../../core/errors.ts";
import type { ProcessRecord } from "../../contracts/workflow.ts";
import type { ListedPane, TerminalAdapter } from "./terminal.ts";
const IDENTITY = { panePid: "10", serverPid: "20", serverStarted: "100", socketPath: "/tmp/codercrew-mock" };
/** Simulated tmux server: two coding CLIs already registered by default, a shell to demonstrate refusal, and a spare CLI to register. */
export function mockPanes(): ListedPane[] {
  return [
    { location: "demo:0.0", command: "codex", cwd: "/demo/project", paneId: "%0" },
    { location: "demo:0.1", command: "2.1.272", cwd: "/demo/project", paneId: "%1" },
    { location: "demo:1.0", command: "zsh", cwd: "/demo/other", paneId: "%2" },
    { location: "demo:1.1", command: "codex", cwd: "/demo/other", paneId: "%3" },
  ].map(({ paneId, ...pane }) => ({ ...pane, identity: { paneId, ...IDENTITY }, dead: false, inMode: false, synchronized: false }));
}
export class MockAdapter implements TerminalAdapter {
  readonly output = new Map<AgentId, string>();
  /** Simulated process trees per session; tests set them to model work spawned during a turn. */
  readonly trees = new Map<AgentId, ProcessRecord[]>();
  /** Simulated foreground pids; unset means the mock cannot tell, like an adapter without process visibility. */
  readonly foregrounds = new Map<AgentId, string>();
  async listPanes(): Promise<ListedPane[]> { return mockPanes(); }
  async inspect(paneId: string): Promise<PaneState> {
    const pane = mockPanes().find((p) => p.identity.paneId === paneId);
    if (!pane) throw new AppError("TMUX_FAILED", `Mock pane ${paneId} does not exist.`, 409);
    return pane;
  }
  async peek(paneId: string): Promise<string> {
    const pane = mockPanes().find((p) => p.identity.paneId === paneId);
    if (!pane) throw new AppError("TMUX_FAILED", `Mock pane ${paneId} does not exist.`, 409);
    return `[MOCK preview of ${paneId} at ${pane.location}]\n${pane.command} running in ${pane.cwd}\nNo real terminal was read.\n> `;
  }
  async preflight(): Promise<void> { /* No process or filesystem side effects. */ }
  async capture(session: SessionRegistration): Promise<string> {
    return this.output.get(session.id) ?? `[MOCK ${session.label}]\n\nThis is a simulated pane, not a connected coding agent.\nNo repository has been read or modified.\n\nReady to preview a manual command.\n> `;
  }
  async send(session: SessionRegistration, text: string): Promise<void> {
    if (text.replace(/ \[codercrew-command:[0-9a-f-]+\]$/i, "") === "mock:uncertain") throw new AppError("TMUX_FAILED", "Simulated transport failure after typing began.", 409);
    this.output.set(session.id, `${await this.capture(session)}${text}\n\n[MOCK] Input received. No review or code change was performed.\n> `);
  }
  async processes(session: SessionRegistration): Promise<ProcessRecord[]> { return [...(this.trees.get(session.id) ?? [])]; }
  async foreground(session: SessionRegistration): Promise<string | null> { return this.foregrounds.get(session.id) ?? null; }
}
export function mockSessions(): SessionRegistration[] {
  return [{ id: "codex", label: "Codex", agentType: "codex" as const, paneId: "%0", expectedCommand: "codex" }, { id: "claude", label: "Claude Code", agentType: "claude" as const, paneId: "%1", expectedCommand: "2.1.272" }]
    .map(({ paneId, ...session }) => ({ ...session, repository: "/demo/project", identity: { paneId, ...IDENTITY }, relayPrompt: "relay", registeredAt: "2026-09-14T00:00:00Z" }));
}
