import { createHash } from 'node:crypto';
import type { AppTool, ToolReply } from '../../contracts/global-ai.ts';
import type { RelayRun, WorkflowState, WorkspaceDiscovery } from '../../contracts/workflow.ts';

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
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 200 };
const tool = (name: string, description: string, inputSchema: Record<string, unknown>): AppTool => ({ name, description, inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
export const APP_TOOLS: AppTool[] = [
  tool('get_capabilities', 'Read supported AltCLI tools, documentation IDs and runtime feature flags. No actions are authorized.', schema({})),
  tool('list_workspaces', 'List the workspaces AltCLI observes on this host, with branch and agent metadata.', schema({})),
  tool('list_runs', 'Read recent and active runs across this host\'s projects. A missing history row is not proof of completion.', schema({})),
  tool('get_run', 'Read exact recorded blockers, current activity, checkpoint, plan and publication. Explain uncertainty; navigation hints are NOT approval.', schema({ runId: string }, ['runId'])),
  tool('get_recent_events', 'Read bounded command/turn status for a specific run; no terminal transcript or raw prompt.', schema({ runId: string }, ['runId'])),
  tool('search_docs', 'Search the operating documents built into this AltCLI version. Results include document hashes and line references.', schema({ query: string }, ['query'])),
  tool('read_doc', 'Read a bounded range from a built-in document ID, not an arbitrary filesystem path.', schema({
    document: string, startLine: { type: 'integer', minimum: 1, maximum: 100000 }, maxLines: { type: 'integer', minimum: 1, maximum: 120 },
  }, ['document'])),
];
/** Operating documents packed at build time by scripts/build-kb.mjs; nothing is read from a checkout at runtime. */
export interface KnowledgeBase { documents: { name: string; description: string; content: string }[] }
export interface ReadServices {
  state(): Promise<WorkflowState>;
  workspaces(): Promise<WorkspaceDiscovery>;
  run(id: string): RelayRun | undefined;
  featureFlags(): Record<string, boolean>;
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
  async call(name: string, value: unknown): Promise<ToolReply> {
    const definitions = APP_TOOLS.find(t => t.name === name);
    if (!definitions) throw new GlobalAIError('TOOL_UNKNOWN', 'Only the listed read-only tools are supported.', 404);
    const args = fields(value, Object.keys(definitions.inputSchema.properties as object));
    let data: unknown;
    if (name === 'get_capabilities') {
      data = { product: 'AltCLI', contract: 'global-ai-read-v1', flags: this.services.featureFlags(), tools: APP_TOOLS.map(t => t.name),
        documents: Object.fromEntries(this.services.kb.documents.map(d => [d.name, d.description])), effects: false, backgroundAssistant: false, model: 'unknown',
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
    } else {
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
          const plan = run.planning;
          data = { runId: run.id, workspace: run.repository, updatedAt: run.updatedAt, status: run.status,
            reason: run.reason, currentCommandId: run.currentCommandId, executionStatus: execution?.status ?? 'unknown',
            phase: run.implementation ? 'implementation' : plan ? 'plan' : run.stage ? 'stage-relay' : 'instruction',
            autoContinue: run.autoContinue, automaticTurns: run.automaticTurns, turnLimit: run.turnLimit,
            blockedHandoff: run.blockedHandoff ?? null,
            participants: run.participants.map(p => ({ id: p.id, label: p.label, instance: state.instances.find(i => i.agentId === p.id)?.status ?? 'unknown',
              activity: state.activities?.find(a => a.agentId === p.id) ?? { state: 'unknown' } })),
            manualInput: { heldAcrossServer: !!state.manualSessions?.some(m => m.live || m.reconciliationRequired),
              affectedRun: !!state.manualSessions?.some(m => m.runs.some(r => r.id === run.id)) },
            checkpoint: checkpoint ? { kind: checkpoint.kind, revision: checkpoint.revision, commandId: checkpoint.commandId, fault: checkpoint.fault ?? null } : null,
            plan: plan ? { step: plan.step, revision: plan.current?.revision ?? null, hash: plan.current?.hash ?? null,
              text: plan.current?.text.slice(0, 24000) ?? null, textTruncated: (plan.current?.text.length ?? 0) > 24000,
              requireApproval: plan.request.requireApproval, endorsements: plan.endorsements, objections: plan.objections } : null,
            publication: run.implementation?.latestPublication ?? null,
            navigation: { surface: 'Console', workspace: run.repository, runId: run.id,
              instruction: 'Open this workspace in Console and inspect Control access or the Plan checkpoint. Navigation is not continuation, readiness, or approval.' },
            uncertainty: 'Readiness, quiescence and permitted next actions must be revalidated by the existing UI. A model recommendation cannot clear a hold.' };
        }
      }
    }
    const reply = { source: `altcli:${name}`, observedAt: new Date().toISOString(), revision: hash(data), data };
    if (Buffer.byteLength(JSON.stringify(reply)) > 128 * 1024) throw new GlobalAIError('RESULT_TOO_LARGE', 'The read exceeds its bound. Narrow the requested context.', 413);
    return reply;
  }
}
