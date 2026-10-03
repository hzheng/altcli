import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AttentionFeed, AttentionItem, AttentionPage } from '../../contracts/attention.ts';
import type { GlobalAIInstance } from '../../contracts/global-ai.ts';
import type { LaunchInstance } from '../../contracts/launches.ts';
import type { RelayRun } from '../../contracts/workflow.ts';
import { AppError } from '../../core/errors.ts';
import { helperAttention, helperKey, helperResolution, launchAttention, launchKey, launchResolution, runKey, runResolution, type Derived } from './derive.ts';
import { deriveRun, helperInstances, launchItems, loadRun, markSource, ownedRunIds } from './sources.ts';

const SWEEP_MS = 15_000;
const FEED_ITEMS = 20, RECENT_ITEMS = 10, PAGE_ITEMS = 50, KEEP_RESOLVED = 200, KEEP_MS = 7 * 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type SourceRecord = { found: false } | { found: true; derived: Derived | null; resolution: string };
interface Row { id: string; key: string; fingerprint: string; value: string }
const itemOf = (row: { value: string }): AttentionItem => JSON.parse(row.value) as AttentionItem;

/** Deterministic attention on the existing connection: it derives, revises and resolves one item per issue from recorded state.
 * It never calls a model, reads terminals or changes a run, approval, hold or launch. Reconciliation is synchronous SQLite work in
 * one transaction, woken after commits that marked a source and repeated by a safety sweep that needs no browser. */
