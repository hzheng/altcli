import { realpathSync } from 'node:fs';
import { AppError } from '../../core/errors.ts';
import { join, resolve } from 'node:path';
import type { GlobalAIInstance } from '../../contracts/global-ai.ts';
import type { TerminalTarget } from '../../contracts/terminals.ts';
import type { WorkflowState, WorkspaceDiscovery } from '../../contracts/workflow.ts';
import { AttentionService } from '../attention/service.ts';
import { noteHelper, noting } from '../attention/sources.ts';
import { ControlPlane } from '../control-plane.ts';
import type { Controller } from '../controller.ts';
import { inspectAttach } from '../tmux-attach.ts';
import { AppReads, type LaunchFacts } from './reads.ts';
import { GlobalAIService, type InstanceRepository } from './service.ts';
import { NativeGlobalHost } from './host.ts';
import { KB } from './kb.generated.ts';

/** Adds a Git-free, user-operated role and app-wide attention without constructing another controller/store or changing
 * workspace dispatch. */
export class GlobalControlPlane extends ControlPlane {
  readonly globalAI: GlobalAIService;
  readonly attention: AttentionService;
  constructor(transport: Controller) {
    super(transport);
    // Optional metadata on the existing connection. No new workflow owner or effectful delegation schema.
    // Older hosts ignore this table and cannot authenticate this boot's in-memory read capability.
    this.store.db.exec('CREATE TABLE IF NOT EXISTS global_ai_instances (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL)');
    // Deterministic attention reads the records written above and by recovery; it runs without a browser once constructed.
    const attention = new AttentionService(this.store.db);
    const repository: InstanceRepository = {
      all: () => (this.store.db.prepare('SELECT value FROM global_ai_instances ORDER BY rowid DESC').all() as { value: string }[]).map(r => JSON.parse(r.value) as GlobalAIInstance),
      save: i => {
        this.store.db.prepare('INSERT INTO global_ai_instances(id,request_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(i.id, i.requestId, JSON.stringify(i));
        noting(() => noteHelper(this.store.db, i), () => attention.schedule());
      },
    };
    const repoRoot = resolve(process.cwd(), '..');
    const reads = new AppReads({ kb: KB, state: () => this.state(), workspaces: () => this.workspaces(), run: id => this.workflow.run(id) ?? undefined,
      attention: { item: id => this.attention.item(id), open: limit => this.attention.open(limit) }, launch: id => this.launchFacts(id),
      featureFlags: () => ({ nativeTerminals: this.config.terminalEnabled === true, agentLaunch: this.config.launchEnabled === true,
        input: this.config.inputEnabled, stageRelay: this.config.legacyEnabled === true, globalAIReadTools: true, delegatedActions: false }) });
    this.globalAI = new GlobalAIService({ repository, reads, host: new NativeGlobalHost({ ...this.config, dataDir: realpathSync(this.config.dataDir) }, repoRoot),
      directory: join(realpathSync(this.config.dataDir), 'global-ai'), profiles: () => this.launches.profiles(),
      enabled: () => this.config.mode === 'tmux' && this.config.inputEnabled && this.config.terminalEnabled === true && this.config.launchEnabled === true,
      launchGuard: work => this.authority.automated(work),
    });
    this.attention = attention;
    const signal = () => attention.schedule();
    this.workflow.attentionSignal = signal; this.interactions.attentionSignal = signal; this.launches.attentionSignal = signal;
    // The first pass reconciles markers recovery wrote before anything listened; a sweep then repairs any missed path.
    attention.start();
  }
  /** Recorded facts for get_launch: a workspace launch or a Helper start, never live pane output. */
  private launchFacts(id: string): LaunchFacts | undefined {
    const item = this.launches.batches().flatMap(b => b.items).find(i => i.id === id);
    if (item) return { id: item.id, kind: 'workspace', status: item.status, phase: item.phase, message: item.message, sessionName: item.sessionName,
      profileLabel: item.profile.label, repository: item.worktree.root, branch: item.branch, updatedAt: item.updatedAt, cleanup: item.cleanup?.status ?? null,
      closed: !!item.closed, identityRecorded: !!item.identity };
    const instance = this.globalAI.instance(id);
    return instance && { id: instance.id, kind: 'helper', status: instance.status, phase: instance.phase, message: instance.message, sessionName: instance.sessionName,
      profileLabel: instance.profile.label, repository: null, branch: null, updatedAt: instance.updatedAt, cleanup: null, closed: instance.status === 'retired',
      identityRecorded: !!instance.identity };
  }
  /** The host-wide attention feed rides on the state every console page already polls. */
  override async state(): Promise<WorkflowState> {
    return { ...await super.state(), attention: this.attention.feed() };
  }
  /** Global AI's own terminal: no project, run or automated delivery uses it, so typing there holds nothing. */
  override inputExempt(target: TerminalTarget): boolean {
    if (!('launchId' in target)) return false;
    const instance = this.globalAI?.instance(target.launchId);
    return !!instance && instance.status !== 'retired';
  }
  override async terminalTarget(target: TerminalTarget) {
    if ('launchId' in target) {
      const instance = this.globalAI?.instance(target.launchId);
      if (instance) {
        if (instance.status === 'retired') throw new AppError('INSTANCE_RETIRED', 'This Helper target was retired; its CLI was not stopped.');
        const observed = await this.globalAI.services.host.inspect(instance).catch(() => { throw new AppError('GLOBAL_IDENTITY', 'The Helper terminal could not be verified. Inspect its exact instance.', 409); });
        // Startup/trust/model prompts are usable before coding-agent recognition. No worktree launch reservation is cleared.
        return inspectAttach(this.config, observed.identity);
      }
    }
    return super.terminalTarget(target);
  }
  override async workspaces(): Promise<WorkspaceDiscovery> {
    const discovery = await super.workspaces();
    const instances = this.globalAI?.services.repository.all() ?? [];
    // Keep raw pane/process evidence for manual holds. Exclude only exact app-role panes from project collaboration offers.
    const appPane = (identity: { paneId: string; serverPid: string; serverStarted: string; socketPath: string }) => instances.some(i => i.identity &&
      i.identity.paneId === identity.paneId && i.identity.serverPid === identity.serverPid &&
      i.identity.serverStarted === identity.serverStarted && i.identity.socketPath === identity.socketPath);
    return { ...discovery, workspaces: discovery.workspaces.map(w => {
      const agents = w.agents.filter(a => !appPane(a.identity));
      return { ...w, agents, group: w.group?.filter(p => agents.some(a => a.identity.paneId === p)) ?? null };
    }) };
  }
}
