import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandRecord, PairInput, RegistrationInput, RegistrationResult, RenameSession, SessionRegistration } from '../contracts/api.ts';
import type { ActivityReset, BackgroundEvidence, Execution, HookEvent, HookReceipt, InstanceState, ManagedSession, ProcessRecord, RunAction, StartInput, WorkflowState, WorkspaceDiscovery, WorkspaceReset, WorkspaceResetResult } from '../contracts/workflow.ts';
import { AppError } from '../core/errors.ts';
import { singleLine, slugify } from '../core/validation.ts';
import { assertAgentCommand, assertIdentity, suggestAgentType } from '../core/policy.ts';
import { Controller } from './controller.ts';
import { WorkflowStore, wireText } from './workflow-store.ts';
import { resolveWorktree, sameWorktree, worktreeFingerprint } from './worktree.ts';
import { assertExternalDataDir } from './paths.ts';
import { isCodexHelper } from './processes.ts';
import { discoverWorkspaces } from './workspaces.ts';
import type { CommitAssignment, Group, GroupInput, GroupSelection, ImplementationRun, ImplementationStart, PolicyChange, PublicationResult, ReviewPreviewInput, StandaloneStart } from '../contracts/implementation.ts';
import { archiveCommit, assertClean, assertLogPath, assertWorktreeInput, branchState, gitRead, createConsentedBranch, integrationNames, isAncestor, previewCommittedRange, readPublication, taskBaseline, validateExistingLog, validateNewBranch, validateReviewRange } from './commit-handoff.ts';
import { classifyAgent } from '../core/workspaces.ts';
import { messageOf } from '../core/errors.ts';
import type { PlanCapture, PlanDecision, PlanningAssignment, PlanStart } from '../contracts/planning.ts';
import { newPlanning, planAgreed } from './planning-state.ts';
import { assertPlanArtifacts, assertPlanBaseline, capturePlanResult } from './planning-documents.ts';
import { ProjectCatalog } from './projects.ts';
import { AgentActivityTracker } from './agent-activity.ts';
import type { WorktreeCreateInput, WorktreePreviewInput, WorktreeRemovalInput, WorktreeRemoveInput } from '../contracts/projects.ts';