export class AttentionService {
  readonly db: Database.Database;
  private readonly now: () => Date;
  private scheduled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The last failed reconciliation, kept for diagnostics; items keep their last known state meanwhile. */
  lastError: string | null = null;
  constructor(db: Database.Database, now: () => Date = () => new Date()) { this.db = db; this.now = now; }
  /** Reconciles at once (the boot pass repairs markers written while nothing listened), then sweeps periodically. */
  start(): void {
    this.attempt(true);
    if (!this.timer) { this.timer = setInterval(() => this.attempt(true), SWEEP_MS); this.timer.unref?.(); }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** After-commit wake-up: coalesced and never awaited by the transition that marked a source. */
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.attempt(false); });
  }
  private attempt(full: boolean): void {
    try { this.reconcile(full); this.lastError = null; } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
  }
  /** `full` also scans every owned run and uncertain launch, repairing any marker a missed path did not write. */
  reconcile(full = false): void {
    this.db.transaction(() => this.reconcileNow(full)).immediate();
  }
  private reconcileIfPending(): void {
    if (this.db.prepare('SELECT 1 FROM attention_sources WHERE pending=1 LIMIT 1').get()) this.reconcile(false);
  }
  private reconcileNow(full: boolean): void {
    const at = this.now().toISOString();
    const open = new Map((this.db.prepare("SELECT id,key,fingerprint,value FROM attention_items WHERE status='open'").all() as Row[]).map((row) => [row.key, row]));
    const keys = new Set<string>([...(this.db.prepare('SELECT source FROM attention_sources WHERE pending=1').all() as { source: string }[]).map((row) => row.source), ...open.keys()]);
    let launches: Map<string, LaunchInstance> | null = null, helpers: GlobalAIInstance[] | null = null;
    const launchesNow = () => launches ??= launchItems(this.db), helpersNow = () => helpers ??= helperInstances(this.db);
    if (full) {
      for (const id of ownedRunIds(this.db)) keys.add(runKey(id));
      for (const item of launchesNow().values()) if (launchAttention(item)) keys.add(launchKey(item.id));
      for (const instance of helpersNow()) if (helperAttention(instance)) keys.add(helperKey(instance.id));
    }
    for (const key of keys) {
      const record = this.record(key, launchesNow, helpersNow), row = open.get(key);
      if (!record.found) {
        // An unreadable or missing source is unknown: keep the item, labelled stale, until a record proves its disposition.
        if (row && !itemOf(row).stale) this.write(row, { ...itemOf(row), stale: true }, row.fingerprint);
        continue;
      }
      markSource(this.db, key, record.derived?.fingerprint ?? '');
      const version = (this.db.prepare('SELECT version FROM attention_sources WHERE source=?').get(key) as { version: number } | undefined)?.version ?? 0;
      const derived = record.derived;
      if (derived && !row) {
        const item: AttentionItem = { id: randomUUID(), key, kind: derived.kind, facets: derived.facets, subject: derived.subject, title: derived.title,
          detail: derived.detail, destination: derived.destination, revision: 1, sourceVersion: version, status: 'open', openedAt: at, updatedAt: at,
          resolvedAt: null, resolution: null, seenRevision: null, stale: false };
        this.db.prepare('INSERT INTO attention_items(id,key,status,fingerprint,updated_at,value) VALUES (?,?,?,?,?,?)').run(item.id, key, 'open', derived.fingerprint, at, JSON.stringify(item));
      } else if (derived && row) {
        const item = itemOf(row), changed = row.fingerprint !== derived.fingerprint;
        if (changed || item.sourceVersion !== version || item.stale) this.write(row, { ...item, kind: derived.kind, facets: derived.facets, subject: derived.subject,
          title: derived.title, detail: derived.detail, destination: derived.destination, revision: item.revision + (changed ? 1 : 0), sourceVersion: version,
          stale: false, updatedAt: changed ? at : item.updatedAt }, derived.fingerprint);
      } else if (row) {
        this.write(row, { ...itemOf(row), status: 'resolved', resolvedAt: at, resolution: record.resolution, sourceVersion: version, stale: false, updatedAt: at }, row.fingerprint, 'resolved');
      }
      this.db.prepare('UPDATE attention_sources SET pending=0 WHERE source=? AND version=?').run(key, version);
    }
    this.prune(at);
  }
  private record(key: string, launches: () => Map<string, LaunchInstance>, helpers: () => GlobalAIInstance[]): SourceRecord {
    const [type, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    try {
      if (type === 'run') {
        const run: RelayRun | undefined = loadRun(this.db, id);
        return run ? { found: true, derived: deriveRun(this.db, run), resolution: runResolution(run) } : { found: false };
      }
      if (type === 'launch') {
        const item = launches().get(id);
        return item ? { found: true, derived: launchAttention(item), resolution: launchResolution(item) } : { found: false };
      }
      if (type === 'helper') {
        const instance = helpers().find((i) => i.id === id);
        return instance ? { found: true, derived: helperAttention(instance), resolution: helperResolution(instance) } : { found: false };
      }
    } catch { /* unreadable: unknown */ }
    return { found: false };
  }
  private write(row: Row, item: AttentionItem, fingerprint: string, status: 'open' | 'resolved' = 'open'): void {
    this.db.prepare('UPDATE attention_items SET status=?, fingerprint=?, updated_at=?, value=? WHERE id=?').run(status, fingerprint, item.updatedAt, JSON.stringify(item), row.id);
  }
  /** Open items are never pruned; resolved history keeps the newest 200 within seven days. */
  private prune(at: string): void {
    const cutoff = new Date(Date.parse(at) - KEEP_MS).toISOString();
    this.db.prepare(`DELETE FROM attention_items WHERE status='resolved' AND (updated_at < ? OR id NOT IN
      (SELECT id FROM attention_items WHERE status='resolved' ORDER BY updated_at DESC, id DESC LIMIT ?))`).run(cutoff, KEEP_RESOLVED);
    this.db.prepare(`DELETE FROM attention_sources WHERE fingerprint='' AND pending=0
      AND source NOT IN (SELECT key FROM attention_items WHERE status='open')`).run();
  }
  /** Counts and the first page of open items, plus recent resolutions. Pending source changes are reconciled first. */
  feed(): AttentionFeed {
    this.reconcileIfPending();
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const open = count("SELECT COUNT(*) AS n FROM attention_items WHERE status='open'");
    const unseen = count(`SELECT COUNT(*) AS n FROM attention_items WHERE status='open' AND (json_extract(value,'$.seenRevision') IS NULL
      OR json_extract(value,'$.seenRevision') < json_extract(value,'$.revision'))`);
    const list = (status: string, limit: number) => (this.db.prepare('SELECT value FROM attention_items WHERE status=? ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(status, limit) as { value: string }[]).map(itemOf);
    return { open, unseen, items: list('open', FEED_ITEMS), recent: list('resolved', RECENT_ITEMS), truncated: open > FEED_ITEMS,
      revision: this.openRevision(), observedAt: this.now().toISOString() };
  }
  /** A complete, cursor-paged list of open or resolved items, newest first. */
  page(status: 'open' | 'resolved', cursor: string | null): AttentionPage {
    this.reconcileIfPending();
    let after: [string, string] | null = null;
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
      if (decoded.length !== 2 || !decoded[0] || !UUID.test(decoded[1]!)) throw new AppError('INVALID_CURSOR', 'Unknown attention cursor; read the first page again.');
      after = [decoded[0], decoded[1]!];
    }
    const rows = (after ? this.db.prepare(`SELECT id,updated_at,value FROM attention_items WHERE status=? AND (updated_at < ? OR (updated_at = ? AND id < ?))
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(status, after[0], after[0], after[1], PAGE_ITEMS + 1)
      : this.db.prepare('SELECT id,updated_at,value FROM attention_items WHERE status=? ORDER BY updated_at DESC, id DESC LIMIT ?').all(status, PAGE_ITEMS + 1)) as { id: string; updated_at: string; value: string }[];
    const last = rows.length > PAGE_ITEMS ? rows[PAGE_ITEMS - 1]! : null;
    return { items: rows.slice(0, PAGE_ITEMS).map(itemOf), next: last && Buffer.from(`${last.updated_at}\n${last.id}`).toString('base64url'),
      revision: this.openRevision(), observedAt: this.now().toISOString() };
  }
  /** Digest of every open item's ID, material revision, seen revision and stale flag. It changes whenever any of them opens,
   * resolves, changes or is marked seen, so a client holding all pages can tell its copy is no longer current. */
  private openRevision(): string {
    const rows = this.db.prepare(`SELECT id, json_extract(value,'$.revision') AS revision, json_extract(value,'$.sourceVersion') AS sourceVersion, json_extract(value,'$.seenRevision') AS seen,
      json_extract(value,'$.stale') AS stale FROM attention_items WHERE status='open' ORDER BY id`).all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  item(id: string): AttentionItem | undefined {
    this.reconcileIfPending();
    const row = this.db.prepare('SELECT value FROM attention_items WHERE id=?').get(id) as { value: string } | undefined;
    return row && itemOf(row);
  }
  /** Newest open items and the total, for Helper's host-wide read. */
  open(limit = 40): { items: AttentionItem[]; total: number } {
    this.reconcileIfPending();
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM attention_items WHERE status='open'").get() as { n: number }).n;
    return { items: (this.db.prepare("SELECT value FROM attention_items WHERE status='open' ORDER BY updated_at DESC, id DESC LIMIT ?").all(limit) as { value: string }[]).map(itemOf), total };
  }
  /** Idempotently marks the exact current revision seen. A changed item refuses, so the owner sees its new state first. */
  markSeen(value: unknown): AttentionItem {
    const b = value as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['action', 'itemId', 'revision'].includes(k)) || b.action !== 'mark-seen'
      || typeof b.itemId !== 'string' || !UUID.test(b.itemId) || !Number.isSafeInteger(b.revision) || (b.revision as number) < 1)
      throw new AppError('INVALID_INPUT', 'Send action mark-seen with an item ID and its revision.');
    this.reconcileIfPending();
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT id,key,fingerprint,value FROM attention_items WHERE id=?').get(b.itemId) as Row | undefined;
      if (!row) throw new AppError('ATTENTION_UNKNOWN', 'This attention item is no longer recorded.', 404);
      const item = itemOf(row);
      if (item.revision !== b.revision) throw new AppError('ATTENTION_CHANGED', 'This item changed since it was shown. Review its current revision first.', 409);
      if (item.seenRevision === item.revision) return item;
      const seen = { ...item, seenRevision: item.revision };
      this.db.prepare('UPDATE attention_items SET value=? WHERE id=?').run(JSON.stringify(seen), row.id);
      return seen;
    }).immediate();
  }
}
