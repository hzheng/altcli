import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CommandRecord, PairInput, RegistrationInput, RegistrationResult, SessionRegistration } from '../contracts/api.ts';
import type { BackgroundEvidence, Execution, HookEvent, HookReceipt, InstanceState, ManagedSession, ProcessRecord, RunAction, StartInput, WorkflowState } from '../contracts/workflow.ts';
import { AppError } from '../core/errors.ts';
import { singleLine, slugify } from '../core/validation.ts';
import { assertAgentCommand, suggestAgentType } from '../core/policy.ts';
import { Controller } from './controller.ts';
import { WorkflowStore, wireText } from './workflow-store.ts';
import { resolveWorktree, sameWorktree, worktreeFingerprint } from './worktree.ts';
import { assertExternalDataDir } from './paths.ts';
import { isCodexHelper } from './processes.ts';

/** The only controller exposed to HTTP. The older Controller supplies transport/read-model helpers, not scheduling. */
export class ControlPlane {
  readonly workflow: WorkflowStore;
  get store() { return this.transport.store; }
  get config() { return this.transport.config; }
  get adapter() { return this.transport.adapter; }
  readonly transport: Controller;
  /** Read-only worktree digest. Mock mode has no repository, so its digest never changes unless a test supplies one. */
  private readonly readWorktree: (root: string) => Promise<string>;
  constructor(transport: Controller, readWorktree?: (root: string) => Promise<string>) {
    this.transport = transport;
    this.readWorktree = readWorktree ?? (transport.config.mode === 'mock' ? async () => 'mock-worktree' : worktreeFingerprint);
    this.workflow = new WorkflowStore(this.store);
    // Mock fixtures have no real filesystem. Real registrations must be renewed explicitly after this upgrade.
    if (this.config.mode === 'mock') for (const raw of this.store.sessions()) {
      const session = raw as ManagedSession;
      if (!session.registrationId) this.store.saveSession({ ...session, registrationId: randomUUID(),
        worktree: { root: session.repository, gitDir: `${session.repository}/.git`, indexPath: `${session.repository}/.git/index` } } as ManagedSession);
    }
    this.workflow.recover();
  }
  async state(): Promise<WorkflowState> {
    const sessions = this.store.sessions() as ManagedSession[];
    const instances = await Promise.all(sessions.map((s) => this.instance(s)));
    const base = await this.transport.state();
    const runsOf = this.workflow.runsOf(base.commands.map((c) => c.id));
    const commands = base.commands.map((c) => ({ ...c, runId: runsOf.get(c.id)?.runId ?? null, pairId: runsOf.get(c.id)?.pairId ?? null }));
    return { ...base, commands, sessions, runs: this.workflow.runs(), executions: this.workflow.activeExecutions(), instances };
  }
  /** Same CLI process as at registration? A registration made before pids were recorded stays unknown until renewed. */
  private async instance(session: ManagedSession): Promise<InstanceState> {
    if (!session.cliPid) return { agentId: session.id, status: 'unknown' };
    const live = await this.adapter.foreground(session).catch(() => null);
    return { agentId: session.id, status: live === null ? 'unknown' : live === session.cliPid ? 'current' : 'replaced' };
  }
  preview(id: string) { return this.transport.preview(id); }
  private unlocked(session: SessionRegistration): void {
    const managed = session as ManagedSession;
    if (this.workflow.owner(managed.worktree?.indexPath ?? managed.repository)) throw new AppError('RUN_ACTIVE', 'A run owns this worktree. Pause and take over before changing registrations or pairs.', 409);
  }
  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const pane = await this.adapter.inspect(input.paneId);
    assertAgentCommand(pane.command);
    const worktree = this.config.mode === 'mock'
      ? { root: pane.cwd, gitDir: `${pane.cwd}/.git`, indexPath: `${pane.cwd}/.git/index` }
      : await resolveWorktree(pane.cwd);
    if (this.config.mode === 'tmux' && input.repository) {
      const specified = await resolveWorktree(input.repository);
      if (worktree ? !sameWorktree(worktree, specified) : await realpath(input.repository) !== await realpath(pane.cwd)) {
        throw new AppError('DIFFERENT_WORKTREE', 'The selected pane and supplied path do not resolve to the same Git worktree.', 409);
      }
    }
    const session: ManagedSession = { id: slugify(input.label), label: input.label, agentType: input.agentType ?? suggestAgentType(pane.command),
      repository: worktree?.root ?? (this.config.mode === 'mock' ? pane.cwd : await realpath(pane.cwd)), expectedCommand: pane.command,
      identity: pane.identity, relayPrompt: singleLine(input.relayPrompt ?? 'relay'), registeredAt: new Date().toISOString(), registrationId: randomUUID(), worktree, cliPid: null };
    await this.adapter.preflight(session);
    session.cliPid = await this.adapter.foreground(session);
    if (this.config.mode === 'tmux' && !session.cliPid) throw new AppError('PROCESS_UNAVAILABLE', 'Could not identify the CLI process. Inspect the pane and try registration again.', 409);
    if (this.config.mode === 'tmux') assertExternalDataDir(this.config.dataDir, session.repository);
    const old = this.store.sessions().find((s) => s.id === session.id);
    if (old) this.unlocked(old);
    this.unlocked(session);
    return { session, replaced: this.store.saveSession(session) };
  }
  remove(id: string): void {
    const session = this.store.sessions().find((s) => s.id === id);
    if (session) this.unlocked(session);
    this.transport.remove(id);
  }
  createPair(input: PairInput) {
    const members = input.sessions.map((id) => this.store.sessions().find((s) => s.id === id)) as (ManagedSession | undefined)[];
    if (members.some((s) => !s?.registrationId || !s.worktree)) throw new AppError('GIT_IDENTITY_REQUIRED', 'Re-register both panes to discover their canonical worktree and index before creating a pair.', 409);
    for (const member of members) this.unlocked(member!);
    if (!sameWorktree(members[0]!.worktree, members[1]!.worktree)) throw new AppError('DIFFERENT_WORKTREE', 'A relay requires the same canonical worktree and Git index.', 409);
    return this.transport.createPair(input);
  }
  removePair(id: string): void {
    const pair = this.store.pairs().find((p) => p.id === id);
    for (const member of pair?.sessions ?? []) {
      const session = this.store.sessions().find((s) => s.id === member); if (session) this.unlocked(session);
    }
    this.transport.removePair(id);
  }
  async submit(input: StartInput): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const session = this.store.sessions().find((s) => s.id === input.agentId) as ManagedSession | undefined;
    if (!session?.registrationId) throw new AppError('REGISTRATION_REQUIRED', 'Register or re-register this worker before issuing commands.', 409);
    const pair = input.pairId ? this.store.pairs().find((p) => p.id === input.pairId) : undefined;
    if (input.pairId && (!pair || !pair.sessions.includes(input.agentId))) throw new AppError('INVALID_PAIR', 'The chosen pair does not contain this target.', 409);
    if ((input.autoContinue || input.handoff) && !pair) throw new AppError('PAIR_REQUIRED', 'Select an explicit pair to arm automatic handoffs.', 409);
    const participants = pair ? pair.sessions.map((id) => this.store.sessions().find((s) => s.id === id) as ManagedSession) : [session];
    if (participants.some((s) => !s?.registrationId)) throw new AppError('REGISTRATION_REQUIRED', 'Re-register the pair participants.', 409);
    if (this.config.mode === 'tmux' && participants.some((s) => !s.cliPid)) throw new AppError('REGISTRATION_REQUIRED', 'Re-register every participant so its current CLI process can be pinned.', 409);
    if (pair && !sameWorktree(participants[0]!.worktree, participants[1]!.worktree)) throw new AppError('DIFFERENT_WORKTREE', 'Pair participants must share a verified worktree and index.', 409);
    if (this.store.get(input.requestId) && !this.workflow.execution(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older transport command.', 409);
    if (input.autoContinue || input.handoff) for (const participant of participants) wireText({ ...input, kind: 'relay', text: undefined }, participant);
    const turn = this.workflow.start(input, participants, pair?.id ?? null);
    await this.pump(turn.runId);
    const record = this.store.get(turn.commandId);
    if (!record) throw new AppError('RUN_PAUSED', 'The run is paused before delivery. Nothing was replayed.', 409);
    return record;
  }
  /** Exactly one caller can claim a planned turn; browsers never create continuation commands. */
  private async pump(runId: string): Promise<void> {
    const run = this.workflow.run(runId); if (!run) return;
    const turn = this.workflow.claim(run.currentCommandId); if (!turn) return;
    await this.deliver(turn);
    for (const pending of this.workflow.pendingEvents(turn.commandId)) {
      const delivered = this.workflow.execution(turn.commandId)!;
      const evidence = pending.event === 'turn_complete' && pending.backgroundState === 'unknown' ? await this.evidence(delivered, pending.reporterPid) : null;
      this.workflow.receive(pending, evidence, pending.event === 'turn_complete' ? await this.worktreeDigest(delivered) : null);
    }
    const next = this.workflow.run(runId);
    if (next?.status === 'running' && next.currentCommandId !== turn.commandId) await this.pump(runId);
  }
  private async deliver(turn: Execution): Promise<void> {
    const run = this.workflow.run(turn.runId)!;
    const participant = run.participants.find((s) => s.id === turn.agentId)!;
    let baseline: ProcessRecord[] | null = null; let worktree: string | null = null;
    try {
      const record = await this.transport.submit(turn.input, { wireText: turn.wireText, beforeSend: async () => {
        const current = this.store.sessions().find((s) => s.id === participant.id) as ManagedSession | undefined;
        if (current?.registrationId !== participant.registrationId) throw new AppError('TARGET_CHANGED', 'Worker registration changed.', 409);
        if (participant.cliPid && await this.adapter.foreground(participant) !== participant.cliPid) throw new AppError('TARGET_CHANGED', 'The CLI in this pane exited or restarted since registration. Re-register the worker.', 409);
        if (this.config.mode === 'tmux') {
          const live = await this.adapter.inspect(participant.identity.paneId);
          if (participant.worktree && !sameWorktree(await resolveWorktree(live.cwd), participant.worktree)) {
            throw new AppError('TARGET_CHANGED', 'Git worktree or index identity changed.', 409);
          }
        }
        // Codex notify carries no background-work fields, so the server keeps its own evidence: what ran under the pane before this turn.
        if (participant.agentType === 'codex') baseline = await this.adapter.processes(participant).catch(() => null);
        // A handoff instruction is judged against the worktree as it was just before delivery.
        if (this.handsOff(turn)) worktree = await this.readWorktree(participant.worktree!.root).catch(() => null);
      } });
      this.workflow.delivered(record.id, record, baseline, worktree);
    } catch { this.workflow.dispatchFailed(turn.commandId); }
  }
  /** Differential process evidence for a Codex completion: anything started under the pane during the turn that is still alive is background work.
   * Claude reports its own in-process background tasks; a process tree cannot see those, so this never substitutes for a Claude payload. */
  private async evidence(turn: Execution, reporterPid?: string): Promise<BackgroundEvidence | null> {
    const participant = this.workflow.run(turn.runId)?.participants.find((s) => s.id === turn.agentId);
    if (!participant || participant.agentType !== 'codex' || !turn.baselineProcesses) return null;
    try {
      const live = await this.adapter.processes(participant);
      const started = live.filter((p) => p.pid !== reporterPid && !isCodexHelper(p.command) && !turn.baselineProcesses!.some((b) => b.pid === p.pid));
      return started.length ? { state: 'active', detail: started.map((p) => `${basename(p.command)} pid ${p.pid}`).join(', ') }
        : { state: 'clear', detail: 'no process started during the turn survives' };
    } catch { return null; }
  }

  private handsOff(turn: Execution): boolean {
    return turn.input.kind === 'instruction' && turn.input.handoff === true && !!this.workflow.run(turn.runId)?.participants.find((s) => s.id === turn.agentId)?.worktree;
  }
  /** The worktree digest at completion of a handoff instruction, so the store can tell a result from a question or a no-op. Null when unreadable. */
  private async worktreeDigest(turn: Execution): Promise<string | null> {
    if (!this.handsOff(turn)) return null;
    const participant = this.workflow.run(turn.runId)!.participants.find((s) => s.id === turn.agentId)!;
    return this.readWorktree(participant.worktree!.root).catch(() => null);
  }

  async recordEvent(input: HookEvent): Promise<HookReceipt> {
    // Uncorrelated start events mean someone used a desktop terminal. Pause affected runs, never infer completion.
    if (input.event === 'turn_started' && !input.commandId && input.identity) {
      for (const run of this.workflow.runs().filter((r) => r.status === 'running')) {
        if (run.participants.some((p) => p.identity.paneId === input.identity!.paneId && p.identity.socketPath === input.identity!.socketPath)) {
          this.workflow.pause(run.id, 'A prompt started in a participant pane without controller correlation (desktop terminal or an older hook). Inspect it; nothing was interrupted or released.');
        }
      }
    }
    const turn = input.commandId ? this.workflow.execution(input.commandId) : undefined;
    const evidence = turn && input.event === 'turn_complete' && input.backgroundState === 'unknown' ? await this.evidence(turn, input.reporterPid) : null;
    const worktree = turn && input.event === 'turn_complete' ? await this.worktreeDigest(turn) : null;
    const receipt = this.workflow.receive(input, evidence, worktree);
    if (turn) await this.pump(turn.runId);
    return receipt;
  }
  action(input: RunAction): void {
    if (input.action === 'pause') this.workflow.pause(input.runId);
    else { if (input.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Confirm every writer has stopped.'); this.workflow.takeover(input.runId); }
  }
}