/** The only controller exposed to HTTP. The older Controller supplies transport/read-model helpers, not scheduling. */
export class ControlPlane {
  readonly workflow: WorkflowStore;
  get store() { return this.transport.store; }
  get config() { return this.transport.config; }
  get adapter() { return this.transport.adapter; }
  readonly transport: Controller;
  readonly projects: ProjectCatalog;
  private readonly activity: AgentActivityTracker;
  /** Ephemeral identity proposals. Discovery never writes registrations or starts work. */
  private readonly discovered = new Map<string, ManagedSession>();
  /** Stored generation replaced by an idle discovery candidate; checked again before an explicit action binds it. */
  private readonly renewalBases = new Map<string, string>();
  /** Read-only worktree digest. Mock mode has no repository, so its digest never changes unless a test supplies one. */
  private readonly readWorktree: (root: string) => Promise<string>;
  constructor(transport: Controller, readWorktree?: (root: string) => Promise<string>) {
    this.transport = transport;
    this.activity = new AgentActivityTracker(this.adapter);
    this.readWorktree = readWorktree ?? (transport.config.mode === 'mock' ? async () => 'mock-worktree' : worktreeFingerprint);
    this.workflow = new WorkflowStore(this.store, join(this.config.dataDir, 'assignments'));
    this.projects = new ProjectCatalog(this.store, this.config);
    // Mock fixtures have no real filesystem. Real registrations must be renewed explicitly after this upgrade.
    if (this.config.mode === 'mock') for (const raw of this.store.sessions()) {
      const session = raw as ManagedSession;
      if (!session.registrationId) this.store.saveSession({ ...session, registrationId: randomUUID(),
        worktree: { root: session.repository, gitDir: `${session.repository}/.git`, indexPath: `${session.repository}/.git/index` } } as ManagedSession);
    }
    this.workflow.recover();
  }
  async state(): Promise<WorkflowState> {
    const discovery = await this.workspaces();
    const sessions = this.workspaceSessions(discovery);
    const instances = await Promise.all(sessions.map((s) => this.instance(s)));
    const base = await this.transport.state(sessions);
    const runsOf = this.workflow.runsOf(base.commands.map((c) => c.id));
    const commands = base.commands.map((c) => ({ ...c, runId: runsOf.get(c.id)?.runId ?? null, pairId: runsOf.get(c.id)?.pairId ?? null, groupId: runsOf.get(c.id)?.groupId ?? null }));
    const activities = sessions.map((session) => instances.find((i) => i.agentId === session.id)?.status === 'current' ? this.activity.read(session)
      : { agentId: session.id, state: 'unknown' as const, updatedAt: null, detail: 'The current CLI instance cannot be verified.' });
    return { ...base, commands, sessions, groups: this.workspaceGroups(discovery), legacyEnabled: this.config.legacyEnabled === true, runs: this.workflow.runs(), executions: this.workflow.activeExecutions(), instances, activities };
  }
  /** Same CLI process as at registration? A registration made before pids were recorded stays unknown until renewed. */
  private async instance(session: ManagedSession): Promise<InstanceState> {
    if (!session.cliPid) return { agentId: session.id, status: 'unknown' };
    const live = await this.adapter.foreground(session).catch(() => null);
    return { agentId: session.id, status: live === null ? 'unknown' : live === session.cliPid ? 'current' : 'replaced' };
  }
  preview(id: string) { return this.transport.preview(id); }
  /** Read-only workspace discovery. Opening or refreshing it never registers a pane, starts a run or touches Git. */
  async workspaces(): Promise<WorkspaceDiscovery> {
    const sessions = this.store.sessions() as ManagedSession[];
    const discovery = await discoverWorkspaces(this.adapter, this.config.mode, sessions, this.config.integrationBranches);
    await Promise.all(discovery.workspaces.flatMap((workspace) => workspace.agents.map(async (agent) => {
      if (!agent.eligible) return;
      const existing = sessions.find((session) => session.id === agent.registeredAs);
      const moved = !!existing && ((existing.cwd ?? existing.repository) !== workspace.cwd ||
        (existing.worktree ? !sameWorktree(existing.worktree, workspace.worktree) : existing.repository !== workspace.worktree.root));
      const oldHeld = () => !!existing && !!(this.workflow.owner(existing.worktree?.indexPath ?? existing.repository) || this.store.activeFor(existing.repository));
      const held = () => oldHeld() || (!!existing && !!(this.workflow.owner(workspace.worktree.indexPath) || this.store.activeFor(workspace.worktree.root)));
      if (held()) {
        if (!moved) agent.session = existing;
        else if (oldHeld()) { agent.eligible = false; agent.reason = `This pane moved from ${existing!.repository}, where a run or delivery still owns it. Open that worktree and Pause / take over after inspecting its work, then Recheck to rebind automatically.`; }
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
  async createWorktree(input: WorktreeCreateInput) { await this.workspaces(); return this.projects.create(input); }
  private async removalGuard(worktree: NonNullable<ManagedSession['worktree']>): Promise<void> {
    const panes = await this.adapter.listPanes(); // An unavailable inventory is not an empty checkout.
    for (const pane of panes) {
      // A pane whose directory no longer exists cannot be inside this existing checkout; its raw path still fails closed.
      const cwd = this.config.mode === 'mock' ? pane.cwd : await realpath(pane.cwd).catch(() => pane.cwd);
      if (cwd === worktree.root || cwd.startsWith(`${worktree.root}/`)) throw new AppError('WORKTREE_IN_USE', 'A tmux pane is still in this worktree. Move or close it yourself, then Recheck.', 409);
    }
    if (this.workflow.owner(worktree.indexPath) || this.store.activeFor(worktree.root)) throw new AppError('WORKTREE_BUSY', 'A run or unresolved delivery owns this worktree. Inspect and take over before removal.', 409);
  }
  async previewRemoval(input: WorktreeRemovalInput) {
    await this.workspaces();
    const preview = await this.projects.previewRemoval(input);
    await this.removalGuard(preview.worktree); return preview;
  }
  async removeWorktree(input: WorktreeRemoveInput) {
    await this.workspaces(); return this.projects.remove(input, (worktree) => this.removalGuard(worktree), (worktree) => this.archiveJournal(worktree.root));
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
  /** CoderCrew's own history for backup; cloning the repository cannot recover it. */
  exportHistory(repository?: string) { return this.workflow.exportHistory(repository); }
  private workspaceSessions(discovery: WorkspaceDiscovery): ManagedSession[] {
    const sessions = new Map((this.store.sessions() as ManagedSession[]).map((session) => [session.id, session]));
    for (const workspace of discovery.workspaces) for (const agent of workspace.agents) if (agent.session) sessions.set(agent.session.id, agent.session);
    return [...sessions.values()];
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
      const eligible = workspace.agents.filter((agent) => agent.eligible);
      const stored = this.store.groups().find((group) => group.repository === workspace.worktree.root &&
        (group.cwd ?? sessions.find((session) => session.id === group.members[0])?.cwd ?? group.repository) === workspace.cwd);
      const owned = this.workflow.runs().find((run) => ['running', 'waiting', 'paused'].includes(run.status) &&
        (run.implementation?.cwd ?? run.planning?.cwd) === workspace.cwd);
      const frozen = owned?.implementation?.group ?? owned?.planning?.group;
      if (frozen) return frozen;
      const available = eligible.flatMap((agent) => agent.session ? [agent.session.id] : []);
      const members = stored ? stored.members.filter((id) => available.includes(id)) : available;
      const signature = JSON.stringify([workspace.socketPath, workspace.cwd]);
      const id = stored?.id ?? `workspace-${createHash('sha256').update(signature).digest('hex').slice(0, 20)}`;
      const revision = stored && isDeepStrictEqual(stored.members, members) ? stored.revision
        : 1 + Number.parseInt(createHash('sha256').update(JSON.stringify([id, stored?.revision ?? 0, members])).digest('hex').slice(0, 12), 16);
      return { id, name: stored?.name ?? basename(workspace.cwd).slice(0, 40), repository: workspace.worktree.root,
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
  async submit(input: StartInput): Promise<CommandRecord> {
    if (!this.config.legacyEnabled && !this.workflow.execution(input.requestId)) throw new AppError('LEGACY_DISABLED', 'The deprecated staging relay is disabled. Start a committed implementation run, or explicitly enable CODERCREW_ENABLE_LEGACY_RELAY on the host for supervised fallback.', 409);
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const session = this.store.sessions().find((s) => s.id === input.agentId) as ManagedSession | undefined;
    if (!session?.registrationId) throw new AppError('REGISTRATION_REQUIRED', 'Register or re-register this worker before issuing commands.', 409);
    this.projects.assertWorktreeReady(session.repository);
    const workspaceGroup = input.pairId ? this.workspaceGroups(await this.workspaces()).find((group) => group.id === input.pairId) : undefined;
    if (workspaceGroup && workspaceGroup.members.length !== 2) throw new AppError('INVALID_PAIR', 'Staging fallback requires exactly two selected agents.', 409);
    const pair = input.pairId ? (workspaceGroup ? { ...workspaceGroup, sessions: workspaceGroup.members } : this.store.pairs().find((p) => p.id === input.pairId)) : undefined;
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
  async submitStandalone(input: StandaloneStart): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const existing = this.workflow.execution(input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(this.workflow.run(existing.runId)?.standalone, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another instruction.', 409);
      const receipt = this.store.get(existing.commandId);
      if (!receipt) throw new AppError('RUN_PAUSED', 'Delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
      return receipt;
    }
    if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older command.', 409);
    const { participants } = await this.implementationGroup({ ...input, kind: 'work', handoff: false, autoContinue: false });
    // Validate length before persisting registrations. Plain Send carries only the user's instruction and correlation marker.
    const command = { requestId: input.requestId, agentId: input.agentId, kind: 'instruction' as const, text: input.text, confirmReady: true as const };
    wireText(command, participants.find((p) => p.id === input.agentId)!);
    this.bindMembers(participants);
    const turn = this.workflow.start(command, participants, null, undefined, undefined, input);
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
  async submitImplementation(input: ImplementationStart): Promise<CommandRecord> {
    if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
    const existing = this.workflow.execution(input.requestId);
    if (existing) {
      if (!isDeepStrictEqual(this.workflow.run(existing.runId)?.implementation?.request, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another implementation request.', 409);
      const receipt = this.store.get(existing.commandId);
      if (!receipt) throw new AppError('SETUP_PENDING', 'This request already owns setup. Inspect its run; it will not be replayed.', 409);
      return receipt;
    }
    if (this.store.get(input.requestId)) throw new AppError('ID_CONFLICT', 'This request ID belongs to an older command.', 409);
    const { implementation, participants } = await this.prepareImplementation(input);
    this.bindMembers(participants);
    const turn = this.workflow.start({ requestId: input.requestId, agentId: input.agentId, kind: 'instruction', text: input.kind === 'commit' ? `Commit all current staged, unstaged and nonignored untracked project changes as they stand. Do not implement pending requests, relay to another agent, or claim task completion. Record unfinished work and checks in the handoff.${input.handoff ? ' The controller will relay the new snapshot after validating publication and completion.' : ''}` : input.text ?? 'Review the assigned candidate.',
      handoff: input.handoff, autoContinue: input.autoContinue, turnLimit: input.turnLimit, pauseOnObjection: input.pauseOnObjection === true, confirmReady: true }, participants, null, implementation);
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
        if (this.workflow.run(runId)?.status !== 'running') throw new AppError('RUN_PAUSED', 'Setup was paused before the branch operation.', 409);
        if (input.branch.newBranch) await createConsentedBranch(worktree.root, input.branch.newBranch, input.branch.head);
        await assertWorktreeInput(worktree.root, implementation.branch, input.branch.head, implementation.initialWorktreeFingerprint);
        this.workflow.setupResult(runId, true);
      } catch (error) { this.workflow.setupResult(runId, false, messageOf(error)); throw error; }
    }
  }
  async submitPlan(input: PlanStart): Promise<CommandRecord> {
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
    const plan = newPlanning(input, group, participants, implementation.participants, cwd);
    await access(resolve(process.cwd(), '../skills/plan-handoff/SKILL.md')).catch(() => { throw new AppError('SKILL_MISSING', 'The repository plan-handoff skill is required.', 409); });
    await assertPlanArtifacts(plan); await assertPlanBaseline(plan);
    // Consent may be absent until the checkpoint, but any supplied choice must match this planning baseline.
    if (input.implementation.branch) {
      if (input.implementation.branch.branch !== input.baseline.branch || input.implementation.branch.head !== input.baseline.head) throw new AppError('BRANCH_CHANGED', 'Branch consent must match the planning baseline.', 409);
      await this.prepareImplementation(implementationInput);
    }
    this.bindMembers([...participants, ...implementation.participants]);
    const turn = this.workflow.start({ requestId: input.requestId, agentId: group.members[0]!, kind: 'instruction', text: input.text, autoContinue: input.autoContinue, turnLimit: input.turnLimit, pauseOnObjection: input.pauseOnObjection === true, confirmReady: true }, participants, null, undefined, plan);
    await this.pump(turn.runId);
    const receipt = this.store.get(turn.commandId);
    if (!receipt) throw new AppError('RUN_PAUSED', 'Planning delivery is pending or paused. Inspect the run; nothing was replayed.', 409);
    return receipt;
  }
  async decidePlan(input: PlanDecision, authority: 'human' | 'automatic' = 'human'): Promise<void> {
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
    const run = this.workflow.run(runId); if (!run) return;
    if (run.planning && !run.implementation && run.status === 'waiting' && !run.planning.next && run.autoContinue && !run.planning.request.requireApproval && planAgreed(run.planning)) {
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
      this.workflow.receive(pending, evidence, pending.event === 'turn_complete' ? await this.worktreeDigest(delivered) : null, await this.publication(delivered, pending), await this.planCapture(delivered, pending));
    }
    const next = this.workflow.run(runId);
    if (next && (next.currentCommandId !== turn.commandId || (next.planning && next.status === 'waiting'))) await this.pump(runId);
  }
  private async deliver(turn: Execution): Promise<void> {
    const run = this.workflow.run(turn.runId)!;
    const participant = run.participants.find((s) => s.id === turn.agentId)!;
    let baseline: ProcessRecord[] | null = null; let worktree: string | null = null;
    try {
      const record = await this.transport.submit(turn.input, { wireText: turn.wireText, beforeSend: async () => {
        if (run.standalone) await this.validateMembers(run.participants);
        if (run.implementation && turn.implementation) {
          await this.validateMembers(run.participants, run.implementation.cwd, false, 'observe');
          const initialWorktreeFingerprint = turn.implementation.identity.turn === 1 && turn.implementation.identity.action === 'work' ? run.implementation.initialWorktreeFingerprint : undefined;
          await assertWorktreeInput(run.repository, run.implementation.branch, turn.implementation.identity.parent, initialWorktreeFingerprint);
          if (run.implementation.logPath) await assertLogPath(run.repository, run.implementation.logPath);
          if (run.planning) await assertPlanArtifacts(run.planning);
          const assignment: CommitAssignment = { identity: turn.implementation.identity, branch: run.implementation.branch, cwd: run.implementation.cwd,
            root: run.repository, logPath: run.implementation.logPath, resultPath: turn.implementation.resultPath, instruction: turn.input.text!, task: run.implementation.request.text ?? (run.implementation.request.kind === 'commit' ? 'Review the current changes; no claim of task completion.' : 'Review the explicitly assigned committed candidate.'), findings: run.implementation.findings,
            participant: { agentType: participant.agentType, label: participant.label }, ...(turn.implementation.identity.turn === 1 && run.implementation.request.kind === 'commit' ? { commitOnly: true as const } : {}), ...(initialWorktreeFingerprint ? { initialWorktreeFingerprint } : {}), ...(run.planning?.frozen ? { frozenPlan: run.planning.frozen } : {}) };
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
              ...(plan.current ? { plan: plan.current } : {}), findings: plan.objections } : {}) };
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
    const observed = [...this.store.sessions() as ManagedSession[], ...this.discovered.values()].find((s) => s.identity.socketPath === input.socketPath && s.identity.paneId === input.paneId);
    await this.activity.record(input, observed);
    if (input.event === 'turn_interrupted' && input.commandId) {
      try {
        const pane = await this.adapter.inspect(input.paneId);
        if (!observed || observed.cliPid !== input.cliPid || !isDeepStrictEqual(pane.identity, input.identity) || await this.adapter.foreground(observed) !== input.cliPid) {
          return { accepted: false, reason: 'The interrupted CLI instance is no longer current.', event: null };
        }
      } catch { return { accepted: false, reason: 'The interrupted CLI instance could not be verified.', event: null }; }
    }
    if (input.event === 'turn_started' && input.identity) {
      const session = this.store.sessions().find((s) => s.identity.socketPath === input.identity!.socketPath && s.identity.paneId === input.identity!.paneId) as ManagedSession | undefined;
      for (const run of this.workflow.runs().filter((r) => (r.implementation || r.planning) && ['running','waiting'].includes(r.status))) {
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
    const receipt = this.workflow.receive(input, evidence, worktree, turn ? await this.publication(turn, input) : null, turn ? await this.planCapture(turn, input) : null);
    if (turn) await this.pump(turn.runId);
    return receipt;
  }
  action(input: RunAction): void | Promise<void> {
    if (input.action === 'pause') this.workflow.pause(input.runId);
    else if (input.action === 'continue') {
      if (!this.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled by the host.', 403);
      if (input.confirmReady !== true || !input.expectedCommandId) throw new AppError('READINESS_REQUIRED', 'Confirm readiness for the current manual handoff.');
      this.workflow.continue(input.runId, input.expectedCommandId); return this.pump(input.runId);
    }
    else { if (input.confirmReady !== true) throw new AppError('READINESS_REQUIRED', 'Confirm every writer has stopped.'); this.workflow.takeover(input.runId); }
  }
  changePolicy(input: PolicyChange): void { this.workflow.changePolicy(input); }
}
