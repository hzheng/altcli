import type { PaneState, SessionRegistration } from "../contracts/api.ts";
import type { DiscoveredKind, SkippedDirectory, Workspace, WorkspaceAgent, WorkspaceDiscovery, WorktreeIdentity } from "../contracts/workflow.ts";
import { assertAgentCommand, suggestAgentType } from "./policy.ts";
/** Read-only result of inspecting one pane directory: its canonical path and Git worktree, or why it could not be inspected. */
export type DirectoryInspection = { cwd: string; worktree: WorktreeIdentity | null; branch: string | null } | { error: string };
const KIND_LABEL = { codex: "Codex", claude: "Claude" } as const;
/** Classify one pane the way the registration picker does: a known coding CLI in a safe pane is eligible, nothing else is. */
export function classifyAgent(pane: PaneState & { location: string }, sessions: SessionRegistration[]): WorkspaceAgent {
  const registered = sessions.find((s) => s.identity.socketPath === pane.identity.socketPath && s.identity.paneId === pane.identity.paneId) ?? null;
  let kind: DiscoveredKind = suggestAgentType(pane.command);
  let reason: string | null = null;
  try { assertAgentCommand(pane.command); } catch { kind = "shell"; reason = `"${pane.command || "?"}" is a shell or generic interpreter, not a coding CLI.`; }
  if (kind === "other") reason = `"${pane.command}" is not a known coding CLI.`;
  if (pane.dead) reason = "The pane's process exited.";
  else if (pane.inMode) reason = "The pane is in copy mode.";
  else if (pane.synchronized) reason = "The pane has synchronized input enabled.";
  const name = kind === "codex" || kind === "claude" ? KIND_LABEL[kind] : pane.command || "?";
  const tmuxName = kind === "codex" || kind === "claude" ? pane.location.split(":")[0] : undefined;
  return { identity: pane.identity, location: pane.location, command: pane.command, kind, eligible: reason === null,
    observable: !pane.dead && (kind === 'codex' || kind === 'claude'), reason,
    label: registered?.label ?? (tmuxName || `${name} ${pane.identity.paneId}`), registeredAs: registered?.id ?? null };
}
const indexKey = (w: WorktreeIdentity) => `${w.root}\0${w.gitDir}\0${w.indexPath}`;
/** Group live panes into workspace cards by canonical cwd on one tmux server. Directories outside Git, or that could not be
 * inspected, are reported rather than guessed. All eligible agents are included by default. */
export function groupWorkspaces(panes: (PaneState & { location: string })[], inspections: Map<string, DirectoryInspection>, sessions: SessionRegistration[]): Pick<WorkspaceDiscovery, "workspaces" | "skipped"> {
  const cards = new Map<string, Workspace>(); const skipped = new Map<string, SkippedDirectory>();
  for (const pane of panes) {
    const inspection = inspections.get(pane.cwd);
    if (!inspection || "error" in inspection || !inspection.worktree) {
      const reason = !inspection ? "The directory was not inspected." : "error" in inspection ? inspection.error : "Not inside a Git worktree.";
      const entry = skipped.get(pane.cwd) ?? { cwd: pane.cwd, panes: 0, reason };
      skipped.set(pane.cwd, { ...entry, panes: entry.panes + 1 }); continue;
    }
    const key = `${pane.identity.socketPath}\0${inspection.cwd}`;
    const card = cards.get(key) ?? { cwd: inspection.cwd, socketPath: pane.identity.socketPath, worktree: inspection.worktree, branch: inspection.branch, agents: [], group: null, sharesIndexWith: [] };
    card.agents.push(classifyAgent(pane, sessions));
    cards.set(key, card);
  }
  const workspaces = [...cards.values()].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.socketPath.localeCompare(b.socketPath));
  for (const card of workspaces) {
    const eligible = card.agents.filter((a) => a.eligible);
    if (eligible.length) card.group = eligible.map((a) => a.identity.paneId);
    card.sharesIndexWith = workspaces.filter((other) => other !== card && indexKey(other.worktree) === indexKey(card.worktree)).map((other) => other.cwd);
  }
  return { workspaces, skipped: [...skipped.values()] };
}
