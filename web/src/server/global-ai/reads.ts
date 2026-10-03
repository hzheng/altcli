import { manualCovers } from '../../core/input-scope.ts';
import { createHash } from 'node:crypto';
import type { AttentionItem } from '../../contracts/attention.ts';
import type { AppTool, ToolReply } from '../../contracts/global-ai.ts';
import type { RelayRun, WorkflowState, WorkspaceDiscovery } from '../../contracts/workflow.ts';
import { violation, type Schema } from './schema.ts';

export class GlobalAIError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message); this.code = code; this.status = status;
  }
}
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new GlobalAIError('INVALID_INPUT', 'Unexpected or missing input object.', 400);
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new GlobalAIError('INVALID_INPUT', 'Expected bounded, nonempty text without control characters.', 400);
  return value;
}
const integer = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new GlobalAIError('INVALID_INPUT', `Expected an integer from 1 to ${max}.`, 400);
  return value as number;
};
/** Who is reading, established by the transport and never by model input: Helper's owner-approved host-wide reads, or one
 * Background attempt limited to its admitted attention item and that item's run or launch. */
export type ReadPrincipal = { kind: 'helper' } | { kind: 'job'; scope: { itemId: string; runId?: string; launchId?: string } };
export const HELPER: ReadPrincipal = { kind: 'helper' };

const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 200 };
// Output schemas describe the exact reply each tool returns; every reply is checked against its schema before it leaves the host.
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema =>
  ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const str: Schema = { type: 'string' }, maybe: Schema = { type: ['string', 'null'] }, int: Schema = { type: 'integer' }, bool: Schema = { type: 'boolean' };
const record: Schema = { type: 'object' }, maybeRecord: Schema = { type: ['object', 'null'] };
const list = (items: Schema, maxItems?: number): Schema => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) });
const PHASES = ['implementation', 'plan', 'stage-relay', 'instruction'];
const ITEM = object({ id: str, key: str, kind: { enum: ['run', 'plan', 'launch'] }, facets: list(str), subject: record, title: str, detail: str,
  destination: record, revision: int, sourceVersion: int, status: { enum: ['open', 'resolved'] }, openedAt: str, updatedAt: str, resolvedAt: maybe,
  resolution: maybe, seenRevision: { type: ['integer', 'null'] }, stale: bool });
