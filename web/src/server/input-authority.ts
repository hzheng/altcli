import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManualSession } from '../contracts/terminals.ts';
import { AppError } from '../core/errors.ts';
import type { Store } from './store.ts';
/** Shared admission counters plus durable barriers; no live writer never implies safe automation. */
export class InputAuthority {
  readonly bootId = randomUUID();
  /** Any keyboard record change invalidates a handoff settled earlier in this boot. */
  revision = 0;
  readonly store: Store;
  private operations = 0;
  private acquiring = false;
  constructor(store: Store) {
    this.store = store;
    for (const s of this.sessions()) if (s.live) this.save({ ...s, live: false, reconciliationRequired: true, reason: 'Host restarted; inspect and reconcile manual input.' });
  }
  sessions(): ManualSession[] { return (this.store.db.prepare('SELECT value FROM keyboard_sessions ORDER BY rowid').all() as { value: string }[]).map(r => JSON.parse(r.value)); }
  pending(): ManualSession[] { return this.sessions().filter(s => s.reconciliationRequired || s.live); }
  get blocked(): boolean { return this.acquiring || this.pending().length > 0; }
  get busy(): boolean { return this.operations > 0 || this.acquiring; }
  assertAutomated(): void {
    if (this.blocked) throw new AppError('MANUAL_INPUT_HELD', 'Manual terminal input holds dispatch, setup and launch across this tmux server. Release and reconcile it first.', 409);
  }
  async automated<T>(work: () => Promise<T> | T): Promise<T> {
    this.assertAutomated(); this.operations++;
    try { return await work(); } finally { this.operations--; }
  }
  async acquire<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new AppError('INPUT_BUSY', 'A delivery or setup operation is still in flight. Wait for its observed result.', 409);
    this.acquiring = true;
    try { return await work(); } finally { this.acquiring = false; }
  }
  save(session: ManualSession): ManualSession {
    const next = { ...session, revision: session.revision + 1, updatedAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO keyboard_sessions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(next.id, JSON.stringify(next));
    this.revision++;
    return next;
  }
  get(id: string): ManualSession {
    const session = this.sessions().find(s => s.id === id);
    if (!session) throw new AppError('MANUAL_CHANGED', 'This manual input record is unavailable.', 409);
    return session;
  }
  markInput(id: string, bytes: number): void {
    const s = this.get(id);
    if (!s.live) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended. No input was sent.', 409);
    this.save({ ...s, inputMayHaveOccurred: true, bytes: s.bytes + bytes });
  }
  release(id: string, reason: string): ManualSession { return this.save({ ...this.get(id), live: false, reconciliationRequired: true, reason }); }
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
