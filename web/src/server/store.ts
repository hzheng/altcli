import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, CommandRecord, RelayPair, Reservation, SessionRegistration, TurnEvent } from "../contracts/api.ts";
import { AppError } from "../core/errors.ts";
import { sameRequest, suggestAgentType } from "../core/policy.ts";
import type { Group } from "../contracts/implementation.ts";
import type { ProjectRecord, WorktreeCreation, WorktreeDiscard, WorktreeIntegration, WorktreeRemoval } from '../contracts/projects.ts';
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
    if (version > 12) throw new Error("Unsupported database version. Do not downgrade this store.");
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pairs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reservations (repository TEXT PRIMARY KEY, active_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worktree_creations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worktree_removals (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worktree_integrations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worktree_discards (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS worktree_creation_owner ON worktree_creations(project_id) WHERE status IN ('applying', 'uncertain');
      `);
      if (version === 1) this.migrateFromV1();
      if (version < 5) for (const pair of this.pairs()) this.saveGroup({ id: pair.id, name: pair.name, repository: pair.repository,
        cwd: null, members: pair.sessions, revision: 1, createdAt: pair.createdAt, legacyPairId: pair.id });
      this.db.exec("PRAGMA user_version = 12"); // older servers must not reuse retired squash checkpoints
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
  projects(): ProjectRecord[] {
    return (this.db.prepare('SELECT value FROM projects ORDER BY rowid').all() as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  saveProject(project: ProjectRecord): void {
    this.db.prepare('INSERT INTO projects(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(project.id, JSON.stringify(project));
  }
  worktreeCreations(): WorktreeCreation[] {
    return (this.db.prepare('SELECT value FROM worktree_creations ORDER BY rowid').all() as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  saveWorktreeCreation(operation: WorktreeCreation): void {
    this.db.prepare('INSERT INTO worktree_creations(id,project_id,status,value) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value')
      .run(operation.input.requestId, operation.input.projectId, operation.status, JSON.stringify(operation));
  }
  worktreeRemovals(): WorktreeRemoval[] {
    return (this.db.prepare('SELECT value FROM worktree_removals ORDER BY rowid').all() as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  saveWorktreeRemoval(operation: WorktreeRemoval): void {
    this.db.prepare('INSERT INTO worktree_removals(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(operation.input.requestId, JSON.stringify(operation));
  }
  worktreeIntegrations(): WorktreeIntegration[] {
    return (this.db.prepare('SELECT value FROM worktree_integrations ORDER BY rowid').all() as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  saveWorktreeIntegration(operation: WorktreeIntegration): void {
    this.db.prepare('INSERT INTO worktree_integrations(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(operation.input.requestId, JSON.stringify(operation));
  }
  /** Keep results for deduplication and history, but never reuse a removed worktree's batch boundary. */
  retireWorktreeIntegrations(projectId: string, worktreeId: string): void {
    for (const operation of this.worktreeIntegrations()) {
      if (operation.status === 'integrated' && !operation.retired && operation.input.projectId === projectId && operation.input.worktreeId === worktreeId) {
        this.saveWorktreeIntegration({ ...operation, retired: true });
      }
    }
  }
  worktreeDiscards(): WorktreeDiscard[] {
    return (this.db.prepare('SELECT value FROM worktree_discards ORDER BY rowid').all() as { value: string }[]).map((row) => JSON.parse(row.value));
  }
  saveWorktreeDiscard(operation: WorktreeDiscard): void {
    this.db.prepare('INSERT INTO worktree_discards(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(operation.input.requestId, JSON.stringify(operation));
  }
  sessions(): SessionRegistration[] {
    // Registration order; an upsert keeps its row, so re-registering a worker does not move it.
    return (this.db.prepare("SELECT value FROM sessions ORDER BY rowid").all() as { value: string }[]).map((r) => JSON.parse(r.value) as SessionRegistration);
  }
  pairs(): RelayPair[] {
    return (this.db.prepare("SELECT value FROM pairs ORDER BY rowid").all() as { value: string }[]).map((r) => JSON.parse(r.value) as RelayPair);
  }
  groups(): Group[] {
    return (this.db.prepare('SELECT value FROM groups ORDER BY rowid').all() as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  saveGroup(group: Group): void {
    this.db.prepare('INSERT INTO groups(id,value) VALUES (?,?)').run(group.id, JSON.stringify(group));
  }
  removeGroup(id: string): void { this.db.prepare('DELETE FROM groups WHERE id=?').run(id); }
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
      if (previous && previous.repository !== session.repository && this.groups().some((g) => g.members.includes(session.id))) throw new AppError('IN_GROUP', 'Remove this agent from its group before moving repositories.', 409);
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
      if (this.groups().some((g) => g.members.includes(id) && !g.legacyPairId)) throw new AppError('IN_GROUP', 'Remove the group before removing this agent.', 409);
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
  /** Forget every pair and registration on one worktree in one transaction. Refuses while a command is in flight or an
   * uncertain delivery holds it. Command history and hook events are kept; no process is touched. */
  clearRepository(repository: string): { sessions: AgentId[]; pairs: string[]; groups: string[] } {
    return this.db.transaction(() => {
      this.assertNoTurn(repository, "resetting a workspace");
      const pairs = this.pairs().filter((p) => p.repository === repository).map((p) => p.id);
      const groups = this.groups().filter((g) => g.repository === repository).map((g) => g.id);
      for (const id of groups) this.removeGroup(id);
      const sessions = this.sessions().filter((s) => s.repository === repository).map((s) => s.id);
      for (const id of pairs) this.db.prepare("DELETE FROM pairs WHERE id=?").run(id);
      for (const id of sessions) this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      return { sessions, pairs, groups };
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
  recoverInterrupted(): void {
    // Called only by the one backend instance.
    // Single host process only; a second server sharing this DB is unsupported.
    for (const reservation of this.reservations()) {
      const record = this.get(reservation.activeCommandId);
      if (!record) { this.db.prepare("DELETE FROM reservations WHERE repository=?").run(reservation.repository); continue; }
      if (["recorded", "sending"].includes(record.status)) this.update({ ...record, status: "uncertain", updatedAt: new Date().toISOString(), error: "Backend restarted during delivery. Inspect the terminal; this command will not be replayed." });
      // Release stale transport-only holds; WorkflowStore owns the separate execution lease.
      else if (record.status === "delivered" || record.status === "rejected") this.release(record.id);
    }
  }
}
