import type { AgentType, PaneState, SessionRegistration } from "../contracts/api.ts";
import { AppError } from "./errors.ts";
/** A suggestion for the registration form only; the human confirms. A native Claude Code binary reports its version as its name. */
export function suggestAgentType(command: string): AgentType {
  if (command === "codex") return "codex";
  if (command === "claude" || /^\d+\.\d+\.\d+/.test(command)) return "claude";
  return "other";
}
// Shells and generic interpreters cannot establish that a coding CLI owns the pane's input. An npm-installed CLI
// that reports "node" is refused on purpose; install the native binary instead. Do not shrink this list to pass a check.
const GENERIC_PROCESSES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login", "su", "sudo", "ssh",
  "tmux", "screen", "script", "node", "bun", "deno", "python", "ruby", "perl"]);
export function assertAgentCommand(command: string): void {
  if (!command || GENERIC_PROCESSES.has(command) || /^python\d/.test(command)) {
    throw new AppError("GENERIC_PROCESS", `"${command || "?"}" is a shell or generic interpreter, not a coding CLI. Start the CLI in this pane (for example with exec) and try again.`, 409);
  }
}
/** Necessary transport checks, NOT proof of semantic readiness or agent authenticity. */
export function assertIdentity(session: SessionRegistration, pane: PaneState): void {
  for (const key of ["paneId", "panePid", "serverPid", "serverStarted", "socketPath"] as const) {
    if (session.identity[key] !== pane.identity[key]) throw new AppError("TARGET_CHANGED", "tmux identity changed. Re-register this session.", 409);
  }
  if (pane.dead || pane.inMode || pane.synchronized) throw new AppError("UNSAFE_PANE", "Pane is dead, in copy mode, or has synchronized input enabled.", 409);
  // The name recorded at registration is a transport check only; a native CLI may report a version string as its name.
  assertAgentCommand(session.expectedCommand);
  if (pane.command !== session.expectedCommand) {
    throw new AppError("WRONG_PROCESS", `The registered process "${session.expectedCommand}" is not in the foreground; the pane reports "${pane.command}". Check the desktop terminal.`, 409);
  }
}
export function sameRequest(previous: { agentId: string; kind: string; text: string }, next: { agentId: string; kind: string; text: string }): boolean {
  return previous.agentId === next.agentId && previous.kind === next.kind && previous.text === next.text;
}
