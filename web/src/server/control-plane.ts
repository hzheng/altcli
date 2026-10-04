import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ClearContextInput, CommandRecord, HostConfig, PairInput, RegistrationInput, RegistrationResult, RenameSession, SessionRegistration } from '../contracts/api.ts';
import { clearContextCommand } from '../core/clear-context.ts';
import { describeConfig } from './config.ts';
import type { ActivityReset, BackgroundEvidence, Execution, HookEvent, HookReceipt, InstanceState, ManagedSession, ProcessRecord, RunAction, StartInput, WorkflowState, WorkspaceDiscovery, WorkspaceReset, WorkspaceResetResult } from '../contracts/workflow.ts';
import { backgroundAuthorization, decisionActor } from './background/action-context.ts';
import { AppError } from '../core/errors.ts';
import { singleLine, slugify } from '../core/validation.ts';
import { assertAgentCommand, assertIdentity, suggestAgentType } from '../core/policy.ts';
import { Controller } from './controller.ts';
import { WorkflowStore, wireText } from './workflow-store.ts';
import { currentBranch, resolveWorktree, sameWorktree, worktreeFingerprint } from './worktree.ts';
import { assertExternalDataDir, isWithin } from './paths.ts';
import { isCodexHelper } from './processes.ts';
import { discoverWorkspaces, mockCheckout } from './workspaces.ts';
import type { BranchState, CommitAssignment, Group, GroupInput, GroupSelection, ImplementationRun, ImplementationStart, PolicyChange, PublicationResult, ReviewPreviewInput, StandaloneStart } from '../contracts/implementation.ts';
import { archiveCommit, assertClean, assertLogPath, assertWorktreeInput, branchState, checkoutHead, gitRead, createConsentedBranch, integrationNames, isAncestor, previewCommittedRange, readPublication, taskBaseline, stageRelayEligibility, validateExistingLog, validateNewBranch, validateReviewRange } from './commit-handoff.ts';
import { classifyAgent, groupName } from '../core/workspaces.ts';
import { sessionNamesOf } from '../core/session-names.ts';
import { listDirectory } from './directories.ts';
import { FinishCoordinator, tmuxFinishHost } from './finish.ts';
import { messageOf } from '../core/errors.ts';
import type { PlanCapture, PlanDecision, PlanningAssignment, PlanStart } from '../contracts/planning.ts';
import { newPlanning, planAgreed } from './planning-state.ts';
import { assertPlanArtifacts, assertPlanBaseline, capturePlanResult, planRoot } from './planning-documents.ts';
import { ProjectCatalog, type SessionRenames } from './projects.ts';
import { installedInside } from './cli-install.ts';
import { AgentActivityTracker } from './agent-activity.ts';
import type { WorktreeCreateInput, WorktreeDiscardConfirm, WorktreeDiscardFinish, WorktreeDiscardInput, WorktreeIntegrateRequest, WorktreeIntegrationInput, WorktreeIntegrationRelease, WorktreePreviewInput, WorktreeRemovalInput, WorktreeRemoveInput, WorktreeRenameConfirm, WorktreeRenameInput, WorktreeUpdateInput, WorktreeUpdateRequest } from '../contracts/projects.ts';
import type { Checkpoint, CheckpointInput, InteractionInput, InteractionRecord } from '../contracts/interactions.ts';
import type { RelayRun } from '../contracts/workflow.ts';
import { InteractionStore } from './interaction-store.ts';
import { parseCheckpoint, parseInteraction } from '../core/interaction-validation.ts';
import { InputAuthority } from './input-authority.ts';
import { scopesFor, type InputScopes } from '../core/input-scope.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';
import { LaunchService } from './launches.ts';
import { MockAdapter } from './adapters/mock.ts';
import { TerminalBroker } from './terminal-broker.ts';
import { inspectAttach, type AttachTarget } from './tmux-attach.ts';
import { paneProcesses } from './processes.ts';
import type { ManualPane, ManualReconcile, ManualSession, TerminalOpen, TerminalTarget } from '../contracts/terminals.ts';
import { parseManualReconcile } from '../core/terminal-validation.ts';
import { AttachmentService, imageAgent } from './attachments.ts';
import type { AttachmentDescriptor, InstructionManifest } from '../contracts/attachments.ts';
import { ObservedRead } from './observation.ts';

