import { createHash, randomUUID } from 'node:crypto';
import type { CommandRecord, TurnEvent } from '../contracts/api.ts';
import type { Execution, HookEvent, HookReceipt, ManagedSession, RelayRun, StartInput } from '../contracts/workflow.ts';
import { AppError } from '../core/errors.ts';
import { singleLine } from '../core/validation.ts';
import type { Store } from './store.ts';

const json = JSON.stringify;
const now = () => new Date().toISOString();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)])) : value;
const hash = (value: unknown) => createHash('sha256').update(json(canonical(value))).digest('hex');
const identityMatches = (a: ManagedSession['identity'], b?: HookEvent['identity']) => !!b &&
  (['paneId', 'panePid', 'serverPid', 'serverStarted', 'socketPath'] as const).every((k) => a[k] === b[k]);
export function wireText(input: StartInput, session: ManagedSession): string {
  const text = input.kind === 'relay' ? `${session.relayPrompt}: ${input.text ?? ''}`.trimEnd() : input.text!;
  const wire = `${text} [codercrew-command:${input.requestId}]`;
  if (new TextEncoder().encode(wire).length > 2000) throw new AppError('INVALID_TEXT', 'The text plus its 57-byte correlation marker exceeds 2,000 UTF-8 bytes. Shorten the text.');
  return singleLine(wire);
}
/** A durable execution ledger, separate from transport receipts and the bounded history view. */
export class WorkflowStore {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, lock_key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_owners (lock_key TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS workflow_turns (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_turns_run ON workflow_turns(run_id);
      CREATE TABLE IF NOT EXISTS workflow_events (id TEXT PRIMARY KEY, command_id TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS workflow_bindings (registration_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    `);
  }
  run(id: string): RelayRun | undefined {
    const row = this.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id) as {value: string} | undefined;
    return row ? JSON.parse(row.value) as RelayRun : undefined;
  }
  execution(id: string): Execution | undefined {
    const row = this.store.db.prepare('SELECT value FROM workflow_turns WHERE id=?').get(id) as {value: string} | undefined;
    return row ? JSON.parse(row.value) as Execution : undefined;
  }
  runs(): RelayRun[] {
    // Keep every owned run, even if many completed runs were created elsewhere.
    return (this.store.db.prepare(`SELECT value FROM workflow_runs WHERE id IN (SELECT run_id FROM workflow_owners)
      OR id IN (SELECT id FROM workflow_runs ORDER BY rowid DESC LIMIT 30) ORDER BY rowid DESC`).all() as {value:string}[]).map((r) => JSON.parse(r.value));
  }
  activeExecutions(): Execution[] {
    return this.runs().filter((r) => r.status === 'running' || r.status === 'paused').map((r) => this.execution(r.currentCommandId)!).filter(Boolean);
  }
  owner(lockKey: string): string | null {
    return (this.store.db.prepare('SELECT run_id FROM workflow_owners WHERE lock_key=?').get(lockKey) as {run_id:string} | undefined)?.run_id ?? null;
  }
  private saveRun(run: RelayRun): void {
    run.updatedAt = now();
    this.store.db.prepare('INSERT INTO workflow_runs(id,lock_key,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(run.id, run.lockKey, json(run));
  }
  private saveExecution(turn: Execution): void {
    this.store.db.prepare('INSERT INTO workflow_turns(id,run_id,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(turn.commandId, turn.runId, json(turn));
  }
  private stop(run: RelayRun, reason: string, complete = false): void {
    run.status = complete ? 'completed' : 'paused'; run.reason = reason; this.saveRun(run);
    if (complete) this.store.db.prepare('DELETE FROM workflow_owners WHERE run_id=?').run(run.id);
  }
  start(input: StartInput, participants: ManagedSession[], pairId: string | null): Execution {
    const first = participants.find((s) => s.id === input.agentId)!;
    const wire = wireText(input, first); // Validation before any durable write.
    return this.store.db.transaction(() => {
      const existing = this.execution(input.requestId);
      if (existing) {
        const existingRun = this.run(existing.runId)!;
        if (existing.runId !== input.requestId || existing.input.kind !== input.kind || existing.agentId !== input.agentId || existing.wireText !== wire || existingRun.pairId !== pairId ||
          existingRun.autoContinue !== (input.autoContinue === true) || (existing.input.handoff === true) !== (input.handoff === true)) {
          throw new AppError('ID_CONFLICT', 'This request ID is already bound to different work or policy.', 409);
        }
        return existing;
      }
      const lockKey = first.worktree?.indexPath ?? first.repository;
      if (this.owner(lockKey)) throw new AppError('RUN_ACTIVE', 'This worktree already has an execution owner. Pause or take over the existing run first.', 409);
      if (this.store.activeFor(first.repository)) throw new AppError('TURN_ACTIVE', 'Reconcile the older uncertain delivery before starting a run.', 409);
      const timestamp = now();
      const run: RelayRun = { id: input.requestId, repository: first.repository, lockKey, pairId, participants,
        autoContinue: input.autoContinue === true, pauseRequested: false, status: 'running', reason: 'Waiting for this command to finish.',
        currentCommandId: input.requestId, automaticTurns: 0, turnLimit: 20, createdAt: timestamp, updatedAt: timestamp };
      const turn: Execution = { commandId: input.requestId, runId: run.id, agentId: first.id, input, wireText: wire,
        status: 'planned', sessionId: null, sourceTurnId: null, continuation: false };
      this.saveRun(run); this.saveExecution(turn);
      this.store.db.prepare('INSERT INTO workflow_owners(lock_key,run_id) VALUES (?,?)').run(lockKey, run.id);
      return turn;
    }).immediate();
  }
  claim(id: string): Execution | null {
    return this.store.db.transaction(() => {
      const turn = this.execution(id); const run = turn && this.run(turn.runId);
      if (!turn || !run || run.status !== 'running' || run.currentCommandId !== id || turn.status !== 'planned') return null;
      turn.status = 'dispatching'; this.saveExecution(turn); return turn;
    }).immediate();
  }
  delivered(id: string, record: CommandRecord): void {
    this.store.db.transaction(() => {
      const turn = this.execution(id)!; const run = this.run(turn.runId)!;
      turn.status = record.status === 'delivered' ? 'delivered' : record.status === 'rejected' ? 'rejected' : 'uncertain';
      this.saveExecution(turn);
      if (turn.status !== 'delivered') this.stop(run, record.error ?? 'Delivery requires human reconciliation.');
    }).immediate();
  }
  dispatchFailed(id: string): void {
    const turn = this.execution(id)!; turn.status = 'uncertain'; this.saveExecution(turn);
    this.stop(this.run(turn.runId)!, 'Delivery may have occurred. Inspect the terminal; it will not be replayed.');
  }
  receive(input: HookEvent): HookReceipt {
    if (!input.commandId || !input.sourceTurnId || !input.sessionId || !input.identity || input.event === 'outcome') {
      // Old hooks/follow-ups remain diagnostic only. They can never complete a newer command.
      return { accepted: false, reason: 'Uncorrelated lifecycle event; update hooks or reconcile manually.', event: null };
    }
    const key = hash([input.source, input.identity, input.sessionId, input.sourceTurnId, input.event]);
    return this.store.db.transaction(() => {
      const row = this.store.db.prepare('SELECT digest,receipt FROM workflow_events WHERE id=?').get(key) as {digest:string;receipt:string|null} | undefined;
      if (row && row.digest !== hash(input)) {
        const turn = this.execution(input.commandId!); if (turn) this.stop(this.run(turn.runId)!, 'Conflicting payload for an existing lifecycle event.');
        return { accepted: false, reason: 'Lifecycle event identity conflict.', event: null };
      }
      if (row?.receipt) return JSON.parse(row.receipt) as HookReceipt;
      if (!row) this.store.db.prepare('INSERT INTO workflow_events(id,command_id,digest,value) VALUES (?,?,?,?)').run(key, input.commandId, hash(input), json(input));
      return this.apply(key, input);
    }).immediate();
  }
  /** Drain completion events that arrived before the terminal transport returned. */
  drain(id: string): void {
    const rows = this.store.db.prepare('SELECT id,value FROM workflow_events WHERE command_id=? AND receipt IS NULL ORDER BY rowid').all(id) as {id:string;value:string}[];
    for (const row of rows) this.store.db.transaction(() => { this.apply(row.id, JSON.parse(row.value) as HookEvent); }).immediate();
  }
  private apply(key: string, input: HookEvent): HookReceipt {
    const done = (reason: string, event: TurnEvent | null = null): HookReceipt => {
      const receipt = { accepted: event !== null, reason, event };
      this.store.db.prepare('UPDATE workflow_events SET receipt=? WHERE id=?').run(json(receipt), key);
      return receipt;
    };
    const turn = this.execution(input.commandId!); const run = turn && this.run(turn.runId);
    if (!turn || !run || run.currentCommandId !== turn.commandId || !['running','paused'].includes(run.status)) return done('Late or unknown command; no workflow transition.');
    const participant = run.participants.find((s) => s.id === turn.agentId)!;
    const current = this.store.sessions().find((s) => s.id === participant.id) as ManagedSession | undefined;
    if (current?.registrationId !== participant.registrationId || input.source !== participant.agentType || !identityMatches(participant.identity, input.identity)) {
      this.stop(run, 'Worker instance changed. Reconcile and re-register before continuing.'); return done(run.reason);
    }
    if (turn.status === 'planned' || turn.status === 'uncertain' || turn.status === 'rejected') return done('Command was not confirmed delivered; manual reconciliation required.');
    if (turn.status === 'dispatching') return { accepted: false, reason: 'Buffered until delivery is established.', event: null };
    if (turn.status === 'finished') return done('This command already has a completion.');
    if (input.prompt?.trim() !== turn.wireText.trim()) {
      this.stop(run, 'The CLI prompt differs from the delivered command. Check for leftover or queued input.'); return done(run.reason);
    }
    const bound = this.store.db.prepare('SELECT session_id FROM workflow_bindings WHERE registration_id=?').get(participant.registrationId) as {session_id:string} | undefined;
    if (bound && bound.session_id !== input.sessionId) { this.stop(run, 'CLI session changed; explicitly re-register the worker.'); return done(run.reason); }
    if (turn.sessionId && (turn.sessionId !== input.sessionId || turn.sourceTurnId !== input.sourceTurnId)) { this.stop(run, 'The completion did not match the acknowledged source turn.'); return done(run.reason); }
    if (input.source === 'claude' && input.event === 'turn_complete' && !turn.sourceTurnId) {
      this.stop(run, 'No matching UserPromptSubmit acknowledgment. Update hooks and reconcile.'); return done(run.reason);
    }
    this.store.db.prepare('INSERT OR IGNORE INTO workflow_bindings(registration_id,session_id) VALUES (?,?)').run(participant.registrationId, input.sessionId);
    turn.sessionId = input.sessionId!; turn.sourceTurnId = input.sourceTurnId!; this.saveExecution(turn);
    if (input.event === 'turn_started') return done('Source turn acknowledged.', this.asTurnEvent(input, participant.id, null));
    const event = this.asTurnEvent(input, participant.id, input.commandId!);
    this.store.addEvent(event);
    if (input.settled !== true || input.backgroundState !== 'clear') {
      this.stop(run, input.backgroundState === 'active' ? 'Background work remains active; ownership was not transferred.' : 'Completion or background-work state is unknown; inspect the workers.');
      return done(run.reason, event);
    }
    turn.status = 'finished'; this.saveExecution(turn);
    if (run.pauseRequested || run.status === 'paused') { this.stop(run, 'Turn finished; run remains paused until human takeover.'); return done(run.reason, event); }
    const isInstruction = turn.input.kind === 'instruction';
    const shouldContinue = isInstruction ? turn.input.handoff === true : input.outcome === 'accept_and_improve' && run.autoContinue;
    if (!shouldContinue) {
      const completed = isInstruction || input.outcome === 'accept_without_improvement' || input.outcome === 'no_incoming_handoff';
      this.stop(run, completed ? 'Chain ended. Final task-level checks are still a human responsibility.' : input.outcome === 'strong_objection' ? `Reviewer objected: ${input.reason ?? 'inspect its output'}` : 'Review finished; automatic continuation is off or no outcome was reported.', completed);
      return done(run.reason, event);
    }
    if (run.automaticTurns >= run.turnLimit) { this.stop(run, 'Automatic turn budget reached.'); return done(run.reason, event); }
    const partner = run.participants.find((s) => s.id !== turn.agentId);
    if (!partner || !run.pairId) { this.stop(run, 'No explicit pair was bound to this run.'); return done(run.reason, event); }
    const nextId = randomUUID();
    const nextInput: StartInput = { requestId: nextId, agentId: partner.id, kind: 'relay', confirmReady: true };
    const next: Execution = { commandId: nextId, runId: run.id, agentId: partner.id, input: nextInput, wireText: wireText(nextInput, partner),
      status: 'planned', sessionId: null, sourceTurnId: null, continuation: true };
    // Event receipt, new command, current-turn change, and budget are one SQLite transaction.
    run.currentCommandId = nextId; run.automaticTurns++; run.reason = 'Next review scheduled by the server.';
    this.saveExecution(next); this.saveRun(run);
    return done('Exactly one continuation scheduled.', event);
  }
  private asTurnEvent(input: HookEvent, agentId: string, commandId: string | null): TurnEvent {
    return { agentId, paneId: input.paneId, source: input.source, sessionId: input.sessionId ?? null, commandId,
      prompt: input.prompt ?? null, outcome: input.outcome ?? null, reason: input.reason ?? null,
      outcomeState: input.outcome ? 'reported' : 'none', receivedAt: now() };
  }
  pause(id: string, reason = 'Paused by the user. This does not interrupt an agent or release ownership.'): void {
    this.store.db.transaction(() => { const run = this.run(id); if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
      if (!['running','paused'].includes(run.status)) return;
      run.pauseRequested = true; this.stop(run, reason);
    }).immediate();
  }
  takeover(id: string): void {
    this.store.db.transaction(() => {
      const run = this.run(id); if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
      if (!['running','paused'].includes(run.status)) return;
      const turn = this.execution(run.currentCommandId)!;
      if (turn.status === 'dispatching') throw new AppError('DELIVERY_PENDING', 'Wait for the in-flight terminal delivery before taking over.', 409);
      const delivery = this.store.activeFor(run.repository);
      if (delivery) this.store.release(delivery);
      run.status = 'stopped'; run.reason = 'Human takeover acknowledged. No command was replayed or process interrupted.'; this.saveRun(run);
      this.store.db.prepare('DELETE FROM workflow_owners WHERE run_id=?').run(id);
    }).immediate();
  }
  recover(): void {
    for (const run of this.runs().filter((r) => r.status === 'running' || r.status === 'paused')) {
      const turn = this.execution(run.currentCommandId)!;
      if (turn.status === 'dispatching') { turn.status = 'uncertain'; this.saveExecution(turn); }
      this.stop(run, 'Backend restarted. Reconcile this run before starting another; nothing was replayed.');
    }
  }
}
