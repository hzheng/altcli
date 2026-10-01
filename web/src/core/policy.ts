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
  assertAgentCommand(session.expectedCommand);
  if (pane.command !== session.expectedCommand) {
    throw new AppError("WRONG_PROCESS", `The registered process "${session.expectedCommand}" is not in the foreground; the pane reports "${pane.command}". Check the desktop terminal.`, 409);
  }
}
export function sameRequest(previous: { agentId: string; kind: string; text: string; handoff?: boolean }, next: { agentId: string; kind: string; text: string; handoff?: boolean }): boolean {
  return previous.agentId === next.agentId && previous.kind === next.kind && previous.text === next.text && Boolean(previous.handoff) === Boolean(next.handoff);
}
/** Codex 0.157+ runs turns in a shared background server unless started with --no-daemon. That server's hooks lack the pane's tmux
 * identity, so AltCLI cannot correlate the pane's turns. Only direct Codex argv can be checked and amended here. */
export function lacksCodexNoDaemon(profile: { adapterHint: string; executable: string; args: string[] }): boolean {
  return isDirectCodexProfile(profile) && !profile.args.includes("--no-daemon");
}
/** A display hint cannot establish how a shell or wrapper passes arguments to Codex. */
export const isDirectCodexProfile = (profile: { executable: string }): boolean => /(^|\/)codex$/.test(profile.executable);
/** The only model and reasoning values a Global AI (A1) launch accepts. Settings saves them in the profile with this label. */
export const GLOBAL_AI_PROFILE_LABEL = "Helper";
/** The label saved before the Helper rename. Such a profile is still found until Settings saves it under the current label. */
const LEGACY_GLOBAL_AI_PROFILE_LABEL = "Global AI";
export function findGlobalAIProfile<T extends { label: string }>(profiles: T[]): T | undefined {
  return profiles.find((p) => p.label === GLOBAL_AI_PROFILE_LABEL) ?? profiles.find((p) => p.label === LEGACY_GLOBAL_AI_PROFILE_LABEL);
}
export const GLOBAL_AI_MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
export const GLOBAL_AI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
