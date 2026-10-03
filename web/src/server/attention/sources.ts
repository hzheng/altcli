import type Database from 'better-sqlite3';
import type { GlobalAIInstance } from '../../contracts/global-ai.ts';
import type { Checkpoint } from '../../contracts/interactions.ts';
import type { LaunchBatch, LaunchInstance } from '../../contracts/launches.ts';
import type { Execution, RelayRun } from '../../contracts/workflow.ts';
import { helperAttention, helperKey, launchAttention, launchKey, runAttention, runKey, type Derived } from './derive.ts';

type DB = Database.Database;
const parse = <T>(row: unknown): T | undefined => row ? JSON.parse((row as { value: string }).value) as T : undefined;
export const loadRun = (db: DB, id: string): RelayRun | undefined => parse(db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id));
const loadExecution = (db: DB, id: string): Execution | undefined => parse(db.prepare('SELECT value FROM workflow_turns WHERE id=?').get(id));
const loadCheckpoint = (db: DB, runId: string): Checkpoint | undefined => parse(db.prepare('SELECT value FROM checkpoints WHERE run_id=?').get(runId));
const exists = (db: DB, table: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
/** Runs that still hold execution ownership; recent-history limits never hide one. Each is read separately, so one unreadable
 * record cannot stop the others from being reconciled. */
export const ownedRunIds = (db: DB): string[] => (db.prepare('SELECT run_id FROM workflow_owners').all() as { run_id: string }[]).map((row) => row.run_id);
/** Unreadable rows are skipped: their items stay open and are labelled stale rather than blocking reconciliation. */
function readable<T>(rows: { value: string }[]): T[] {
  return rows.flatMap((row) => { try { return [JSON.parse(row.value) as T]; } catch { return []; } });
}
export function launchItems(db: DB): Map<string, LaunchInstance> {
  const items = new Map<string, LaunchInstance>();
  for (const batch of readable<LaunchBatch>(db.prepare('SELECT value FROM launches').all() as { value: string }[])) for (const item of batch.items ?? []) items.set(item.id, item);
  return items;
}
/** Helper's table belongs to the app plane and is absent from a bare Store. */
export const helperInstances = (db: DB): GlobalAIInstance[] => exists(db, 'global_ai_instances')
  ? readable<GlobalAIInstance>(db.prepare('SELECT value FROM global_ai_instances').all() as { value: string }[]) : [];
/** Only a paused or waiting run can need the human; reading its turn and checkpoint is skipped otherwise. */
export function deriveRun(db: DB, run: RelayRun): Derived | null {
  return run.status === 'paused' || run.status === 'waiting' ? runAttention(run, loadExecution(db, run.currentCommandId), loadCheckpoint(db, run.id)) : null;
}
/** Records a source's semantic fingerprint in the caller's transaction, so a rolled-back transition leaves no marker. A changed
 * fingerprint raises the source's monotonic version and marks it pending; an empty fingerprint means no attention is needed.
 * Returns whether reconciliation has new work. */
export function markSource(db: DB, source: string, fingerprint: string): boolean {
  const row = db.prepare('SELECT fingerprint FROM attention_sources WHERE source=?').get(source) as { fingerprint: string } | undefined;
  if (!row) {
    if (!fingerprint) return false;
    db.prepare('INSERT INTO attention_sources(source,fingerprint,version,pending) VALUES (?,?,1,1)').run(source, fingerprint);
    return true;
  }
  if (row.fingerprint === fingerprint) return false;
  db.prepare('UPDATE attention_sources SET fingerprint=?, version=version+1, pending=1 WHERE source=?').run(fingerprint, source);
  return true;
}
export const noteRun = (db: DB, run: RelayRun): boolean => markSource(db, runKey(run.id), deriveRun(db, run)?.fingerprint ?? '');
export function noteRunById(db: DB, runId: string): boolean {
  const run = loadRun(db, runId);
  return run ? noteRun(db, run) : false;
}
export const noteLaunch = (db: DB, item: LaunchInstance): boolean => markSource(db, launchKey(item.id), launchAttention(item)?.fingerprint ?? '');
export const noteHelper = (db: DB, instance: GlobalAIInstance): boolean => markSource(db, helperKey(instance.id), helperAttention(instance)?.fingerprint ?? '');
/** Attention bookkeeping must never break the transition that triggered it: a missed marker is repaired by the next sweep. */
export function noting(work: () => boolean, signal: (() => void) | null): void {
  let changed = false;
  try { changed = work(); } catch { /* repaired by the safety sweep */ }
  if (changed) signal?.();
}
