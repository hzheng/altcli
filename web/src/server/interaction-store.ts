import { isDeepStrictEqual } from 'node:util';
import type { Checkpoint, CheckpointInput, InteractionInput, InteractionRecord } from '../contracts/interactions.ts';
import { AppError } from '../core/errors.ts';
import type { Store } from './store.ts';

export class InteractionStore {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  get(id: string): InteractionRecord | undefined {
    const row = this.store.db.prepare('SELECT value FROM interactions WHERE id=?').get(id) as { value: string } | undefined;
    return row && JSON.parse(row.value);
  }
  records(repository?: string): InteractionRecord[] {
    const rows = repository === undefined ? this.store.db.prepare('SELECT value FROM interactions ORDER BY rowid').all()
      : this.store.db.prepare('SELECT value FROM interactions WHERE repository=? ORDER BY rowid').all(repository);
    return (rows as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  /** The console view, bounded like recent commands. Unresolved input stays visible past that window: it still owns a run. */
  recent(limit = 30): InteractionRecord[] {
    return (this.store.db.prepare(`SELECT value FROM interactions
      WHERE rowid IN (SELECT rowid FROM interactions ORDER BY rowid DESC LIMIT ?)
         OR json_extract(value, '$.status') IN ('recorded','sending','uncertain') ORDER BY rowid`).all(limit) as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  duplicate(input: InteractionInput): InteractionRecord | undefined {
    const existing = this.get(input.requestId);
    if (existing && !isDeepStrictEqual(existing.input, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to different input.', 409);
    return existing;
  }
  save(record: InteractionRecord): void {
    this.store.db.prepare('INSERT INTO interactions(id,repository,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.input.requestId, record.repository, JSON.stringify(record));
  }
  pending(runId: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM interactions WHERE json_extract(value, '$.input.runId')=?
      AND json_extract(value, '$.status') IN ('recorded','sending','uncertain') LIMIT 1`).get(runId);
  }
  checkpoint(runId: string): Checkpoint | undefined {
    const row = this.store.db.prepare('SELECT value FROM checkpoints WHERE run_id=?').get(runId) as { value: string } | undefined;
    return row && JSON.parse(row.value);
  }
  checkpoints(): Checkpoint[] {
    return (this.store.db.prepare('SELECT value FROM checkpoints').all() as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  /** Only a run that still holds execution ownership can be reconciled, so nothing else is ever read or scanned.
   * Ownership is exactly the running/waiting/paused set; a completed or taken-over run releases it. */
  activeCheckpoints(): Checkpoint[] {
    return (this.store.db.prepare('SELECT value FROM checkpoints WHERE run_id IN (SELECT run_id FROM workflow_owners)').all() as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  /** Checkpoints of released runs can never be restored; drop them instead of carrying them forever. */
  prune(): void {
    this.store.db.prepare('DELETE FROM checkpoints WHERE run_id NOT IN (SELECT run_id FROM workflow_owners)').run();
  }
  saveCheckpoint(value: Checkpoint): void {
    this.store.db.prepare('INSERT INTO checkpoints(run_id,value) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value').run(value.runId, JSON.stringify(value));
  }
  invalidate(runId: string, reason: string): void {
    const value = this.checkpoint(runId);
    if (value) this.saveCheckpoint({ ...value, revision: value.revision + 1, fault: true, reason });
  }
  duplicateDecision(input: CheckpointInput): boolean {
    const row = this.store.db.prepare('SELECT value FROM checkpoint_decisions WHERE id=?').get(input.requestId) as { value: string } | undefined;
    if (row && !isDeepStrictEqual(JSON.parse(row.value), input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another checkpoint decision.', 409);
    return !!row;
  }
  decide(input: CheckpointInput): void {
    this.store.db.prepare('INSERT INTO checkpoint_decisions(id,value) VALUES (?,?)').run(input.requestId, JSON.stringify(input));
    this.invalidate(input.runId, 'This checkpoint was already reconciled.');
  }
  recover(): void {
    for (const r of this.records()) if (['recorded','sending'].includes(r.status)) this.save({ ...r, status: 'uncertain', updatedAt: new Date().toISOString(), error: 'Restart during input; inspect it, never resend.' });
    this.prune();
    for (const cp of this.activeCheckpoints()) this.invalidate(cp.runId, 'Restart discarded live activity evidence; use deliberate takeover.');
  }
}
