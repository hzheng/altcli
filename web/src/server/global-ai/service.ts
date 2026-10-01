import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { GlobalAIInstance, GlobalAIPreview, GlobalAIView, ToolReply } from '../../contracts/global-ai.ts';
import type { LaunchProfile } from '../../contracts/launches.ts';
import type { PaneIdentity } from '../../contracts/api.ts';
import { AppReads, APP_TOOLS, fields, GlobalAIError, hash, text } from './reads.ts';
import { codexProfileArgs } from './codex.ts';

export interface InstanceRepository {
  all(): GlobalAIInstance[];
  save(instance: GlobalAIInstance): void;
}
export interface GlobalHost {
  executable(profile: LaunchProfile): Promise<string>;
  environmentHash(): string;
  args(profile: LaunchProfile, directory: string): string[];
  prepare(instance: GlobalAIInstance, descriptor: { endpoint: string; token: string }): Promise<void>;
  launch(instance: GlobalAIInstance, save: (change: Partial<GlobalAIInstance>) => void): Promise<void>;
  inspect(instance: GlobalAIInstance): Promise<{ identity: PaneIdentity; sessionId: string; label: string; dead: boolean }>;
  capture(instance: GlobalAIInstance): Promise<string>;
  /** Ends the exact, marked Global AI tmux session after verifying it; refuses anything it cannot verify. A refusal throws
   * GlobalAIError before any effect; any other failure may follow the stop. */
  stop(instance: GlobalAIInstance): Promise<void>;
  descriptor(instance: GlobalAIInstance, descriptor: { endpoint: string; token: string }): Promise<void>;
}
export interface GlobalServices {
  repository: InstanceRepository;
  host: GlobalHost;
  reads: AppReads;
  directory: string;
  profiles(): LaunchProfile[];
  enabled(): boolean;
  /** Existing admission excludes managed writes during launch. It does not impose exclusive native writers. */
  launchGuard<T>(work: () => Promise<T>): Promise<T>;
}
interface HeldPreview { preview: GlobalAIPreview; environment: string; endpoint: string }
interface Grant { instanceId: string; token: string; expires: number; revision: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function uuid(value: unknown): string { const id = text(value, 36); if (!UUID.test(id)) throw new GlobalAIError('INVALID_INPUT', 'Expected a UUID.', 400); return id; }
/** A capability endpoint can only be the host's own loopback port, never an arbitrary fetch destination. */
export function toolEndpoint(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new GlobalAIError('HOST_ADDRESS', 'Helper requires this host\'s loopback HTTP origin.');
  return `${url.origin}/api/v1/global-ai/tools`;
}

/** One optional app instance. Durable launch facts share the host store; read credentials exist only in this boot. */
export class GlobalAIService {
  readonly services: GlobalServices;
  private readonly previews = new Map<string, HeldPreview>();
  private grant: Grant | null = null;
  private grantRevision = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private requests = 0;
  constructor(services: GlobalServices) {
    this.services = services;
    for (const instance of services.repository.all()) if (instance.status === 'launching') {
      this.update(instance, { status: 'uncertain', message: 'Host restarted during launch. Inspect its exact record; no launch or credential was replayed.' });
    }
  }
  private active(): GlobalAIInstance | null { return this.services.repository.all().find(i => i.status !== 'retired') ?? null; }
  /** Enabled profiles whose arguments A1 accepts. Listing is advisory: preview validates the chosen profile again. */
  launchableProfiles(): LaunchProfile[] {
    return this.services.profiles().filter(p => { if (!p.enabled) return false; try { codexProfileArgs(p); return true; } catch { return false; } });
  }
  instance(id: string): GlobalAIInstance | undefined { return this.services.repository.all().find(i => i.id === id); }
  private checkEnabled() { if (!this.services.enabled()) throw new GlobalAIError('GLOBAL_AI_DISABLED', 'Enable host input, native terminals and agent launch before starting Helper.', 403); }
  private update(instance: GlobalAIInstance, change: Partial<GlobalAIInstance>) {
    Object.assign(instance, change, { updatedAt: new Date().toISOString() }); this.services.repository.save(instance);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(work); this.tail = result; return result;
  }
  private publicView(instance: GlobalAIInstance | null, nativeState: GlobalAIView['nativeState'], nativeMessage: string): GlobalAIView {
    const valid = this.grant && this.grant.instanceId === instance?.id && this.grant.expires > Date.now() && this.services.enabled();
    return { instance, toolsEnabled: !!valid, toolsExpireAt: valid ? new Date(this.grant!.expires).toISOString() : null,
      nativeState, nativeMessage, observedModel: null, enabled: this.services.enabled() };
  }
  async view(): Promise<GlobalAIView> {
    const instance = this.active();
    if (!instance) return this.publicView(null, 'unverified', 'No Helper instance has been started.');
    if (instance.status === 'launching') return this.publicView(instance, 'unverified', 'Launch is in flight; its placeholder is not agent readiness.');
    if (!instance.identity) return this.publicView(instance, 'unavailable', 'Launch identity is unresolved. No automatic retry or adoption.');
    const inspectedGrantRevision = this.grantRevision;
    try {
      const native = await this.services.host.inspect(instance);
      if (native.dead && this.grantRevision === inspectedGrantRevision && this.grant?.instanceId === instance.id) this.revoke();
      return this.publicView(instance, native.dead ? 'exited' : 'alive', native.dead ? 'The CLI exited. Its tmux record is retained.' : 'Process observed. Login, model and readiness are not certified; inspect the native terminal.');
    } catch {
      if (this.grantRevision === inspectedGrantRevision && this.grant?.instanceId === instance.id) this.revoke();
      return this.publicView(instance, 'unavailable', 'The recorded terminal changed or cannot be verified. App tools are revoked; nothing is relaunched.');
    }
  }
  async preview(value: unknown, origin: string): Promise<GlobalAIPreview> {
    this.checkEnabled();
    const b = fields(value, ['profileId']);
    const profile = this.services.profiles().find(p => p.id === text(b.profileId) && p.enabled);
    if (!profile) throw new GlobalAIError('PROFILE_UNKNOWN', 'Choose an enabled launch profile.');
    const executable = await this.services.host.executable(profile);
    const id = randomUUID(), directory = join(this.services.directory, id), args = this.services.host.args(profile, directory);
    const environment = this.services.host.environmentHash(), endpoint = toolEndpoint(origin), expiresAt = new Date(Date.now() + 120000).toISOString();
    const core = { id, expiresAt, profile: structuredClone(profile), executable, args, directory, sessionName: `altcli-global-${id}` };
    const preview = { ...core, digest: hash({ ...core, environment, endpoint }) };
    for (const [id, held] of this.previews) if (Date.parse(held.preview.expiresAt) < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 16) throw new GlobalAIError('PREVIEW_LIMIT', 'Too many pending previews. Let older previews expire.');
    this.previews.set(id, { preview, environment, endpoint });
    return preview;
  }
  async start(value: unknown): Promise<GlobalAIView> {
    const b = fields(value, ['id', 'digest', 'requestId', 'confirm']);
    const id = uuid(b.id), requestId = uuid(b.requestId), digest = text(b.digest, 64);
    if (b.confirm !== true) throw new GlobalAIError('CONFIRM_REQUIRED', 'Confirm the profile, native process launch and shared context.', 400);
    return this.serialize(async () => {
      const previous = this.services.repository.all().find(i => i.requestId === requestId);
      if (previous) {
        if (previous.id !== id || previous.requestDigest !== digest) throw new GlobalAIError('ID_CONFLICT', 'The request ID already belongs to another start.');
        return this.publicView(previous, 'unverified', 'Recorded request returned without replaying its launch.');
      }
      this.checkEnabled();
      if (this.active()) throw new GlobalAIError('GLOBAL_AI_EXISTS', 'Open the existing Helper conversation or explicitly retire its app access first.');
      const held = this.previews.get(id);
      if (!held || held.preview.digest !== digest || Date.parse(held.preview.expiresAt) < Date.now()) throw new GlobalAIError('PREVIEW_CHANGED', 'Preview again before starting Helper.');
      const p = held.preview;
      const profile = this.services.profiles().find(s => s.id === p.profile.id);
      if (!profile || hash(profile) !== hash(p.profile) || await this.services.host.executable(profile) !== p.executable || held.environment !== this.services.host.environmentHash())
        throw new GlobalAIError('PROFILE_CHANGED', 'The profile, executable or launch environment changed. Preview again.');
      return this.services.launchGuard(async () => {
        this.checkEnabled();
        if (hash(this.services.profiles().find(s => s.id === p.profile.id)) !== hash(p.profile) || held.environment !== this.services.host.environmentHash())
          throw new GlobalAIError('PROFILE_CHANGED', 'Launch settings changed during admission. Preview again.');
        const at = new Date().toISOString();
        const instance: GlobalAIInstance = { schema: 1, id, requestId, requestDigest: digest, role: 'global_ai', profile: p.profile,
          executable: p.executable, args: p.args, directory: p.directory, sessionName: p.sessionName,
          sessionId: null, windowId: null, identity: null, phase: 'reserved', status: 'launching',
          message: 'Confirmed launch recorded before any process starts.', createdAt: at, updatedAt: at };
        this.services.repository.save(instance); this.previews.delete(id);
        const token = randomBytes(32).toString('hex');
        this.grant = { instanceId: id, token, expires: Date.now() + 8 * 3600000, revision: ++this.grantRevision };
        try {
          await this.services.host.prepare(instance, { endpoint: held.endpoint, token });
          this.checkEnabled();
          await this.services.host.launch(instance, change => this.update(instance, change));
          this.update(instance, { status: 'started', phase: 'observed', message: 'Started a distinct user-operated CLI. Inspect login and /mcp; startup is not proof of readiness.' });
        } catch {
          this.revoke();
          this.update(instance, { status: 'uncertain', message: 'Helper startup did not settle. Inspect the original session. Nothing is retried, deleted or adopted automatically.' });
        }
        return this.publicView(instance, 'unverified', instance.message);
      });
    });
  }
  /** Revocation is always available, even with host input disabled or another writer active. */
  revoke(): void { this.grant = null; this.grantRevision++; }
  async refreshTools(value: unknown, origin: string): Promise<GlobalAIView> {
    const b = fields(value, ['instanceId', 'confirm']);
    if (b.confirm !== true) throw new GlobalAIError('CONFIRM_REQUIRED', 'Confirm renewing read-only app access.', 400);
    const id = uuid(b.instanceId);
    return this.serialize(async () => {
      this.checkEnabled(); const instance = this.active();
      if (!instance || instance.id !== id || instance.status !== 'started') throw new GlobalAIError('INSTANCE_CHANGED', 'This conversation is not an observed Helper instance.');
      const requestedRevision = this.grantRevision;
      const native = await this.services.host.inspect(instance);
      if (requestedRevision !== this.grantRevision) throw new GlobalAIError('APP_ACCESS_REVOKED', 'Revocation canceled the pending renewal.');
      if (native.dead) throw new GlobalAIError('INSTANCE_EXITED', 'The CLI has exited. Do not renew its app access.');
      this.revoke();
      const revision = this.grantRevision;
      const token = randomBytes(32).toString('hex');
      await this.services.host.descriptor(instance, { endpoint: toolEndpoint(origin), token });
      if (revision !== this.grantRevision) throw new GlobalAIError('APP_ACCESS_REVOKED', 'Revocation canceled the pending renewal.');
      this.checkEnabled();
      this.grant = { instanceId: id, token, expires: Date.now() + 8 * 3600000, revision: ++this.grantRevision };
      return this.publicView(instance, 'alive', 'Read-only app access renewed for this boot. No prompt, run or process was restarted.');
    });
  }
  async retire(value: unknown): Promise<GlobalAIView> {
    const b = fields(value, ['instanceId', 'confirm', 'stop']); const id = uuid(b.instanceId);
    if (b.confirm !== true) throw new GlobalAIError('CONFIRM_REQUIRED', 'Confirm that retiring access does not stop the CLI or undo shared context.', 400);
    if (b.stop !== undefined && b.stop !== true) throw new GlobalAIError('INVALID_INPUT', 'Send stop: true to also stop the CLI, or omit it.', 400);
    return this.serialize(async () => {
      const instance = this.instance(id);
      if (!instance) throw new GlobalAIError('INSTANCE_CHANGED', 'The instance record is unavailable.');
      if (this.grant?.instanceId === id) this.revoke();
      // Restart stops only Global AI's own verified session; an unverified one keeps running and stays unretired for inspection.
      if (b.stop === true && instance.status !== 'retired') {
        this.checkEnabled();
        try { if (!instance.identity) throw new Error('unobserved'); await this.services.host.stop(instance); }
        catch (error) {
          // A refusal stopped nothing, so its reason (such as extra panes or windows) is certain and worth showing.
          if (error instanceof GlobalAIError) throw new GlobalAIError('GLOBAL_IDENTITY', `${error.message} Nothing was stopped or retired; app tools are revoked.`);
          throw new GlobalAIError('GLOBAL_IDENTITY', 'Stopping Helper could not be verified. It was not retired and app tools are revoked; inspect its original session before trying again.');
        }
        this.update(instance, { status: 'retired', message: 'Stopped and retired by the owner. Codex keeps its own session history.' });
      }
      if (instance.status !== 'retired') this.update(instance, { status: 'retired', message: 'App access retired by the owner. CLI/session and provider conversation are not deleted or stopped.' });
      return this.view();
    });
  }
  authenticate(token: string): { instance: GlobalAIInstance; revision: number } {
    const grant = this.grant, instance = this.active();
    if (!grant || !instance || grant.instanceId !== instance.id || grant.expires <= Date.now() || !this.services.enabled() ||
      !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(grant.token)))
      throw new GlobalAIError('APP_ACCESS_REVOKED', 'Helper app access is absent, expired or revoked. Ask the owner to refresh app access.', 401);
    return { instance, revision: grant.revision };
  }
  async tools(token: string, value: unknown): Promise<unknown> {
    const caller = this.authenticate(token), b = fields(value, ['method', 'name', 'arguments']);
    if (this.requests >= 4) throw new GlobalAIError('TOOLS_BUSY', 'Too many app-tool reads. Try after outstanding reads settle.', 429);
    this.requests++;
    try {
      let result: unknown;
      if (b.method === 'list' && b.name === undefined && b.arguments === undefined) result = { tools: APP_TOOLS };
      else if (b.method === 'call') result = await this.services.reads.call(text(b.name), b.arguments ?? {});
      else throw new GlobalAIError('TOOL_METHOD', 'Only tool listing and read calls are supported.', 400);
      // Revocation, restart or retirement during an await must win over the pending read.
      if (this.authenticate(token).revision !== caller.revision) throw new GlobalAIError('APP_ACCESS_REVOKED', 'App access changed while the read was pending.', 401);
      return result;
    } finally { this.requests--; }
  }
  async ownerRead(value: unknown): Promise<ToolReply> {
    const b = fields(value, ['name', 'arguments']);
    return this.services.reads.call(text(b.name), b.arguments ?? {});
  }
}