/** The writer-guard wording for each way of aligning a task branch with main. */
const ALIGN_ACTION = { update: 'Update', rebase: 'Rebase', reset: 'Reset' } as const;
/** The only controller exposed to HTTP. The older Controller supplies transport/read-model helpers, not scheduling. */
export class ControlPlane {
  readonly workflow: WorkflowStore;
  readonly authority: InputAuthority;
  readonly terminals: TerminalBroker;
  readonly launches: LaunchService;
  readonly finish: FinishCoordinator;
  readonly interactions: InteractionStore;
  readonly attachments: AttachmentService;
  get store() { return this.transport.store; }
  get config() { return this.transport.config; }
  get adapter() { return this.transport.adapter; }
  readonly transport: Controller;
  readonly projects: ProjectCatalog;
  private readonly activity: AgentActivityTracker;
  private readonly scopedNative = new Map<string | null, { revision: number; active: number }>();
  private lifecycleRevision = 0;
  private lifecycleObservations = 0;
  /** Claude's Stop blocks its CLI until our HTTP response returns and the reporting hook exits. */
  private readonly completingHooks = new Map<string, { commandId: string; reporters: Set<string> }>();
  /** Ephemeral identity proposals. Discovery never writes registrations or starts work. */
  private readonly discovered = new Map<string, ManagedSession>();
  private readonly stateObservation = new ObservedRead<WorkflowState>(2000);
  private readonly workspaceObservation = new ObservedRead<WorkspaceDiscovery>(5000);
  /** Stored generation replaced by an idle discovery candidate; checked again before an explicit action binds it. */
  private readonly renewalBases = new Map<string, string>();
  /** Read-only worktree digest. Mock mode has no repository, so its digest never changes unless a test supplies one. */
  private readonly readWorktree: (root: string) => Promise<string>;
  constructor(transport: Controller, readWorktree?: (root: string) => Promise<string>) {
    this.transport = transport;
    this.activity = new AgentActivityTracker(this.adapter);
    this.readWorktree = readWorktree ?? (transport.config.mode === 'mock' ? async () => 'mock-worktree' : worktreeFingerprint);
    this.workflow = new WorkflowStore(this.store, join(this.config.dataDir, 'assignments'));
    this.interactions = new InteractionStore(this.store);
    this.interactions.recover();
    this.projects = new ProjectCatalog(this.store, this.config);
    this.attachments = new AttachmentService(this.config, this.store, async () => (await this.workspaces()).workspaces.map((workspace) => workspace.worktree.root));
    // No upload survives a restart; reclaim interrupted ones without touching any image that may have been used.
    void this.attachments.recover().catch(() => {});
    // Mock fixtures have no real filesystem. Real registrations must be renewed explicitly after this upgrade.
    if (this.config.mode === 'mock') for (const raw of this.store.sessions()) {
      const session = raw as ManagedSession;
      if (!session.registrationId) this.store.saveSession({ ...session, registrationId: randomUUID(),
        worktree: { root: session.repository, gitDir: `${session.repository}/.git`, indexPath: `${session.repository}/.git/index` } } as ManagedSession);
    }
    this.workflow.recover();
    this.authority = new InputAuthority(this.store);
    this.launches = new LaunchService(this.config, this.store, this.projects, this.authority, tree => {
      if(this.workflow.owner(tree.indexPath) || this.store.activeFor(tree.root)) throw new AppError('WORKTREE_BUSY', 'A run or delivery owns this checkout.', 409);
    }, async () => { this.syncMockLaunches(); return sessionNamesOf(await this.adapter.listPanes()); });
    this.transport.inputGuard = agentId => this.authority.assertAutomated(this.agentScopes(agentId));
    this.terminals = new TerminalBroker({ config: this.config, authority: this.authority,
      resolve: target => this.terminalTarget(target), begin: (input, id, generation, prior, scope) => this.beginKeyboard(input, id, generation, prior, scope),
      scope: target => this.keyboardScope(target),
      exempt: target => this.inputExempt(target),
      reconcile: (input, handoffRequestId) => this.reconcileManual(input, handoffRequestId),
      image: (target, attach, attachmentId) => this.nativeImage(target, attach, attachmentId),
      pinImage: (descriptor, refId) => this.attachments.pin([descriptor], 'native', refId) });
    this.finish = new FinishCoordinator({ config: this.config, store: this.store, projects: this.projects, launches: this.launches, authority: this.authority,
      host: tmuxFinishHost(this.config, () => this.adapter.listPanes()),
      owner: (indexPath) => { const id = this.workflow.owner(indexPath); const run = id ? this.workflow.run(id) : undefined;
        return run ? { id: run.id, status: run.status, execution: this.workflow.execution(run.currentCommandId)?.status ?? null } : null; },
      delivery: (root) => !!this.store.activeFor(root),
      agents: async () => Promise.all((await this.checkoutSessions()).map(async (s) => ({ paneId: s.identity.paneId, socketPath: s.identity.socketPath, label: s.label,
        state: (await this.instance(s)).status === 'current' ? this.activity.read(s).state : 'unknown' as const }))),
      closeTerminals: (paneIds, reason) => this.terminals.closePanes(paneIds, reason),
      remove: async (input, parent) => { await this.workspaces(); return this.projects.remove(input, (worktree) => this.removalGuard(worktree), (worktree) => this.archiveJournal(worktree.root), parent); },
      discard: async (input, parent) => { await this.workspaces(); return this.projects.discard(input, (worktree) => this.removalGuard(worktree), (worktree) => this.archiveJournal(worktree.root), parent); },
      reconcileChild: (kind, requestId) => kind === 'removal' ? this.projects.reconcileRemoval(requestId) : this.projects.reconcileDiscard(requestId) });
  }
  /** Finish branch (ADR-0013): preview and confirm closing the app-launched sessions of a task worktree, then its removal or discard. */
  async previewFinish(value: unknown) { await this.workspaces(); return this.finish.preview(value); }
  async confirmFinish(value: unknown) { await this.workspaces(); return this.finish.confirm(value); }
  async continueFinish(value: unknown) { await this.workspaces(); return this.finish.continue(value); }
  async reconcileFinish(value: unknown) { await this.workspaces(); return this.finish.reconcile(value); }
  previewLaunchCleanup(id: string) { return this.launches.previewCleanup(id); }
  confirmLaunchCleanup(id: string, value: unknown) { return this.launches.confirmCleanup(id, value); }
  /** The effective host configuration for the Settings tab; read-only and without the token. */
  hostConfig(): HostConfig { return describeConfig(this.config); }
  /** Read-only host directory browsing for choosing a project's starting checkout. */
  directories(value: unknown) { return listDirectory(value, this.config.mode); }
  private ownedRuns(): RelayRun[] {
    return (this.store.db.prepare('SELECT run_id FROM workflow_owners').all() as { run_id: string }[]).map(row => this.workflow.run(row.run_id)!);
  }
  private agentScopes(agentId: string): InputScopes {
    const session = this.discovered.get(agentId) ?? this.store.sessions().find(s => s.id === agentId) as ManagedSession | undefined;
    return scopesFor(session?.worktree);
  }
  private runScopes(runId: string): InputScopes { const run = this.workflow.run(runId); return run ? [run.lockKey] : null; }
  private async groupScopes(groupId: string): Promise<InputScopes> {
    const discovery = await this.workspaces();
    const group = this.workspaceGroups(discovery).find(g => g.id === groupId);
    const scopes = group?.members.map(id => this.agentScopes(id));
    return scopes?.length && scopes.every(s => s !== null) ? scopes.flatMap(s => s!) : null;
  }
  private nativeIn(scopes: InputScopes, states = this.scopedNative): { revision: number; active: number } {
    let revision = 0, active = 0;
    for (const [key, state] of states) if (key === null || scopes === null || scopes.includes(key)) {
      revision += state.revision; active += state.active;
    }
    return { revision, active };
  }
  private assertNativeBoundary(scope: WorktreeIdentity | null = null): void {
    const covers = (tree: WorktreeIdentity) => !scope || tree.indexPath === scope.indexPath;
    const setup = [...this.store.worktreeCreations().filter(op => covers(op.input.source) || op.input.path === scope?.root),
      ...[...this.store.worktreeRemovals(), ...this.store.worktreeDiscards(), ...this.store.worktreeUpdates(), ...this.store.worktreeRenames()].filter(op => covers(op.input.worktree)),
      ...this.store.worktreeIntegrations().filter(op => covers(op.input.worktree) || covers(op.input.target))];
    const launches = this.store.db.prepare('SELECT index_path FROM launch_reservations').all() as { index_path: string }[];
    if (this.store.reservations().some(r => !scope || r.repository === scope.root) || setup.some(op => ['applying', 'uncertain'].includes(op.status)) ||
      this.store.taskFinishes().some(op => covers(op.preview.worktree) && ['applying', 'uncertain', 'git_applying', 'git_uncertain'].includes(op.status)) ||
      launches.some(r => !scope || r.index_path === scope.indexPath) ||
      this.ownedRuns().some(run => (!scope || run.lockKey === scope.indexPath) && ((run.implementation && run.implementation.setup !== 'ready') || this.interactions.pending(run.id)))) {
      throw new AppError('INPUT_BUSY', 'A delivery, setup or launch in this scope is unresolved. Inspect its owner before native input or reconciliation.', 409);
    }
  }
  /** Resolve the original target afresh; an unverifiable worktree keeps the global barrier. */
  private async keyboardScope(target: TerminalTarget): Promise<WorktreeIdentity | null> {
    const attached = await this.terminalTarget(target);
    const recorded = 'launchId' in target ? this.launches.batches().flatMap(b => b.items).find(i => i.id === target.launchId)?.worktree
      : this.workspaceSessions(await this.workspaces()).find(s => s.id === target.agentId && s.registrationId === target.registrationId)?.worktree;
    if (!recorded) return null;
    const pane = await this.adapter.inspect(attached.identity.paneId);
    if (!isDeepStrictEqual(pane.identity, attached.identity)) throw new AppError('TARGET_CHANGED', 'The keyboard target changed during inspection.', 409);
    const actual = this.config.mode === 'mock' ? { root: pane.cwd, gitDir: `${pane.cwd}/.git`, indexPath: `${pane.cwd}/.git/index` } : await resolveWorktree(pane.cwd).catch(() => null);
    return actual && sameWorktree(actual, recorded) ? recorded : null;
  }
  /** Every workspace terminal joins the manual-input barrier; app-role subclasses may exempt their own. */
  inputExempt(_target: TerminalTarget): boolean { return false; }
  async terminalTarget(target: TerminalTarget): Promise<AttachTarget> {
    if ('launchId' in target) return this.launches.target(target.launchId);
    const discovery = await this.workspaces();
    const session = this.workspaceSessions(discovery).find(s => s.id === target.agentId && s.registrationId === target.registrationId);
    if (!session || (this.config.mode !== 'mock' && await this.adapter.foreground(session) !== session.cliPid)) throw new AppError('TARGET_CHANGED', 'The terminal registration or CLI process changed. Recheck.', 409);
    if (this.config.mode === 'mock') return { identity: session.identity, sessionId: `mock-${session.identity.paneId}`, label: session.label };
    return inspectAttach(this.config, session.identity);
  }
  /** Native image insertion: only a registered Claude Code or Codex instance whose CLI and directory are unchanged, and only an image
   * uploaded for that workspace. Nothing here writes to the pane. */
  private async nativeImage(target: TerminalTarget, attach: AttachTarget, attachmentId: string) {
    if ('launchId' in target) throw new AppError('IMAGE_TARGET', 'Image insertion needs a registered agent terminal. Nothing was inserted.', 409);
    const session = this.workspaceSessions(await this.workspaces()).find((s) => s.id === target.agentId && s.registrationId === target.registrationId);
    if (!session || !isDeepStrictEqual(session.identity, attach.identity)) throw new AppError('TARGET_CHANGED', 'The terminal registration changed. Recheck; nothing was inserted.', 409);
    if (!imageAgent(session.agentType)) throw new AppError('IMAGE_UNSUPPORTED', 'Image insertion is verified only for Claude Code and Codex. Nothing was inserted.', 409);
    if (this.config.mode !== 'mock') {
      if (await this.adapter.foreground(session) !== session.cliPid) throw new AppError('TARGET_CHANGED', 'The CLI in this pane exited or restarted. Nothing was inserted.', 409);
      const live = await this.adapter.inspect(session.identity.paneId);
      if (!isDeepStrictEqual(live.identity, session.identity) || !session.worktree || !sameWorktree(await resolveWorktree(live.cwd), session.worktree)) throw new AppError('TARGET_CHANGED', 'The pane changed directory or instance. Nothing was inserted.', 409);
    }
    return this.attachments.reference(attachmentId, session.worktree?.root ?? session.repository);
  }
  private async manualSnapshot(scope: WorktreeIdentity | null = null, original: ManualPane[] = []): Promise<ManualPane[]> {
    let panes = await this.adapter.listPanes();
    if (scope) {
      const selected = await Promise.all(panes.map(async pane => {
        if (original.some(p => p.identity.socketPath === pane.identity.socketPath && p.identity.paneId === pane.identity.paneId)) return true;
        if ([...this.store.sessions() as ManagedSession[], ...this.discovered.values()].some(s => s.worktree?.indexPath === scope.indexPath && isDeepStrictEqual(s.identity, pane.identity))) return true;
        const tree = this.config.mode === 'mock' ? { root: pane.cwd, gitDir: `${pane.cwd}/.git`, indexPath: `${pane.cwd}/.git/index` } : await resolveWorktree(pane.cwd).catch(() => null);
        return tree?.indexPath === scope.indexPath;
      }));
      panes = panes.filter((_, i) => selected[i]);
    }
    if (panes.length > 64) throw new AppError('INPUT_INVENTORY', 'Manual reconciliation supports at most 64 panes on this server.', 409);
    // An exited (remain-on-exit) pane has no process tree to read; its pane_pid is gone or could be reused.
    const snapshots = await Promise.all(panes.map(async pane => ({ identity: pane.identity, cwd: pane.cwd, command: pane.command, dead: pane.dead,
      agent: ['codex','claude'].includes(suggestAgentType(pane.command)) || this.store.sessions().some(s => isDeepStrictEqual(s.identity, pane.identity)),
      processes: this.config.mode === 'mock' || pane.dead ? [] : await paneProcesses(pane.identity.panePid) })));
    return snapshots.sort((a, b) => a.identity.paneId.localeCompare(b.identity.paneId));
  }
  private async beginKeyboard(input: TerminalOpen, connectionId: string, generation: string, prior?: ManualSession, scope?: WorktreeIdentity | null): Promise<ManualSession> {
    if (scope === undefined) scope = await this.keyboardScope(input.target);
    this.assertNativeBoundary(scope);
    const scopes = scopesFor(scope);
    const revision = this.nativeIn(scopes).revision;
    if (scope && !isDeepStrictEqual(await this.keyboardScope(input.target), scope)) throw new AppError('TARGET_CHANGED', 'The keyboard worktree changed. Reconnect before typing.', 409);
    const resolved = await this.terminalTarget(input.target);
    const inventory = prior?.panes.some(p => isDeepStrictEqual(p.identity, resolved.identity)) ? prior.panes : await this.manualSnapshot(scope, prior?.panes);
    const panes = prior ? [...prior.panes, ...inventory.filter(p => isDeepStrictEqual(p.identity, resolved.identity) && !prior!.panes.some(old => isDeepStrictEqual(old.identity, p.identity)))] : inventory;
    const affectedRuns = () => this.ownedRuns().filter(run => !scope || run.lockKey === scope.indexPath || run.participants.some(p => 'agentId' in input.target && p.id === input.target.agentId));
    const runs = affectedRuns();
    const expected = JSON.stringify(runs);
    return this.store.db.transaction(() => {
      this.assertNativeBoundary(scope);
      if (this.nativeIn(scopes).active || revision !== this.nativeIn(scopes).revision || JSON.stringify(affectedRuns()) !== expected) throw new AppError('INPUT_CHANGED', 'Activity changed during keyboard inspection. Recheck.', 409);
      // Existing writers can type during target inspection. Join the latest aggregate,
      // never overwrite their byte evidence, revisions or a disconnect with the old copy.
      if (prior) {
        prior = this.authority.get(prior.id);
        if (!prior.reconciliationRequired) throw new AppError('MANUAL_CHANGED', 'Manual input changed during admission. Inspect the current period.', 409);
      }
      const known = new Set(prior?.runs.map(r => r.id) ?? []);
      for (const run of runs) if (!known.has(run.id)) {
        const cp = this.interactions.checkpoint(run.id);
        this.workflow.beginKeyboard(run.id);
        // Preserve the original checkpoint bytes/evidence; never recapture away intervening work.
        if (run.status === 'waiting' && cp?.kind === 'waiting' && cp.commandId === run.currentCommandId) this.interactions.saveCheckpoint({ ...cp, kind: 'interaction', revision: cp.revision + 1 });
        else if (run.status === 'paused') this.interactions.invalidate(run.id, 'Keyboard acquisition cannot restore an already paused run.');
      }
      const now = new Date().toISOString();
      return this.authority.save({ scope, id: prior?.id ?? randomUUID(), revision: prior?.revision ?? 0, bootId: this.authority.bootId,
        clientInstanceId: prior?.clientInstanceId ?? input.clientInstanceId, connectionId: prior?.connectionId ?? connectionId,
        generation: prior?.generation ?? generation, target: prior?.target ?? input.target, live: true, reconciliationRequired: true,
        targets: [...(prior?.targets ?? []), ...(prior?.targets.some(t => isDeepStrictEqual(t, input.target)) ? [] : [input.target])],
        recoveryRequired: prior?.recoveryRequired ?? false, writers: [...(prior?.writers ?? []).filter(w => w.live && w.connectionId !== connectionId),
          { connectionId, clientInstanceId: input.clientInstanceId, generation, target: input.target, identity: resolved.identity, sessionId: resolved.sessionId,
            revision: 1, live: true, bytes: 0, inputMayHaveOccurred: false }],
        inputMayHaveOccurred: prior?.inputMayHaveOccurred ?? false, bytes: prior?.bytes ?? 0, createdAt: prior?.createdAt ?? now, updatedAt: now,
        reason: scope ? `Keyboard input holds ${scope.root}.` : 'Keyboard input holds every worktree on this server.', panes,
        runs: [...(prior?.runs ?? []), ...runs.filter(r => !known.has(r.id)).map(r => ({ id: r.id, commandId: r.currentCommandId, priorStatus: r.status }))] });
    }).immediate();
  }
  async reconcileManual(value: ManualReconcile, handoffRequestId?: string): Promise<ManualSession> {
    const input = parseManualReconcile(value);
    const duplicate = this.authority.duplicate<ManualSession>(input.requestId, input); if (duplicate) return duplicate;
    const manual = this.authority.get(input.manualSessionId);
    const scope = manual.scope ?? null, scopes = scopesFor(scope);
    if (this.authority.pending(scopes).some(s => s.live) || manual.revision !== input.expectedRevision || !manual.reconciliationRequired || this.authority.busyFor(scopes)) throw new AppError('MANUAL_CHANGED', 'Release the keyboard and inspect the current manual input record.', 409);
    this.assertNativeBoundary(scope); const nativeRevision = this.nativeIn(scopes).revision;
    if ('confirmReady' in input) {
      const panes = await this.manualSnapshot(scope, manual.panes);
      if (!isDeepStrictEqual(panes.map(p => p.identity), manual.panes.map(p => p.identity))) throw new AppError('INPUT_INVENTORY', 'Pane identities changed during manual input. Inspect the host and record a human decision if settled checks cannot establish safety.', 409);
      const sessions = await this.checkoutSessions();
      for (const pane of panes) {
        const session = sessions.find(s => isDeepStrictEqual(s.identity, pane.identity));
        const before = manual.panes.find(p => isDeepStrictEqual(p.identity, pane.identity))!;
        const agent = pane.agent || before.agent || !!session;
        if (!!pane.dead !== !!before.dead) throw new AppError('INPUT_INVENTORY', 'A pane exited during manual input. Inspect and record a human decision.', 409);
        if (!agent && (!before.command || pane.command !== before.command)) throw new AppError('INPUT_INVENTORY', 'A non-agent command changed or lacks its original evidence. Inspect and record a human decision.', 409);
        if (agent && pane.cwd !== before.cwd) throw new AppError('INPUT_INVENTORY', 'An agent directory changed during manual input. Inspect and record a human decision.', 409);
        if (this.config.mode !== 'mock' && agent && (!session || !['idle','ready'].includes(this.activity.read(session).state))) throw new AppError('UNKNOWN_ACTIVITY', 'Agent panes need known settled activity. Inspect unowned CLIs and use Reset status where eligible, or record a human decision.', 409);
        if (pane.processes.some(p => p.pid !== session?.cliPid && !(session?.agentType === 'codex' && isCodexHelper(p.command)) && !before.processes.some(b => b.pid === p.pid && b.command === p.command))) throw new AppError('BACKGROUND_ACTIVE', 'New background processes remain after manual input.', 409);
      }
      for (const affected of manual.runs) {
        const run = this.workflow.run(affected.id);
        if (!run || !['running','waiting','paused'].includes(run.status)) continue; // deliberate takeover retains its history
        const cp = this.interactions.checkpoint(run.id);
        if (affected.priorStatus === 'paused' || !cp || cp.fault || cp.commandId !== affected.commandId || run.currentCommandId !== affected.commandId || this.checkpointResult(run) !== cp.result) throw new AppError('CHECKPOINT_CHANGED', 'An affected run lacks its valid original checkpoint. Wait for completion or use deliberate takeover.', 409);
        await this.assertCheckpointResult(run);
        if (await this.readWorktree(run.repository) !== cp.fingerprint || (this.config.mode !== 'mock' && await currentBranch(run.repository) !== cp.branch)) throw new AppError('CHECKPOINT_CHANGED', 'An affected checkout changed after its validated checkpoint.', 409);
      }
    }
    return this.store.db.transaction(() => {
      const prior = this.authority.duplicate<ManualSession>(input.requestId, input); if (prior) return prior;
      this.assertNativeBoundary(scope);
      if (this.authority.busyFor(scopes) || this.authority.pending(scopes).some(s => s.live) || this.authority.get(manual.id).revision !== manual.revision || this.nativeIn(scopes).active || this.nativeIn(scopes).revision !== nativeRevision) throw new AppError('MANUAL_CHANGED', 'New input or activity invalidated reconciliation.', 409);
      // This decision releases only this period. Run holds, checkpoints and faults remain untouched.
      const settled = { ...manual, reconciliationRequired: false, recoveryRequired: false };
      delete settled.settlement;
      const delegated = backgroundAuthorization();
      if (delegated?.decision === 'policy') delete settled.humanDecision; else delete settled.backgroundDecision;
      const result = this.authority.save({ ...settled,
        ...('confirmReady' in input && handoffRequestId ? { settlement: { requestId: handoffRequestId, nativeRevision, keyboardRevision: this.authority.revisionFor(scopes) + 1 } } : {}),
        ...('confirmInspected' in input
        ? { ...(delegated?.decision === 'policy'
            ? { backgroundDecision: { requestId: input.requestId, note: input.note, at: new Date().toISOString(), authorization: delegated } }
            : { humanDecision: { requestId: input.requestId, note: input.note, at: new Date().toISOString() } }),
          reason: delegated?.decision === 'policy'
            ? `${decisionActor()} acknowledged possible prior and background effects. This period released; affected runs still require checkpoint review or takeover.`
            : 'Human inspection recorded possible prior and background effects. This period released; affected runs still require checkpoint review or takeover.' }
        : { reason: 'Manual input recorded settled after inspection. Review each saved workflow checkpoint explicitly.' }) });
      this.authority.decide(input.requestId, input, result); return result;
    }).immediate();
  }
  private assertKeyboardSettlement(input: Pick<ImplementationStart, 'requestId' | 'keyboardSettlement' | 'agentId'>): void {
    if (!input.keyboardSettlement) return;
    const evidence = input.keyboardSettlement;
    const manual = this.authority.sessions().find(s => s.id === evidence.manualSessionId);
    const targetScopes = this.agentScopes(input.agentId);
    if (!manual || (manual.scope && !targetScopes?.includes(manual.scope.indexPath)) || manual.revision !== evidence.revision || manual.bootId !== this.authority.bootId || manual.live || manual.reconciliationRequired ||
      manual.settlement?.requestId !== input.requestId || manual.settlement.nativeRevision !== this.nativeIn(scopesFor(manual.scope)).revision ||
      manual.settlement.keyboardRevision !== this.authority.revisionFor(scopesFor(manual.scope)) || this.nativeIn(scopesFor(manual.scope)).active) {
      throw new AppError('SETTLEMENT_CHANGED', 'Keyboard settlement changed. Inspect the agents and confirm readiness again.', 409);
    }
  }
  /** Shared display snapshots only. Actions keep calling the uncached inspection methods below. */
  protected observationRevision = () => `${(this.store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n}:${this.lifecycleRevision}`;
  observedState(): Promise<WorkflowState> { return this.stateObservation.read(() => this.state(true), this.observationRevision); }
  observedWorkspaces(): Promise<WorkspaceDiscovery> { return this.workspaceObservation.read(() => this.workspaces(), this.observationRevision); }
  async state(observed = false): Promise<WorkflowState> {
    const discovery = await (observed ? this.observedWorkspaces() : this.workspaces());
    const sessions = this.workspaceSessions(discovery);
    const instances = await Promise.all(sessions.map((s) => this.instance(s)));
    const base = await this.transport.state(sessions);
    const runsOf = this.workflow.runsOf(base.commands.map((c) => c.id));
    const commands = base.commands.map((c) => ({ ...c, runId: runsOf.get(c.id)?.runId ?? null, pairId: runsOf.get(c.id)?.pairId ?? null, groupId: runsOf.get(c.id)?.groupId ?? null, repository: runsOf.get(c.id)?.repository ?? null }));
    const activities = sessions.map((session) => instances.find((i) => i.agentId === session.id)?.status === 'current' ? this.activity.read(session)
      : { agentId: session.id, state: 'unknown' as const, updatedAt: null, detail: 'The current CLI instance cannot be verified.' });
    return { ...base, commands, sessions, groups: this.workspaceGroups(discovery), legacyEnabled: this.config.legacyEnabled === true, runs: this.workflow.runs(), executions: this.workflow.activeExecutions(), instances, activities,
      manualSessions: this.authority.pending(), interactions: this.interactions.recent(), checkpoints: this.interactions.activeCheckpoints() };
  }
  /** Same CLI process as at registration? A registration made before pids were recorded stays unknown until renewed. */
  private async instance(session: ManagedSession): Promise<InstanceState> {
    if (!session.cliPid) return { agentId: session.id, status: 'unknown' };
    const live = await this.adapter.foreground(session).catch(() => null);
    return { agentId: session.id, status: live === null ? 'unknown' : live === session.cliPid ? 'current' : 'replaced' };
  }
  preview(id: string) { return this.transport.preview(id); }
  /** Read-only workspace discovery. Opening or refreshing it never registers a pane, starts a run or touches Git. */
  /** Mock mode has no tmux: launched sessions are simulated from the launch records. */
  private syncMockLaunches(): void {
    if(this.adapter instanceof MockAdapter) this.adapter.launched = this.launches.batches().flatMap(b=>b.items).filter(i=>i.identity&&!i.closed).map(i=>({identity:i.identity!,cwd:i.worktree.root,location:`${i.sessionName}:0.0`,command:i.profile.adapterHint==='manual'?'sh':i.profile.adapterHint,dead:false,inMode:false,synchronized:false}));
  }
  async workspaces(): Promise<WorkspaceDiscovery> {
    const { workspaces, skipped, error, discoveredAt, projects } = await this.workspaceInventory();
    return { workspaces, skipped, error, discoveredAt, projects };
  }
  /** Subdirectory panes cannot join a group, but still share its checkout and must remain observable internally. */
  private async workspaceInventory() {
    this.syncMockLaunches();
    const sessions = this.withoutClosedLaunches(this.store.sessions() as ManagedSession[]);
    const discovery = await discoverWorkspaces(this.adapter, this.config.mode, sessions, this.config.integrationBranches);
    await Promise.all(discovery.directories.flatMap((workspace) => workspace.agents.map(async (agent) => {
      if (!agent.observable) return;
      const existing = sessions.find((session) => session.id === agent.registeredAs);
      const moved = !!existing && ((existing.cwd ?? existing.repository) !== workspace.cwd ||
        (existing.worktree ? !sameWorktree(existing.worktree, workspace.worktree) : existing.repository !== workspace.worktree.root));
      const oldHeld = () => !!existing && !!(this.workflow.owner(existing.worktree?.indexPath ?? existing.repository) || this.store.activeFor(existing.repository));
      const held = () => oldHeld() || (!!existing && !!(this.workflow.owner(workspace.worktree.indexPath) || this.store.activeFor(workspace.worktree.root)));
      if (held()) {
        if (!moved) agent.session = existing;
        else if (oldHeld()) { agent.eligible = false; agent.reason = `This pane moved from ${existing!.repository}, where a run or delivery still owns it. Open that worktree, pause and take over the run after inspecting its work, then Recheck to rebind automatically.`; }
        else { agent.eligible = false; agent.reason = `This pane moved here from ${existing!.repository}, but a run or delivery already owns this worktree without it. Wait for that work or take it over, then Recheck to rebind automatically.`; }
        return;
      }
      if (existing && (!isDeepStrictEqual(existing.identity, agent.identity) || existing.agentType !== agent.kind)) {
        agent.eligible = false; agent.reason = 'The pane identity or CLI type changed. Inspect and reset its old workspace before rebinding.'; return;
      }
      // Legacy registrations without a canonical cwd retain their explicit renewal contract.
      if (existing && !moved && (!existing.cwd || !existing.worktree)) { agent.session = existing; return; }
      const id = existing?.id ?? `agent-${createHash('sha256').update(JSON.stringify([agent.identity, workspace.cwd])).digest('hex').slice(0, 24)}`;
      const candidate: ManagedSession = { id, label: agent.label, agentType: agent.kind as 'codex' | 'claude', repository: workspace.worktree.root,
        expectedCommand: agent.command, identity: agent.identity, relayPrompt: existing?.relayPrompt ?? 'relay', registeredAt: new Date().toISOString(), registrationId: randomUUID(), worktree: workspace.worktree, cwd: workspace.cwd };
      candidate.cliPid = await this.adapter.foreground(candidate).catch(() => null);
      if (held()) { agent.eligible = false; agent.reason = 'A run claimed the old or new worktree during discovery. Recheck after reconciliation.'; return; }
      if (existing && !moved && (!candidate.cliPid || (existing.cliPid === candidate.cliPid && existing.expectedCommand === candidate.expectedCommand))) { agent.session = existing; return; }
      if (moved && !candidate.cliPid) { agent.eligible = false; agent.reason = 'The moved CLI process cannot be verified. Inspect it and Recheck.'; return; }
      if (this.config.mode === 'tmux' && !candidate.cliPid) { agent.eligible = false; agent.reason = 'The host cannot identify this CLI process. Recheck before selecting it.'; return; }
      const prior = this.discovered.get(id);
      const session = prior && this.renewalBases.get(id) === existing?.registrationId && prior.cliPid === candidate.cliPid && prior.expectedCommand === candidate.expectedCommand && prior.cwd === candidate.cwd && isDeepStrictEqual(prior.identity, candidate.identity) && sameWorktree(prior.worktree, candidate.worktree) ? { ...prior, label: agent.label } : candidate;
      if (existing) this.renewalBases.set(id, existing.registrationId);
      this.discovered.set(id, session); agent.session = session;
    })));
    return { ...discovery, projects: await this.projects.discover(discovery.workspaces, sessions) };
  }
  async previewWorktree(input: WorktreePreviewInput) { await this.workspaces(); return this.projects.preview(input); }
  async createWorktree(input: WorktreeCreateInput) { return this.authority.automated(() => this.createWorktreeAdmitted(input), scopesFor(input.source)); }
  private async createWorktreeAdmitted(input: WorktreeCreateInput) { await this.workspaces(); return this.projects.create(input); }
  private async removalGuard(worktree: NonNullable<ManagedSession['worktree']>): Promise<void> {
    const panes = await this.adapter.listPanes(); // An unavailable inventory is not an empty checkout.
    for (const pane of panes) {
      // A pane whose directory no longer exists cannot be inside this existing checkout; its raw path still fails closed.
      const cwd = this.config.mode === 'mock' ? pane.cwd : await realpath(pane.cwd).catch(() => pane.cwd);
      if (cwd === worktree.root || cwd.startsWith(`${worktree.root}/`)) throw new AppError('WORKTREE_IN_USE', 'A tmux pane is still in this worktree. Finish branch closes sessions AltCLI launched; move or close other panes yourself, then Recheck.', 409);
    }
    if (this.workflow.owner(worktree.indexPath) || this.store.activeFor(worktree.root)) throw new AppError('WORKTREE_BUSY', 'A run or unresolved delivery owns this worktree. Inspect and take over before removal.', 409);
    // Deleting the checkout the CLIs' hooks or skill links point into would silently end every turn observation on the host.
    const installed = await installedInside(worktree.root, this.config);
    if (installed.length) throw new AppError('WORKTREE_INSTALLED', `The host's CLI hooks or skills point into this worktree: ${installed.join(', ')}. Reinstall them from the main checkout (node scripts/install-hooks.mjs and node scripts/install-skills.mjs there), then Recheck.`, 409);
  }
  async previewRemoval(input: WorktreeRemovalInput) {
    await this.workspaces();
    const preview = await this.projects.previewRemoval(input);
    await this.removalGuard(preview.worktree); return preview;
  }
  async removeWorktree(input: WorktreeRemoveInput) { return this.authority.automated(() => this.removeWorktreeAdmitted(input), scopesFor(input.worktree)); }
  private async removeWorktreeAdmitted(input: WorktreeRemoveInput) {
    await this.workspaces(); return this.projects.remove(input, (worktree) => this.removalGuard(worktree), (worktree) => this.archiveJournal(worktree.root));
  }
  /** Squash shares the checkout with every pane, including unselected agents and subdirectories. Native idle/ready is
   * only turn evidence: fresh process evidence must also exclude surviving writers before each Git mutation. */
  private async integrationGuard(target: NonNullable<ManagedSession['worktree']>, source: NonNullable<ManagedSession['worktree']>, revision: Map<string | null, { revision: number; active: number }>, acknowledged = false): Promise<void> {
    const ownership = () => {
      if (this.workflow.owner(target.indexPath) || this.store.activeFor(target.root)) throw new AppError('WORKTREE_BUSY', 'A run or unresolved delivery owns the integration checkout. Inspect and take over before squashing into it.', 409);
      if (this.workflow.owner(source.indexPath) || this.store.activeFor(source.root)) throw new AppError('WORKTREE_BUSY', 'A run or unresolved delivery owns the task worktree. Let it finish or take over before squashing its branch.', 409);
    };
    ownership();
    // An acknowledged squash accepts that agents may still be working; ownership still refuses.
    if (!acknowledged) await this.settledWriters([target, source], revision, 'INTEGRATION_WRITERS', 'Squash requires settled agents and clear process evidence in both checkouts. To proceed anyway, acknowledge that agents may be working.');
    ownership();
  }
  /** Aligning or renaming a worktree uses the human's confirmation of agent risks.
   * These operations cannot overlap a controller owner or rewrite the host's installed hooks, skills or running checkout. */
  private async changeGuard(worktree: NonNullable<ManagedSession['worktree']>, action: 'Update' | 'Rebase' | 'Reset' | 'Rename'): Promise<void> {
    if (action !== 'Rename') {
      const installed = await installedInside(worktree.root, this.config);
      if (installed.length) throw new AppError('WORKTREE_INSTALLED', `The host's CLI hooks or skills point into this worktree: ${installed.join(', ')}. Changing its files would change them under every session. Reinstall them from the main checkout (node scripts/install-hooks.mjs and node scripts/install-skills.mjs there), then Recheck.`, 409);
      if (isWithin(worktree.root, await realpath(resolve(process.cwd(), '..')).catch(() => resolve(process.cwd(), '..')))) throw new AppError('WORKTREE_HOST', 'AltCLI itself runs from this worktree, so changing its files would change the running host\'s code. Run the host from another checkout, or align this branch by hand.', 409);
    }
    if (this.workflow.owner(worktree.indexPath) || this.store.activeFor(worktree.root)) throw new AppError('WORKTREE_BUSY', `A run or unresolved delivery owns this worktree, including a paused run bound to its current commits. Let it finish or take over before the ${action.toLowerCase()}.`, 409);
  }
  /** Every pane must be a settled CLI, idle shell or the verified AltCLI host launch chain, with fresh process evidence
   * excluding surviving work. Native idle/ready alone is only turn evidence; host children are still work. */
  private async settledWriters(trees: NonNullable<ManagedSession['worktree']>[], revision: Map<string | null, { revision: number; active: number }>, code: string, requirement: string): Promise<void> {
    const scopes = trees.map(tree => tree.indexPath);
    const nativeChanged = () => this.nativeIn(scopes).active || this.nativeIn(scopes).revision !== this.nativeIn(scopes, revision).revision;
    const unknown = (detail = 'Current activity or process evidence is unavailable or changed.') => new AppError(code, `${requirement} ${detail} Inspect the panes and stop background work, then Recheck.`, 409);
    const hostProcesses = async (panePid: string) => {
      const initial = await this.adapter.hostProcesses(panePid);
      let current = initial;
      const deadline = performance.now() + 500;
      // Concurrent state/discovery reads spawn short-lived git/tmux/ps children. Wait for a clear scan, never exempt
      // them by executable name. Persistent children and processes outside the backend still block the operation.
      while (current?.writers.length && current.writers.every(p => current!.backendChildren.includes(p.pid)) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        current = await this.adapter.hostProcesses(panePid);
        if (!current || current.foregroundPid !== initial!.foregroundPid || !isDeepStrictEqual(current.lineage, initial!.lineage)) throw unknown();
      }
      return current;
    };
    const inventory = async () => {
      const result = [];
      for (const pane of await this.adapter.listPanes()) {
        const cwd = await realpath(pane.cwd).catch(() => pane.cwd);
        const tree = trees.find(w => cwd === w.root || cwd.startsWith(`${w.root}/`));
        if (tree) result.push({ pane, cwd, tree });
      }
      return result.sort((a, b) => JSON.stringify(a.pane.identity).localeCompare(JSON.stringify(b.pane.identity)));
    };
    try {
      if (nativeChanged()) throw unknown();
      const panes = await inventory();
      for (const { pane, cwd, tree } of panes) {
        const host = await hostProcesses(pane.identity.panePid);
        const agent = classifyAgent({ ...pane, inMode: false, synchronized: false }, []);
        const shell = /^(sh|bash|zsh|fish|dash|ksh|tcsh|csh)$/.test(pane.command);
        if (pane.dead || (!host && !shell && (!agent.eligible || (agent.kind !== 'codex' && agent.kind !== 'claude')))) throw unknown(`Pane ${pane.identity.paneId} (${pane.command}) is not a supported agent or shell.`);
        const session: ManagedSession = { id: pane.identity.paneId, label: agent.label, agentType: agent.kind === 'codex' || agent.kind === 'claude' ? agent.kind : 'other', identity: pane.identity,
          expectedCommand: pane.command, repository: tree.root, cwd, worktree: tree, registrationId: '', relayPrompt: '', registeredAt: '' };
        session.cliPid = await this.adapter.foreground(session);
        if (!session.cliPid || !sameWorktree(await resolveWorktree(cwd), tree)) throw unknown();
        if (host ? session.cliPid !== host.foregroundPid : shell ? session.cliPid !== pane.identity.panePid : !this.activity.settledForGit(session)) throw unknown(`Pane ${pane.identity.paneId} (${pane.command}) has no settled foreground activity evidence.`);
        const processes = host ? host.writers : await this.adapter.processes(session);
        if (!host && session.cliPid !== pane.identity.panePid && !processes.some(p => p.pid === session.cliPid)) throw unknown();
        const writer = host ? processes[0] : processes.find(p => p.pid !== session.cliPid && !(session.agentType === 'codex' && isCodexHelper(p.command)));
        if (writer) throw unknown(`Pane ${pane.identity.paneId} has process ${writer.pid} (${writer.command}) still running.`);
        const current = await this.adapter.inspect(pane.identity.paneId);
        if (!isDeepStrictEqual(current.identity, pane.identity) || current.dead || current.command !== pane.command
          || await realpath(current.cwd) !== cwd || await this.adapter.foreground(session) !== session.cliPid) throw unknown();
        if (host && !isDeepStrictEqual(await hostProcesses(pane.identity.panePid), host)) throw unknown();
      }
      const scope = (rows: typeof panes) => rows.map(({ pane, cwd }) => [pane.identity, cwd, pane.command, pane.dead]);
      if (!isDeepStrictEqual(scope(await inventory()), scope(panes)) || nativeChanged()) throw unknown();
    } catch (error) { if (error instanceof AppError && error.code === code) throw error; throw unknown(); }
  }
  async previewIntegration(input: WorktreeIntegrationInput) {
    const revision = new Map([...this.scopedNative].map(([key, state]) => [key, { ...state }]));
    await this.workspaces();
    const preview = await this.projects.previewIntegration(input);
    await this.integrationGuard(preview.target, preview.worktree, revision, preview.acknowledgeActivity === true); return preview;
  }
  private async updateScopes(input: WorktreeUpdateRequest): Promise<InputScopes> {
    const prior = this.store.worktreeUpdates().find(op => op.input.requestId === input.requestId);
    if (prior) return scopesFor(prior.input.worktree);
    await this.workspaces();
    return scopesFor((await this.projects.launchWorktree(input.projectId, input.worktreeId)).identity);
  }
  private async integrationScopes(input: WorktreeIntegrateRequest): Promise<InputScopes> {
    const prior = this.store.worktreeIntegrations().find(op => op.input.requestId === input.requestId);
    await this.workspaces();
    const preview = prior?.input ?? await this.projects.previewIntegration({ projectId: input.projectId, worktreeId: input.worktreeId,
      ...(input.through ? { through: input.through } : {}), ...(input.acknowledgeActivity ? { acknowledgeActivity: true } : {}) });
    return [preview.worktree.indexPath, preview.target.indexPath];
  }
  async integrateWorktree(input: WorktreeIntegrateRequest) { return this.authority.automated(() => this.integrateWorktreeAdmitted(input), await this.integrationScopes(input)); }
  private async integrateWorktreeAdmitted(input: WorktreeIntegrateRequest) {
    // One revision spans the entire operation: even a turn that starts and finishes between checks invalidates it.
    const revision = new Map([...this.scopedNative].map(([key, state]) => [key, { ...state }]));
    const acknowledged = (input as { acknowledgeActivity?: unknown }).acknowledgeActivity === true; // parsed strictly by integrate
    await this.workspaces(); return this.projects.integrate(input, async (target, source) => this.integrationGuard(target, source, revision, acknowledged));
  }
  async reconcileIntegration(requestId: string) {
    const revision = new Map([...this.scopedNative].map(([key, state]) => [key, { ...state }]));
    // Inspection applies the confirmed decision: an acknowledged squash is not refused for activity it accepted.
    const acknowledged = this.store.worktreeIntegrations().find((op) => op.input.requestId === requestId)?.input.acknowledgeActivity === true;
    return this.projects.reconcileIntegration(requestId, (target, source) => this.integrationGuard(target, source, revision, acknowledged));
  }
  /** Clear hold: the human's decision replaces the inspection gates; no Git state changes, so no writer or ownership check applies. */
  releaseIntegration(input: WorktreeIntegrationRelease) { return this.projects.releaseIntegration(input.requestId); }
  async previewUpdate(input: WorktreeUpdateInput) {
    await this.workspaces();
    const preview = await this.projects.previewUpdate(input);
    await this.changeGuard(preview.worktree, ALIGN_ACTION[preview.mode]); return preview;
  }
  async updateWorktree(input: WorktreeUpdateRequest) { return this.authority.automated(() => this.updateWorktreeAdmitted(input), await this.updateScopes(input)); }
  private async updateWorktreeAdmitted(input: WorktreeUpdateRequest) {
    await this.workspaces();
    return this.projects.update(input, (worktree) => this.changeGuard(worktree, ALIGN_ACTION[input.mode ?? 'update']), (worktree) => this.archiveJournal(worktree.root));
  }
  async reconcileUpdate(requestId: string) {
    return this.projects.reconcileUpdate(requestId, (worktree) => this.changeGuard(worktree, 'Update'));
  }
  private readonly sessionRenames: SessionRenames = (worktreeId, newBranch) => this.launches.plannedRenames(worktreeId, newBranch);
  async previewRename(input: WorktreeRenameInput) {
    await this.workspaces();
    const preview = await this.projects.previewRename(input, this.sessionRenames);
    await this.changeGuard(preview.worktree, 'Rename'); return preview;
  }
  async renameWorktree(input: WorktreeRenameConfirm) { return this.authority.automated(() => this.renameWorktreeAdmitted(input), scopesFor(input.worktree)); }
  private async renameWorktreeAdmitted(input: WorktreeRenameConfirm) {
    await this.workspaces();
    return this.projects.rename(input, (worktree) => this.changeGuard(worktree, 'Rename'), this.sessionRenames, (confirmed, renames) => this.followBranchRename(confirmed, renames));
  }
  /** After a verified branch rename: the confirmed app-launched sessions take their new names, agent names still showing an old session name
   * follow it, and a saved group named after the old branch takes the new one. A name the user chose and the directory stay. */
  private async followBranchRename(input: WorktreeRenameConfirm, renames: { from: string; to: string }[]): Promise<string> {
    const { renamed, failed } = await this.launches.renameSessions(input.worktreeId, renames);
    const last = (branch: string) => branch.split('/').pop()!;
    this.store.db.transaction(() => {
      for (const r of renamed) for (const session of this.store.sessions()) {
        if (isDeepStrictEqual(session.identity, r.identity) && session.label === r.from && !this.store.sessions().some((other) => other.label === r.to)) this.store.saveSession({ ...session, label: r.to });
      }
      for (const group of this.store.groups()) if (group.repository === input.worktree.root && group.name === last(input.branch)) { this.store.removeGroup(group.id); this.store.saveGroup({ ...group, name: last(input.newBranch) }); }
    }).immediate();
    return `${renamed.length ? ` Renamed tmux session${renamed.length === 1 ? '' : 's'} ${renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}; agent names that matched followed.` : ''}${failed.length ? ` Not renamed: ${failed.join('; ')}. Nothing was retried.` : ''}`;
  }
  async reconcileRename(requestId: string) { return this.projects.reconcileRename(requestId); }
  async previewDiscard(input: WorktreeDiscardInput) {
    await this.workspaces();
    const preview = await this.projects.previewDiscard(input);
    await this.removalGuard(preview.worktree); return preview;
  }
  async discardWorktree(input: WorktreeDiscardConfirm) { return this.authority.automated(() => this.discardWorktreeAdmitted(input), scopesFor(input.worktree)); }
  private async discardWorktreeAdmitted(input: WorktreeDiscardConfirm) {
    await this.workspaces(); return this.projects.discard(input, (worktree) => this.removalGuard(worktree), (worktree) => this.archiveJournal(worktree.root));
  }
  /** No occupancy guard: the checkout is verified gone before the remaining branch deletion, and its pending discard refuses new runs. */
  async finishDiscard(input: WorktreeDiscardFinish) { return this.authority.automated(() => this.finishDiscardAdmitted(input), scopesFor(this.store.worktreeDiscards().find(op => op.input.requestId === input.requestId)?.input.worktree)); }
  private async finishDiscardAdmitted(input: WorktreeDiscardFinish) {
    await this.workspaces(); return this.projects.finishDiscard(input);
  }
  /** Archive before cleanup: every handoff commit this worktree's runs published keeps its content in the journal, so later
   * squash integration or branch deletion cannot lose an intermediate revision. A commit already gone has nothing left to keep. */
  async archiveJournal(root: string): Promise<number> {
    let archived = 0;
    for (const record of this.workflow.unarchived(root)) {
      if (!(await gitRead(root, ['rev-parse', '--verify', '--quiet', `${record.sha}^{commit}`], true)).trim()) continue;
      this.workflow.saveArchive(record.commandId, await archiveCommit(root, record.sha)); archived++;
    }
    return archived;
  }
  /** AltCLI's own history for backup; cloning the repository cannot recover it. */
  exportHistory(repository?: string) { return { ...this.workflow.exportHistory(repository), interactions: this.interactions.records(repository) }; }
  /** Closed launches retain registrations for history, but cannot remain console or discovery targets.
   * A respawn can change panePid; closing the original server's pane retires every CLI it hosted. */
  private withoutClosedLaunches(sessions: ManagedSession[]): ManagedSession[] {
    const closed = this.launches.batches().flatMap(batch => batch.items.flatMap(item => {
      const identity = item.identity ?? item.placeholder;
      return item.closed && identity ? [identity] : [];
    }));
    return sessions.filter(session => !closed.some(identity => identity.socketPath === session.identity.socketPath &&
      identity.serverPid === session.identity.serverPid && identity.serverStarted === session.identity.serverStarted &&
      identity.paneId === session.identity.paneId));
  }
  private workspaceSessions(discovery: WorkspaceDiscovery): ManagedSession[] {
    const sessions = new Map((this.store.sessions() as ManagedSession[]).map((session) => [session.id, session]));
    for (const workspace of discovery.workspaces) for (const agent of workspace.agents) if (agent.session) sessions.set(agent.session.id, agent.session);
    return this.withoutClosedLaunches([...sessions.values()]);
  }
  private async checkoutSessions(): Promise<ManagedSession[]> {
    const inventory = await this.workspaceInventory();
    return this.workspaceSessions({ ...inventory, workspaces: inventory.directories });
  }
  private isRenewal(member: ManagedSession, current: ManagedSession): boolean {
    return this.renewalBases.get(member.id) === current.registrationId && this.discovered.get(member.id)?.registrationId === member.registrationId;
  }
  /** Persist only exact identities already revalidated for a deliberate edit or Start. */
  private bindMembers(members: ManagedSession[]): void {
    for (const member of members) {
      this.projects.assertWorktreeReady(member.repository);
      if (this.workflow.owner(member.worktree?.indexPath ?? member.repository)) throw new AppError('WORKTREE_BUSY', 'This worktree already has an execution owner. Inspect and take over before starting different work.', 409);
      const current = this.store.sessions().find((session) => session.id === member.id) as ManagedSession | undefined;
      if (current) this.unlocked(current);
      if (current && current.registrationId !== member.registrationId && !this.isRenewal(member, current)) throw new AppError('TARGET_CHANGED', 'The agent instance changed. Recheck before continuing.', 409);
      if (this.config.mode === 'tmux') assertExternalDataDir(this.config.dataDir, member.repository);
    }
    this.store.db.transaction(() => {
      for (const member of members) if (!this.store.sessions().some((session) => session.id === member.id && (session as ManagedSession).registrationId === member.registrationId)) {
        const old = this.store.sessions().find((session) => session.id === member.id) as ManagedSession | undefined;
        if (old && (old.cwd !== member.cwd || !sameWorktree(old.worktree, member.worktree))) {
          // Configuration follows verified placement only at an explicit edit/Start; frozen runs keep their snapshots.
          for (const pair of this.store.pairs().filter((p) => p.sessions.includes(member.id))) this.store.removePair(pair.id);
          for (const group of this.store.groups().filter((g) => g.members.includes(member.id))) {
            this.store.removeGroup(group.id);
            const remaining = group.members.filter((id) => id !== member.id);
            if (remaining.length) this.store.saveGroup({ ...group, members: remaining, revision: group.revision + 1, legacyPairId: null });
          }
        }
        this.store.saveSession(member);
      }
      for (const root of new Set(members.map((member) => member.repository))) this.projects.remember(root);
    }).immediate();
  }
  /** One read-only default per live workspace. Older associations remain stored for frozen runs/history,
   * but are not offered as additional workspace groups. Only an explicit selection writes configuration. */
  private workspaceGroups(discovery: WorkspaceDiscovery): Group[] {
    const sessions = this.store.sessions() as ManagedSession[];
    return discovery.workspaces.map((workspace) => {
      const stored = this.store.groups().find((group) => group.repository === workspace.worktree.root &&
        (group.cwd ?? sessions.find((session) => session.id === group.members[0])?.cwd ?? group.repository) === workspace.cwd);
      const owned = this.workflow.runs().find((run) => ['running', 'waiting', 'paused'].includes(run.status) &&
        (run.implementation?.cwd ?? run.planning?.cwd) === workspace.cwd);
      const frozen = owned?.implementation?.group ?? owned?.planning?.group;
      if (frozen) return frozen;
      // Temporary input modes must not remove a verified CLI from its group or close its terminal.
      const available = workspace.agents.flatMap((agent) => agent.session ? [agent.session.id] : []);
      const members = stored ? stored.members.filter((id) => available.includes(id)) : available;
      const signature = JSON.stringify([workspace.socketPath, workspace.cwd]);
      const id = stored?.id ?? `workspace-${createHash('sha256').update(signature).digest('hex').slice(0, 20)}`;
      const revision = stored && isDeepStrictEqual(stored.members, members) ? stored.revision
        : 1 + Number.parseInt(createHash('sha256').update(JSON.stringify([id, stored?.revision ?? 0, members])).digest('hex').slice(0, 12), 16);
      return { id, name: stored?.name ?? groupName(workspace), repository: workspace.worktree.root,
        cwd: workspace.cwd, members, revision, createdAt: stored?.createdAt ?? sessions.find((session) => members.includes(session.id))?.registeredAt ?? '1970-01-01T00:00:00.000Z', legacyPairId: stored?.legacyPairId ?? null };
    });
  }
  async rename(id: string, input: RenameSession): Promise<SessionRegistration> {
    const sessions = this.workspaceSessions(await this.workspaces());
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) throw new AppError('NOT_REGISTERED', 'No registration with this id.', 404);
    this.unlocked(session);
    if (session.registrationId !== input.expectedRegistrationId || session.label !== input.expectedLabel) throw new AppError('TARGET_CHANGED', 'This registration changed. Refresh before renaming it.', 409);
    if (sessions.some((other) => other.id !== id && other.label === input.label)) throw new AppError('LABEL_EXISTS', 'Another agent already uses this name.', 409);
    await this.validateMembers([session], session.cwd, true);
    if (this.store.sessions().some((other) => other.id !== id && other.label === input.label)) throw new AppError('LABEL_EXISTS', 'Another agent already uses this name.', 409);
    this.bindMembers([session]);
    const current = this.store.sessions().find((candidate) => candidate.id === id)!;
    if (current.label !== input.expectedLabel) throw new AppError('TARGET_CHANGED', 'This name changed. Refresh before renaming it.', 409);
    const renamed = { ...session, label: input.label };
    this.store.saveSession(renamed);
    return renamed;
  }
  private unlocked(session: SessionRegistration): void {
    this.projects.assertWorktreeReady(session.repository);
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
      identity: pane.identity, relayPrompt: singleLine(input.relayPrompt ?? 'relay'), registeredAt: new Date().toISOString(), registrationId: randomUUID(), worktree, cliPid: null,
      cwd: this.config.mode === 'mock' ? pane.cwd : await realpath(pane.cwd) };
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
    this.store.db.transaction(() => {
      // Configuration references may be removed at an idle boundary; historical run snapshots are untouched.
      for (const group of this.store.groups().filter((candidate) => candidate.members.includes(id))) {
        if (this.store.pairs().some((pair) => pair.id === group.id)) this.store.removePair(group.id);
        this.store.removeGroup(group.id);
        const members = group.members.filter((member) => member !== id);
        if (members.length) this.store.saveGroup({ ...group, members, revision: group.revision + 1 });
      }
      for (const pair of this.store.pairs().filter((candidate) => candidate.sessions.includes(id))) this.store.removePair(pair.id);
      this.transport.remove(id);
    }).immediate();
    this.discovered.delete(id); this.renewalBases.delete(id);
  }
  createPair(input: PairInput) {
    const members = input.sessions.map((id) => this.store.sessions().find((s) => s.id === id)) as (ManagedSession | undefined)[];
    if (members.some((s) => !s?.registrationId || !s.worktree)) throw new AppError('GIT_IDENTITY_REQUIRED', 'Re-register both panes to discover their canonical worktree and index before creating a pair.', 409);
    for (const member of members) this.unlocked(member!);
    if (!sameWorktree(members[0]!.worktree, members[1]!.worktree)) throw new AppError('DIFFERENT_WORKTREE', 'A relay requires the same canonical worktree and Git index.', 409);
    const pair = this.transport.createPair(input);
    this.store.saveGroup({ id: pair.id, name: pair.name, repository: pair.repository, cwd: members[0]!.cwd ?? null, members: pair.sessions, revision: 1, createdAt: pair.createdAt, legacyPairId: pair.id });
    return pair;
  }
  async createGroup(input: GroupInput): Promise<Group> {
    const participants = input.members.map((id) => this.store.sessions().find((s) => s.id === id) as ManagedSession | undefined);
    if (participants.length < 1 || new Set(input.members).size !== input.members.length || participants.some((p) => !p?.registrationId)) throw new AppError('INVALID_GROUP', 'Choose distinct agents.', 409);
    const members = participants as ManagedSession[];
    const cwd = await this.validateMembers(members);
    for (const member of members) this.unlocked(member);
    if (this.store.groups().some((group) => group.repository === members[0]!.repository &&
      (group.cwd ?? (this.store.sessions().find((session) => session.id === group.members[0]) as ManagedSession | undefined)?.cwd ?? group.repository) === cwd)) throw new AppError('WORKSPACE_GROUP_EXISTS', 'This workspace already has a group. Change its members instead of creating another.', 409);
    const id = slugify(input.name);
    if (this.store.groups().some((g) => g.id === id)) throw new AppError('GROUP_EXISTS', 'A group with this name already exists.', 409);
    const group: Group = { id, name: input.name, repository: members[0]!.repository, cwd, members: input.members, revision: 1, createdAt: new Date().toISOString(), legacyPairId: null };
    this.store.db.transaction(() => {
      this.store.saveGroup(group);
      if (members.length === 2) this.store.savePair({ id, name: input.name, repository: group.repository, sessions: [members[0]!.id, members[1]!.id], createdAt: group.createdAt });
    }).immediate();
    return group;
  }
  async selectGroup(id: string, input: GroupSelection): Promise<Group> {
    if (new Set(input.members).size !== input.members.length) throw new AppError('INVALID_GROUP', 'Choose distinct agents.', 409);
    const initial = await this.workspaces();
    const group = this.workspaceGroups(initial).find((candidate) => candidate.id === id);
    if (!group || group.revision !== input.expectedRevision) throw new AppError('GROUP_CHANGED', 'The workspace group changed. Recheck before choosing members.', 409);
    const sessions = this.workspaceSessions(initial);
    const members = input.members.map((member) => sessions.find((session) => session.id === member)) as ManagedSession[];
    if (members.some((member) => !member?.registrationId || input.registrations[member.id] !== member.registrationId)) throw new AppError('TARGET_CHANGED', 'A selected registration changed. Recheck before choosing members.', 409);
    await this.validateMembers(members, group.cwd ?? undefined, true);
    // Recheck after asynchronous pane inspection, before the atomic update.
    const discovery = await this.workspaces();
    const current = this.workspaceGroups(discovery).find((candidate) => candidate.id === id);
    if (!current || current.revision !== input.expectedRevision) throw new AppError('GROUP_CHANGED', 'Another client changed this group. Recheck before saving.', 409);
    const eligible = discovery.workspaces.find((workspace) => workspace.cwd === group.cwd && workspace.worktree.root === group.repository)!.agents.filter((agent) => agent.eligible);
    if (input.members.some((member) => !eligible.some((agent) => agent.session?.id === member))) throw new AppError('GROUP_CHANGED', 'The eligible agents changed. Recheck before selecting members.', 409);
    const latest = this.workspaceSessions(discovery);
    if (members.some((member) => latest.find((session) => session.id === member.id)?.registrationId !== input.registrations[member.id])) throw new AppError('TARGET_CHANGED', 'An instance changed while checking the selection.', 409);
    if (this.workflow.owner(discovery.workspaces.find((workspace) => workspace.cwd === group.cwd)!.worktree.indexPath)) throw new AppError('RUN_ACTIVE', 'A run owns this worktree. Take over before changing its group.', 409);
    const updated = { ...group, members: input.members, revision: group.revision + 1 };
    this.store.db.transaction(() => {
      this.bindMembers(members);
      if (this.store.pairs().some((pair) => pair.id === id)) this.store.removePair(id);
      this.store.removeGroup(id); this.store.saveGroup(updated);
      this.projects.remember(updated.repository);
      if (members.length === 2) this.store.savePair({ id, name: updated.name, repository: updated.repository, sessions: [members[0]!.id, members[1]!.id], createdAt: updated.createdAt });
    }).immediate();
    return updated;
  }
  removeGroup(id: string): void {
    const group = this.store.groups().find((g) => g.id === id);
    if (!group) throw new AppError('NOT_FOUND', 'Group not found.', 404);
    for (const member of group.members) { const session = this.store.sessions().find((s) => s.id === member); if (session) this.unlocked(session); }
    if (this.store.pairs().some((p) => p.id === group.id)) this.transport.removePair(group.id);
    this.store.removeGroup(id);
  }
  private async validateMembers(members: ManagedSession[], expectedCwd?: string, allowUnbound = false, mode: 'input' | 'observe' = 'input'): Promise<string> {
    let cwd = expectedCwd;
    for (const member of members) {
      const current = this.store.sessions().find((s) => s.id === member.id) as ManagedSession | undefined;
      this.projects.assertWorktreeReady(member.repository);
      if ((!current && !allowUnbound) || (current && current.registrationId !== member.registrationId && !(allowUnbound && this.isRenewal(member, current))) || !member.worktree || !sameWorktree(member.worktree, members[0]!.worktree)) throw new AppError('TARGET_CHANGED', 'Group registration or canonical worktree changed.', 409);
      const pane = await this.adapter.inspect(member.identity.paneId);
      // Reading a publication must not depend on whether the terminal accepts input.
      // The transport still checks the actual destination before every send.
      const observed = mode === 'observe' ? { ...pane, inMode: false, synchronized: false } : pane;
      const classification = classifyAgent({ ...observed, location: '' }, []);
      if (!classification.eligible || classification.kind !== member.agentType) throw new AppError('INELIGIBLE_AGENT', `${member.label}: ${classification.reason ?? 'The CLI type no longer matches its registered agent.'}`, 409);
      assertIdentity(member, observed);
      if (mode === 'input') await this.adapter.preflight(member);
      if ((this.config.mode === 'tmux' && !member.cliPid) || (member.cliPid && await this.adapter.foreground(member) !== member.cliPid)) throw new AppError('TARGET_CHANGED', 'Re-register the current CLI instance before starting implementation.', 409);
      const liveCwd = this.config.mode === 'mock' ? pane.cwd : await realpath(pane.cwd);
      if ((cwd && liveCwd !== cwd) || (member.cwd && member.cwd !== liveCwd)) throw new AppError('DIFFERENT_DIRECTORY', 'Every group member must remain in the same canonical current directory.', 409);
      if (this.config.mode === 'tmux' && !sameWorktree(await resolveWorktree(liveCwd), member.worktree)) throw new AppError('TARGET_CHANGED', 'The canonical worktree or index changed.', 409);
      cwd = liveCwd;
    }
    return cwd!;
  }
  /** Forget every registration and group on one checkout at once. A run that owns the worktree must be taken over first. */
  resetWorkspace(input: WorkspaceReset): WorkspaceResetResult {
    for (const session of this.store.sessions().filter((s) => s.repository === input.repository)) this.unlocked(session);
    const result = this.store.clearRepository(input.repository);
    for (const [id, session] of this.discovered) if (session.repository === input.repository) { this.discovered.delete(id); this.renewalBases.delete(id); }
    return result;
  }
  async resetActivity(input: ActivityReset) {
    if (input.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Inspect the terminal before resetting its status.');
    const session = this.workspaceSessions(await this.workspaces()).find((s) => s.id === input.agentId);
    if (!session?.cliPid || session.registrationId !== input.registrationId) throw new AppError('TARGET_CHANGED', 'The registered CLI changed or is unverified. Refresh before resetting its status.', 409);
    this.unlocked(session);
    await this.validateMembers([session], undefined, true, 'observe');
    // Validation yields: a concurrent send, registration change or native event must win over this reset.
    const current = this.store.sessions().find((s) => s.id === session.id) as ManagedSession | undefined;
    if (current ? current.registrationId !== input.registrationId && !this.isRenewal(session, current)
      : this.discovered.get(session.id)?.registrationId !== input.registrationId) throw new AppError('TARGET_CHANGED', 'The registration changed during status recovery.', 409);
    this.unlocked(session);
    if (this.store.activeFor(session.repository)) throw new AppError('TURN_ACTIVE', 'Reconcile the pending delivery before resetting activity.', 409);
    return this.activity.confirmReady(session, input.expectedUpdatedAt);
  }
  removePair(id: string): void {
    const pair = this.store.pairs().find((p) => p.id === id);
    for (const member of pair?.sessions ?? []) {
      const session = this.store.sessions().find((s) => s.id === member); if (session) this.unlocked(session);
    }
    this.transport.removePair(id);
    this.store.removeGroup(id);
  }
  /** A native conversation reset has a durable delivery receipt but no task, completion event or automatic continuation. */
  async clearContext(input: ClearContextInput): Promise<CommandRecord> {
    const decision = { action: 'clear_context', ...input };
    const previous = () => {
      if (!this.authority.duplicate<{ commandId: string }>(input.requestId, decision)) return;
      const record = this.store.get(input.requestId);
      if (!record) throw new AppError('CLEAR_PENDING', 'This clear-context request was already admitted. Inspect the terminal; it will not be replayed.', 409);
      return record;
    };
    const recorded = previous(); if (recorded) return recorded;
    return this.authority.automated(async () => {
      if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
      const session = this.workspaceSessions(await this.workspaces()).find(s => s.id === input.agentId);
      if (!session || session.registrationId !== input.registrationId) throw new AppError('TARGET_CHANGED', 'The CLI instance changed. Inspect it before clearing context.', 409);
      const text = clearContextCommand(session.agentType);
      if (!text) throw new AppError('CLEAR_UNSUPPORTED', 'Clear context supports Claude Code and Codex only.');
      const available = () => {
        this.projects.assertWorktreeReady(session.repository);
        this.authority.assertAutomated(scopesFor(session.worktree));
        if (this.workflow.owner(session.worktree?.indexPath ?? session.repository)) throw new AppError('RUN_ACTIVE', 'A run owns this worktree. Let it finish or take control before clearing context.', 409);
        const activity = this.activity.read(session);
        if (activity.state === 'working') throw new AppError('AGENT_WORKING', 'This agent is working. Wait for it to finish before clearing context.', 409);
        if (activity.updatedAt !== input.expectedActivityUpdatedAt) throw new AppError('ACTIVITY_CHANGED', 'Agent activity changed. Inspect the terminal and confirm again.', 409);
      };
      available();
      await this.validateMembers([session], session.cwd, true);
      // Another caller can finish validation while this one awaits discovery. Only the first may admit this request ID.
      const concurrent = previous(); if (concurrent) return concurrent;
      if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another command.', 409);
      available();
      if (this.store.activeFor(session.repository)) throw new AppError('TURN_ACTIVE', 'Inspect and reconcile the pending delivery before clearing context.', 409);
      this.bindMembers([session]);
      this.authority.decide(input.requestId, decision, { commandId: input.requestId });
      return this.transport.submit({ requestId: input.requestId, agentId: session.id, kind: 'instruction', text, confirmReady: true }, {
        beforeSend: async () => { await this.validateMembers([session], session.cwd); available(); },
      });
    }, this.agentScopes(input.agentId));
  }
  async submit(input: StartInput): Promise<CommandRecord> { return this.authority.automated(() => this.submitAdmitted(input), this.agentScopes(input.agentId)); }
  private async submitAdmitted(input: StartInput): Promise<CommandRecord> {
    // An existing request returns its recorded result even if the host has since disabled Stage relay.
    const fresh = !this.workflow.execution(input.requestId);
    if (fresh && !this.config.legacyEnabled) throw new AppError('STAGE_RELAY_DISABLED', 'Stage relay is disabled on this host (ALTCLI_ENABLE_LEGACY_RELAY=false). Remove that line or set it to true and restart the host to use Stage relay on main or the default branch.', 409);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const discovery = await this.workspaces();
    const stored = this.store.sessions() as ManagedSession[];
    const sessions = fresh ? this.workspaceSessions(discovery) : stored;
    const session = sessions.find((s) => s.id === input.agentId);
    if (!session?.registrationId) throw new AppError('REGISTRATION_REQUIRED', 'Register or re-register this worker before issuing commands.', 409);
    this.projects.assertWorktreeReady(session.repository);
    const workspaceGroup = input.pairId ? this.workspaceGroups(discovery).find((group) => group.id === input.pairId) : undefined;
    if (workspaceGroup && workspaceGroup.members.length !== 2) throw new AppError('INVALID_PAIR', 'Stage relay requires exactly two selected agents.', 409);
    const pair = input.pairId ? (workspaceGroup ? { ...workspaceGroup, sessions: workspaceGroup.members } : this.store.pairs().find((p) => p.id === input.pairId)) : undefined;
    if (input.pairId && (!pair || !pair.sessions.includes(input.agentId))) throw new AppError('INVALID_PAIR', 'The chosen pair does not contain this target.', 409);
    if (fresh && !pair) throw new AppError('PAIR_REQUIRED', 'Stage relay needs the two-member workspace group. Use Send for a single instruction.', 409);
    if ((input.autoContinue || input.handoff) && !pair) throw new AppError('PAIR_REQUIRED', 'Select an explicit pair to arm automatic handoffs.', 409);
    const participants = pair ? pair.sessions.map((id) => sessions.find((s) => s.id === id) as ManagedSession) : [session];
    if (participants.some((s) => !s?.registrationId)) throw new AppError('REGISTRATION_REQUIRED', 'Re-register the pair participants.', 409);
    if (this.config.mode === 'tmux' && participants.some((s) => !s.cliPid)) throw new AppError('REGISTRATION_REQUIRED', 'Re-register every participant so its current CLI process can be pinned.', 409);
    if (pair && !sameWorktree(participants[0]!.worktree, participants[1]!.worktree)) throw new AppError('DIFFERENT_WORKTREE', 'Pair participants must share a verified worktree and index.', 409);
    if (this.store.get(input.requestId) && !this.workflow.execution(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older transport command.', 409);
    if (fresh) await this.assertStageStart(input, participants[0]!.worktree?.root ?? session.repository);
    if (input.autoContinue || input.handoff) for (const participant of participants) wireText({ ...input, kind: 'relay', text: undefined }, participant);
    // Discovery is read-only; an explicit Start validates and binds any newly discovered or renewed members, but only the exact
    // instances the human confirmed. Repeated requests keep the original run's identities and never rebind or redeliver them.
    const unbound = participants.some((member) => !stored.some((saved) => saved.id === member.id && saved.registrationId === member.registrationId));
    const confirmed = input.registrations;
    if (fresh && (unbound || confirmed) && (!confirmed || Object.keys(confirmed).length !== participants.length || participants.some((member) => confirmed[member.id] !== member.registrationId))) {
      throw new AppError('TARGET_CHANGED', 'An agent instance changed or was not confirmed. Recheck and confirm readiness again; nothing was sent.', 409);
    }
    if (fresh && unbound) {
      await this.validateMembers(participants, workspaceGroup?.cwd ?? undefined, true);
      this.bindMembers(participants);
    }
    const turn = this.workflow.start(input, participants, pair?.id ?? null);
    await this.pump(turn.runId);
    const record = this.store.get(turn.commandId);
    if (!record) throw new AppError('RUN_PAUSED', 'The run is paused before delivery. Nothing was replayed.', 409);
    return record;
  }
  /** A new Stage relay start: main or the recorded default only, confirmed on the exact branch and commit the server reads now. */
  private async assertStageStart(input: StartInput, root: string): Promise<void> {
    const checkout = await this.stageCheckout(root);
    const eligibility = stageRelayEligibility(checkout.branch, checkout.primary, this.config.integrationBranches);
    if (!eligibility.eligible) throw new AppError(checkout.branch ? 'STAGE_BRANCH' : 'STAGE_BRANCH_DETACHED', eligibility.reason!, 409);
    if (!input.stage) throw new AppError('STAGE_BRANCH_REQUIRED', 'Confirm the displayed branch and commit before starting Stage relay.', 409);
    if (checkout.branch !== input.stage.branch || checkout.head !== input.stage.head) throw new AppError('BRANCH_CHANGED', 'The checked-out branch or commit changed. Recheck before starting Stage relay.', 409);
  }
  /** Branch and HEAD for Stage relay. Simulated /demo checkouts match discovery; every other path is read with Git. */
  private async stageCheckout(root: string) { return (this.config.mode === 'mock' && mockCheckout(root)) || checkoutHead(root); }
  /** Before every Stage relay delivery. A staging run without a binding predates branch-scoped Stage relay and dispatches nothing more. */
  private async assertStageBinding(run: RelayRun): Promise<void> {
    if (!run.stage) throw new AppError('STAGE_UNBOUND', 'This staging run predates branch-scoped Stage relay. Nothing more is dispatched; inspect the agents and take over.', 409);
    const checkout = await this.stageCheckout(run.repository);
    if (checkout.branch !== run.stage.branch || checkout.head !== run.stage.head) throw new AppError('BRANCH_CHANGED', `Stage relay is bound to ${run.stage.branch} at ${run.stage.head.slice(0, 12)}, but the checkout is now on ${checkout.branch ?? 'detached HEAD'} at ${checkout.head.slice(0, 12)}. Nothing was sent; inspect the checkout and take over.`, 409);
  }
  /** The checkout at a Stage relay completion, so the store schedules and releases nothing when it moved during the turn. Null when unreadable. */
  private async stageObservation(turn: Execution): Promise<Pick<BranchState, 'branch' | 'head'> | null> {
    const run = this.workflow.run(turn.runId);
    if (!run?.stage) return null;
    try { const { branch, head } = await this.stageCheckout(run.repository); return { branch, head }; } catch { return null; }
  }
  /** Resolves ordered attachment IDs for an admission: each recipient must be a CLI whose image reading was verified, and each image
   * must be a complete, unchanged upload for this workspace. Pinning happens atomically with run admission. */
  private async admitAttachments(ids: string[] | undefined, workspace: string, recipients: ManagedSession[]): Promise<AttachmentDescriptor[]> {
    if (!ids?.length) return [];
    const unsupported = recipients.filter((recipient) => !imageAgent(recipient.agentType));
    if (unsupported.length) throw new AppError('IMAGE_UNSUPPORTED', `Images are verified only for Claude Code and Codex recipients; ${unsupported.map((r) => r.label).join(', ')} cannot receive them. Remove the images or choose other agents.`, 409);
    return this.attachments.describe(ids, workspace);
  }
  async submitStandalone(input: StandaloneStart): Promise<CommandRecord> { return this.authority.automated(() => this.submitStandaloneAdmitted(input), await this.groupScopes(input.groupId)); }
  private async submitStandaloneAdmitted(input: StandaloneStart): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const existing = this.workflow.execution(input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(this.workflow.run(existing.runId)?.standalone, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another instruction.', 409);
      const receipt = this.store.get(existing.commandId);
      if (!receipt) throw new AppError('RUN_PAUSED', 'Delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
      return receipt;
    }
    if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older command.', 409);
    this.assertKeyboardSettlement(input);
    const { group, participants } = await this.implementationGroup({ ...input, kind: 'work', handoff: false, autoContinue: false });
    // Validate length before persisting registrations. Plain Send carries only the user's instruction and correlation marker,
    // or, with images, only the path of its immutable input manifest.
    const command = { requestId: input.requestId, agentId: input.agentId, kind: 'instruction' as const, text: input.text, ...(input.replaceDraft !== undefined ? { replaceDraft: input.replaceDraft } : {}), confirmReady: true as const };
    wireText(command, participants.find((p) => p.id === input.agentId)!);
    const attachments = await this.admitAttachments(input.attachments, group.repository, participants.filter((p) => p.id === input.agentId));
    this.assertKeyboardSettlement(input);
    this.bindMembers(participants);
    const turn = this.workflow.start(command, participants, null, undefined, undefined, input, attachments);
    await this.pump(turn.runId);
    const receipt = this.store.get(turn.commandId);
    if (!receipt) throw new AppError('RUN_PAUSED', 'Delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
    return receipt;
  }
  async previewReview(input: ReviewPreviewInput) {
    const discovery = await this.workspaces();
    const group = this.workspaceGroups(discovery).find((candidate) => candidate.id === input.groupId);
    if (!group || (input.recipient && !group.members.includes(input.recipient))) throw new AppError('INVALID_GROUP', 'Recheck the selected workspace group and recipient before previewing.', 409);
    return previewCommittedRange(group.repository, input, (agentId, shas) => this.workflow.publishedBy(agentId, shas));
  }
  async submitImplementation(input: ImplementationStart): Promise<CommandRecord> { return this.authority.automated(() => this.submitImplementationAdmitted(input), await this.groupScopes(input.groupId)); }
  private async submitImplementationAdmitted(input: ImplementationStart): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const existing = this.workflow.execution(input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(this.workflow.run(existing.runId)?.implementation?.request, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another implementation request.', 409);
      const receipt = this.store.get(existing.commandId);
      if (!receipt) throw new AppError('SETUP_PENDING', 'This request already owns setup. Inspect its run; it will not be replayed.', 409);
      return receipt;
    }
    if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older command.', 409);
    this.assertKeyboardSettlement(input);
    const { implementation, participants } = await this.prepareImplementation(input);
    // Every member receives the task images: the worker, and a peer or fixed reviewer in later assignments.
    const attachments = await this.admitAttachments(input.attachments, implementation.worktree.root, participants);
    this.assertKeyboardSettlement(input);
    this.bindMembers(participants);
    const turn = this.workflow.start({ requestId: input.requestId, agentId: input.agentId, kind: 'instruction', text: input.kind === 'commit' ? `Commit all current staged, unstaged and nonignored untracked project changes as they stand. Do not implement pending requests, relay to another agent, or claim task completion. Record unfinished work and checks in the handoff.${input.handoff ? ' The controller will relay the new snapshot after validating publication and completion.' : ''}` : input.text ?? 'Review the assigned candidate.',
      handoff: input.handoff, autoContinue: input.autoContinue, turnLimit: input.turnLimit, pauseOnObjection: input.pauseOnObjection === true, ...(input.replaceDraft !== undefined ? { replaceDraft: input.replaceDraft } : {}), confirmReady: true }, participants, null, implementation, undefined, undefined, attachments);
    await this.setupImplementation(turn.runId);
    await this.pump(turn.runId);
    const receipt = this.store.get(turn.commandId);
    if (!receipt) throw new AppError('RUN_PAUSED', 'Setup or delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
    return receipt;
  }
  private async implementationGroup(input: Pick<ImplementationStart, 'groupId' | 'groupRevision' | 'registrations' | 'agentId' | 'policy' | 'workerId' | 'kind' | 'handoff' | 'autoContinue'>) {
    const discovery = await this.workspaces();
    const group = this.workspaceGroups(discovery).find((g) => g.id === input.groupId);
    if (!group || !group.members.includes(input.agentId)) throw new AppError('INVALID_GROUP', 'The selected group is unavailable or no longer shares the same canonical current directory. Recheck its members.', 409);
    if (group.revision !== input.groupRevision) throw new AppError('GROUP_CHANGED', 'The selected group changed after confirmation. Recheck its membership and canonical current directory.', 409);
    if ((group.members.length === 1) !== (input.policy === 'solo') || group.members.length > 2 || (input.policy === 'solo' && (input.handoff || input.kind === 'review' || input.autoContinue))) throw new AppError('INVALID_POLICY', 'Solo implementation performs one work turn. Collaboration requires two distinct members.', 409);
    if (input.policy === 'worker_reviewer' && (!input.workerId || !group.members.includes(input.workerId) || (input.kind !== 'review' ? input.agentId !== input.workerId : input.agentId === input.workerId))) throw new AppError('INVALID_ROLE', 'Work targets the assigned worker; review targets the other group member.', 409);
    const sessions = this.workspaceSessions(discovery);
    const participants = group.members.map((id) => sessions.find((s) => s.id === id)) as ManagedSession[];
    if (participants.some((p) => !p?.registrationId)) throw new AppError('REGISTRATION_REQUIRED', 'Re-register the group members.', 409);
    if (group.revision !== input.groupRevision || Object.keys(input.registrations).length !== participants.length || participants.some((p) => input.registrations[p.id] !== p.registrationId)) throw new AppError('GROUP_CHANGED', 'The selected group or registered instance changed after confirmation. Refresh and inspect the current agents.', 409);
    const cwd = await this.validateMembers(participants, group.cwd ?? undefined, true);
    return { group, participants, cwd };
  }
  private async prepareImplementation(input: ImplementationStart) {
    const { group, participants, cwd } = await this.implementationGroup(input);
    const worktree = participants[0]!.worktree!;
    await access(resolve(process.cwd(), '../skills/commit-handoff/SKILL.md')).catch(() => { throw new AppError('SKILL_MISSING', 'Start the host from web/ with the repository commit-handoff skill present.', 409); });
    const state = input.kind !== 'review' ? await branchState(worktree.root) : await assertClean(worktree.root, input.branch.branch, input.branch.head);
    if (state.branch !== input.branch.branch || state.head !== input.branch.head) throw new AppError('BRANCH_CHANGED', 'The checked-out branch or commit changed. Recheck and make a fresh branch choice.', 409);
    if (input.kind === 'commit' && input.autoContinue && !input.handoff) throw new AppError('INVALID_POLICY', 'Commit without relay cannot enable automatic continuation.', 409);
    if (input.kind === 'commit' && !input.handoff && input.reviewBase !== undefined) throw new AppError('INVALID_BASELINE', 'A review baseline requires relay.', 409);
    if (input.kind === 'commit' && state.clean) throw new AppError('NO_CHANGES', 'There are no uncommitted changes. Use Relay last commit or Relay recent commits to review committed work.', 409);
    const initialWorktreeFingerprint = !state.clean ? await worktreeFingerprint(worktree.root) : undefined;
    // A tracked journal mirror is an explicit project preference; its existing entries stay immutable even when the initial project work is unfinished.
    if (input.logPath) {
      if (initialWorktreeFingerprint && await gitRead(worktree.root, ['status', '--porcelain=v1', '--untracked-files=all', '--', `:(literal)${input.logPath}`])) throw new AppError('LOG_CHANGED', 'The relay log has uncommitted changes. Reconcile it or choose a new log path.', 409);
      await assertLogPath(worktree.root, input.logPath);
      await validateExistingLog(worktree.root, input.branch.head, input.logPath);
    }
    // Integration branches are starting points only: task work and its review commits never land on them directly.
    const policy = await taskBaseline(worktree.root, state, this.config.integrationBranches);
    const integration = (name: string) => integrationNames(state.primary, this.config.integrationBranches).includes(name);
    if (input.branch.newBranch) {
      if (integration(input.branch.newBranch)) throw new AppError('INTEGRATION_BRANCH', `${input.branch.newBranch} is an integration branch name. Choose a task branch name.`, 409);
      await validateNewBranch(worktree.root, input.branch.newBranch);
    }
    else if (!input.branch.branch) throw new AppError('BRANCH_REQUIRED', 'Detached HEAD requires a new named branch or a manual checkout and Recheck.', 409);
    else if (policy.integration) throw new AppError('INTEGRATION_BRANCH', `${input.branch.branch} is an integration branch: a starting point, not an implementation branch. Create a task branch here or a task worktree in Projects.`, 409);
    // A new branch begins at the confirmed head. An existing task branch keeps its permanent baseline, confirmed when it cannot be inferred.
    const taskBase = input.branch.newBranch ? input.branch.head : input.branch.taskBase ?? policy.taskBase;
    if (!taskBase) throw new AppError('BASELINE_REQUIRED', 'Confirm where this task branch began. Its commits beyond the integration branch cannot be inferred; enter the task baseline commit.', 409);
    if (taskBase !== input.branch.head && !await isAncestor(worktree.root, taskBase, input.branch.head)) throw new AppError('INVALID_BASELINE', 'The task baseline must be the current commit or one of its ancestors.', 409);
    if (input.kind === 'review' || (input.kind === 'commit' && input.handoff)) {
      const reviewBase = input.reviewBase ?? input.branch.head;
      await validateReviewRange(worktree.root, reviewBase, input.branch.head, input.logPath ?? null, input.kind === 'commit');
      if (!await isAncestor(worktree.root, taskBase, reviewBase)) throw new AppError('INVALID_BASELINE', 'The review baseline precedes the task baseline. Both ranges are recorded; keep the review inside the task.', 409);
    }
    const implementation: ImplementationRun = { phase: 'implementation', handoff: 'commit', group: { ...group, cwd }, cwd, worktree,
      policy: input.policy, workerId: input.policy === 'worker_reviewer' ? input.workerId! : null, revision: 1,
      branch: input.branch.newBranch ?? input.branch.branch!, consent: input.branch, setup: 'pending', logPath: input.logPath ?? null,
      taskBaseSha: taskBase, acceptedSha: input.reviewBase ?? input.branch.head,
      candidateSha: input.kind === 'review' ? input.branch.head : null,
      candidateAuthor: input.kind === 'review' ? participants.find((p) => p.id !== input.agentId)!.id : null,
      expectedParentSha: input.branch.head, turn: 1, findings: null, latestPublication: null, next: null, request: input,
      ...(initialWorktreeFingerprint ? { initialWorktreeFingerprint } : {}) };
    return { implementation, participants };
  }
  private async setupImplementation(runId: string): Promise<void> {
    const run = this.workflow.run(runId)!; const implementation = run.implementation!;
    const { participants } = run; const { cwd, worktree, request: input } = implementation;
    if (this.workflow.claimSetup(runId)) {
      try {
        if (run.planning) { await this.validateMembers(run.planning.participants, cwd); await assertPlanBaseline(run.planning); await assertPlanArtifacts(run.planning); }
        await this.validateMembers(participants, cwd);
        await assertWorktreeInput(worktree.root, input.branch.branch, input.branch.head, implementation.initialWorktreeFingerprint);
        this.assertKeyboardSettlement(input);
        if (this.workflow.run(runId)?.status !== 'running') throw new AppError('RUN_PAUSED', 'Setup was paused before the branch operation.', 409);
        if (input.branch.newBranch) await createConsentedBranch(worktree.root, input.branch.newBranch, input.branch.head);
        await assertWorktreeInput(worktree.root, implementation.branch, input.branch.head, implementation.initialWorktreeFingerprint);
        this.workflow.setupResult(runId, true);
      } catch (error) { this.workflow.setupResult(runId, false, messageOf(error)); throw error; }
    }
  }
  async submitPlan(input: PlanStart): Promise<CommandRecord> { return this.authority.automated(() => this.submitPlanAdmitted(input), await this.groupScopes(input.groupId)); }
  private async submitPlanAdmitted(input: PlanStart): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const existing = this.workflow.execution(input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(this.workflow.run(existing.runId)?.planning?.request, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another planning request.', 409);
      const receipt = this.store.get(existing.commandId);
      if (!receipt) throw new AppError('SETUP_PENDING', 'Planning already owns setup. Inspect its run; it will not be replayed.', 409);
      return receipt;
    }
    if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older command.', 409);
    const discovery = await this.workspaces();
    const group = this.workspaceGroups(discovery).find((g) => g.id === input.groupId);
    if (!group || group.members.length < 1 || group.members.length > 2 || new Set(group.members).size !== group.members.length) throw new AppError('INVALID_GROUP', 'Select one or two distinct planners.', 409);
    const sessions = this.workspaceSessions(discovery);
    const participants = group.members.map((id) => sessions.find((s) => s.id === id)) as ManagedSession[];
    if (group.revision !== input.groupRevision || Object.keys(input.registrations).length !== participants.length || participants.some((p) => !p?.registrationId || input.registrations[p.id] !== p.registrationId)) throw new AppError('GROUP_CHANGED', 'The planning group or registration generation changed after confirmation.', 409);
    const cwd = await this.validateMembers(participants, group.cwd ?? undefined, true);
    const implementationInput: ImplementationStart = { ...input.implementation, branch: input.implementation.branch ?? input.baseline, requestId: input.requestId, kind: 'work', text: input.text, autoContinue: false, turnLimit: input.turnLimit, confirmReady: true };
    const implementation = await this.implementationGroup(implementationInput);
    if (implementation.cwd !== cwd || !sameWorktree(implementation.participants[0]!.worktree, participants[0]!.worktree)) throw new AppError('DIFFERENT_WORKTREE', 'Both phases must use the same prepared workspace.', 409);
    // Plan documents belong to AltCLI, not the project: they live beside the assignments, outside every checkout.
    const plan = newPlanning(input, group, participants, implementation.participants, cwd, await planRoot(this.config.dataDir, participants[0]!.worktree!.root));
    await access(resolve(process.cwd(), '../skills/plan-handoff/SKILL.md')).catch(() => { throw new AppError('SKILL_MISSING', 'The repository plan-handoff skill is required.', 409); });
    await assertPlanArtifacts(plan); await assertPlanBaseline(plan);
    // Consent may be absent until the checkpoint, but any supplied choice must match this planning baseline.
    if (input.implementation.branch) {
      if (input.implementation.branch.branch !== input.baseline.branch || input.implementation.branch.head !== input.baseline.head) throw new AppError('BRANCH_CHANGED', 'Branch consent must match the planning baseline.', 409);
      await this.prepareImplementation(implementationInput);
    }
    // Shared brief images reach every planner and the approved implementation members.
    const attachments = await this.admitAttachments(input.attachments, participants[0]!.worktree!.root, [...participants, ...implementation.participants]);
    this.bindMembers([...participants, ...implementation.participants]);
    const turn = this.workflow.start({ requestId: input.requestId, agentId: group.members[0]!, kind: 'instruction', text: input.text, autoContinue: input.autoContinue, turnLimit: input.turnLimit, pauseOnObjection: input.pauseOnObjection === true, confirmReady: true }, participants, null, undefined, plan, undefined, attachments);
    await this.pump(turn.runId);
    const receipt = this.store.get(turn.commandId);
    if (!receipt) throw new AppError('RUN_PAUSED', 'Planning delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
    return receipt;
  }
  async decidePlan(input: PlanDecision, authority: 'human' | 'automatic' = 'human'): Promise<void> { return this.authority.automated(() => this.decidePlanAdmitted(input, authority), this.runScopes(input.runId)); }
  private async decidePlanAdmitted(input: PlanDecision, authority: 'human' | 'automatic' = 'human'): Promise<void> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const run = this.workflow.run(input.runId); const plan = run?.planning;
    if (!run || !plan) throw new AppError('NOT_FOUND', 'Planning run not found.', 404);
    if (run.implementation) {
      const frozen = plan.frozen;
      if (input.action === 'approve' && frozen?.plan.revision === input.expectedRevision && frozen.plan.hash === input.expectedHash && frozen.briefRevision === input.expectedBriefRevision && frozen.policyRevision === input.expectedPolicyRevision) return;
      throw new AppError('PLAN_CHANGED', 'This run already entered Implementation.', 409);
    }
    if (run.status !== 'waiting' || !plan.current) throw new AppError('PLAN_BOUNDARY', 'Wait for a captured plan and a settled planning boundary.', 409);
    await this.validateMembers(plan.participants, plan.cwd);
    await assertPlanBaseline(plan); await assertPlanArtifacts(plan);
    if (input.action === 'changes') { this.workflow.requestPlanChanges(input); await this.pump(run.id); return; }
    const branch = input.branch ?? plan.request.implementation.branch;
    if (!branch) throw new AppError('BRANCH_REQUIRED', 'The plan is ready. Confirm the Implementation branch separately before continuing.', 409);
    if (branch.branch !== plan.request.baseline.branch || branch.head !== plan.request.baseline.head) throw new AppError('BRANCH_CHANGED', 'The branch choice must match the unchanged planning baseline.', 409);
    const nextId = randomUUID();
    const implInput: ImplementationStart = { ...plan.request.implementation, branch, requestId: nextId, kind: 'work', text: plan.request.text,
      autoContinue: plan.request.implementation.policy !== 'solo' && run.autoContinue, turnLimit: run.turnLimit, confirmReady: true };
    const { implementation } = await this.prepareImplementation(implInput);
    const turn = this.workflow.beginImplementation(input, implementation, authority);
    await this.setupImplementation(turn.runId); await this.pump(turn.runId);
  }
  /** Exactly one caller can claim a planned turn; browsers never create continuation commands. */
  private async pump(runId: string): Promise<void> {
    if (this.authority.blockedFor(this.runScopes(runId)) || this.completingHooks.has(runId)) return;
    return this.authority.automated(() => this.pumpAdmitted(runId), this.runScopes(runId));
  }
  private async pumpAdmitted(runId: string): Promise<void> {
    if (this.completingHooks.has(runId)) return;
    const run = this.workflow.run(runId); if (!run) return;
    if (run.planning && !run.implementation && run.status === 'waiting' && !run.restoredCheckpoint && !run.planning.next && run.autoContinue && !run.planning.request.requireApproval && planAgreed(run.planning)) {
      const plan = run.planning;
      if (!plan.request.implementation.branch) return; // Approval waiver never supplies branch consent.
      try { await this.decidePlan({ runId, expectedCommandId: run.currentCommandId, expectedRevision: plan.current!.revision, expectedHash: plan.current!.hash,
        expectedBriefRevision: plan.briefRevision, expectedPolicyRevision: plan.policyRevision, action: 'approve', confirmReady: true }, 'automatic'); }
      catch (error) { if (!this.workflow.run(runId)?.implementation) this.workflow.pause(runId, `Plan-to-Implementation validation stopped: ${messageOf(error)}`); }
      return;
    }
    const turn = this.workflow.claim(run.currentCommandId); if (!turn) return;
    await this.deliver(turn);
    for (const pending of this.workflow.pendingEvents(turn.commandId)) {
      const delivered = this.workflow.execution(turn.commandId)!;
      const evidence = pending.event === 'turn_complete' && pending.backgroundState === 'unknown' ? await this.evidence(delivered, pending.reporterPid) : null;
      const receipt = this.workflow.receive(pending, evidence, pending.event === 'turn_complete' ? await this.worktreeDigest(delivered) : null, await this.publication(delivered, pending), await this.planCapture(delivered, pending),
        pending.event === 'turn_complete' ? await this.stageObservation(delivered) : null);
      this.deferClaudeHook(delivered, pending, receipt);
    }
    await this.captureCheckpoint(runId);
    const next = this.workflow.run(runId);
    if (next && (next.currentCommandId !== turn.commandId || (next.planning && next.status === 'waiting'))) await this.pump(runId);
  }
  private async deliver(turn: Execution): Promise<void> {
    const run = this.workflow.run(turn.runId)!;
    const participant = run.participants.find((s) => s.id === turn.agentId)!;
    let baseline: ProcessRecord[] | null = null; let worktree: string | null = null;
    try {
      const record = await this.transport.submit(turn.input, { wireText: turn.wireText, beforeSend: async () => {
        if (!run.implementation && !run.planning && !run.standalone) await this.assertStageBinding(run);
        if (run.standalone) await this.validateMembers(run.participants);
        // Frozen images must be unchanged at every dispatch; missing or changed bytes refuse delivery and pause with ownership retained.
        if (run.attachments) await this.attachments.verify(run.attachments);
        if (run.standalone && run.attachments) {
          const manifest: InstructionManifest = { schema: 1, commandId: turn.commandId, instruction: run.standalone.text, attachments: run.attachments };
          await mkdir(this.workflow.assignmentDirectory, { recursive: true, mode: 0o700 });
          const path = this.workflow.manifestPath(turn.commandId), content = JSON.stringify(manifest, null, 2);
          try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== content) throw error; }
        }
        if (run.implementation && turn.implementation) {
          await this.validateMembers(run.participants, run.implementation.cwd, false, 'observe');
          const initialWorktreeFingerprint = turn.implementation.identity.turn === 1 && turn.implementation.identity.action === 'work' ? run.implementation.initialWorktreeFingerprint : undefined;
          await assertWorktreeInput(run.repository, run.implementation.branch, turn.implementation.identity.parent, initialWorktreeFingerprint);
          if (run.implementation.logPath) await assertLogPath(run.repository, run.implementation.logPath);
          if (run.planning) await assertPlanArtifacts(run.planning);
          const assignment: CommitAssignment = { identity: turn.implementation.identity, branch: run.implementation.branch, cwd: run.implementation.cwd,
            root: run.repository, logPath: run.implementation.logPath, resultPath: turn.implementation.resultPath, instruction: turn.input.text!, task: run.implementation.request.text ?? (run.implementation.request.kind === 'commit' ? 'Review the current changes; no claim of task completion.' : 'Review the explicitly assigned committed candidate.'), findings: run.implementation.findings,
            note: turn.agentId !== run.implementation.request.agentId ? run.implementation.request.reviewNote ?? null : null,
            participant: { agentType: participant.agentType, label: participant.label }, ...(turn.implementation.identity.turn === 1 && run.implementation.request.kind === 'commit' ? { commitOnly: true as const } : {}), ...(initialWorktreeFingerprint ? { initialWorktreeFingerprint } : {}), ...(run.planning?.frozen ? { frozenPlan: run.planning.frozen } : {}),
            ...(run.attachments ? { attachments: run.attachments } : {}) };
          await mkdir(this.workflow.assignmentDirectory, { recursive: true, mode: 0o700 });
          const path = join(this.workflow.assignmentDirectory, `${turn.commandId}.json`);
          const content = JSON.stringify(assignment, null, 2);
          try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== content) throw error; }
          if (this.workflow.run(run.id)?.status !== 'running') throw new AppError('RUN_PAUSED', 'Run paused before dispatch.', 409);
        }
        if (run.planning && turn.planning) {
          const plan = run.planning;
          await this.validateMembers(run.participants, plan.cwd, false, 'observe'); await assertPlanBaseline(plan); await assertPlanArtifacts(plan);
          const assignment: PlanningAssignment = { identity: turn.planning.identity, root: run.repository, cwd: plan.cwd, branch: plan.request.baseline.branch,
            brief: plan.brief, resultPath: turn.planning.resultPath,
            ...(turn.planning.identity.action !== 'draft' ? { drafts: plan.required.map((id) => ({ agentId: id, document: plan.drafts[id]!.document! })),
              ...(plan.current ? { plan: plan.current } : {}), findings: plan.objections } : {}), ...(run.attachments ? { attachments: run.attachments } : {}) };
          await mkdir(this.workflow.assignmentDirectory, { recursive: true, mode: 0o700 });
          await writeFile(join(this.workflow.assignmentDirectory, `${turn.commandId}.json`), JSON.stringify(assignment, null, 2), { flag: 'wx', mode: 0o600 });
          if (this.workflow.run(run.id)?.status !== 'running') throw new AppError('RUN_PAUSED', 'Plan paused before dispatch.', 409);
        }
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
        if (run.standalone) this.assertKeyboardSettlement(run.standalone);
        if (run.implementation?.request.requestId === turn.commandId) this.assertKeyboardSettlement(run.implementation.request);
        if ((run.implementation || run.planning || run.standalone) && this.workflow.run(run.id)?.status !== 'running') throw new AppError('RUN_PAUSED', 'Run paused before dispatch.', 409);
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
    return !turn.implementation && !turn.planning && turn.input.kind === 'instruction' && turn.input.handoff === true && !!this.workflow.run(turn.runId)?.participants.find((s) => s.id === turn.agentId)?.worktree;
  }
  private async publication(turn: Execution, input: HookEvent): Promise<PublicationResult | null> {
    if (!turn.implementation || input.event !== 'turn_complete' || !['delivered','dispatching'].includes(turn.status)) return null;
    const run = this.workflow.run(turn.runId)!;
    try {
      await this.validateMembers(run.participants, run.implementation!.cwd, false, 'observe');
      if (run.planning) await assertPlanArtifacts(run.planning);
      return await readPublication(run.implementation!, turn.implementation, input.outcome);
    } catch (error) { return { error: messageOf(error) }; }
  }
  private async planCapture(turn: Execution, input: HookEvent): Promise<PlanCapture | null> {
    if (!turn.planning || input.event !== 'turn_complete' || !['delivered','dispatching'].includes(turn.status)) return null;
    const plan = this.workflow.run(turn.runId)!.planning!;
    try {
      await this.validateMembers(plan.participants, plan.cwd, false, 'observe');
      if (input.outcome) throw new AppError('PLAN_PROTOCOL', 'A legacy relay outcome cannot certify a Plan assignment.', 409);
      return { captured: await capturePlanResult(plan, turn.planning) };
    } catch (error) { return { error: messageOf(error) }; }
  }
  /** The worktree digest at completion of a handoff instruction, so the store can tell a result from a question or a no-op. Null when unreadable. */
  private async worktreeDigest(turn: Execution): Promise<string | null> {
    if (!this.handsOff(turn)) return null;
    const participant = this.workflow.run(turn.runId)!.participants.find((s) => s.id === turn.agentId)!;
    return this.readWorktree(participant.worktree!.root).catch(() => null);
  }

  async recordEvent(input: HookEvent): Promise<HookReceipt> {
    this.lifecycleRevision++; this.lifecycleObservations++;
    try { return await this.recordObservedEvent(input); }
    finally { this.lifecycleRevision++; this.lifecycleObservations--; }
  }
  private async recordObservedEvent(input: HookEvent): Promise<HookReceipt> {
    const observed = [...this.store.sessions() as ManagedSession[], ...this.discovered.values()].find((s) => s.identity.socketPath === input.socketPath && s.identity.paneId === input.paneId);
    const key = observed?.worktree?.indexPath ?? null;
    const native = this.scopedNative.get(key) ?? { revision: 0, active: 0 }; this.scopedNative.set(key, native);
    native.revision++; native.active++;
    try {
      await this.observeCheckpointActivity(input);
      await this.activity.record(input, observed);
    } finally { native.revision++; native.active--; }
    if (input.event === 'turn_interrupted' && input.commandId) {
      try {
        const pane = await this.adapter.inspect(input.paneId);
        if (!observed || observed.cliPid !== input.cliPid || !isDeepStrictEqual(pane.identity, input.identity) || await this.adapter.foreground(observed) !== input.cliPid) {
          return { accepted: false, reason: 'The interrupted CLI instance is no longer current.', event: null };
        }
      } catch { return { accepted: false, reason: 'The interrupted CLI instance could not be verified.', event: null }; }
    }
    if (input.event === 'turn_started' && input.identity) {
      const session = observed;
      // Input holds can apply a saved disposition when preflight rejects, even before a checkpoint exists.
      // Revoke them and blocked handoffs; other pauses keep their reason and recovery path.
      for (const run of this.workflow.runs().filter((r) => (r.implementation || r.planning) && (
        ['running','waiting'].includes(r.status) ||
        (r.status === 'paused' && (r.blockedHandoff || (r.interaction?.active && !r.interaction.fault)))
      ))) {
        const previous = input.commandId ? this.workflow.execution(input.commandId) : undefined;
        if (session?.worktree?.indexPath === run.lockKey && input.commandId !== run.currentCommandId && previous?.status !== 'finished') this.workflow.pause(run.id, 'Another prompt started on this checkout outside its current assignment. Reconcile all writers.');
      }
    }
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
    const receipt = this.workflow.receive(input, evidence, worktree, turn ? await this.publication(turn, input) : null, turn ? await this.planCapture(turn, input) : null,
      turn && input.event === 'turn_complete' ? await this.stageObservation(turn) : null);
    if (turn) this.deferClaudeHook(turn, input, receipt);
    if (turn) { await this.captureCheckpoint(turn.runId); await this.pump(turn.runId); }
    // A held run's checkpoint needs settled activity from every checkout agent; later evidence from any of them may complete it.
    for (const held of this.ownedRuns()) if (held.id !== turn?.runId && held.interaction?.active && !held.interaction.fault && held.interaction.disposition) await this.captureCheckpoint(held.id);
    return receipt;
  }
  private deferClaudeHook(turn: Execution, input: HookEvent, receipt: HookReceipt): void {
    if (input.source !== 'claude' || input.event !== 'turn_complete' || !input.reporterPid || !receipt.accepted || receipt.completion !== 'finished' ||
      this.workflow.execution(turn.commandId)?.status !== 'finished') return;
    const pending = this.completingHooks.get(turn.runId);
    if (pending) { if (pending.commandId === turn.commandId) pending.reporters.add(input.reporterPid); return; }
    // A late duplicate must not create a new wait or pump a later assignment.
    if (turn.status === 'finished') return;
    const run = this.workflow.run(turn.runId)!;
    if (!['running', 'waiting', 'paused'].includes(run.status)) return;
    const member = run.participants.find(s => s.id === turn.agentId)!;
    const barrier = { commandId: turn.commandId, reporters: new Set([input.reporterPid]) };
    this.completingHooks.set(run.id, barrier);
    void this.waitForClaudeHooks(run.id, member, barrier);
  }
  private async waitForClaudeHooks(runId: string, member: ManagedSession, barrier: { commandId: string; reporters: Set<string> }): Promise<void> {
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        // Return the receipt before polling: waiting inside the request would deadlock the synchronous Stop.
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!this.store.db.open) return;
        const run = this.workflow.run(runId);
        // A keyboard hold pauses the run at its validated disposition; its checkpoint still waits for this Stop hook to exit.
        if (!run || !['running', 'waiting', 'paused'].includes(run.status) || this.workflow.owner(run.lockKey) !== runId) return;
        const pane = await this.adapter.inspect(member.identity.paneId);
        // Observing exit cannot type into the pane; copy mode or synchronized input must not turn a scrolled pane into a pause.
        assertIdentity(member, { ...pane, inMode: false, synchronized: false });
        if (!member.cliPid || await this.adapter.foreground(member) !== member.cliPid) throw new Error('The reporting CLI changed.');
        const reporters = [...barrier.reporters];
        const live = await this.adapter.processes(member);
        // A duplicate reported during inspection needs a new snapshot that can include its process.
        if (reporters.length === barrier.reporters.size && !reporters.some(pid => live.some(p => p.pid === pid))) break;
        if (Date.now() >= deadline) throw new Error('The reporting Stop hook did not exit.');
      }
      this.completingHooks.delete(runId);
      await this.captureCheckpoint(runId); await this.pump(runId);
    } catch (error) {
      if (this.store.db.open) this.workflow.pause(runId, `Claude hook exit could not be verified. ${messageOf(error)} Inspect the worker and take over; no command was replayed.`);
    } finally {
      if (this.completingHooks.get(runId) === barrier) this.completingHooks.delete(runId);
    }
  }
  async submitInteraction(value: InteractionInput): Promise<InteractionRecord> { return this.authority.automated(() => this.submitInteractionAdmitted(value), this.runScopes(value.runId)); }
  private async submitInteractionAdmitted(value: InteractionInput): Promise<InteractionRecord> {
    const input = parseInteraction(value);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const duplicate = this.interactions.duplicate(input); if (duplicate) return duplicate;
    const run = this.workflow.run(input.runId);
    const participant = run?.participants.find((p) => p.id === input.agentId);
    if (!run || !participant) throw new AppError('INTERACTION_CHANGED', 'The current worker is no longer bound.', 409);
    const prior = run.interaction;
    let record: InteractionRecord = { input, repository: run.repository, status: 'recorded', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.store.db.transaction(() => {
      if (this.interactions.pending(run.id) || this.store.activeFor(run.repository)) throw new AppError('DELIVERY_PENDING', 'Inspect the unresolved input before sending again.', 409);
      this.workflow.beginInteraction(input); this.interactions.save(record);
    }).immediate();
    try {
      await this.validateMembers([participant], participant.cwd);
      const current = this.workflow.run(run.id)!; const turn = this.workflow.execution(input.commandId);
      if (current.status !== 'running' || current.pauseRequested || current.interaction?.fault || turn?.status !== 'delivered') throw new AppError('INTERACTION_CHANGED', 'The assignment changed before typing.', 409);
    } catch (error) {
      record = { ...record, status: 'rejected', error: messageOf(error), updatedAt: new Date().toISOString() };
      this.store.db.transaction(() => { this.interactions.save(record); this.workflow.rejectInteraction(run.id, prior); }).immediate();
      await this.captureCheckpoint(run.id); await this.pump(run.id);
      return record;
    }
    record = { ...record, status: 'sending', updatedAt: new Date().toISOString() }; this.interactions.save(record);
    try {
      if (input.purpose === 'key') await this.adapter.press(participant, input.key!);
      else await this.adapter.send(participant, input.text!);
      record = { ...record, status: 'delivered', updatedAt: new Date().toISOString() };
    } catch (error) {
      record = { ...record, status: 'uncertain', error: messageOf(error), updatedAt: new Date().toISOString() };
      this.workflow.pause(run.id, 'Terminal input may have occurred. Inspect it; it will never be replayed.');
    }
    this.interactions.save(record);
    await this.captureCheckpoint(run.id);
    return record;
  }
  /** Only an actually validated original result can establish a checkpoint. */
  private checkpointResult(run: RelayRun): string | null {
    const turn = this.workflow.execution(run.currentCommandId);
    if (turn?.status !== 'finished') return null;
    const result = run.implementation ? turn.implementation?.published : run.planning ? turn.planning?.captured : run.standalone ? { commandId: turn.commandId } : null;
    return result ? JSON.stringify({ result, next: run.implementation?.next ?? run.planning?.next, plan: run.planning?.current, brief: run.planning?.briefRevision, policy: run.implementation?.revision ?? run.planning?.policyRevision }) : null;
  }
  private async checkpointMembers(run: RelayRun): Promise<ManagedSession[]> {
    const discovery = await this.workspaceInventory();
    if (discovery.error) throw new AppError('UNKNOWN_ACTIVITY', 'Pane inventory is unavailable.', 409);
    const workspaces = discovery.directories.filter((w) => w.worktree.indexPath === run.lockKey);
    if (workspaces.some((w) => w.agents.some((a) => !a.eligible || !a.session))) throw new AppError('UNKNOWN_ACTIVITY', 'Every checkout pane must have a verified agent identity.', 409);
    const sessions = workspaces.flatMap((w) => w.agents.map((a) => a.session!));
    if (!run.participants.every((p) => sessions.some((s) => s.id === p.id && s.registrationId === p.registrationId))) throw new AppError('TARGET_CHANGED', 'A participant is missing or changed.', 409);
    for (const s of sessions) {
      await this.validateMembers([s], s.cwd, true, 'observe');
      if (this.config.mode !== 'mock' && !['idle','ready'].includes(this.activity.read(s).state)) throw new AppError('UNKNOWN_ACTIVITY', 'Every checkout agent must have current settled native activity.', 409);
    }
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async captureCheckpoint(id: string): Promise<void> {
    if (this.completingHooks.has(id)) return;
    const scopes = this.runScopes(id), revision = this.nativeIn(scopes).revision;
    const run = this.workflow.run(id); if (!run || this.nativeIn(scopes).active || this.interactions.pending(id)) return;
    const kind = run.status === 'waiting' && !run.interaction?.active ? 'waiting' : run.interaction?.active && !run.interaction.fault && run.interaction.disposition ? 'interaction' : null;
    const result = kind && this.checkpointResult(run); if (!kind || !result) return;
    const existing = this.interactions.checkpoint(id);
    if (existing?.commandId === run.currentCommandId && existing.result === result && existing.kind === kind) return; // Never refresh away intervening work or faults.
    const expected = JSON.stringify(run);
    try {
      const sessions = await this.checkpointMembers(run);
      await this.assertCheckpointResult(run);
      if (run.planning) await assertPlanArtifacts(run.planning);
      const processes = Object.fromEntries(await Promise.all(sessions.map(async (s) => [s.id, await this.adapter.processes(s)] as const)));
      const fingerprint = await this.readWorktree(run.repository);
      const branch = this.config.mode === 'mock' ? null : await currentBranch(run.repository);
      if (this.nativeIn(scopes).active || this.nativeIn(scopes).revision !== revision || JSON.stringify(this.workflow.run(id)) !== expected || this.interactions.pending(id)) return;
      this.interactions.saveCheckpoint({ runId: id, commandId: run.currentCommandId, revision: (existing?.revision ?? 0) + 1, capturedAt: new Date().toISOString(), kind, fingerprint, branch, result, sessions, processes, external: {}, fault: false, reason: null });
    } catch { /* Missing evidence never creates a recoverable boundary. */ }
  }
  private async assertCheckpointResult(run: RelayRun): Promise<void> {
    const turn = this.workflow.execution(run.currentCommandId)!;
    if (run.implementation && turn.implementation) {
      const { publication } = await readPublication(run.implementation, turn.implementation);
      if (!isDeepStrictEqual(publication, turn.implementation.published)) throw new AppError('CHECKPOINT_CHANGED', 'The published result changed.', 409);
    } else if (run.planning && turn.planning) {
      const captured = await capturePlanResult(run.planning, turn.planning);
      if (!isDeepStrictEqual(captured, turn.planning.captured)) throw new AppError('CHECKPOINT_CHANGED', 'The captured plan result changed.', 409);
    }
  }
  /** Track external native evidence independently; never identify input by its text or reservation. */
  private async observeCheckpointActivity(input: HookEvent): Promise<void> {
    if (!['turn_started','turn_complete','turn_interrupted'].includes(input.event) || !input.identity) return;
    for (const saved of this.interactions.activeCheckpoints()) {
      const run = this.workflow.run(saved.runId);
      if (!run || !['waiting','paused','running'].includes(run.status) || run.currentCommandId !== saved.commandId) continue;
      const session = saved.sessions.find((s) => isDeepStrictEqual(s.identity, input.identity));
      if (!session) continue;
      if (input.commandId === saved.commandId) {
        const original = this.workflow.execution(saved.commandId)!;
        if (original.agentId === session.id && original.sessionId === input.sessionId && original.sourceTurnId === input.sourceTurnId) continue;
        this.interactions.invalidate(run.id, 'Another native turn reused the finished command marker. Inspect it and take over.');
        this.workflow.pause(run.id, 'A command marker cannot attribute another native turn to a finished assignment.'); continue;
      }
      if (saved.kind !== 'waiting') { this.interactions.invalidate(run.id, 'Another native turn requires takeover.'); continue; }
      if (!input.sessionId || !input.sourceTurnId || !input.cliPid || !input.startedAt || input.cliPid !== session.cliPid || input.source !== session.agentType) {
        this.interactions.invalidate(run.id, 'External native activity is not exactly identifiable.'); continue;
      }
      if (!(Date.parse(input.startedAt) > Date.parse(saved.capturedAt))) {
        this.interactions.invalidate(run.id, 'Native activity does not establish work started after this checkpoint.'); continue;
      }
      const key = JSON.stringify([session.id, input.sessionId, input.sourceTurnId, input.startedAt]);
      const prior = saved.external[key];
      const evidence = createHash('sha256').update(JSON.stringify([input.commandId ?? null, input.prompt ?? null, input.event, input.backgroundState, input.settled, input.outcome ?? null])).digest('hex');
      if (input.event === 'turn_started' && prior) {
        if (prior.startEvidence !== evidence) this.interactions.invalidate(run.id, 'Conflicting native start evidence requires takeover.');
        continue;
      }
      // Invalidate pending confirmations before any asynchronous inspection.
      const cp: Checkpoint = { ...saved, revision: saved.revision + 1, external: { ...saved.external } };
      if (input.event === 'turn_started') {
        if (Object.values(cp.external).some((e) => e.agentId === session.id && e.state !== 'clear')) cp.fault = true;
        cp.external[key] = { agentId: session.id, sessionId: input.sessionId, sourceTurnId: input.sourceTurnId, cliPid: input.cliPid, startedAt: input.startedAt, state: 'working', startEvidence: evidence };
        cp.reason = 'External native work must settle before this checkpoint can be restored.';
        this.interactions.saveCheckpoint(cp);
        this.workflow.pause(run.id, 'External native activity paused the settled checkpoint. Restore it only after exact settlement and inspection.'); continue;
      }
      if (!prior || input.event === 'turn_interrupted' || input.settled !== true) { this.interactions.invalidate(run.id, 'External native completion is missing or interrupted.'); continue; }
      if (prior.finishEvidence) {
        if (prior.finishEvidence !== evidence) this.interactions.invalidate(run.id, 'Conflicting native completion evidence requires takeover.');
        continue;
      }
      cp.external[key] = { ...prior, state: 'unknown', finishEvidence: evidence }; this.interactions.saveCheckpoint(cp);
      try {
        await this.validateMembers([session], session.cwd, true, 'observe');
        const live = await this.adapter.processes(session);
        const clear = session.agentType === 'claude' ? input.backgroundState === 'clear' : input.backgroundState !== 'active' && live.every((p) => p.pid === input.reporterPid || isCodexHelper(p.command) || cp.processes[session.id]?.some((b) => b.pid === p.pid && b.command === p.command));
        const current = this.interactions.checkpoint(run.id)!;
        // Another checkout agent can finish concurrently. Merge only this exact observation;
        // a fault, replaced checkpoint or conflicting finish still invalidates the evidence.
        if (!current.fault && current.commandId === cp.commandId && current.capturedAt === cp.capturedAt && current.external[key]?.finishEvidence === evidence && clear) {
          this.interactions.saveCheckpoint({ ...current, revision: current.revision + 1, external: { ...current.external, [key]: { ...prior, state: 'clear', finishEvidence: evidence } } });
        }
      } catch { /* Unknown remains a blocker. */ }
    }
  }
  async reconcileCheckpoint(value: CheckpointInput): Promise<void> { return this.authority.automated(() => this.reconcileCheckpointAdmitted(value), this.runScopes(value.runId)); }
  private async reconcileCheckpointAdmitted(value: CheckpointInput): Promise<void> {
    const input = parseCheckpoint(value);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    if (this.interactions.duplicateDecision(input)) return;
    const cp = this.interactions.checkpoint(input.runId); const run = this.workflow.run(input.runId);
    if (run) this.projects.assertWorktreeReady(run.repository);
    if (!cp || !run || cp.fault || cp.commandId !== input.commandId || run.currentCommandId !== input.commandId || cp.revision !== input.expectedRevision ||
      (input.action === 'restore' ? cp.kind !== 'waiting' || !Object.keys(cp.external).length : cp.kind !== 'interaction') ||
      Object.values(cp.external).some((e) => e.state !== 'clear') || this.interactions.pending(run.id) || this.store.activeFor(run.repository) || this.checkpointResult(run) !== cp.result) throw new AppError('CHECKPOINT_CHANGED', 'This checkpoint is incomplete, changed or uncertain. Inspect it; takeover may be required.', 409);
    const expected = JSON.stringify(run);
    const scopes = this.runScopes(run.id), nativeRevision = this.nativeIn(scopes).revision;
    if (this.nativeIn(scopes).active) throw new AppError('CHECKPOINT_CHANGED', 'Native activity is still being observed.', 409);
    const sessions = await this.checkpointMembers(run);
    if (!isDeepStrictEqual(sessions, cp.sessions)) throw new AppError('TARGET_CHANGED', 'Checkout agent identities changed.', 409);
    if (run.planning) { await assertPlanArtifacts(run.planning); if (!run.implementation) await assertPlanBaseline(run.planning); }
    await this.assertCheckpointResult(run);
    for (const s of sessions) {
      const processes = await this.adapter.processes(s);
      if (processes.some((p) => !(s.agentType === 'codex' && isCodexHelper(p.command)) && !cp.processes[s.id]?.some((b) => b.pid === p.pid && b.command === p.command))) throw new AppError('BACKGROUND_ACTIVE', 'New background processes remain. Inspect all checkout writers.', 409);
    }
    if (await this.readWorktree(run.repository) !== cp.fingerprint || (this.config.mode !== 'mock' && await currentBranch(run.repository) !== cp.branch)) throw new AppError('CHECKPOINT_CHANGED', 'The checkout changed after the validated result.', 409);
    this.store.db.transaction(() => {
      if (this.interactions.duplicateDecision(input)) return;
      if (this.nativeIn(scopes).active || this.nativeIn(scopes).revision !== nativeRevision || JSON.stringify(this.workflow.run(run.id)) !== expected || this.interactions.checkpoint(run.id)?.revision !== cp.revision || this.interactions.pending(run.id)) throw new AppError('CHECKPOINT_CHANGED', 'New activity invalidated this confirmation.', 409);
      if (input.action === 'restore') this.workflow.restoreCheckpoint(run.id, input.commandId);
      else this.workflow.reconcileInput(run.id, input.commandId);
      this.interactions.decide(input);
    }).immediate();
    if (input.action === 'review_input') { await this.captureCheckpoint(run.id); await this.pump(run.id); }
  }
  action(input: RunAction): void | Promise<void> {
    if (input.action === 'pause') { this.interactions.invalidate(input.runId, backgroundAuthorization()?.decision === 'policy' ? 'Background paused under the owner’s saved permission; takeover remains explicit.' : 'Explicit human pause requires takeover.'); this.workflow.pause(input.runId); }
    else if (input.action === 'recheck') return this.authority.automated(() => this.recheckHandoff(input), this.runScopes(input.runId));
    else if (input.action === 'continue') {
      this.authority.assertAutomated(this.runScopes(input.runId));
      const owned = this.workflow.run(input.runId); if (owned) this.projects.assertWorktreeReady(owned.repository);
      if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
      if (input.confirmReady !== true || !input.expectedCommandId) throw new AppError('READINESS_REQUIRED', 'Confirm readiness for the current manual handoff.');
      this.workflow.continue(input.runId, input.expectedCommandId); return this.pump(input.runId);
    }
    else {
      if (input.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Confirm every writer has stopped.');
      // A takeover confirmed for one command must not end a newer one: reject before anything is invalidated or released.
      const observed = this.workflow.run(input.runId);
      if (input.expectedCommandId && observed && observed.currentCommandId !== input.expectedCommandId) throw new AppError('HANDOFF_CHANGED', 'The controller moved to another command after you inspected it. Review its current state before taking over.', 409);
      if (this.interactions.records().some((r) => r.input.runId === input.runId && ['recorded','sending'].includes(r.status))) throw new AppError('DELIVERY_PENDING', 'Wait for terminal input to finish before taking over.', 409);
      this.interactions.invalidate(input.runId, `${decisionActor()} takeover ended this checkpoint.`); this.workflow.takeover(input.runId);
    }
  }
  private async recheckHandoff(input: RunAction): Promise<void> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    if (input.confirmReady !== true || !input.expectedCommandId || !input.expectedRevision) throw new AppError('READINESS_REQUIRED', 'Inspect every checkout writer and confirm the current blocked handoff.');
    const run = this.workflow.run(input.runId); const turn = this.workflow.execution(input.expectedCommandId);
    const completion = turn?.completion;
    const participant = run?.participants.find(p => p.id === turn?.agentId);
    if (!run?.implementation || run.status !== 'paused' || run.pauseRequested || run.interaction?.active ||
      run.currentCommandId !== input.expectedCommandId || run.blockedHandoff?.revision !== input.expectedRevision ||
      turn?.status !== 'delivered' || !completion || completion.cliPid !== participant?.cliPid || !completion.cliPid || !completion.startedAt ||
      completion.sessionId !== turn.sessionId || completion.sourceTurnId !== turn.sourceTurnId || this.interactions.pending(run.id)) {
      throw new AppError('HANDOFF_CHANGED', 'This handoff lacks current completion evidence or requires separate reconciliation.', 409);
    }
    const expected = JSON.stringify(run); const revision = this.lifecycleRevision;
    if (this.lifecycleObservations) throw new AppError('HANDOFF_CHANGED', 'Lifecycle evidence is still arriving. Recheck after it settles.', 409);
    await this.validateMembers(run.participants, run.implementation.cwd);
    const evidence = completion.source === 'codex' && completion.backgroundState === 'unknown' ? await this.evidence(turn) : null;
    const background = evidence?.state ?? completion.backgroundState;
    if (completion.settled !== true || background !== 'clear') throw new AppError('BACKGROUND_PENDING', 'Waiting for a current, correlated clear completion. An idle-looking terminal cannot replace this evidence.', 409);
    const publication = await this.publication(turn, completion);
    if (!publication?.publication) throw new AppError('INVALID_PUBLICATION', publication?.error ?? 'No validated handoff result was found.', 409);
    if (run.blockedHandoff.publishedSha && run.blockedHandoff.publishedSha !== publication.publication.sha) throw new AppError('HANDOFF_CHANGED', 'The published commit changed after completion. Reconcile the checkout.', 409);
    if (this.lifecycleObservations || this.lifecycleRevision !== revision || JSON.stringify(this.workflow.run(run.id)) !== expected || this.interactions.pending(run.id)) {
      throw new AppError('HANDOFF_CHANGED', 'New activity invalidated this confirmation. Refresh and inspect the run.', 409);
    }
    this.workflow.recheck(run.id, turn.commandId, input.expectedRevision, publication, evidence);
    await this.pump(run.id);
  }
  changePolicy(input: PolicyChange): void { this.workflow.changePolicy(input); }
}
