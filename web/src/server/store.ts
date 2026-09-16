import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandRecord, RelayPair, Reservation, SessionRegistration, TurnEvent } from "../contracts/api.ts";
import { AppError } from "../core/errors.ts";
import { sameRequest, suggestAgentType } from "../core/policy.ts";
export class Store {
  readonly db: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, "codercrew.sqlite3");
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 3) throw new Error("Unsupported database version. Do not downgrade this store.");
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pairs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reservations (repository TEXT PRIMARY KEY, active_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, value TEXT NOT NULL);
      `);
      if (version === 1) this.migrateFromV1();
      this.db.exec("PRAGMA user_version = 3"); // v3 only adds the events table
    })();
  }
  /** v1 had one global reservation in `control` and sessions without agentType. */
  private migrateFromV1(): void {
    for (const session of this.sessions()) {
      if (!session.agentType) this.db.prepare("UPDATE sessions SET value=? WHERE id=?").run(JSON.stringify({ ...session, agentType: suggestAgentType(session.expectedCommand) }), session.id);
    }
    const row = this.db.prepare("SELECT active_id FROM control WHERE id=1").get() as { active_id: string | null } | undefined;
    if (row?.active_id) {
      const command = this.get(row.active_id);
      const repository = this.sessions().find((s) => s.id === command?.agentId)?.repository ?? "(unknown)";
      this.db.prepare("INSERT OR IGNORE INTO reservations(repository, active_id) VALUES (?,?)").run(repository, row.active_id);
    }
    this.db.exec("DROP TABLE control");
  }
  close(): void { this.db.close(); }
  sessions(): SessionRegistration[] {
    // Registration order; an upsert keeps its row, so re-registering a worker does not move it.
    return (this.db.prepare("SELECT value FROM sessions ORDER BY rowid").all() as { value: string }[]).map((r) => JSON.parse(r.value) as SessionRegistration);
  }
  pairs(): RelayPair[] {
    return (this.db.prepare("SELECT value FROM pairs ORDER BY rowid").all() as { value: string }[]).map((r) => JSON.parse(r.value) as RelayPair);
  }
  reservations(): Reservation[] {
    return (this.db.prepare("SELECT repository, active_id FROM reservations ORDER BY rowid").all() as { repository: string; active_id: string }[])
      .map((r) => ({ repository: r.repository, activeCommandId: r.active_id }));
  }
  activeFor(repository: string): string | null {
    return (this.db.prepare("SELECT active_id FROM reservations WHERE repository=?").get(repository) as { active_id: string } | undefined)?.active_id ?? null;
  }
  private assertNoTurn(repository: string, what: string): void {
    if (this.activeFor(repository)) throw new AppError("TURN_ACTIVE", `${repository} has a command in flight or an uncertain delivery; confirm it before ${what}.`, 409);
  }
  /** Returns true when an existing registration with the same id was replaced. */
  saveSession(session: SessionRegistration): boolean {
    return this.db.transaction(() => {
      const previous = this.sessions().find((s) => s.id === session.id);
      if (previous) this.assertNoTurn(previous.repository, "changing registrations");
      this.assertNoTurn(session.repository, "changing registrations");
      const duplicate = this.sessions().find((s) => s.id !== session.id && s.identity.socketPath === session.identity.socketPath && s.identity.paneId === session.identity.paneId);
      if (duplicate) throw new AppError("DUPLICATE_PANE", `This pane is already registered as "${duplicate.label}".`, 409);
      const pair = previous && previous.repository !== session.repository ? this.pairs().find((p) => p.sessions.includes(session.id)) : undefined;
      if (pair) throw new AppError("IN_PAIR", `"${previous!.label}" belongs to the pair "${pair.name}" in ${previous!.repository}. Remove the pair before moving it to another repository.`, 409);
      this.db.prepare("INSERT INTO sessions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(session.id, JSON.stringify(session));
      return Boolean(previous);
    }).immediate();
  }
  removeSession(id: string): void {
    this.db.transaction(() => {
      const session = this.sessions().find((s) => s.id === id);
      if (!session) throw new AppError("NOT_REGISTERED", "No registration with this id.", 404);
      this.assertNoTurn(session.repository, "removing a registration");
      const pair = this.pairs().find((p) => p.sessions.includes(id));
      if (pair) throw new AppError("IN_PAIR", `"${session.label}" belongs to the pair "${pair.name}". Remove the pair first.`, 409);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    }).immediate();
  }
  savePair(pair: RelayPair): void {
    this.db.transaction(() => {
      this.assertNoTurn(pair.repository, "changing pairs");
      if (this.pairs().some((p) => p.id === pair.id)) throw new AppError("PAIR_EXISTS", `A pair named "${pair.name}" already exists. Remove it first.`, 409);
      this.db.prepare("INSERT INTO pairs(id,value) VALUES (?,?)").run(pair.id, JSON.stringify(pair));
    }).immediate();
  }
  removePair(id: string): void {
    this.db.transaction(() => {
      const pair = this.pairs().find((p) => p.id === id);
      if (!pair) throw new AppError("NOT_FOUND", "No pair with this id.", 404);
      this.assertNoTurn(pair.repository, "removing a pair");
      this.db.prepare("DELETE FROM pairs WHERE id=?").run(id);
    }).immediate();
  }
  get(id: string): CommandRecord | undefined {
    const row = this.db.prepare("SELECT value FROM commands WHERE id=?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as CommandRecord : undefined;
  }
  recent(): CommandRecord[] {
    // Stable append order avoids relying on wall-clock ordering.
    return (this.db.prepare("SELECT value FROM commands ORDER BY rowid DESC LIMIT 30").all() as { value: string }[]).map((r) => JSON.parse(r.value) as CommandRecord);
  }
  update(record: CommandRecord): void {
    this.db.prepare("UPDATE commands SET value=? WHERE id=?").run(JSON.stringify(record), record.id);
  }
  /** Reserves one worktree while a command is in flight or its delivery is uncertain. Different worktrees do not share an index and may run concurrently. */
  reserve(record: CommandRecord, repository: string): { record: CommandRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.get(record.id);
      if (existing) {
        if (!sameRequest(existing, record)) throw new AppError("ID_CONFLICT", "This request ID belongs to a different command.", 409);
        return { record: existing, created: false };
      }
      if (this.activeFor(repository)) throw new AppError("TURN_ACTIVE", `${repository} still has a command in flight or an uncertain delivery. Inspect its panes and confirm before sending another command there.`, 409);
      this.db.prepare("INSERT INTO commands(id,value) VALUES (?,?)").run(record.id, JSON.stringify(record));
      this.db.prepare("INSERT INTO reservations(repository, active_id) VALUES (?,?)").run(repository, record.id);
      return { record, created: true };
    }).immediate();
  }
  release(id: string): void {
    this.db.transaction(() => {
      const reservation = this.reservations().find((r) => r.activeCommandId === id);
      if (!reservation) throw new AppError("TURN_CHANGED", "This command no longer holds the worktree. Refresh the console.", 409);
      const record = this.get(id);
      if (!record || record.status === "recorded" || record.status === "sending") throw new AppError("DELIVERY_PENDING", "Delivery is still in progress.", 409);
      this.update({ ...record, releasedAt: new Date().toISOString() });
      this.db.prepare("DELETE FROM reservations WHERE repository=?").run(reservation.repository);
    }).immediate();
  }
  /** Appends a CLI lifecycle event and keeps the table bounded; the console only needs the latest per session. */
  addEvent(event: TurnEvent): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO events(agent_id, value) VALUES (?,?)").run(event.agentId, JSON.stringify(event));
      this.db.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)").run();
    }).immediate();
  }
  /** Latest event per registered session, plus the latest unmatched event so a misconfigured hook is visible. */
  latestTurns(): TurnEvent[] {
    return (this.db.prepare(`SELECT value FROM events WHERE id IN (
        SELECT MAX(id) FROM events GROUP BY COALESCE(agent_id, '')
      ) ORDER BY id`).all() as { value: string }[]).map((r) => ({ outcome: null, reason: null, outcomeState: "none", prompt: null, ...JSON.parse(r.value) } as TurnEvent)); // rows older than these fields
  }
  /** The latest event for a pane, with its row id, so a follow-up can complete it in place. */
  latestEventForPane(paneId: string): { id: number; event: TurnEvent } | undefined {
    const rows = this.db.prepare("SELECT id, value FROM events ORDER BY id DESC LIMIT 50").all() as { id: number; value: string }[];
    for (const row of rows) { const event = JSON.parse(row.value) as TurnEvent; if (event.paneId === paneId) return { id: row.id, event }; }
    return undefined;
  }
  updateEvent(id: number, event: TurnEvent): void {
    this.db.prepare("UPDATE events SET value=? WHERE id=?").run(JSON.stringify(event), id);
  }
  recoverInterrupted(): void {
    // Called only by the one backend instance.
    // Single host process only; a second server sharing this DB is unsupported.
    for (const reservation of this.reservations()) {
      const record = this.get(reservation.activeCommandId);
      if (!record) { this.db.prepare("DELETE FROM reservations WHERE repository=?").run(reservation.repository); continue; }
      if (["recorded", "sending"].includes(record.status)) this.update({ ...record, status: "uncertain", updatedAt: new Date().toISOString(), error: "Backend restarted during delivery. Inspect the terminal; this command will not be replayed." });
      // A delivered or rejected command holds nothing (ADR-0008); holds left by the earlier rule are settled here.
      else if (record.status === "delivered" || record.status === "rejected") this.release(record.id);
    }
  }
}
