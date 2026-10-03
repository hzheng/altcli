import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { LaunchBatch } from '../contracts/launches.ts';
import type { ManagedWorkspace, ProjectRecord, RepositorySettings, TaskFinish, WorktreeCreation, WorktreeDiscard, WorktreeIntegration, WorktreeRemoval, WorktreeRename, WorktreeUpdate } from '../contracts/projects.ts';
import { FINISH_HOLDING } from '../contracts/projects.ts';
import type { ManagedSession, WorktreeIdentity } from '../contracts/workflow.ts';
import { AppError } from '../core/errors.ts';
import { idOf } from './ids.ts';

/** The schema that records registered repositories and app-created task workspaces (ADR-0024). */
export const REGISTRY_SCHEMA = 20;
/** 21: worktree-scoped manual input, all older periods remaining global. 22: attention records and Background assistant profiles,
 * an additive change that needs no settlement. 23: durable Background instance and attempt accounting. 24: action permissions, audit and delegated decisions. */
export const STORE_SCHEMA = 24;
/** Unresolved work that only the backend version which started it can settle. */
export interface UpgradeBlocker { kind: string; id: string; detail: string }

const exists = (db: Database.Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const values = <T>(db: Database.Database, table: string): T[] => exists(db, table)
  ? (db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all() as { value: string }[]).map((row) => JSON.parse(row.value) as T) : [];
const HOLDING = ['applying', 'uncertain'];

/** Read-only: every execution owner, delivery, manual-input period, launch, setup operation or Helper start an upgrade would strand.
 * Tables an older or newer component never created count as empty. Completed history is never a blocker. */
export function settlementBlockers(db: Database.Database): UpgradeBlocker[] {
  const blockers: UpgradeBlocker[] = [];
  if (exists(db, 'workflow_owners')) for (const row of db.prepare('SELECT lock_key, run_id FROM workflow_owners ORDER BY rowid').all() as { lock_key: string; run_id: string }[])
    blockers.push({ kind: 'run', id: row.run_id, detail: `owns the checkout index ${row.lock_key}` });
  if (exists(db, 'reservations') && exists(db, 'commands')) for (const row of db.prepare('SELECT r.repository, r.active_id, c.value FROM reservations r LEFT JOIN commands c ON c.id = r.active_id ORDER BY r.rowid').all() as { repository: string; active_id: string; value: string | null }[]) {
    // A delivered or rejected command's hold, or one without a command, is released by the next start's recovery.
    const status = row.value ? (JSON.parse(row.value) as { status: string }).status : null;
    if (status && !['delivered', 'rejected'].includes(status)) blockers.push({ kind: 'delivery', id: row.active_id, detail: `${status} delivery holds ${row.repository}` });
  }
  // Schema 1 kept its single hold in `control`.
  if (exists(db, 'control') && exists(db, 'commands')) for (const row of db.prepare('SELECT x.active_id, c.value FROM control x JOIN commands c ON c.id = x.active_id').all() as { active_id: string; value: string }[]) {
    const status = (JSON.parse(row.value) as { status: string }).status;
    if (!['delivered', 'rejected'].includes(status)) blockers.push({ kind: 'delivery', id: row.active_id, detail: `${status} delivery holds the host` });
  }
  for (const record of values<{ input: { requestId: string }; repository: string; status: string }>(db, 'interactions'))
    if (['recorded', 'sending', 'uncertain'].includes(record.status)) blockers.push({ kind: 'interaction', id: record.input.requestId, detail: `${record.status} input to a run in ${record.repository}` });
  for (const session of values<{ id: string; live: boolean; reconciliationRequired: boolean }>(db, 'keyboard_sessions'))
    if (session.live || session.reconciliationRequired) blockers.push({ kind: 'manual-input', id: session.id, detail: session.live ? 'a live native writer' : 'manual input awaiting reconciliation' });
  if (exists(db, 'launch_reservations')) for (const row of db.prepare('SELECT index_path, launch_id FROM launch_reservations ORDER BY rowid').all() as { index_path: string; launch_id: string }[])
    blockers.push({ kind: 'launch', id: row.launch_id, detail: `unsettled launch or cleanup holds ${row.index_path}` });
  // Inspecting a formerly running launch can report startup, exit or uncertainty after its reservation was released.
  // Those instance records still need the previous backend's inspection/reconciliation; an empty reservation table is insufficient.
  for (const batch of values<LaunchBatch>(db, 'launches')) for (const item of batch.items) {
    if (item.closed) continue;
    if (item.cleanup && HOLDING.includes(item.cleanup.status))
      blockers.push({ kind: 'launch-cleanup', id: item.id, detail: `${item.cleanup.status} cleanup of ${item.worktree.root}` });
    else if (['applying', 'starting', 'exited', 'uncertain'].includes(item.status))
      blockers.push({ kind: 'launch', id: item.id, detail: `${item.status} launch in ${item.worktree.root}` });
  }
  const operations: [string, string, { input: { requestId: string }; status: string }[]][] = [
    ['worktree-creation', 'worktree_creations', values<WorktreeCreation>(db, 'worktree_creations')],
    ['worktree-removal', 'worktree_removals', values<WorktreeRemoval>(db, 'worktree_removals')],
    ['squash', 'worktree_integrations', values<WorktreeIntegration>(db, 'worktree_integrations')],
    ['worktree-discard', 'worktree_discards', values<WorktreeDiscard>(db, 'worktree_discards')],
    ['worktree-update', 'worktree_updates', values<WorktreeUpdate>(db, 'worktree_updates')],
    ['branch-rename', 'worktree_renames', values<WorktreeRename>(db, 'worktree_renames')]];
  for (const [kind, , records] of operations) for (const op of records) if (HOLDING.includes(op.status)) blockers.push({ kind, id: op.input.requestId, detail: op.status });
  for (const finish of values<TaskFinish>(db, 'task_finishes')) if (FINISH_HOLDING.includes(finish.status)) blockers.push({ kind: 'finish-branch', id: finish.requestId, detail: finish.status });
  for (const instance of values<{ id: string; status: string }>(db, 'global_ai_instances'))
    if (['launching', 'uncertain'].includes(instance.status)) blockers.push({ kind: 'helper', id: instance.id, detail: `Helper start is ${instance.status}` });
  for (const attempt of values<{ id: string; status: string }>(db, 'background_attempts'))
    if (['claimed', 'running', 'uncertain'].includes(attempt.status)) blockers.push({ kind: 'background', id: attempt.id, detail: `Background attempt is ${attempt.status}` });
  for (const settings of values<{ instance: { id: string; status: string } | null }>(db, 'background_state'))
    if (settings.instance && settings.instance.status !== 'retired') blockers.push({ kind: 'background-instance', id: settings.instance.id, detail: 'A recorded Background reservation or session has not been retired.' });
  for (const action of values<{ id: string; status: string }>(db, 'background_actions'))
    if (['running', 'uncertain'].includes(action.status)) blockers.push({ kind: 'background-action', id: action.id, detail: `Background action is ${action.status}` });
  return blockers;
}

/** Refuses an upgrade before the store changes. The previous version still owns everything listed. */
export function upgradeBlocked(from: number, blockers: UpgradeBlocker[]): AppError {
  const shown = blockers.slice(0, 12).map((b) => `${b.kind} ${b.id} (${b.detail})`).join('; ');
  return new AppError('UPGRADE_BLOCKED', `This AltCLI version records repositories and task workspaces (store schema ${from} to ${REGISTRY_SCHEMA}) and upgrades only a settled store. `
    + `Unresolved: ${shown}${blockers.length > 12 ? `; and ${blockers.length - 12} more` : ''}. Nothing was changed. Start the previous AltCLI version on this data directory, `
    + 'let the work finish or inspect, reconcile or take it over there, stop that backend, then start this version again. '
    + '`npm --prefix web run upgrade:check` lists what remains without changing anything.', 503);
}

/** A registration awaiting the owner's choice of base checkout, integration branch and default agents. */
export const pendingSettings = (): RepositorySettings => ({ revision: 1, confirmation: 'pending', base: null, integrationBranch: null, launchDefaults: [], confirmedAt: null });
const sameIdentity = (a: WorktreeIdentity, b: WorktreeIdentity) => a.root === b.root && a.gitDir === b.gitDir && a.indexPath === b.indexPath;
/** Whether `at` falls in the half-open interval [from, until). ISO-8601 UTC timestamps compare as strings. */
const within = (at: string, from: string, until: string | null) => at >= from && (until === null || at < until);

export interface RegistryPlan { projects: ProjectRecord[]; workspaces: ManagedWorkspace[]; launches: LaunchBatch[] }
/** Read-only: what migration records. Every persisted project becomes a registration awaiting the owner's confirmation; schema 19 never
 * recorded a base checkout or integration choice, so none is invented. Each verified ready creation becomes a task workspace whose
 * identity must be anchored by saved records from its own lifetime (operations, launches, registrations) that agree; otherwise it is
 * `pending`. Verified removal or discard, or a later creation at the same path, retires it. Launches link to a workspace only when
 * their recorded worktree matches that workspace exactly and they were launched during its lifetime. No Git, tmux or file access. */
export function planRegistry(db: Database.Database): RegistryPlan {
  const projects = values<ProjectRecord>(db, 'projects').map((project) => project.settings ? project : { ...project, settings: pendingSettings() });
  const creations = values<WorktreeCreation>(db, 'worktree_creations').filter((op) => op.status === 'ready').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const removals = values<WorktreeRemoval>(db, 'worktree_removals'), discards = values<WorktreeDiscard>(db, 'worktree_discards');
  const renames = values<WorktreeRename>(db, 'worktree_renames'), updates = values<WorktreeUpdate>(db, 'worktree_updates');
  const integrations = values<WorktreeIntegration>(db, 'worktree_integrations'), finishes = values<TaskFinish>(db, 'task_finishes');
  const batches = values<LaunchBatch>(db, 'launches'), sessions = values<ManagedSession>(db, 'sessions');
  const workspaces = creations.map((creation, index): ManagedWorkspace => {
    const { input } = creation, from = creation.updatedAt;
    const later = creations.slice(index + 1).find((other) => other.input.path === input.path) ?? null;
    const here = <T extends { input: { projectId: string; worktree: WorktreeIdentity } }>(op: T) => op.input.projectId === input.projectId && op.input.worktree.root === input.path;
    const retirement = [
      ...removals.filter((op) => op.status === 'removed' && here(op)).map((op) => ({ kind: 'removal' as const, requestId: op.input.requestId, at: op.updatedAt })),
      ...discards.filter((op) => op.status === 'discarded' && here(op)).map((op) => ({ kind: 'discard' as const, requestId: op.input.requestId, at: op.updatedAt })),
    ].filter((r) => within(r.at, from, later?.updatedAt ?? null)).sort((a, b) => a.at.localeCompare(b.at))[0]
      ?? (later ? { kind: 'superseded' as const, requestId: later.input.requestId, at: later.updatedAt } : null);
    const until = retirement?.at ?? null;
    // Identity evidence recorded while this incarnation existed. The removal or discard that retired it describes it too.
    const anchors: { worktreeId: string; identity: WorktreeIdentity }[] = [
      ...[...removals, ...discards, ...renames, ...updates, ...integrations].filter((op) => here(op) && (within(op.updatedAt, from, until) || op.input.requestId === retirement?.requestId))
        .map((op) => ({ worktreeId: op.input.worktreeId, identity: op.input.worktree })),
      ...finishes.filter((op) => op.preview.projectId === input.projectId && op.preview.worktree.root === input.path && within(op.updatedAt, from, until))
        .map((op) => ({ worktreeId: op.preview.worktreeId, identity: op.preview.worktree })),
      ...batches.filter((batch) => within(batch.createdAt, from, until)).flatMap((batch) => batch.items)
        .filter((item) => item.projectId === input.projectId && item.worktree.root === input.path).map((item) => ({ worktreeId: item.worktreeId, identity: item.worktree })),
      ...sessions.filter((session) => session.worktree?.root === input.path && within(session.registeredAt, from, until))
        .map((session) => ({ worktreeId: idOf('worktree', [input.projectId, session.worktree!.gitDir, session.worktree!.indexPath]), identity: session.worktree! })),
    ];
    const distinct = anchors.filter((anchor, i) => anchors.findIndex((other) => isDeepStrictEqual(other, anchor)) === i);
    const anchor = distinct.length === 1 && distinct[0]!.worktreeId === idOf('worktree', [input.projectId, distinct[0]!.identity.gitDir, distinct[0]!.identity.indexPath]) ? distinct[0]! : null;
    let expectedBranch = input.branch;
    for (const rename of renames.filter((op) => op.status === 'renamed' && here(op) && within(op.updatedAt, from, until)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) expectedBranch = rename.input.newBranch;
    const aligned = updates.filter((op) => op.status === 'updated' && here(op) && within(op.updatedAt, from, until)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).pop();
    return { id: input.requestId, projectId: input.projectId, worktreeId: anchor?.worktreeId ?? null, path: input.path, identity: anchor?.identity ?? null,
      branch: input.branch, baseline: input.sourceHead, expectedBranch, status: retirement ? 'retired' : anchor ? 'active' : 'pending', retiredBy: retirement,
      aligned: aligned ? { requestId: aligned.input.requestId, mode: aligned.input.mode, commit: aligned.commit, at: aligned.updatedAt } : null,
      createdAt: from, updatedAt: from, migrated: true };
  });
  const launches = batches.map((batch) => ({ ...batch, items: batch.items.map((item) => item.role ? item : { ...item, role: 'workspace-agent' as const,
    workspaceId: workspaces.find((ws) => ws.identity && ws.status !== 'pending' && ws.projectId === item.projectId && ws.worktreeId === item.worktreeId
      && sameIdentity(ws.identity, item.worktree) && within(batch.createdAt, ws.createdAt, ws.retiredBy?.at ?? null))?.id ?? null }) }));
  return { projects, workspaces, launches };
}

/** What `npm run upgrade:check` reports: opened read-only, so a running previous backend is not disturbed and nothing changes. */
export interface UpgradeReport { version: number; target: number; blockers: UpgradeBlocker[]; repositories: number; workspaces: Record<ManagedWorkspace['status'], number>; linkedLaunches: number }
export function inspectUpgrade(path: string): UpgradeReport {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true }) as number;
    const pending = version >= 1 && version < REGISTRY_SCHEMA;
    const plan = pending ? planRegistry(db) : null;
    const workspaces = { active: 0, pending: 0, retired: 0 };
    for (const workspace of plan?.workspaces ?? []) workspaces[workspace.status]++;
    return { version, target: STORE_SCHEMA, blockers: pending ? settlementBlockers(db) : [], repositories: plan?.projects.length ?? 0, workspaces,
      linkedLaunches: plan?.launches.flatMap((batch) => batch.items).filter((item) => item.workspaceId).length ?? 0 };
  } finally { db.close(); }
}