const DATA: Record<string, Schema> = {
  get_capabilities: object({ product: { const: 'AltCLI' }, contract: str, flags: { type: 'object', additionalProperties: bool }, tools: list(str),
    documents: { type: 'object', additionalProperties: str }, effects: { const: false }, model: { const: 'unknown' }, authority: str,
    backgroundAssistant: object({ attention: bool, runtime: { enum: ['unavailable'] }, enabled: { const: false } }) }),
  list_workspaces: object({ discoveredAt: str, error: maybe, workspaces: list(object({ root: str, directory: str, branch: maybe, gitError: maybe,
    agents: list(object({ id: maybe, label: str, kind: str, reason: maybe })) }), 32) }),
  list_runs: object({ runs: list(object({ id: str, workspace: str, status: str, reason: str, phase: { enum: PHASES }, updatedAt: str }), 40), truncated: bool }),
  get_run: object({ runId: str, workspace: str, updatedAt: str, status: str, reason: str, currentCommandId: str, executionStatus: str, phase: { enum: PHASES },
    autoContinue: bool, automaticTurns: int, turnLimit: int, blockedHandoff: maybeRecord,
    participants: list(object({ id: str, label: str, instance: str, activity: record })),
    manualInput: object({ heldAcrossServer: bool, heldForWorktree: bool, affectedRun: bool }), checkpoint: maybeRecord, plan: maybeRecord, publication: maybeRecord,
    navigation: object({ surface: { const: 'Console' }, workspace: str, runId: str, instruction: str }), uncertainty: str, omitted: list(str) }, ['omitted']),
  get_recent_events: object({ runId: str, runUpdatedAt: str, commands: list(object({ id: str, agentId: str, createdAt: str }), 30),
    executions: list(object({ commandId: str, agentId: str, status: str, backgroundState: str }), 30), note: str }),
  search_docs: object({ results: list(object({ document: str, documentHash: str, line: int, text: str }), 24), limit: int }),
  read_doc: object({ document: str, documentHash: str, startLine: int, totalLines: int, lines: list(object({ line: int, text: str, truncated: bool }), 120),
    nextLine: { type: ['integer', 'null'] } }),
  list_attention: object({ open: int, items: list(ITEM, 40), truncated: bool }),
  get_attention_item: object({ item: ITEM }),
  get_launch: object({ launch: object({ id: str, kind: { enum: ['workspace', 'helper'] }, status: str, phase: str, message: str, sessionName: str, profileLabel: str,
    repository: maybe, branch: maybe, updatedAt: maybe, cleanup: maybe, closed: bool, identityRecorded: bool }) }),
};
const tool = (name: string, description: string, inputSchema: Record<string, unknown>): AppTool => ({ name, description, inputSchema,
  outputSchema: object({ source: str, observedAt: str, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, data: DATA[name]! }) as Record<string, unknown>,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
export const APP_TOOLS: AppTool[] = [
  tool('get_capabilities', 'Read supported AltCLI tools, documentation IDs and runtime feature flags. No actions are authorized.', input({})),
  tool('list_workspaces', 'List the workspaces AltCLI observes on this host, with branch and agent metadata.', input({})),
  tool('list_runs', 'Read recent and active runs across this host\'s projects. A missing history row is not proof of completion.', input({})),
  tool('get_run', 'Read exact recorded blockers, current activity, checkpoint, plan and publication. Explain uncertainty; navigation hints are NOT approval.', input({ runId: string }, ['runId'])),
  tool('get_recent_events', 'Read bounded command/turn status for a specific run; no terminal transcript or raw prompt.', input({ runId: string }, ['runId'])),
  tool('search_docs', 'Search the operating documents built into this AltCLI version. Results include document hashes and line references.', input({ query: string }, ['query'])),
  tool('read_doc', 'Read a bounded range from a built-in document ID, not an arbitrary filesystem path.', input({
    document: string, startLine: { type: 'integer', minimum: 1, maximum: 100000 }, maxLines: { type: 'integer', minimum: 1, maximum: 120 },
  }, ['document'])),
  tool('list_attention', 'Read the current attention items for every project on this host: deterministic records of runs, plans and launches that need the owner. Evidence, not approval.', input({})),
  tool('get_attention_item', 'Read one attention item: its current revision, typed facets and the existing surface that handles it. Opening that surface is not approval.', input({ itemId: string }, ['itemId'])),
  tool('get_launch', 'Read one recorded workspace launch or Helper start: status, phase and message. Inspection and reconciliation remain explicit owner actions.', input({ launchId: string }, ['launchId'])),
];
/** Host-wide enumeration is Helper's; a Background job reads only its admitted issue and the installed documents. */
const HELPER_ONLY = new Set(['list_workspaces', 'list_runs', 'list_attention']);
export const toolsFor = (principal: ReadPrincipal): AppTool[] => principal.kind === 'helper' ? APP_TOOLS : APP_TOOLS.filter(t => !HELPER_ONLY.has(t.name));
/** Operating documents packed at build time by scripts/build-kb.mjs; nothing is read from a checkout at runtime. */
export interface KnowledgeBase { documents: { name: string; description: string; content: string }[] }
/** The recorded facts get_launch returns for a workspace launch or a Helper start. */
export interface LaunchFacts {
  id: string; kind: 'workspace' | 'helper'; status: string; phase: string; message: string; sessionName: string; profileLabel: string;
  repository: string | null; branch: string | null; updatedAt: string | null; cleanup: string | null; closed: boolean; identityRecorded: boolean;
}
export interface ReadServices {
  state(): Promise<WorkflowState>;
  workspaces(): Promise<WorkspaceDiscovery>;
  run(id: string): RelayRun | undefined;
  featureFlags(): Record<string, boolean>;
  attention: { item(id: string): AttentionItem | undefined; open(limit: number): { items: AttentionItem[]; total: number } };
  launch(id: string): LaunchFacts | undefined;
  kb: KnowledgeBase;
}
/** Bounded projection of the same host's read model. No SQLite connection, command execution or mutation tools. */
export class AppReads {
  readonly services: ReadServices;
  constructor(services: ReadServices) { this.services = services; }
  private document(name: string): { name: string; content: string; hash: string } {
    const doc = this.services.kb.documents.find(d => d.name === name);
    if (!doc) throw new GlobalAIError('DOCUMENT_UNKNOWN', 'Choose a document from get_capabilities.', 404);
    return { name, content: doc.content, hash: hash(doc.content) };
  }
  private known(run: RelayRun | undefined): RelayRun {
    if (!run) throw new GlobalAIError('RUN_UNKNOWN', 'No recorded run has this ID. Use list_runs.', 404);
    return run;
  }
  /** A job may name only the subject it was admitted for; any other ID is refused before it is looked up. */
  private within(principal: ReadPrincipal, kind: 'itemId' | 'runId' | 'launchId', id: string): void {
    if (principal.kind === 'job' && principal.scope[kind] !== id)
      throw new GlobalAIError('OUT_OF_SCOPE', 'A Background job reads only its admitted attention item and that item\'s run or launch.', 403);
  }
  async call(name: string, value: unknown, principal: ReadPrincipal = HELPER): Promise<ToolReply> {
    const definitions = APP_TOOLS.find(t => t.name === name);
    if (!definitions) throw new GlobalAIError('TOOL_UNKNOWN', 'Only the listed read-only tools are supported.', 404);
    if (!toolsFor(principal).includes(definitions)) throw new GlobalAIError('OUT_OF_SCOPE', 'Host-wide listings are not available to a Background job.', 403);
    const args = fields(value, Object.keys(definitions.inputSchema.properties as object));
    let data: unknown;
    if (name === 'get_capabilities') {
      data = { product: 'AltCLI', contract: 'global-ai-read-v2', flags: this.services.featureFlags(), tools: toolsFor(principal).map(t => t.name),
        documents: Object.fromEntries(this.services.kb.documents.map(d => [d.name, d.description])), effects: false, model: 'unknown',
        // Deterministic attention exists; no Background runtime, adapter or enablement does in this version.
        backgroundAssistant: { attention: true, runtime: 'unavailable', enabled: false },
        authority: 'Read-only AltCLI tools. Native CLI permissions and provider billing remain separate.' };
    } else if (name === 'read_doc') {
      const doc = this.document(text(args.document));
      const start = integer(args.startLine, 1, 100000), count = integer(args.maxLines, 80, 120);
      const lines = doc.content.split('\n');
      const selected = lines.slice(start - 1, start - 1 + count);
      data = { document: doc.name, documentHash: doc.hash, startLine: start, totalLines: lines.length,
        lines: selected.map((line, i) => ({ line: start + i, text: line.slice(0, 2000), truncated: line.length > 2000 })),
        nextLine: start - 1 + selected.length < lines.length ? start + selected.length : null };
    } else if (name === 'search_docs') {
      const query = text(args.query).toLocaleLowerCase(), results: unknown[] = [];
      for (const { name } of this.services.kb.documents) {
        const doc = this.document(name);
        doc.content.split('\n').forEach((line, index) => {
          if (results.length < 24 && line.toLocaleLowerCase().includes(query)) results.push({ document: name, documentHash: doc.hash, line: index + 1, text: line.slice(0, 1200) });
        });
      }
      data = { results, limit: 24 };
    } else if (name === 'list_workspaces') {
      const discovery = await this.services.workspaces();
      data = { discoveredAt: discovery.discoveredAt, error: discovery.error,
        workspaces: discovery.workspaces.slice(0, 32).map(w => ({
          root: w.worktree.root, directory: w.cwd, branch: w.branch, gitError: w.gitError ?? null,
          agents: w.agents.filter(a => a.observable || a.eligible).map(a => ({ id: a.session?.id ?? a.registeredAs, label: a.label, kind: a.kind, reason: a.reason })),
        })) };
    } else if (name === 'list_attention') {
      const open = this.services.attention.open(40);
      data = { open: open.total, items: open.items, truncated: open.total > open.items.length };
    } else if (name === 'get_attention_item') {
      const id = text(args.itemId); this.within(principal, 'itemId', id);
      const item = this.services.attention.item(id);
      if (!item) throw new GlobalAIError('ATTENTION_UNKNOWN', 'No attention item has this ID.', 404);
      data = { item };
    } else if (name === 'get_launch') {
      const id = text(args.launchId); this.within(principal, 'launchId', id);
      const launch = this.services.launch(id);
      if (!launch) throw new GlobalAIError('LAUNCH_UNKNOWN', 'No recorded launch or Helper start has this ID.', 404);
      data = { launch };
    } else {
      if (name !== 'list_runs') this.within(principal, 'runId', text(args.runId));
      const state = await this.services.state();
      if (name === 'list_runs') {
        const runs = state.runs;
        data = { runs: runs.slice(0, 40).map(r => ({ id: r.id, workspace: r.repository, status: r.status, reason: r.reason,
          phase: r.implementation ? 'implementation' : r.planning ? 'plan' : r.stage ? 'stage-relay' : 'instruction', updatedAt: r.updatedAt })),
          truncated: runs.length > 40 };
      } else {
        const run = this.known(this.services.run(text(args.runId)));
        const execution = state.executions.find(e => e.commandId === run.currentCommandId);
        if (name === 'get_recent_events') {
          data = { runId: run.id, runUpdatedAt: run.updatedAt,
            commands: state.commands.filter(c => c.runId === run.id).slice(0, 30).map(c => ({ id: c.id, agentId: c.agentId, createdAt: c.createdAt })),
            executions: state.executions.filter(e => e.runId === run.id).slice(0, 30).map(e => ({ commandId: e.commandId, agentId: e.agentId, status: e.status,
              backgroundState: e.completion?.backgroundState ?? 'unknown' })),
            note: 'Bounded host read model, not a complete event history or transcript.' };
        } else {
          const checkpoint = state.checkpoints?.find(c => c.runId === run.id);
          const plan = run.planning, job = principal.kind === 'job', published = run.implementation?.latestPublication ?? null;
          data = { runId: run.id, workspace: run.repository, updatedAt: run.updatedAt, status: run.status,
            reason: run.reason, currentCommandId: run.currentCommandId, executionStatus: execution?.status ?? 'unknown',
            phase: run.implementation ? 'implementation' : plan ? 'plan' : run.stage ? 'stage-relay' : 'instruction',
            autoContinue: run.autoContinue, automaticTurns: run.automaticTurns, turnLimit: run.turnLimit,
            blockedHandoff: run.blockedHandoff ?? null,
            participants: run.participants.map(p => ({ id: p.id, label: p.label, instance: state.instances.find(i => i.agentId === p.id)?.status ?? 'unknown',
              activity: state.activities?.find(a => a.agentId === p.id) ?? { state: 'unknown' } })),
            manualInput: { heldAcrossServer: !!state.manualSessions?.some(m => !m.scope && (m.live || m.reconciliationRequired)),
              heldForWorktree: !!state.manualSessions?.some(m => (m.live || m.reconciliationRequired) && manualCovers(m, [run.lockKey])),
              affectedRun: !!state.manualSessions?.some(m => m.runs.some(r => r.id === run.id)) },
            checkpoint: checkpoint ? { kind: checkpoint.kind, revision: checkpoint.revision, commandId: checkpoint.commandId, fault: checkpoint.fault ?? null } : null,
            // A job sees the blocker metadata it needs, not the full plan text or publication body.
            plan: plan ? { step: plan.step, revision: plan.current?.revision ?? null, hash: plan.current?.hash ?? null,
              text: job ? null : plan.current?.text.slice(0, 24000) ?? null, textTruncated: !job && (plan.current?.text.length ?? 0) > 24000,
              requireApproval: plan.request.requireApproval, endorsements: plan.endorsements, objections: job ? Object.keys(plan.objections) : plan.objections } : null,
            publication: job ? published && { sha: published.sha, projectChanged: published.projectChanged, decision: published.entry.decision, needsHuman: published.entry.needsHuman } : published,
            navigation: { surface: 'Console', workspace: run.repository, runId: run.id,
              instruction: 'Open this workspace in Console and inspect Control access or the Plan checkpoint. Navigation is not continuation, readiness, or approval.' },
            uncertainty: 'Readiness, quiescence and permitted next actions must be revalidated by the existing UI. A model recommendation cannot clear a hold.',
            ...(job ? { omitted: ['plan text', 'objection text', 'publication summary and checks'] } : {}) };
        }
      }
    }
    // The checked reply is the exact JSON that leaves the host.
    const reply = JSON.parse(JSON.stringify({ source: `altcli:${name}`, observedAt: new Date().toISOString(), revision: hash(data), data })) as ToolReply;
    if (Buffer.byteLength(JSON.stringify(reply)) > 128 * 1024) throw new GlobalAIError('RESULT_TOO_LARGE', 'The read exceeds its bound. Narrow the requested context.', 413);
    const problem = violation(definitions.outputSchema as Schema, reply);
    if (problem) throw new GlobalAIError('TOOL_CONTRACT', `The read did not match its declared output schema (${problem}). Nothing was returned; report this host defect.`, 500);
    return reply;
  }
}
