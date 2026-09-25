import { createHash, randomUUID } from 'node:crypto';
import type { CommandRecord, TurnEvent } from '../contracts/api.ts';
import type { BackgroundEvidence, Execution, HistoryExport, HookEvent, HookReceipt, ManagedSession, ProcessRecord, RelayRun, StartInput } from '../contracts/workflow.ts';
import { AppError } from '../core/errors.ts';
import { promptText } from '../core/validation.ts';
import type { Store } from './store.ts';
import { join, resolve } from 'node:path';
import type { HandoffArchive, ImplementationAction, ImplementationRun, JournalRecord, PolicyChange, Publication, PublicationResult, StandaloneStart } from '../contracts/implementation.ts';
import type { FrozenPlan, PlanCapture, PlanDecision, PlanningRun } from '../contracts/planning.ts';
import { consumePlan, planAgreed } from './planning-state.ts';
import type { InteractionHold, InteractionInput } from '../contracts/interactions.ts';

const json = JSON.stringify;
export const DEFAULT_TURN_LIMIT = 20;
const now = () => new Date().toISOString();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)])) : value;
const hash = (value: unknown) => createHash('sha256').update(json(canonical(value))).digest('hex');
/** The hooks flatten control characters to spaces before echoing a prompt (protocol.mjs `plain`); compare in that form. */
const flat = (text: string | null | undefined) => (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
const identityMatches = (a: ManagedSession['identity'], b?: HookEvent['identity']) => !!b &&
  (['paneId', 'panePid', 'serverPid', 'serverStarted', 'socketPath'] as const).every((k) => a[k] === b[k]);
export function wireText(input: StartInput, session: ManagedSession): string {
  const text = input.kind === 'relay' ? `${session.relayPrompt}: ${input.text ?? ''}`.trimEnd() : input.text!;
  const wire = `${text} [altcli-command:${input.requestId}]`;
  if (new TextEncoder().encode(wire).length > 2000) throw new AppError('INVALID_TEXT', 'The text plus its 54-byte correlation marker exceeds 2,000 UTF-8 bytes. Shorten the text.');
  return promptText(wire);
}
/** A durable execution ledger, separate from transport receipts and the bounded history view. */
export class WorkflowStore {
  readonly store: Store;
  readonly assignmentDirectory: string;
  constructor(store: Store, assignmentDirectory = '/tmp/altcli-test-assignments') {
    this.store = store;
    this.assignmentDirectory = assignmentDirectory;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, lock_key TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_owners (lock_key TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS workflow_turns (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_turns_run ON workflow_turns(run_id);
      CREATE TABLE IF NOT EXISTS workflow_events (id TEXT PRIMARY KEY, command_id TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, receipt TEXT);
      DROP TABLE IF EXISTS workflow_bindings; -- a CLI session was once pinned per registration; it is now recorded per execution
      CREATE TABLE IF NOT EXISTS handoff_journal (command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repository TEXT NOT NULL, agent_id TEXT NOT NULL, sha TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS handoff_journal_agent ON handoff_journal(agent_id, sha);
      CREATE INDEX IF NOT EXISTS handoff_journal_repository ON handoff_journal(repository);
    `);
    this.backfillJournal();
  }
  /** Publications recorded before the journal existed (in the turn ledger only) become journal records once; their commits are archived later, if still present. */
  private backfillJournal(): void {
    const rows = this.store.db.prepare(`SELECT t.value AS turn, r.value AS run FROM workflow_turns t JOIN workflow_runs r ON r.id = t.run_id
      WHERE json_extract(t.value, '$.implementation.published') IS NOT NULL AND t.id NOT IN (SELECT command_id FROM handoff_journal) ORDER BY t.rowid`).all() as { turn: string; run: string }[];
    if (!rows.length) return;
    this.store.db.transaction(() => {
      for (const row of rows) {
        const turn = JSON.parse(row.turn) as Execution; const run = JSON.parse(row.run) as RelayRun;
        this.saveJournal(run, turn, turn.implementation!.published!, null, run.updatedAt);
      }
    }).immediate();
  }
  private saveJournal(run: RelayRun, turn: Execution, publication: Publication, archive: HandoffArchive | null, recordedAt = now()): void {
    const identity = turn.implementation!.identity;
    const record: JournalRecord = { runId: run.id, commandId: turn.commandId, repository: run.repository, branch: run.implementation!.branch, agentId: turn.agentId,
      turn: identity.turn, action: identity.action, parent: identity.parent, sha: publication.sha, projectChanged: publication.projectChanged, entry: publication.entry, archive, recordedAt };
    this.store.db.prepare('INSERT INTO handoff_journal(command_id,run_id,repository,agent_id,sha,value) VALUES (?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET value=excluded.value')
      .run(record.commandId, record.runId, record.repository, record.agentId, record.sha, json(record));
  }
  /** The durable handoff journal, oldest first; optionally one worktree root only. */
  journal(repository?: string): JournalRecord[] {
    const rows = repository === undefined ? this.store.db.prepare('SELECT value FROM handoff_journal ORDER BY rowid').all()
      : this.store.db.prepare('SELECT value FROM handoff_journal WHERE repository=? ORDER BY rowid').all(repository);
    return (rows as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  /** Which of `shas` are commits at which `agentId` completed a turn (its handoff commit, or the unchanged tip of a report-only turn). */
  publishedBy(agentId: string, shas: string[]): Set<string> {
    if (!shas.length) return new Set();
    const rows = this.store.db.prepare(`SELECT sha FROM handoff_journal WHERE agent_id=? AND sha IN (${shas.map(() => '?').join(',')})`).all(agentId, ...shas) as { sha: string }[];
    return new Set(rows.map((row) => row.sha));
  }
  /** Journal records on one worktree whose handoff commit has not been archived yet. */
  unarchived(repository: string): JournalRecord[] {
    return this.journal(repository).filter((record) => record.sha !== record.parent && record.archive === null);
  }
  saveArchive(commandId: string, archive: HandoffArchive): void {
    const row = this.store.db.prepare('SELECT value FROM handoff_journal WHERE command_id=?').get(commandId) as { value: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Journal record not found.', 404);
    this.store.db.prepare('UPDATE handoff_journal SET value=? WHERE command_id=?').run(json({ ...JSON.parse(row.value), archive }), commandId);
  }
  /** Every run and turn (not the bounded console view), plus the journal, for backup outside the repository. */
  exportHistory(repository?: string): HistoryExport {
    const scope = repository === undefined ? { where: '', args: [] as string[] } : { where: "WHERE json_extract(value, '$.repository')=?", args: [repository] };
    const runs = this.store.db.prepare(`SELECT value FROM workflow_runs ${scope.where} ORDER BY rowid`).all(...scope.args) as { value: string }[];
    const turns = this.store.db.prepare(`SELECT value FROM workflow_turns WHERE run_id IN (SELECT id FROM workflow_runs ${scope.where}) ORDER BY rowid`).all(...scope.args) as { value: string }[];
    return { schema: 1, exportedAt: now(), repository: repository ?? null, runs: runs.map((row) => JSON.parse(row.value)), turns: turns.map((row) => JSON.parse(row.value)), journal: this.journal(repository) };
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
  /** Run and pair for each listed command id, from the durable ledger, in one query. */
  runsOf(commandIds: string[]): Map<string, { runId: string; pairId: string | null; groupId: string | null; repository: string }> {
    if (!commandIds.length) return new Map();
    const rows = this.store.db.prepare(`SELECT t.id AS id, t.run_id AS runId, json_extract(r.value, '$.repository') AS repository, json_extract(r.value, '$.pairId') AS pairId,
      COALESCE(json_extract(r.value, '$.implementation.group.id'), json_extract(r.value, '$.planning.group.id'), json_extract(r.value, '$.standalone.groupId'), json_extract(r.value, '$.pairId')) AS groupId
      FROM workflow_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE t.id IN (${commandIds.map(() => '?').join(',')})`).all(...commandIds) as {id:string;runId:string;repository:string;pairId:string|null;groupId:string|null}[];
    return new Map(rows.map((row) => [row.id, { runId: row.runId, pairId: row.pairId, groupId: row.groupId, repository: row.repository }]));
  }
  activeExecutions(): Execution[] {
    return this.runs().filter((r) => ['running','waiting','paused'].includes(r.status)).map((r) => this.execution(r.currentCommandId)!).filter(Boolean);
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
    delete run.blockedHandoff;
    if (run.interaction?.active) {
      if (complete && !run.interaction.fault) { this.holdDisposition(run, 'complete'); return; }
      run.interaction.fault = true;
      complete = false;
    }
    run.status = complete ? 'completed' : 'paused'; run.reason = reason; this.saveRun(run);
    if (complete) this.store.db.prepare('DELETE FROM workflow_owners WHERE run_id=?').run(run.id);
  }
  private holdDisposition(run: RelayRun, disposition: NonNullable<InteractionHold['disposition']>): void {
    run.interaction!.disposition = disposition;
    run.status = 'paused'; run.reason = 'Original turn validated. Review the terminal input before continuing.';
    this.saveRun(run);
  }
  /** Called in the interaction reservation transaction, before any terminal side effect. */
  beginKeyboard(id: string): void {
    const run = this.run(id)!;
    if (!run.implementation && !run.planning && !run.standalone) throw new AppError('LEGACY_OWNED', 'Settle or take over the legacy staging run before native input.', 409);
    const turn = this.execution(run.currentCommandId);
    if (run.status === 'running' && turn?.status !== 'delivered') throw new AppError('DELIVERY_PENDING', 'Wait for the current delivery before taking keyboard.', 409);
    const fault = run.status === 'paused' || run.pauseRequested || run.interaction?.fault === true;
    run.interaction = { revision: (run.interaction?.revision ?? 0) + 1, active: true, fault, origin: 'keyboard',
      ...(run.status === 'waiting' ? { disposition: 'waiting' as const } : {}) };
    if (run.status === 'waiting') { run.status = 'paused'; run.reason = 'Manual keyboard input holds this validated checkpoint.'; }
    this.saveRun(run);
  }
  beginInteraction(input: InteractionInput): void {
    const run = this.run(input.runId); const turn = this.execution(input.commandId);
    if (!run || (!run.implementation && !run.planning && !run.standalone) || run.status !== 'running' || run.pauseRequested || run.interaction?.fault ||
      run.currentCommandId !== input.commandId || turn?.status !== 'delivered' || turn.agentId !== input.agentId ||
      turn.sessionId !== input.sessionId || turn.sourceTurnId !== input.sourceTurnId || (run.interaction?.revision ?? 0) !== input.expectedRevision ||
      run.participants.find((p) => p.id === input.agentId)?.registrationId !== input.registrationId) throw new AppError('INTERACTION_CHANGED', 'The current assignment or input revision changed. Refresh; nothing was sent.', 409);
    run.interaction = { revision: input.expectedRevision + 1, active: true, fault: false };
    this.saveRun(run);
  }
  rejectInteraction(id: string, prior: InteractionHold | undefined): void {
    const run = this.run(id)!;
    if (run.interaction?.fault) return;
    if (run.interaction?.disposition) {
      // A preflight refusal wrote no bytes. Only an earlier delivered input can retain this hold.
      if (!prior?.active && !run.pauseRequested) this.reconcileInput(id, run.currentCommandId);
      return;
    }
    run.interaction = prior ? { ...prior, revision: run.interaction!.revision } : { revision: run.interaction!.revision, active: false, fault: false };
    this.saveRun(run);
  }
  reconcileInput(id: string, commandId: string): void {
    const run = this.run(id)!; const hold = run.interaction;
    if (run.currentCommandId !== commandId || run.status !== 'paused' || run.pauseRequested || !hold?.active || hold.fault || !hold.disposition) throw new AppError('CHECKPOINT_CHANGED', 'Input is not at a validated checkpoint.', 409);
    const disposition = hold.disposition; hold.active = false; delete hold.disposition;
    if (disposition === 'complete') { this.stop(run, 'Input reviewed; validated task finished.', true); return; }
    if (disposition === 'automatic') {
      if (run.automaticTurns >= run.turnLimit) { this.stop(run, 'Automatic turn budget reached.'); return; }
      this.scheduleCommit(run, true); return;
    }
    if (disposition === 'plan' && run.planning?.next && run.autoContinue) {
      if (run.automaticTurns >= run.turnLimit) { this.stop(run, 'Automatic turn budget reached.'); return; }
      this.schedulePlan(run, true); return;
    }
    run.status = 'waiting'; run.reason = 'Input reviewed. The saved checkpoint is ready for its next decision.'; this.saveRun(run);
  }
  restoreCheckpoint(id: string, commandId: string): void {
    const run = this.run(id)!;
    if (run.currentCommandId !== commandId || run.status !== 'paused' || run.interaction?.active || this.execution(commandId)?.status !== 'finished') throw new AppError('CHECKPOINT_CHANGED', 'This settled checkpoint cannot be restored.', 409);
    run.pauseRequested = false; run.restoredCheckpoint = true; run.status = 'waiting';
    run.reason = 'Settled checkpoint restored. Choose Next turn or a plan decision explicitly; nothing was sent.'; this.saveRun(run);
  }
  start(input: StartInput, participants: ManagedSession[], pairId: string | null, implementation?: ImplementationRun, planning?: PlanningRun, standalone?: StandaloneStart): Execution {
    const first = participants.find((s) => s.id === input.agentId)!;
    const wire = implementation || planning ? '' : wireText(input, first); // Validation before any durable write.
    return this.store.db.transaction(() => {
      const existing = this.execution(input.requestId);
      if (existing) {
        const existingRun = this.run(existing.runId)!;
        if (hash(existingRun.standalone ?? null) !== hash(standalone ?? null)) throw new AppError('ID_CONFLICT', 'This request ID is bound to another instruction.', 409);
        if (planning && existingRun.planning) {
          if (hash(existingRun.planning.request) !== hash(planning.request)) throw new AppError('ID_CONFLICT', 'This request ID is bound to another planning request.', 409);
          return existing;
        }
        if (implementation && existingRun.implementation) {
          if (hash(existingRun.implementation.request) !== hash(implementation.request)) throw new AppError('ID_CONFLICT', 'This request ID is bound to another implementation request.', 409);
          return existing;
        }
        if (existing.runId !== input.requestId || existing.input.kind !== input.kind || existing.agentId !== input.agentId || existing.wireText !== wire || existingRun.pairId !== pairId ||
          existingRun.autoContinue !== (input.autoContinue === true) || existingRun.turnLimit !== (input.turnLimit ?? DEFAULT_TURN_LIMIT) || (existingRun.pauseOnObjection === true) !== (input.pauseOnObjection === true) || (existing.input.handoff === true) !== (input.handoff === true)) {
          throw new AppError('ID_CONFLICT', 'This request ID is already bound to different work or policy.', 409);
        }
        return existing;
      }
      const lockKey = first.worktree?.indexPath ?? first.repository;
      if (this.owner(lockKey)) throw new AppError('RUN_ACTIVE', 'This worktree already has an execution owner. Pause or take over the existing run first.', 409);
      if (this.store.activeFor(first.repository)) throw new AppError('TURN_ACTIVE', 'Reconcile the older uncertain delivery before starting a run.', 409);
      const timestamp = now();
      const run: RelayRun = { id: input.requestId, repository: first.repository, lockKey, pairId, participants,
        autoContinue: input.autoContinue === true, pauseOnObjection: input.pauseOnObjection === true, pauseRequested: false, status: 'running', reason: 'Waiting for this command to finish.',
        currentCommandId: input.requestId, automaticTurns: 0, turnLimit: input.turnLimit ?? DEFAULT_TURN_LIMIT, createdAt: timestamp, updatedAt: timestamp,
        ...(implementation ? { implementation } : {}), ...(planning ? { planning } : {}), ...(standalone ? { standalone } : {}) };
      const turn: Execution = planning ? this.planTurn(run) : implementation ? this.commitTurn(run, first.id, implementation.request.kind !== 'review' ? 'work' : implementation.policy === 'peer' ? 'review_and_improve' : 'review', input.text ?? '', input.handoff === true, input.requestId) : { commandId: input.requestId, runId: run.id, agentId: first.id, input, wireText: wire,
        status: 'planned', sessionId: null, sourceTurnId: null, continuation: false, baselineProcesses: null, baselineWorktree: null };
      this.saveRun(run); this.saveExecution(turn);
      if(this.store.db.prepare('SELECT 1 FROM launch_reservations WHERE index_path=?').get(lockKey)) throw new AppError('LAUNCH_BUSY', 'An unresolved launch owns this checkout.', 409);
      this.store.db.prepare('INSERT INTO workflow_owners(lock_key,run_id) VALUES (?,?)').run(lockKey, run.id);
      return turn;
    }).immediate();
  }
  claim(id: string): Execution | null {
    return this.store.db.transaction(() => {
      if (this.store.db.prepare(`SELECT 1 FROM keyboard_sessions WHERE json_extract(value,'$.live')=1 OR json_extract(value,'$.reconciliationRequired')=1 LIMIT 1`).get()) return null;
      const turn = this.execution(id); const run = turn && this.run(turn.runId);
      if (!turn || !run || run.interaction?.active || run.status !== 'running' || run.currentCommandId !== id || turn.status !== 'planned' || (run.implementation && run.implementation.setup !== 'ready')) return null;
      turn.status = 'dispatching'; this.saveExecution(turn); return turn;
    }).immediate();
  }
  delivered(id: string, record: CommandRecord, baselineProcesses: ProcessRecord[] | null = null, baselineWorktree: string | null = null): void {
    this.store.db.transaction(() => {
      const turn = this.execution(id)!; const run = this.run(turn.runId)!;
      turn.status = record.status === 'delivered' ? 'delivered' : record.status === 'rejected' ? 'rejected' : 'uncertain';
      turn.baselineProcesses = baselineProcesses; turn.baselineWorktree = baselineWorktree; this.saveExecution(turn);
      if (turn.status !== 'delivered') this.stop(run, record.error ?? 'Delivery requires human reconciliation.');
    }).immediate();
  }
  dispatchFailed(id: string): void {
    const turn = this.execution(id)!; turn.status = 'uncertain'; this.saveExecution(turn);
    this.stop(this.run(turn.runId)!, 'Delivery may have occurred. Inspect the terminal; it will not be replayed.');
  }
  /** `evidence` is the server's own background-work reading for this completion; it is consulted only when the hook reports unknown.
   * `worktree` is the worktree digest read at this completion for a handoff instruction; null when not gathered or unreadable. */
  receive(input: HookEvent, evidence: BackgroundEvidence | null = null, worktree: string | null = null, publication: PublicationResult | null = null, planCapture: PlanCapture | null = null): HookReceipt {
    if (input.event === 'session_started') return { accepted: false, reason: 'Session startup is display evidence only.', event: null };
    if (!input.commandId || !input.sourceTurnId || !input.sessionId || !input.identity || input.event === 'outcome') {
      // Old hooks/follow-ups remain diagnostic only. They can never complete a newer command.
      return { accepted: false, reason: 'Uncorrelated lifecycle event; update hooks or reconcile manually.', event: null };
    }
    const identity: unknown[] = [input.source, input.identity, input.sessionId, input.sourceTurnId, input.event];
    if (input.completionSequence !== undefined) identity.push(input.completionSequence);
    const key = hash(identity);
    const { reporterPid: _reporterPid, ...semanticInput } = input;
    const digest = hash(semanticInput); // reporterPid identifies the transient hook process, not the lifecycle event.
    return this.store.db.transaction(() => {
      const row = this.store.db.prepare('SELECT digest,receipt FROM workflow_events WHERE id=?').get(key) as {digest:string;receipt:string|null} | undefined;
      if (row && row.digest !== digest) {
        const turn = this.execution(input.commandId!); if (turn) this.stop(this.run(turn.runId)!, 'Conflicting payload for an existing lifecycle event.');
        return { accepted: false, reason: 'Lifecycle event identity conflict.', event: null };
      }
      if (row?.receipt) return JSON.parse(row.receipt) as HookReceipt;
      if (!row) this.store.db.prepare('INSERT INTO workflow_events(id,command_id,digest,value) VALUES (?,?,?,?)').run(key, input.commandId, digest, json(input));
      return this.apply(key, input, evidence, worktree, publication, planCapture);
    }).immediate();
  }
  /** Lifecycle events that arrived before the terminal transport returned. The caller gathers evidence per event. */
  pendingEvents(id: string): HookEvent[] {
    return (this.store.db.prepare('SELECT value FROM workflow_events WHERE command_id=? AND receipt IS NULL ORDER BY rowid').all(id) as {value:string}[])
      .map((row) => JSON.parse(row.value) as HookEvent);
  }
  private apply(key: string, input: HookEvent, evidence: BackgroundEvidence | null, worktree: string | null, publication: PublicationResult | null, planCapture: PlanCapture | null): HookReceipt {
    const done = (reason: string, event: TurnEvent | null = null, completion?: HookReceipt['completion']): HookReceipt => {
      const state = completion ?? (event && input.event === 'turn_complete' ? this.execution(input.commandId!)?.status === 'finished' ? 'finished' : 'pending' : undefined);
      const receipt: HookReceipt = { accepted: event !== null, reason, event, ...(state ? { completion: state } : {}) };
      this.store.db.prepare('UPDATE workflow_events SET receipt=? WHERE id=?').run(json(receipt), key);
      return receipt;
    };
    const turn = this.execution(input.commandId!); const run = turn && this.run(turn.runId);
    if (!turn || !run || run.currentCommandId !== turn.commandId || !['running','paused'].includes(run.status)) return done('Late or unknown command; no workflow transition.');
    const participant = run.participants.find((s) => s.id === turn.agentId)!;
    const current = this.store.sessions().find((s) => s.id === participant.id) as ManagedSession | undefined;
    if (input.event === 'turn_interrupted' && (input.source !== 'codex' || input.source !== participant.agentType || !input.cliPid || input.cliPid !== participant.cliPid || !input.startedAt ||
      current?.registrationId !== participant.registrationId || !identityMatches(participant.identity, input.identity) ||
      flat(input.prompt) !== flat(turn.wireText) || (turn.sessionId && (turn.sessionId !== input.sessionId || turn.sourceTurnId !== input.sourceTurnId)))) {
      return done('Stale or mismatched interruption; no workflow transition.');
    }
    if (current?.registrationId !== participant.registrationId || input.source !== participant.agentType || !identityMatches(participant.identity, input.identity)) {
      this.stop(run, 'Worker instance changed. Reconcile and re-register before continuing.'); return done(run.reason);
    }
    if (turn.status === 'planned' || turn.status === 'uncertain' || turn.status === 'rejected') return done('Command was not confirmed delivered; manual reconciliation required.');
    if (turn.status === 'dispatching') return { accepted: false, reason: 'Buffered until delivery is established.', event: null };
    if (turn.status === 'finished') return done('This command already has a completion.');
    if (turn.status === 'interrupted') return done('This command was interrupted; completion cannot resume it.');
    if (input.cliPid && input.cliPid !== participant.cliPid) { this.stop(run, 'The CLI process changed. Reconcile this worker.'); return done(run.reason); }
    if (flat(input.prompt) !== flat(turn.wireText)) {
      if (input.event === 'turn_complete' && flat(input.prompt).includes(flat(turn.wireText))) {
        // Codex also notifies for auxiliary turns (thread-title generation) whose prompt quotes the user prompt, marker
        // included. That is not this command's completion; keep waiting for the exact one. The same shape arises when
        // leftover input preceded the delivered text; a mismatched native start must pause instead of waiting.
        // Preserve an existing pause reason when its rejected completion arrives later.
        if (run.status !== 'paused') {
          run.reason = 'A turn quoting this command finished with a different prompt; still waiting for the exact completion. If the pane held leftover input before delivery, pause and take over.';
          this.saveRun(run);
        }
        return done('A prompt that only quotes the delivered command is not its completion.');
      }
      this.stop(run, 'The CLI prompt differs from the delivered command. Check for leftover or queued input.'); return done(run.reason);
    }
    // The registration pins the physical worker (pane identity, CLI pid at dispatch); the CLI's logical session is pinned only
    // within a command, so a chat reset between commands (Codex /new, Claude /clear) needs no re-registration.
    if (turn.sessionId && (turn.sessionId !== input.sessionId || turn.sourceTurnId !== input.sourceTurnId)) { this.stop(run, 'The completion did not match the acknowledged source turn.'); return done(run.reason); }
    if (input.source === 'claude' && input.event === 'turn_complete' && !turn.sourceTurnId) {
      this.stop(run, 'No matching UserPromptSubmit acknowledgment. Update hooks and reconcile.'); return done(run.reason);
    }
    turn.sessionId = input.sessionId!; turn.sourceTurnId = input.sourceTurnId!; this.saveExecution(turn);
    if (input.event === 'turn_started') return done('Source turn acknowledged.', this.asTurnEvent(input, participant.id, null));
    if (input.event === 'turn_interrupted') {
      turn.status = 'interrupted'; this.saveExecution(turn);
      run.pauseRequested = true;
      this.stop(run, 'The assigned CLI turn was interrupted. Inspect unfinished work and background writers before taking over; no handoff was accepted.');
      return done(run.reason);
    }
    if (turn.completion && (input.completionSequence ?? 0) <= (turn.completion.completionSequence ?? 0)) return done('Older completion observation; no workflow transition.');
    turn.completion = input; this.saveExecution(turn);
    const event = this.asTurnEvent(input, participant.id, input.commandId!);
    this.store.addEvent(event);
    const background = input.backgroundState === 'unknown' && evidence ? evidence : { state: input.backgroundState, detail: null };
    const recheckable = run.implementation && !run.pauseRequested && !run.interaction?.active &&
      (run.status === 'running' || !!run.blockedHandoff);
    if (recheckable && (input.settled !== true || background.state !== 'clear' || run.blockedHandoff)) {
      const gate = input.settled !== true ? 'Waiting for settled completion of the assigned turn.'
        : background.state === 'active' ? 'Background work remains active; ownership was not transferred.'
          : background.state !== 'clear' ? 'Background-work state is unknown; waiting for current evidence.'
            : 'Clear completion recorded. Inspect every writer, then recheck the handoff.';
      this.stop(run, gate);
      run.blockedHandoff = { commandId: turn.commandId, revision: randomUUID(), backgroundState: background.state ?? 'unknown',
        ...(input.backgroundSummary ? { backgroundSummary: input.backgroundSummary } : {}),
        publishedSha: publication?.publication?.sha ?? null, publicationError: publication?.error ?? null, gate };
      this.saveRun(run);
      return done(gate, event, input.settled === true && background.state === 'clear' ? 'finished' : 'pending');
    }
    if (input.settled !== true || background.state !== 'clear') {
      this.stop(run, background.state === 'active' ? `Background work remains active${background.detail ? ` (${background.detail})` : ''}; ownership was not transferred.`
        : 'Completion or background-work state is unknown; inspect the workers.');
      return done(run.reason, event);
    }
    turn.status = 'finished'; this.saveExecution(turn);
    if (run.implementation) {
      if (!publication?.publication) { this.stop(run, publication?.error ?? 'No validated handoff result was found.'); return done(run.reason, event); }
      this.consumePublication(run, turn, publication.publication, publication.archive);
      return done(run.reason, event);
    }
    if (run.planning && turn.planning) {
      if (!planCapture?.captured) { this.stop(run, planCapture?.error ?? 'No validated planning result.'); return done(run.reason, event); }
      turn.planning.captured = planCapture.captured; this.saveExecution(turn);
      consumePlan(run.planning, planCapture.captured);
      if (run.pauseRequested || run.status === 'paused') this.stop(run, 'Planning result recorded; the run remains paused until reconciliation.');
      else if (planCapture.captured.result.outcome === 'blocked') this.stop(run, `Planner blocked: ${planCapture.captured.result.reason}`);
      else if (run.interaction?.active) this.holdDisposition(run, 'plan');
      else if (run.planning.next && run.autoContinue) {
        if (run.automaticTurns >= run.turnLimit) this.stop(run, 'Automatic turn budget reached during planning.');
        else this.schedulePlan(run, true);
      } else {
        run.status = 'waiting';
        run.reason = run.planning.next ? 'Plan: ready for the next manual assignment.' : !planAgreed(run.planning) ? 'Plan objection: request changes or explicitly override the recorded disagreement.'
          : `${run.planning.required.length === 1 ? 'Plan ready (solo; not independent consensus)' : 'Plan agreed by every required member'}. ${run.planning.request.requireApproval ? 'Awaiting your approval before Implementation.' : run.autoContinue ? 'Checking the authorized Implementation transition.' : 'Awaiting manual continuation into Implementation.'}`;
        this.saveRun(run);
      }
      return done(run.reason, event);
    }
    if (run.pauseRequested || run.status === 'paused') { this.stop(run, 'Turn finished; run remains paused until human takeover.'); return done(run.reason, event); }
    const isInstruction = turn.input.kind === 'instruction';
    if (isInstruction && turn.input.handoff === true) {
      // A review needs something to review. Compare the worktree with its pre-delivery digest rather than reading the agent's
      // prose: an agent that only asked a question, declined, or reported without editing leaves the digest unchanged.
      if (!turn.baselineWorktree || !worktree) { this.stop(run, 'The worktree could not be read before delivery or at completion, so no review was scheduled. Inspect the worker and take over.'); return done(run.reason, event); }
      if (turn.baselineWorktree === worktree) { this.stop(run, 'The worker finished without changing the worktree (it may have asked for more information); no review was scheduled.', true); return done(run.reason, event); }
    }
    // Event validation refuses C0/C1 controls but not U+2028/U+2029, which promptText rejects; a reason that reached the
    // scheduled instruction unsanitized would throw inside this transaction and leave the run running without a completion.
    const objectionReason = !isInstruction && input.outcome === 'strong_objection' ? input.reason?.replace(/[\u2028\u2029]/gu, ' ').trim() : undefined;
    const shouldContinue = isInstruction ? turn.input.handoff === true
      : run.autoContinue && (input.outcome === 'accept_and_improve' || !!objectionReason);
    if (!shouldContinue) {
      const completed = isInstruction || input.outcome === 'accept_without_improvement' || input.outcome === 'no_incoming_handoff';
      this.stop(run, completed ? 'Chain ended. Final task-level checks are still a human responsibility.' : input.outcome === 'strong_objection' ? `Reviewer objected: ${objectionReason || 'inspect its output'}` : 'Review finished; automatic continuation is off or no outcome was reported.', completed);
      return done(run.reason, event);
    }
    if (run.automaticTurns >= run.turnLimit) { this.stop(run, 'Automatic turn budget reached.'); return done(run.reason, event); }
    const partner = run.participants.find((s) => s.id !== turn.agentId);
    if (!partner || !run.pairId) { this.stop(run, 'No explicit pair was bound to this run.'); return done(run.reason, event); }
    const nextId = randomUUID();
    // Objection remediation is authoring work, not a review of the author's own diff. Send a normal instruction whose
    // handoff returns a changed worktree to the reviewer; do not invoke the review-handoff skill on the author.
    const nextInput: StartInput = objectionReason
      ? { requestId: nextId, agentId: partner.id, kind: 'instruction',
          text: `Address objection: ${objectionReason}\n\nMake the required changes, leave them unstaged, and then return the work for relay review.`,
          handoff: true, confirmReady: true }
      : { requestId: nextId, agentId: partner.id, kind: 'relay', confirmReady: true };
    const next: Execution = { commandId: nextId, runId: run.id, agentId: partner.id, input: nextInput, wireText: wireText(nextInput, partner),
      status: 'planned', sessionId: null, sourceTurnId: null, continuation: true, baselineProcesses: null, baselineWorktree: null };
    // Event receipt, new command, current-turn change, and budget are one SQLite transaction.
    run.currentCommandId = nextId; run.automaticTurns++;
    run.reason = objectionReason ? `Reviewer objected; correction scheduled for ${partner.label}.` : 'Next review scheduled by the server.';
    this.saveExecution(next); this.saveRun(run);
    return done('Exactly one continuation scheduled.', event);
  }
  private commitTurn(run: RelayRun, agentId: string, action: ImplementationAction, text: string, handoff: boolean, commandId: string = randomUUID()): Execution {
    const impl = run.implementation!;
    const participant = run.participants.find((p) => p.id === agentId)!;
    // Like runtime.ts, the host starts from web/. Keep a filesystem path: bundlers must not import this agent document.
    const skill = resolve(process.cwd(), '../skills/commit-handoff/SKILL.md');
    const wire = promptText(`Use the commit-handoff skill at ${JSON.stringify(skill)}. Read your assignment at ${JSON.stringify(join(this.assignmentDirectory, `${commandId}.json`))} and carry it out. [altcli-command:${commandId}]`);
    return { commandId, runId: run.id, agentId, input: { requestId: commandId, agentId, kind: 'instruction', text: text || 'Review the assigned committed candidate.', handoff, confirmReady: true },
      wireText: wire, status: 'planned', sessionId: null, sourceTurnId: null, continuation: commandId !== run.id, baselineProcesses: null, baselineWorktree: null,
      implementation: { resultPath: join(this.assignmentDirectory, `${commandId}.result.json`), identity: { schema: 1, phase: 'implementation', runId: run.id, commandId, turn: impl.turn, policyRevision: impl.revision, action, agentId,
        registrationId: participant.registrationId, parent: impl.expectedParentSha, base: impl.acceptedSha,
        reviewBase: action === 'work' ? null : impl.acceptedSha, reviewHead: action === 'work' ? null : impl.candidateSha } } };
  }
  private planTurn(run: RelayRun): Execution {
    const plan = run.planning!; const next = plan.next!; const participant = plan.participants.find((p) => p.id === next.agentId)!;
    const commandId = next.action === 'draft' ? plan.drafts[next.agentId]!.commandId : randomUUID();
    const outputPath = next.action === 'draft' ? plan.drafts[next.agentId]!.path : plan.planPath;
    if (next.action === 'draft') plan.drafts[next.agentId]!.status = 'running';
    const skill = resolve(process.cwd(), '../skills/plan-handoff/SKILL.md');
    const wire = promptText(`Use the plan-handoff skill at ${JSON.stringify(skill)}. Read your assignment at ${JSON.stringify(join(this.assignmentDirectory, `${commandId}.json`))}. Plan only; do not implement. [altcli-command:${commandId}]`);
    plan.next = null;
    return { commandId, runId: run.id, agentId: next.agentId, input: { requestId: commandId, agentId: next.agentId, kind: 'instruction', text: 'Perform the assigned planning action only.', confirmReady: true },
      wireText: wire, status: 'planned', sessionId: null, sourceTurnId: null, continuation: commandId !== run.id, baselineProcesses: null, baselineWorktree: null,
      planning: { resultPath: join(this.assignmentDirectory, `${commandId}.result.json`), identity: { schema: 1, phase: 'plan', runId: run.id, commandId, epoch: plan.epoch, briefRevision: plan.briefRevision,
        rosterRevision: plan.group.revision, policyRevision: plan.policyRevision, agentId: next.agentId, registrationId: participant.registrationId, action: next.action,
        baseline: plan.request.baseline.head, outputPath, inputRevision: next.action === 'draft' ? null : plan.current?.revision ?? null, inputHash: next.action === 'draft' ? null : plan.current?.hash ?? null } } };
  }
  private schedulePlan(run: RelayRun, automatic: boolean): void {
    const turn = this.planTurn(run); run.currentCommandId = turn.commandId; run.status = 'running'; run.reason = `Plan: ${turn.planning!.identity.action} assigned.`;
    if (automatic) run.automaticTurns++;
    this.saveExecution(turn); this.saveRun(run);
  }
  private planBoundary(input: PlanDecision): RelayRun {
    const run = this.run(input.runId); const plan = run?.planning;
    if (!run || !plan?.current || run.implementation || run.status !== 'waiting' || run.currentCommandId !== input.expectedCommandId || plan.current.revision !== input.expectedRevision || plan.current.hash !== input.expectedHash || plan.briefRevision !== input.expectedBriefRevision || plan.policyRevision !== input.expectedPolicyRevision) throw new AppError('PLAN_CHANGED', 'This plan or its approval boundary changed. Review the current captured version.', 409);
    return run;
  }
  requestPlanChanges(input: PlanDecision): void {
    this.store.db.transaction(() => {
      const run = this.planBoundary(input); const plan = run.planning!;
      if (!input.text?.trim() || !input.agentId || !plan.required.includes(input.agentId)) throw new AppError('INVALID_GUIDANCE', 'Choose a required planner and describe the requested changes.', 409);
      if (plan.brief.length + input.text.length > 32000) throw new AppError('BRIEF_LIMIT', 'The accumulated brief is full. Stop and begin a new scoped planning task.', 409);
      run.restoredCheckpoint = false;
      plan.brief += `\n\nHuman changes (brief revision ${plan.briefRevision + 1}):\n${input.text}`;
      plan.briefRevision++; plan.endorsements = {}; plan.step = 'refinement'; plan.next = { agentId: input.agentId, action: 'revise' };
      this.schedulePlan(run, false);
    }).immediate();
  }
  /** Atomic phase transition: ownership/budgets survive and a frozen plan precedes any branch write. */
  beginImplementation(input: PlanDecision, implementation: ImplementationRun, authority: FrozenPlan['authority']): Execution {
    return this.store.db.transaction(() => {
      const run = this.planBoundary(input); const plan = run.planning!;
      if (authority === 'automatic' && (run.restoredCheckpoint || !run.autoContinue || plan.request.requireApproval || !planAgreed(plan))) throw new AppError('APPROVAL_REQUIRED', 'This transition is not preauthorized.', 409);
      if (!planAgreed(plan) && !input.overrideReason?.trim()) throw new AppError('PLAN_DISAGREEMENT', 'Explicitly acknowledge the missing endorsements or objections before overriding plan judgment.', 409);
      if (authority === 'automatic' && run.automaticTurns >= run.turnLimit) throw new AppError('TURN_LIMIT', 'Automatic turn budget reached before Implementation.', 409);
      plan.frozen = { transitionId: implementation.request.requestId, authorizedAt: now(), authority, overrideReason: input.overrideReason ?? null,
        epoch: plan.epoch, briefRevision: plan.briefRevision, policyRevision: plan.policyRevision, rosterRevision: plan.group.revision, baseline: plan.request.baseline.head,
        brief: plan.brief, planningGroup: plan.group, planners: plan.participants,
        automaticPolicy: { autoContinue: run.autoContinue, requireApproval: plan.request.requireApproval, turnLimit: run.turnLimit, pauseOnObjection: run.pauseOnObjection === true, automaticTurnsBeforeTransition: run.automaticTurns },
        plan: plan.current!, endorsements: { ...plan.endorsements }, objections: { ...plan.objections }, implementation: { ...plan.request.implementation, branch: implementation.consent } };
      plan.step = 'implemented'; plan.next = null;
      run.implementation = implementation; run.participants = plan.implementationParticipants; run.autoContinue = implementation.request.autoContinue;
      const turn = this.commitTurn(run, implementation.request.agentId, 'work', 'Implement the frozen plan within the recorded task scope.', implementation.request.handoff, implementation.request.requestId);
      run.currentCommandId = turn.commandId; run.status = 'running'; run.reason = 'Plan frozen and authorized; Implementation branch setup pending.';
      if (authority === 'automatic') run.automaticTurns++;
      this.saveExecution(turn); this.saveRun(run); return turn;
    }).immediate();
  }
  setupResult(id: string, ready: boolean, reason?: string): void {
    const run = this.run(id)!; run.implementation!.setup = ready ? 'ready' : 'uncertain';
    if (ready) this.saveRun(run); else this.stop(run, reason ?? 'Branch setup is uncertain. Inspect the checkout; nothing will be replayed.');
  }
  claimSetup(id: string): boolean {
    return this.store.db.transaction(() => {
      const run = this.run(id)!;
      if (run.status !== 'running' || run.implementation?.setup !== 'pending') return false;
      run.implementation.setup = 'applying'; this.saveRun(run); return true;
    }).immediate();
  }
  private consumePublication(run: RelayRun, turn: Execution, publication: Publication, archive: HandoffArchive | null): void {
    const impl = run.implementation!;
    turn.implementation!.published = publication; this.saveExecution(turn);
    this.saveJournal(run, turn, publication, archive);
    impl.latestPublication = publication;
    impl.expectedParentSha = publication.sha;
    const { entry, projectChanged } = publication;
    const peer = run.participants.find((p) => p.id !== turn.agentId);
    impl.next = null;
    if (entry.action === 'work') {
      if (projectChanged) {
        impl.candidateSha = publication.sha; impl.candidateAuthor = turn.agentId;
        if (turn.input.handoff && peer) impl.next = { agentId: peer.id, action: impl.policy === 'peer' ? 'review_and_improve' : 'review', text: 'Review the complete candidate against the accepted baseline.', handoff: true };
      }
      run.reason = projectChanged ? 'Proposal published. Final task-level verification remains required.' : `Worker report: ${entry.summary}`;
    } else if (entry.decision === 'accept') {
      impl.acceptedSha = entry.reviewHead!; impl.findings = null;
      if (projectChanged) {
        impl.candidateSha = publication.sha; impl.candidateAuthor = turn.agentId;
        if (peer) impl.next = { agentId: peer.id, action: 'review_and_improve', text: 'Review the new improvements against the accepted candidate.', handoff: true };
      } else impl.candidateSha = null;
      run.reason = 'Review chain completed. Final task-level verification remains required.';
    } else {
      impl.findings = entry.reason;
      const author = impl.policy === 'worker_reviewer' ? impl.workerId : impl.candidateAuthor;
      if (author && author !== turn.agentId) impl.next = { agentId: author, action: 'work', text: 'Address the outstanding reviewer findings within the original task scope. Publish a revised proposal or a log-only report explaining what needs human direction.', handoff: true };
      run.reason = `Reviewer objected: ${entry.reason}`;
    }
    if (run.pauseRequested || run.status === 'paused') { this.stop(run, `Turn publication recorded; run remains paused. ${run.reason}`); return; }
    if (entry.needsHuman) { impl.next = null; this.stop(run, `Human direction required: ${entry.reason ?? entry.summary}`); return; }
    if (!impl.next) { this.stop(run, run.reason, true); return; }
    // An explicit handoff requests its initial review even with subsequent automatic collaboration off.
    const automatic = entry.action === 'work' ? turn.input.handoff === true && (turn.implementation!.identity.turn === 1 || run.autoContinue) : run.autoContinue;
    // An objection routes back to the author like any other turn unless the agreement says it pauses for the human.
    if (!automatic || (entry.decision === 'object' && run.pauseOnObjection === true)) {
      if (run.interaction?.active) { this.holdDisposition(run, 'waiting'); return; }
      run.status = 'waiting'; run.reason = entry.decision === 'object' ? `${run.reason} Next turn sends these findings to the author.` : 'Publication validated. Ready for the next manual handoff.';
      this.saveRun(run); return;
    }
    if (run.automaticTurns >= run.turnLimit) { this.stop(run, 'Automatic turn budget reached.'); return; }
    if (run.interaction?.active) { this.holdDisposition(run, 'automatic'); return; }
    this.scheduleCommit(run, true);
  }
  private scheduleCommit(run: RelayRun, automatic: boolean): void {
    const impl = run.implementation!; const next = impl.next!;
    impl.turn++; impl.next = null;
    const turn = this.commitTurn(run, next.agentId, next.action, next.text, next.handoff);
    run.currentCommandId = turn.commandId; run.status = 'running'; run.reason = 'Next implementation turn scheduled.';
    if (automatic) run.automaticTurns++;
    this.saveExecution(turn); this.saveRun(run);
  }
  continue(id: string, expectedCommandId: string): void {
    this.store.db.transaction(() => {
      const run = this.run(id);
      if (run?.planning && !run.implementation && run.status === 'waiting' && run.currentCommandId === expectedCommandId && run.planning.next) { run.restoredCheckpoint = false; this.schedulePlan(run, false); return; }
      if (!run?.implementation || run.status !== 'waiting' || run.currentCommandId !== expectedCommandId || !run.implementation.next) throw new AppError('HANDOFF_CHANGED', 'This manual handoff is no longer current. Refresh the run.', 409);
      run.restoredCheckpoint = false; this.scheduleCommit(run, false);
    }).immediate();
  }
  /** One explicit decision consumes the retained completion and applies the frozen continuation policy once. */
  recheck(id: string, commandId: string, revision: string, publication: PublicationResult, evidence: BackgroundEvidence | null): void {
    this.store.db.transaction(() => {
      const run = this.run(id); const turn = this.execution(commandId);
      const completion = turn?.completion;
      const background = completion?.source === 'codex' && completion.backgroundState === 'unknown' ? evidence?.state : completion?.backgroundState;
      if (!run?.implementation || run.status !== 'paused' || run.pauseRequested || run.interaction?.active || completion?.settled !== true || background !== 'clear' ||
        run.currentCommandId !== commandId || run.blockedHandoff?.revision !== revision || turn?.status !== 'delivered' || !turn.completion || !publication.publication) {
        throw new AppError('HANDOFF_CHANGED', 'This blocked handoff is no longer current. Refresh and inspect the run.', 409);
      }
      delete run.blockedHandoff; run.status = 'running';
      turn.status = 'finished'; this.saveExecution(turn);
      this.consumePublication(run, turn, publication.publication, publication.archive);
    }).immediate();
  }
  changePolicy(input: PolicyChange): void {
    this.store.db.transaction(() => {
      const run = this.run(input.runId); const impl = run?.implementation;
      if (!run || !impl || run.status !== 'waiting' || run.currentCommandId !== input.expectedCommandId || impl.revision !== input.expectedRevision || !impl.next || run.participants.length !== 2) throw new AppError('POLICY_BOUNDARY', 'Policy changes require the current settled manual handoff. Refresh the run.', 409);
      if (input.policy === 'worker_reviewer' && !run.participants.some((p) => p.id === input.workerId)) throw new AppError('INVALID_ROLE', 'Choose one group member as the worker.', 409);
      const reviewer = input.policy === 'worker_reviewer' ? run.participants.find((p) => p.id !== input.workerId)!.id : run.participants.find((p) => p.id !== impl.candidateAuthor)!.id;
      if (impl.next.action !== 'work' && reviewer === impl.candidateAuthor) throw new AppError('SELF_REVIEW', 'The candidate author cannot become its independent reviewer. Keep that member as worker until this candidate is reviewed.', 409);
      impl.policy = input.policy; impl.workerId = input.policy === 'worker_reviewer' ? input.workerId! : null; impl.revision++;
      impl.next.agentId = impl.next.action === 'work' ? impl.workerId ?? impl.candidateAuthor! : reviewer;
      if (impl.next.action !== 'work') impl.next.action = input.policy === 'peer' ? 'review_and_improve' : 'review';
      run.autoContinue = input.autoContinue; if (input.pauseOnObjection !== undefined) run.pauseOnObjection = input.pauseOnObjection;
      run.reason = 'Collaboration policy updated at the settled boundary. Confirm readiness for Next turn.'; this.saveRun(run);
    }).immediate();
  }
  private asTurnEvent(input: HookEvent, agentId: string, commandId: string | null): TurnEvent {
    return { agentId, paneId: input.paneId, source: input.source, sessionId: input.sessionId ?? null, commandId,
      prompt: input.prompt ?? null, outcome: input.outcome ?? null, reason: input.reason ?? null,
      outcomeState: input.outcome ? 'reported' : 'none', receivedAt: now() };
  }
  pause(id: string, reason = 'Paused by the user. This does not interrupt an agent or release ownership.'): void {
    this.store.db.transaction(() => { const run = this.run(id); if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
      if (!['running','waiting','paused'].includes(run.status)) return;
      run.pauseRequested = true; this.stop(run, reason);
    }).immediate();
  }
  takeover(id: string): void {
    this.store.db.transaction(() => {
      const run = this.run(id); if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
      if (!['running','waiting','paused'].includes(run.status)) return;
      const turn = this.execution(run.currentCommandId)!;
      if (run.implementation?.setup === 'applying') throw new AppError('SETUP_PENDING', 'Wait for the in-flight branch setup before taking over.', 409);
      if (turn.status === 'dispatching') throw new AppError('DELIVERY_PENDING', 'Wait for the in-flight terminal delivery before taking over.', 409);
      const delivery = this.store.activeFor(run.repository);
      if (delivery) this.store.release(delivery);
      run.status = 'stopped'; run.reason = 'Human takeover acknowledged. No command was replayed or process interrupted.'; this.saveRun(run);
      this.store.db.prepare('DELETE FROM workflow_owners WHERE run_id=?').run(id);
    }).immediate();
  }
  recover(): void {
    for (const run of this.runs().filter((r) => ['running','waiting','paused'].includes(r.status))) {
      const turn = this.execution(run.currentCommandId)!;
      if (run.implementation?.setup === 'applying') run.implementation.setup = 'uncertain';
      if (turn.status === 'dispatching') { turn.status = 'uncertain'; this.saveExecution(turn); }
      this.stop(run, 'Backend restarted. Reconcile this run before starting another; nothing was replayed.');
    }
  }
}
