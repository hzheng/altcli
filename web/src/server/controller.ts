import { realpath } from "node:fs/promises";
import type { AvailablePane, CommandInput, CommandRecord, ConsoleState, PairInput, PanePreview, RegistrationInput, RegistrationResult, RelayPair, SessionRegistration, Snapshot } from "../contracts/api.ts";
import { AppError, messageOf } from "../core/errors.ts";
import { assertAgentCommand, suggestAgentType } from "../core/policy.ts";
import { paneId as validPaneId, promptText, singleLine, slugify } from "../core/validation.ts";
import type { TerminalAdapter } from "./adapters/terminal.ts";
import type { Config } from "./config.ts";
import { assertExternalDataDir } from "./paths.ts";
import { Store } from "./store.ts";
/** Internal transport/read helpers. HTTP uses ControlPlane to enforce execution ownership. */
export class Controller {
  readonly config: Config;
  readonly store: Store;
  readonly adapter: TerminalAdapter;
  constructor(config: Config, store: Store, adapter: TerminalAdapter) {
    this.config = config; this.store = store; this.adapter = adapter;
    this.store.recoverInterrupted();
  }
  async snapshot(session: SessionRegistration): Promise<Snapshot> {
    try {
      const text = await this.adapter.capture(session);
      return { agentId: session.id, text, capturedAt: new Date().toISOString(), status: "available" };
    } catch (error) {
      return { agentId: session.id, text: "", capturedAt: new Date().toISOString(), status: "unavailable", error: messageOf(error) };
    }
  }
  async panes(sessions: SessionRegistration[]): Promise<Pick<ConsoleState, "panes" | "panesError">> {
    try {
      const panes: AvailablePane[] = (await this.adapter.listPanes()).map((pane) => ({ ...pane,
        registeredAs: sessions.find((s) => s.identity.socketPath === pane.identity.socketPath && s.identity.paneId === pane.identity.paneId)?.id ?? null }));
      return { panes, panesError: null };
    } catch (error) {
      return { panes: [], panesError: messageOf(error) };
    }
  }
  async state(sessions = this.store.sessions()): Promise<ConsoleState> {
    const [snapshots, panes] = await Promise.all([Promise.all(sessions.map((s) => this.snapshot(s))), this.panes(this.store.sessions())]);
    const registered = new Set(sessions.map((s) => s.id));
    return { mode: this.config.mode, inputEnabled: this.config.inputEnabled, sessions, pairs: this.store.pairs(), ...panes, snapshots,
      commands: this.store.recent(), reservations: this.store.reservations(),
      turns: this.store.latestTurns().filter((t) => t.agentId === null || registered.has(t.agentId)), serverTime: new Date().toISOString() };
  }
  /** Read-only tail of any live pane for the registration picker. Exposes that pane's screen to the token holder. */
  async preview(paneId: string): Promise<PanePreview> {
    return { paneId: validPaneId(paneId), text: await this.adapter.peek(paneId), capturedAt: new Date().toISOString() };
  }
  /** Records a human-chosen pane. Sends no input. The observed foreground process becomes the identity to re-check before every capture and send. */
  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const pane = await this.adapter.inspect(input.paneId);
    assertAgentCommand(pane.command);
    const repository = this.config.mode === "tmux" ? await realpath(input.repository ?? pane.cwd).catch(() => {
      throw new AppError("INVALID_REPOSITORY", "Repository path does not exist on the host.");
    }) : input.repository ?? pane.cwd;
    const session: SessionRegistration = { id: slugify(input.label), label: input.label, agentType: input.agentType ?? suggestAgentType(pane.command), repository,
      expectedCommand: pane.command, identity: pane.identity, relayPrompt: singleLine(input.relayPrompt ?? "relay"), registeredAt: new Date().toISOString() };
    await this.adapter.preflight(session);
    if (this.config.mode === "tmux") assertExternalDataDir(this.config.dataDir, session.repository);
    return { session, replaced: this.store.saveSession(session) };
  }
  remove(id: string): void { this.store.removeSession(id); }
  /** Internal pair persistence. ControlPlane separately verifies canonical Git identity. */
  createPair(input: PairInput): RelayPair {
    const sessions = this.store.sessions();
    const members = input.sessions.map((id) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) throw new AppError("NOT_REGISTERED", `"${id}" is not a registered session.`, 404);
      return session;
    }) as [SessionRegistration, SessionRegistration];
    if (members[0].repository !== members[1].repository) {
      throw new AppError("DIFFERENT_WORKTREE", `"${members[0].label}" (${members[0].repository}) and "${members[1].label}" (${members[1].repository}) do not share a worktree, so they cannot alternate on one index.`, 409);
    }
    const pair: RelayPair = { id: slugify(input.name), name: input.name, repository: members[0].repository, sessions: input.sessions, createdAt: new Date().toISOString() };
    this.store.savePair(pair);
    return pair;
  }
  removePair(id: string): void { this.store.removePair(id); }
  async submit(input: CommandInput, options: { wireText?: string; beforeSend?: () => Promise<void> } = {}): Promise<CommandRecord> {
    const session = this.store.sessions().find((s) => s.id === input.agentId);
    if (!session) throw new AppError("NOT_REGISTERED", "Register this session first.", 404);
    if (!this.config.inputEnabled) throw new AppError("READ_ONLY", "Real input is disabled. Enable it on the host only after completing the local checks.", 403);
    // A relay with context becomes one line, "<prompt>: <context>", so the reviewer sees both and the size limit still applies.
    const text = promptText(input.kind === "relay" ? (input.text ? `${session.relayPrompt}: ${input.text}` : session.relayPrompt) : input.text);
    if (this.config.mode === "tmux") assertExternalDataDir(this.config.dataDir, session.repository);
    if (options.wireText !== undefined) promptText(options.wireText);
    const now = new Date().toISOString();
    let record: CommandRecord = { id: input.requestId, agentId: input.agentId, kind: input.kind, text, handoff: input.kind === "relay" || input.handoff === true,
      status: "recorded", createdAt: now, updatedAt: now, error: null, releasedAt: null };
    const reservation = this.store.reserve(record, session.repository);
    if (!reservation.created) return reservation.record; // Never redeliver a duplicate ID.
    try {
      await this.adapter.preflight(session);
      await options.beforeSend?.();
    } catch (error) {
      record = { ...record, status: "rejected", error: messageOf(error), updatedAt: new Date().toISOString() };
      this.store.update(record);
      this.store.release(record.id); // No delivery attempt occurred.
      return this.store.get(record.id)!;
    }
    record = { ...record, status: "sending", updatedAt: new Date().toISOString() };
    this.store.update(record); // Durable boundary BEFORE terminal input.
    try {
      await this.adapter.send(session, options.wireText ?? text);
      record = { ...record, status: "delivered", updatedAt: new Date().toISOString() };
    } catch (error) {
      record = { ...record, status: "uncertain", error: messageOf(error), updatedAt: new Date().toISOString() };
    }
    this.store.update(record);
    // Release only the transport reservation. ControlPlane retains execution ownership across clean deliveries.
    if (record.status === "delivered") { this.store.release(record.id); return this.store.get(record.id)!; }
    return record;
  }
}
