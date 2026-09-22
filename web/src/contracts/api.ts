/** JSON-only API contracts. Never import Node, Next, SQLite, or React here. */
/** Lowercase slug derived from the registration label, e.g. "codex" or "claude-2". */
export type AgentId = string;
export type AdapterMode = "mock" | "tmux";
/** Which CLI the human says runs in the pane. Suggested from the observed process name, confirmed at registration. */
export type AgentType = "codex" | "claude" | "other";
export type DeliveryStatus = "recorded" | "sending" | "delivered" | "uncertain" | "rejected";
export type HandoffOutcome = "no_incoming_handoff" | "strong_objection" | "accept_without_improvement" | "accept_and_improve";
export interface PaneIdentity {
  paneId: string;
  panePid: string;
  serverPid: string;
  serverStarted: string;
  socketPath: string;
}
export interface SessionRegistration {
  id: AgentId;
  label: string;
  agentType: AgentType;
  /** Real path of the worktree root. Sessions sharing it form one project and one reservation scope. */
  repository: string;
  /** The pane's foreground process name observed when the human registered it; never a shell or generic interpreter. */
  expectedCommand: string;
  identity: PaneIdentity;
  relayPrompt: string;
  registeredAt: string;
}
export interface PaneState {
  identity: PaneIdentity;
  command: string;
  cwd: string;
  dead: boolean;
  inMode: boolean;
  synchronized: boolean;
}
/** One live pane from the whole tmux server, so the human can pick it. Not a lifecycle or readiness signal. */
export interface AvailablePane extends PaneState {
  /** Current tmux location as session:window.pane; informational and may change. */
  location: string;
  registeredAs: AgentId | null;
}
export interface RegistrationInput {
  paneId: string;
  label: string;
  /** Defaults to the suggestion derived from the observed process name. */
  agentType?: AgentType;
  /** Absolute path; defaults to the pane's current directory. */
  repository?: string;
  /** Defaults to "relay". */
  relayPrompt?: string;
}
export interface RegistrationResult {
  session: SessionRegistration;
  /** True when an existing registration with the same id was re-pointed at this pane. */
  replaced: boolean;
}
/** A label-only edit; instance identity and historical attribution do not change. */
export interface RenameSession { label: string; expectedRegistrationId: string; expectedLabel: string }
/** Bounded read-only capture of any live pane, so the human can identify it before registering. */
export interface PanePreview {
  paneId: string;
  text: string;
  capturedAt: string;
}
/** Two registered sessions that alternate reviews on one worktree. Grouping and validation only; no automation. */
export interface RelayPair {
  id: string;
  name: string;
  repository: string;
  sessions: [AgentId, AgentId];
  createdAt: string;
}
export interface PairInput {
  name: string;
  sessions: [AgentId, AgentId];
}
/** A worktree with a command in flight or an uncertain delivery; cleared automatically on clean delivery. */
export interface Reservation {
  repository: string;
  activeCommandId: string;
}
/** What a CLI's own lifecycle hook reported: Claude Code's Stop hook or Codex's notify. Not terminal text. */
export interface EventInput {
  source: AgentType;
  /** turn_complete announces the end of a turn; outcome is the follow-up when the outcome line was not yet readable. */
  event: "turn_complete" | "outcome";
  /** $TMUX_PANE inside the pane, e.g. "%3". */
  paneId: string;
  /** First field of $TMUX, the server socket; optional but matched when present. */
  socketPath?: string;
  cwd?: string;
  /** The CLI's own session/thread id when its payload carries one. */
  sessionId?: string;
  /** The reviewer's final "RELAY-OUTCOME:" line, read by the hook from the CLI's record of its last message. */
  outcome?: HandoffOutcome;
  reason?: string;
  /** False when the CLI's record of the final message was not complete at post time; a follow-up will come. */
  settled?: boolean;
  /** The text that started the turn, from the CLI's record, so the turn is tied to the command it actually answered. */
  prompt?: string;
}
export interface TurnEvent {
  /** Registered session the event matched, or null when the pane is not registered. */
  agentId: AgentId | null;
  paneId: string;
  source: AgentType;
  sessionId: string | null;
  /** The console command this turn answered: the delivered command whose text equals the turn's prompt. Null when the
   * turn answered something else, e.g. text typed in the terminal or a command altered by text left in the input line. */
  commandId: string | null;
  /** The turn's prompt as the CLI recorded it, when the hook could read it. */
  prompt: string | null;
  /** What the reviewer said it did, or null when its final message carried no RELAY-OUTCOME line. */
  outcome: HandoffOutcome | null;
  reason: string | null;
  /** reported: the line arrived; pending: a relay ended and the line is still being read; none: no line, or none expected. */
  outcomeState: "reported" | "pending" | "none";
  receivedAt: string;
}
export interface Snapshot {
  agentId: AgentId;
  text: string;
  capturedAt: string;
  status: "available" | "unavailable";
  error?: string;
}
export interface CommandInput {
  requestId: string;
  agentId: AgentId;
  /** relay sends the registered relay prompt; with text it becomes "<prompt>: <text>", a relay with context. */
  kind: "relay" | "instruction";
  text?: string;
  /** For an instruction: hand off to the relay partner when the agent finishes (its result is the next thing to review). */
  handoff?: boolean;
  confirmReady: true;
}
export interface CommandRecord {
  id: string;
  agentId: AgentId;
  kind: "relay" | "instruction";
  text: string;
  /** Whether finishing this command should hand off to the relay partner. Always true for a relay. */
  handoff: boolean;
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  releasedAt: string | null;
}
export interface ConsoleState {
  mode: AdapterMode;
  inputEnabled: boolean;
  sessions: SessionRegistration[];
  pairs: RelayPair[];
  panes: AvailablePane[];
  /** Set when the pane listing itself failed, e.g. no tmux server; sessions may still be listed. */
  panesError: string | null;
  snapshots: Snapshot[];
  commands: CommandRecord[];
  reservations: Reservation[];
  /** Latest turn-complete event per registered session, plus the latest unmatched one for troubleshooting. */
  turns: TurnEvent[];
  serverTime: string;
}
export interface ApiError { error: { code: string; message: string } }
/** The host's effective global configuration as read at startup. Read-only; the access token is never included. */
export interface HostConfig {
  mode: AdapterMode;
  inputEnabled: boolean;
  /** Whether the deprecated staging relay may be shown as a console preference. */
  legacyEnabled: boolean;
  /** Controller data (SQLite store, journal, plans, assignments); the adapter mode is appended to the configured base. */
  dataDir: string;
  /** Where task worktrees are created by default. */
  worktreeDir: string;
  tmuxBin: string;
  /** Where PATH resolves tmuxBin, or the configured absolute path when it exists; null when no executable was found. */
  tmuxPath: string | null;
  tmuxSocket: string | null;
  /** Creation bases, never implementation branches; each project's detected default branch is always added. */
  integrationBranches: string[];
  allowedOrigins: string[];
  claudeConfigDir: string;
  codexHome: string;
  /** The environment variables that were set when the host started; a setting not listed here uses its default. */
  environment: string[];
}
