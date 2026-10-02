import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManualSession, ManualWriter } from '../contracts/terminals.ts';
import { AppError } from '../core/errors.ts';
import type { Store } from './store.ts';
import { manualCovers, scopesOverlap, type InputScopes } from '../core/input-scope.ts';
/** Shared admission counters plus durable barriers; no live writer never implies safe automation. */
export class InputAuthority {
  readonly bootId = randomUUID();
  readonly store: Store;
  private readonly operations = new Set<{ scopes: InputScopes }>();
  private readonly acquisitions = new Set<{ scopes: InputScopes }>();
  constructor(store: Store) {
    this.store = store;
    for (const s of this.sessions()) if (s.live || s.reconciliationRequired) this.save({ ...s, live: false,
      writers: s.writers.map(w => ({ ...w, live: false })), recoveryRequired: true,
      reconciliationRequired: true, reason: 'Host restarted; inspect and reconcile manual input.' });
  }
  sessions(): ManualSession[] { return (this.store.db.prepare('SELECT value FROM keyboard_sessions ORDER BY rowid').all() as { value: string }[]).map(r => JSON.parse(r.value)); }
  pending(scopes: InputScopes = null): ManualSession[] { return this.sessions().filter(s => (s.reconciliationRequired || s.live) && manualCovers(s, scopes)); }
  blockedFor(scopes: InputScopes): boolean { return [...this.acquisitions].some(s => scopesOverlap(s.scopes, scopes)) || this.pending(scopes).length > 0; }
  busyFor(scopes: InputScopes): boolean { return [...this.operations, ...this.acquisitions].some(s => scopesOverlap(s.scopes, scopes)); }
  revisionFor(scopes: InputScopes): number { return this.sessions().filter(s => manualCovers(s, scopes)).reduce((sum, s) => sum + s.revision, 0); }
  get blocked(): boolean { return this.blockedFor(null); }
  get busy(): boolean { return this.busyFor(null); }
  assertAutomated(scopes: InputScopes = null): void {
    if (this.blockedFor(scopes)) throw new AppError('MANUAL_INPUT_HELD', 'Manual terminal input holds this worktree or the whole server. Release and reconcile it first.', 409);
  }
  async automated<T>(work: () => Promise<T> | T, scopes: InputScopes = null): Promise<T> {
    this.assertAutomated(scopes); const held = { scopes: scopes && [...scopes] }; this.operations.add(held);
    try { return await work(); } finally { this.operations.delete(held); }
  }
  async acquire<T>(work: () => Promise<T>, scopes: InputScopes = null): Promise<T> {
    if (this.busyFor(scopes)) throw new AppError('INPUT_BUSY', 'A delivery or setup operation is still in flight in this scope. Wait for its observed result.', 409);
    const held = { scopes: scopes && [...scopes] }; this.acquisitions.add(held);
    try { return await work(); } finally { this.acquisitions.delete(held); }
  }
  /** Draining/closing is manual work too; no settled check can overtake it. */
  async draining<T>(work: () => Promise<T>, scopes: InputScopes = null): Promise<T> {
    const held = { scopes: scopes && [...scopes] }; this.operations.add(held);
    try { return await work(); } finally { this.operations.delete(held); }
  }
  save(session: ManualSession): ManualSession {
    const next = { ...session, live: session.writers.some(w => w.live), revision: session.revision + 1, updatedAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(next.id, JSON.stringify(next));
    return next;
  }
  get(id: string): ManualSession {
    const session = this.sessions().find(s => s.id === id);
    if (!session) throw new AppError('MANUAL_CHANGED', 'This manual input record is unavailable.', 409);
    return session;
  }
  writer(id: string, connectionId: string): ManualWriter {
    const writer = this.get(id).writers.find(w => w.connectionId === connectionId);
    if (!writer) throw new AppError('KEYBOARD_REVOKED', 'This writer record is unavailable.', 409);
    return writer;
  }
  updateWriter(id: string, connectionId: string, patch: Partial<ManualWriter>): ManualSession {
    const s = this.get(id), writer = this.writer(id, connectionId);
    return this.save({ ...s, writers: s.writers.map(w => w.connectionId === connectionId ? { ...writer, ...patch, revision: writer.revision + 1 } : w) });
  }
  markInput(id: string, connectionId: string, generation: string, bytes: number): void {
    const s = this.get(id);
    const writer = this.writer(id, connectionId);
    if (!writer.live || writer.generation !== generation) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended. No input was sent.', 409);
    this.save({ ...s, inputMayHaveOccurred: true, bytes: s.bytes + bytes, writers: s.writers.map(w => w.connectionId === connectionId
      ? { ...w, revision: w.revision + 1, inputMayHaveOccurred: true, bytes: w.bytes + bytes } : w) });
  }
  release(id: string, connectionId: string, reason: string, uncertain = false): ManualSession {
    const s = this.get(id);
    return this.save({ ...s, writers: s.writers.map(w => w.connectionId === connectionId ? { ...w, live: false, revision: w.revision + 1 } : w),
      reconciliationRequired: true, recoveryRequired: s.recoveryRequired || uncertain, reason });
  }
  duplicate<T>(id: string, input: unknown): T | undefined {
    const row = this.store.db.prepare('SELECT value FROM terminal_decisions WHERE id=?').get(id) as { value: string } | undefined;
    if (!row) return;
    const prior = JSON.parse(row.value);
    if (!isDeepStrictEqual(prior.input, input)) throw new AppError('ID_CONFLICT', 'This request ID belongs to another terminal decision.', 409);
    return prior.result as T;
  }
  decide(id: string, input: unknown, result: unknown): void {
    this.store.db.prepare('INSERT INTO terminal_decisions(id,value) VALUES (?,?)').run(id, JSON.stringify({ input, result }));
  }
}
