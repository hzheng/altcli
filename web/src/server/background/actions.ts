import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BackgroundAttempt, BackgroundSettings } from '../../contracts/background.ts';
import type { BackgroundAction, BackgroundActionView, BackgroundAuthorization, BackgroundLogEntry, BackgroundOperation, BackgroundPermissions } from '../../contracts/background-actions.ts';
import type { AppTool } from '../../contracts/global-ai.ts';
import type { AttentionItem } from '../../contracts/attention.ts';
import { fields, GlobalAIError, hash, text } from '../global-ai/reads.ts';

const MODES = ['ask', 'allow'];
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const ALLOWED_ROOTS = new Set(['activities', 'attention', 'checkpoints', 'commands', 'config', 'control', 'directories', 'groups', 'history', 'implementation', 'instructions', 'interactions', 'launch-profiles', 'launches', 'pairs', 'panes', 'planning', 'projects', 'runs', 'sessions', 'state', 'terminals', 'workspaces', 'global-ai']);
/** Intentionally does not infer safe shell commands: every command requires the host-command permission. */
export function operation(value: unknown): BackgroundOperation {
  const b = fields(value, ['kind', 'method', 'path', 'body', 'directory', 'executable', 'args', 'stdin']);
  if (b.kind === 'app') {
    fields(value, ['kind', 'method', 'path', 'body']);
    const path = text(b.path, 500);
    const url = new URL(path, 'http://127.0.0.1');
    // No alternate hosts, escapes, query credentials, hook forgery, private tools or self-managed permissions.
    if (url.origin !== 'http://127.0.0.1' || url.pathname + url.search !== path || !/^\/api\/v1\/[a-zA-Z0-9_/-]+$/.test(url.pathname)
      || url.pathname.includes('//') || !ALLOWED_ROOTS.has(url.pathname.split('/')[3]!)
      || /\/(?:tools|runner)(?:\/|$)/.test(url.pathname) || !['GET', 'POST', 'PATCH', 'DELETE'].includes(String(b.method)))
      throw new GlobalAIError('ACTION_PATH', 'Choose an owner app route. Hooks, credentials and Background’s own settings are not action targets.', 400);
    if (b.body !== undefined && (!b.body || typeof b.body !== 'object' || Array.isArray(b.body))) throw new GlobalAIError('ACTION_BODY', 'The app body must be a JSON object.', 400);
    if (b.method === 'GET' && b.body !== undefined) throw new GlobalAIError('ACTION_BODY', 'GET has no body.', 400);
    return { kind: 'app', method: b.method as 'GET' | 'POST' | 'PATCH' | 'DELETE', path, ...(b.body === undefined ? {} : { body: b.body as Record<string, unknown> }) };
  }
  fields(value, ['kind', 'directory', 'executable', 'args', 'stdin']);
  if (b.kind !== 'command' || !Array.isArray(b.args) || b.args.length > 100 || b.args.some(a => typeof a !== 'string' || a.includes('\0')))
    throw new GlobalAIError('ACTION_COMMAND', 'Use an executable and argument array, with an absolute working directory.', 400);
  const directory = text(b.directory, 4096), executable = text(b.executable, 4096);
  if (!directory.startsWith('/') || directory.includes('\0') || executable.includes('\0')) throw new GlobalAIError('ACTION_COMMAND', 'Invalid command location.', 400);
  if (b.stdin !== undefined && (typeof b.stdin !== 'string' || b.stdin.includes('\0'))) throw new GlobalAIError('ACTION_COMMAND', 'stdin must be text.', 400);
  return { kind: 'command', directory, executable, args: b.args as string[], ...(b.stdin === undefined ? {} : { stdin: b.stdin as string }) };
}
export function riskDecision(op: BackgroundOperation): boolean {
  if (op.kind !== 'app' || op.method === 'GET') return false;
  return /\/(?:decision|reconcile|reset|clear-context|release|cleanup|discard|finish)(?:\/|$)/.test(op.path)
    || /"(?:confirm|proceed|acknowledge|override)[A-Za-z]*"\s*:/.test(JSON.stringify(op.body))
    || ['takeover', 'approve', 'continue'].includes(String(op.body?.action));
}
// Exact input is needed for consent. Refuse credential literals instead of silently changing a command before executing it.
export function redactActionText(value: string, ownerToken = ''): string {
  let result = ownerToken ? value.split(ownerToken).join('<REDACTED_OWNER_TOKEN>') : value;
  result = result.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '<REDACTED_PRIVATE_KEY>')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|AKIA[0-9A-Z]{16})\b/g, '<REDACTED_CREDENTIAL>')
    .replace(/Bearer\s+[A-Za-z0-9._~-]{16,}/gi, 'Bearer <REDACTED_TOKEN>')
    .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/g, '$1<REDACTED_CREDENTIAL>@');
  return result;
}
export function cleanActionValue(value: unknown, token = ''): unknown {
  if (typeof value === 'string') return redactActionText(value, token);
  if (Array.isArray(value)) return value.map(v => cleanActionValue(v, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(?:token|accessToken|refreshToken|password|secret|authorization|cookie|privateKey)$/i.test(k) ? '<REDACTED>' : cleanActionValue(v, token)]));
  return value;
}
export interface ActionResult { status: 'accepted' | 'completed' | 'failed' | 'uncertain'; message: string; result: unknown }
export interface ActionGrant {
  token: string;
  /** Atomically revokes future consumption. Repeated settlement returns the same evidence. */
  settle(): 'unused' | 'consumed' | 'unknown';
}
export interface ActionServices {
  db: Database.Database; settings(): BackgroundSettings; item(id: string): AttentionItem | undefined; enabled(): boolean;
  /** Starts no process or request before `admitted()` returns. */
  execute(action: BackgroundAction, signal: AbortSignal, started: (pid: number) => void, admitted: () => void, grant: () => ActionGrant): Promise<ActionResult>;
  settled(action: BackgroundAction): void; ownerToken?: string; now?: () => number;
}
const out = { type: 'object', properties: { source: { type: 'string' }, revision: { type: 'string' }, observedAt: { type: 'string' }, data: { type: 'object' } }, required: ['source', 'revision', 'observedAt', 'data'], additionalProperties: false };
const input = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const ACTION_TOOLS: AppTool[] = [
  { name: 'get_action_permissions', description: 'Read Background action permissions, limits and request formats. The model cannot change permissions. App contracts are in shared/openapi.yaml via read_doc/search_docs.', inputSchema: input({}), outputSchema: out,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'get_actions', description: 'Read recent actions for this issue, or one actionId for its bounded result. Pending is not approval. Accepted is an app request receipt, not task completion; inspect the original operation. Uncertain actions must not be repeated.', inputSchema: input({ actionId: { type: 'string' } }), outputSchema: out,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'request_action', description: 'Propose one exact app request or host command (including file edits). Returns a durable action ID immediately. Ask-first actions wait in Background → Log; saved permissions may start them. Never assume completion; read get_actions. Do not repeat uncertain effects or use commands to evade app checks.',
    inputSchema: input({ requestKey: { type: 'string', minLength: 1, maxLength: 100 }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, operation: { oneOf: [
      input({ kind: { const: 'app' }, method: { enum: ['GET', 'POST', 'PATCH', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object' } }, ['kind', 'method', 'path']),
      input({ kind: { const: 'command' }, directory: { type: 'string' }, executable: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } }, ['kind', 'directory', 'executable', 'args']),
    ] } }, ['requestKey', 'reason', 'operation']), outputSchema: out,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
];

/** The only Background effect admission point. Claims and audit events commit before a process or app request can start. */
export class BackgroundActions {
  readonly services: ActionServices;
  private now: () => number;
  private running = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private grants = new Map<string, { id: string; consumed: boolean }>();
  private closing = false;
  constructor(services: ActionServices) {
    this.services = services; this.now = services.now ?? Date.now;
    for (const row of this.rows("status='running'")) this.transition(row, 'uncertain', 'Host restarted before the action settled. Inspect its effects; nothing was replayed.', 'host');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private rows(where = '1', args: (string | number)[] = [], limit = 100): BackgroundAction[] {
    return (this.services.db.prepare(`SELECT value FROM background_actions WHERE ${where} ORDER BY rowid DESC LIMIT ?`).all(...args, limit) as { value: string }[]).map(r => JSON.parse(r.value));
  }
  private get(id: string) { const row = this.services.db.prepare('SELECT value FROM background_actions WHERE id=?').get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) as BackgroundAction : null; }
  private modelView(action: BackgroundAction, limit = 8192) {
    const result = JSON.stringify(action.result);
    return { id: action.id, status: action.status, reason: action.reason, message: action.message, authorization: action.authorization,
      result: result.length <= limit ? action.result : { excerpt: result.slice(0, limit), truncated: true }, expiresAt: action.expiresAt };
  }
  private save(action: BackgroundAction) { this.services.db.prepare('INSERT INTO background_actions(id,attempt_id,item_id,status,digest,value) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value')
    .run(action.id, action.attemptId, action.itemId, action.status, action.digest, JSON.stringify(action)); }
  log(actor: BackgroundLogEntry['actor'], kind: string, message: string, detail: unknown = null, actionId: string | null = null, attemptId: string | null = null) {
    this.services.db.prepare('INSERT INTO background_log(at,actor,kind,action_id,attempt_id,message,detail) VALUES(?,?,?,?,?,?,?)')
      .run(this.at(), actor, kind, actionId, attemptId, redactActionText(message, this.services.ownerToken), JSON.stringify(cleanActionValue(detail, this.services.ownerToken)));
  }
  private transition(action: BackgroundAction, status: BackgroundAction['status'], message: string, actor: BackgroundLogEntry['actor'], result: unknown = action.result) {
    const next = { ...action, status, message, result: cleanActionValue(result, this.services.ownerToken), updatedAt: this.at() };
    this.services.db.transaction(() => { this.save(next); this.log(actor, status, message, { authorization: next.authorization, result: next.result }, next.id, next.attemptId); }).immediate();
    return next;
  }
  permissions(): BackgroundPermissions {
    const row = this.services.db.prepare('SELECT value FROM background_permissions WHERE id=1').get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { revision: 0, app: 'ask', command: 'ask', risk: 'ask' };
  }
  savePermissions(value: unknown) {
    const b = fields(value, ['expectedRevision', 'app', 'command', 'risk', 'confirm']);
    if (b.confirm !== true || !MODES.includes(String(b.app)) || !MODES.includes(String(b.command)) || !MODES.includes(String(b.risk))) throw new GlobalAIError('CONFIRM_REQUIRED', 'Confirm these Background permissions.', 400);
    const current = this.permissions();
    if (b.expectedRevision !== current.revision) throw new GlobalAIError('POLICY_CHANGED', 'Permissions changed in another client. Review the current settings.');
    const next = { revision: current.revision + 1, app: b.app, command: b.command, risk: b.risk } as BackgroundPermissions;
    this.services.db.transaction(() => { this.services.db.prepare('INSERT INTO background_permissions(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(next));
      this.log('owner', 'permissions', 'Saved Background action permissions. Existing proposals were not approved.', { previous: current, current: next }); }).immediate();
    return next;
  }
  view(before?: number): BackgroundActionView {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new GlobalAIError('LOG_CURSOR', 'Invalid log cursor.', 400);
    const rows = this.services.db.prepare('SELECT * FROM background_log WHERE id<? ORDER BY id DESC LIMIT 51').all(before ?? Number.MAX_SAFE_INTEGER) as { id: number; at: string; actor: BackgroundLogEntry['actor']; kind: string; action_id: string | null; attempt_id: string | null; message: string; detail: string }[];
    return { permissions: this.permissions(), actions: [...this.rows("status IN ('running','uncertain')"), ...this.rows("status='pending'")],
      entries: rows.slice(0, 50).map(r => ({ id: r.id, at: r.at, actor: r.actor, kind: r.kind, actionId: r.action_id, attemptId: r.attempt_id, message: r.message, detail: JSON.parse(r.detail) })),
      next: rows.length > 50 ? rows[49]!.id : null };
  }
  private assertCurrent(action: BackgroundAction, admission = true) {
    const s = this.services.settings(), item = this.services.item(action.itemId);
    if (this.closing || !this.services.enabled() || !s.enabled || admission && (s.paused || s.needsInspection) || s.revision !== action.enablement || s.instance?.id !== action.instanceId
      || !item || item.status !== 'open' || item.stale || item.revision !== action.itemRevision || item.sourceVersion !== action.sourceVersion
      || this.now() >= Date.parse(action.expiresAt) || this.permissions().revision !== action.policyRevision)
      throw new GlobalAIError('ACTION_STALE', 'The issue, instance, permissions or expiry changed. Request a fresh action.');
  }
  unsettled() { return this.rows("status IN ('running','uncertain')", [], 1).length > 0; }
  tick() {
    if (this.closing) return;
    for (const action of this.rows("status='pending'")) {
      try { this.assertCurrent(action, false); }
      catch { this.transition(action, 'stale', 'The proposal no longer matches the current issue, permissions or expiry.', 'host'); continue; }
      const policy = this.permissions(), s = this.services.settings();
      if (!this.unsettled() && !s.paused && !s.needsInspection && policy[action.operation.kind] === 'allow' && (!action.risk || policy.risk === 'allow')) { this.launch(action, 'policy'); break; }
    }
  }
  async tool(name: string, value: unknown, attempt: BackgroundAttempt) {
    if (name === 'get_action_permissions') { fields(value, []); return { permissions: this.permissions(), contract: 'background-actions-v1',
      limits: { proposalsPerJob: 4, pending: 100, commandMs: 120000, outputBytes: 8192, proposalMinutes: 30 }, appRoots: [...ALLOWED_ROOTS],
      note: 'Ask first is the default. Native readiness is never inferred. All app checks still apply. Host commands run as the host user, without an OS sandbox. Read shared/openapi.yaml for exact app contracts.' }; }
    if (name === 'get_actions') {
      const b = fields(value, ['actionId']);
      if (b.actionId !== undefined) { const action = this.get(text(b.actionId));
        if (!action || action.itemId !== attempt.itemId) throw new GlobalAIError('OUT_OF_SCOPE', 'This action is not part of the admitted issue.', 403);
        return { action: this.modelView(action) };
      }
      return { actions: this.rows('item_id=?', [attempt.itemId], 10).map(a => this.modelView(a, 1000)) };
    }
    const b = fields(value, ['requestKey', 'reason', 'operation']);
    const op = operation(b.operation), requestKey = text(b.requestKey, 100), reason = text(b.reason, 1000);
    const raw = JSON.stringify({ operation: op, reason, requestKey });
    if (Buffer.byteLength(raw) > 12000) throw new GlobalAIError('ACTION_SIZE', 'An action proposal is limited to 12 KiB.', 413);
    if (/[\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new GlobalAIError('ACTION_TEXT', 'An action cannot contain hidden text-direction controls.', 400);
    if (JSON.stringify(cleanActionValue({ operation: op, reason, requestKey }, this.services.ownerToken)) !== raw) throw new GlobalAIError('ACTION_SECRET', 'Do not put credential literals in an action or its audit log. Reference the host’s credential store instead.', 400);
    const digest = hash(canonical({ instance: attempt.instanceId, enablement: attempt.enablement, item: attempt.itemId, version: attempt.sourceVersion, op }));
    const duplicate = this.rows('attempt_id=? AND json_extract(value,\'$.requestKey\')=?', [attempt.id, requestKey], 1)[0];
    if (duplicate && duplicate.digest !== digest) throw new GlobalAIError('ACTION_CONFLICT', 'This action request key already names another operation.');
    const prior = duplicate ?? this.rows('digest=?', [digest], 1)[0];
    if (prior && (duplicate || !['denied', 'stale'].includes(prior.status))) return { action: this.modelView(prior) };
    if (this.rows('attempt_id=?', [attempt.id], 5).length >= 4 || this.rows("status='pending'", [], 100).length >= 100) throw new GlobalAIError('ACTION_LIMIT', 'The Background action proposal limit is reached.', 429);
    const policy = this.permissions();
    const action: BackgroundAction = { id: randomUUID(), requestKey, digest, attemptId: attempt.id, instanceId: attempt.instanceId, enablement: attempt.enablement,
      itemId: attempt.itemId, itemRevision: attempt.itemRevision, sourceVersion: attempt.sourceVersion, policyRevision: policy.revision, operation: op, reason, risk: riskDecision(op),
      status: 'pending', createdAt: this.at(), expiresAt: new Date(this.now() + 1800000).toISOString(), updatedAt: this.at(), authorization: null, pid: null, result: null, message: 'Waiting for your confirmation in Background → Log.' };
    this.assertCurrent(action);
    this.services.db.transaction(() => { this.save(action); this.log('background', 'proposed', reason, { operation: op, digest, itemId: action.itemId, sourceVersion: action.sourceVersion, expiresAt: action.expiresAt }, action.id, attempt.id); }).immediate();
    if (policy[op.kind] === 'allow' && (!action.risk || policy.risk === 'allow')) {
      if (!this.unsettled()) this.launch(action, 'policy');
      else this.transition(action, 'pending', 'Saved permissions allow this action; waiting for the earlier action to settle.', 'host');
    }
    return { action: this.modelView(this.get(action.id)!) };
  }
  decide(value: unknown) {
    const b = fields(value, ['action', 'id', 'digest', 'confirm', 'note']);
    const action = this.get(text(b.id));
    if (!action || action.digest !== b.digest) throw new GlobalAIError('ACTION_CHANGED', 'Review the exact current action.');
    if (b.action === 'deny') {
      if (action.status !== 'pending') return action;
      return this.transition(action, 'denied', 'You declined this action. Nothing was executed.', 'owner');
    }
    if (b.action === 'reconcile') {
      if (b.confirm !== true || action.status !== 'uncertain' || this.running.has(action.id)) throw new GlobalAIError('ACTION_UNSETTLED', 'Wait for execution to end, then inspect the action and its possible effects.');
      const note = text(b.note, 1000);
      if (action.pid) { try { process.kill(-action.pid, 0); throw new GlobalAIError('ACTION_UNSETTLED', 'The recorded command process group still exists.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
      return this.transition(action, 'reconciled', 'Owner inspected possible effects. History retained; this action will not be replayed.', 'owner', { previous: action.result, note });
    }
    if (b.action !== 'approve' || b.confirm !== true) throw new GlobalAIError('CONFIRM_REQUIRED', 'Confirm the exact operation, including any readiness or risk acknowledgements in its body.', 400);
    if (action.status !== 'pending') return action; // A lost confirmation response never executes twice.
    try { this.assertCurrent(action); } catch (e) { this.transition(action, 'stale', 'The proposal no longer matches current authority or issue state.', 'host'); throw e; }
    if (this.rows("status IN ('running','uncertain')", [], 1).length) throw new GlobalAIError('ACTION_UNSETTLED', 'Another Background action has not settled. Inspect it first.');
    this.launch(action, 'interactive'); return this.get(action.id)!;
  }
  private launch(action: BackgroundAction, decision: BackgroundAuthorization['decision']) {
    this.assertCurrent(action);
    action.authorization = { actionId: action.id, decision, policyRevision: action.policyRevision, at: this.at() };
    action = this.transition(action, 'running', decision === 'interactive' ? 'You approved this exact action.' : 'Authorized by saved Background permissions.', decision === 'interactive' ? 'owner' : 'host');
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      let admitted = false;
      try {
        const result = await this.services.execute(action, abort.signal, pid => { action.pid = pid; this.save(action); }, () => { this.assertCurrent(action); admitted = true; }, () => {
          const token = randomBytes(32).toString('hex'), record = { id: action.id, consumed: false };
          this.grants.set(token, record);
          let evidence: ReturnType<ActionGrant['settle']> | undefined;
          return { token, settle: () => {
            if (evidence !== undefined) return evidence;
            evidence = this.grants.get(token) !== record ? 'unknown' : record.consumed ? 'consumed' : 'unused';
            this.grants.delete(token); return evidence;
          } };
        });
        const next = this.transition(action, result.status, result.message, 'host', result.result);
        if (result.status !== 'uncertain') this.services.settled(next);
      } catch (error) {
        // Nothing starts before admission, so a refusal there (such as held manual input) is known, never an unknown outcome.
        const known = !admitted;
        const next = this.transition(action, known ? 'failed' : 'uncertain', known ? (error instanceof Error ? error.message : 'Refused before execution; nothing started.')
          : 'Execution outcome is unknown. Inspect the host and the app operation; do not replay.', 'host');
        if (known) this.services.settled(next);
      } finally { this.running.delete(action.id); for (const [token, grant] of this.grants) if (grant.id === action.id) this.grants.delete(token); }
    });
    this.running.set(action.id, { abort, promise });
  }
  /** Called only after owner HTTP authentication, before invoking the existing route handler. */
  consume(token: string, method: string, path: string, body: unknown): BackgroundAuthorization {
    const grant = this.grants.get(token), action = grant && this.get(grant.id);
    if (!grant || grant.consumed || !action || action.status !== 'running' || action.operation.kind !== 'app' || action.operation.method !== method
      || action.operation.path !== path || hash(action.operation.body ?? null) !== hash(body ?? null)) throw new GlobalAIError('ACTION_GRANT', 'The exact Background action grant is absent or already used.', 403);
    this.assertCurrent(action); grant.consumed = true; return action.authorization!;
  }
  cancel() { for (const { abort } of this.running.values()) abort.abort(); }
  async shutdown() { this.closing = true; this.cancel(); await this.drain(); }
  async drain() { await Promise.all([...this.running.values()].map(r => r.promise)); }
}
