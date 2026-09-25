import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { FINISH_HOLDING } from '../contracts/projects.ts';
import type { FinishPane, FinishPreview, FinishProcess, FinishSession, FinishSessionResult, FinishStatus, TaskFinish, WorktreeDiscard, WorktreeDiscardConfirm, WorktreeRemoval, WorktreeRemoveInput } from '../contracts/projects.ts';
import type { LaunchInstance } from '../contracts/launches.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';
import type { ListedPane } from './adapters/terminal.ts';
import { AppError, messageOf } from '../core/errors.ts';
import { parseFinishConfirm, parseFinishContinue, parseFinishInput, parseFinishReconcile } from '../core/project-validation.ts';
import type { Config } from './config.ts';
import type { InputAuthority } from './input-authority.ts';
import type { LaunchService } from './launches.ts';
import { paneProcessTree, processStarts } from './processes.ts';
import type { ProjectCatalog } from './projects.ts';
import type { Store } from './store.ts';
import { terminalRunner } from './terminal-environment.ts';
import { sameWorktree } from './worktree.ts';

/** One pane of a launched session, as tmux lists it. */
export interface TmuxPane {
  sessionId: string; sessionName: string; windowId: string; paneId: string; panePid: string;
  serverPid: string; serverStarted: string; socketPath: string; command: string; cwd: string; dead: boolean; linked: boolean; marker: string;
}
/** The narrow tmux and process access Finish branch needs. Sessions are always addressed by ID, never by a (reusable) name. */
export interface FinishHost {
  /** Every pane of one session; null when that session is not on the reachable server. Throws when this cannot be established. */
  sessionPanes(sessionId: string): Promise<TmuxPane[] | null>;
  clients(sessionId: string): Promise<number>;
  allPanes(): Promise<{ paneId: string; location: string; command: string; cwd: string }[]>;
  kill(sessionId: string): Promise<void>;
  /** true: verifiably gone from the original server (or that server is gone); false: still present; null: cannot be established. */
  absent(session: { sessionId: string; serverPid: string; serverStarted: string }): Promise<boolean | null>;
  processes(rootPid: string): Promise<{ root: FinishProcess | null; processes: FinishProcess[] }>;
  /** Start time per live PID; null when the process table cannot be read. */
  starts(): Promise<Map<string, string> | null>;
}
export interface FinishDeps {
  config: Config; store: Store; projects: ProjectCatalog; launches: LaunchService; authority: InputAuthority; host: FinishHost;
  /** The run owning a worktree index: its status and its current execution's status. */
  owner(indexPath: string): { id: string; status: string; execution: string | null } | null;
  /** An unresolved legacy delivery holds this worktree. */
  delivery(root: string): boolean;
  /** Registered agents by pane, with current activity (unknown when the CLI instance cannot be verified). */
  agents(): Promise<{ paneId: string; socketPath: string; label: string; state: NonNullable<FinishPane['activity']> }[]>;
  closeTerminals(paneIds: Set<string>, reason: string): Promise<void>;
  remove(input: WorktreeRemoveInput, parent: string): Promise<WorktreeRemoval>;
  discard(input: WorktreeDiscardConfirm, parent: string): Promise<WorktreeDiscard>;
  reconcileChild(kind: 'removal' | 'discard', requestId: string): Promise<{ status: string; message: string }>;
  wait?: (ms: number) => Promise<void>;
}
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
const ACTIVE = new Set(['working', 'unknown']);
const now = () => new Date().toISOString();
/** Task processes are what a pane runs beyond its CLI and known helpers; they, and working or unknown activity, need acknowledgement. */
const taskProcesses = (pane: FinishPane) => pane.processes.filter((p) => p.pid !== pane.root?.pid && !p.infrastructure);
/** What a session stop consents to, without volatile detail: identities, scope, activity class, task processes and occupancy.
 * Git tips are not part of it: writes by the task being stopped must not prevent stopping it; the Git step gets fresh consent. */
function consentOf(worktree: WorktreeIdentity, branch: string, sessions: FinishSession[], others: FinishPreview['others'], run: FinishPreview['run']): unknown {
  return { worktree, branch, run, others: others.map((o) => o.paneId).sort(),
    sessions: sessions.map(sessionConsent).sort((a, b) => a.sessionId.localeCompare(b.sessionId)) };
}
function sessionConsent(s: FinishSession) {
  return { launchId: s.launchId, sessionId: s.sessionId, server: s.server, closable: s.closable,
    panes: s.panes.map((p) => ({ paneId: p.paneId, windowId: p.windowId, cwd: p.cwd, dead: p.dead, root: p.root && [p.root.pid, p.root.started],
      activity: p.activity === null ? 'none' : ACTIVE.has(p.activity) ? 'active' : 'settled',
      task: taskProcesses(p).map((t) => [t.pid, t.started]).sort() })).sort((a, b) => a.paneId.localeCompare(b.paneId)) };
}
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Finish branch: a confirmed, never automatic close of the tmux sessions AltCLI launched for one linked task worktree, then an
 * optional removal (branch kept) or discard (branch deleted) through the existing confirmed operations. The operation is durable
 * and owns the worktree until it settles; nothing is retried, rolled back or merged, and killing a session is never assumed to have
 * stopped every process it started. */
export class FinishCoordinator {
  private readonly deps: FinishDeps;
  private readonly previews = new Map<string, { preview: FinishPreview; expires: number }>();
  constructor(deps: FinishDeps) {
    this.deps = deps;
    // A restart during a step may have acted: keep ownership as uncertain and inspect, never repeat.
    for (const op of deps.store.taskFinishes()) {
      if (op.status === 'applying') this.save({ ...op, status: 'uncertain', message: 'The host restarted while closing sessions. Inspect the result; nothing is retried.' }, op.revision);
      if (op.status === 'git_applying') this.save({ ...op, status: 'git_uncertain', message: 'The host restarted during the confirmed removal or discard. Inspect its result; nothing is retried.' }, op.revision);
    }
  }
  private get store() { return this.deps.store; }
  private pause(ms: number): Promise<void> { return (this.deps.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms); }
  private find(requestId: string): TaskFinish | undefined { return this.store.taskFinishes().find((op) => op.requestId === requestId); }
  private save(next: TaskFinish, expected: number): TaskFinish {
    const saved = { ...next, revision: expected + 1, updatedAt: now() };
    this.store.db.transaction(() => this.store.saveTaskFinish(saved, expected)).immediate();
    return saved;
  }
  /** Hard refusals, checked at preview and again when claiming ownership. */
  private blockers(projectId: string, worktree: WorktreeIdentity): string[] {
    const run = this.deps.owner(worktree.indexPath);
    return [
      ...(run && run.status !== 'paused' ? [`The controller is ${run.status === 'waiting' ? 'waiting for you' : run.status} on this worktree. Pause it in Console first; pausing does not interrupt the workers.`] : []),
      ...(run?.execution && ['planned', 'dispatching', 'uncertain'].includes(run.execution) ? ['A delivery to this worktree is being sent or is uncertain. Inspect it in Console first.'] : []),
      ...(this.deps.delivery(worktree.root) ? ['An unresolved delivery owns this worktree. Inspect it in Console first.'] : []),
      ...(this.deps.authority.pending().length ? ['Manual terminal input holds automation on this server. Release the keyboard and reconcile manual input first.'] : []),
      ...(this.deps.projects.projectHeld(projectId) ? ['Another setup, launch or Finish branch operation owns this project. Inspect its result first.'] : []),
    ];
  }
  /** The launches recorded for this exact worktree that still claim a session. */
  private launchesOf(worktree: WorktreeIdentity): LaunchInstance[] {
    return this.deps.launches.batches().flatMap((b) => b.items).filter((i) => !i.closed && i.status !== 'failed' && i.sessionId && i.windowId && i.identity && sameWorktree(i.worktree, worktree));
  }
  /** One launched session as it is now; null when it no longer exists. Closable only with the exact server, full-UUID marker and
   * session ID, every pane inside this worktree and no window shared with another session. A matching name proves nothing. */
  private async session(item: LaunchInstance, worktree: WorktreeIdentity, agents: Awaited<ReturnType<FinishDeps['agents']>>): Promise<FinishSession | null> {
    const identity = item.identity!;
    const base: Omit<FinishSession, 'closable' | 'reason' | 'panes' | 'clients'> = { launchId: item.id, sessionName: item.sessionName, sessionId: item.sessionId!, windowId: item.windowId!,
      server: { pid: identity.serverPid, started: identity.serverStarted, socketPath: identity.socketPath } };
    let listed: TmuxPane[] | null;
    try { listed = await this.deps.host.sessionPanes(item.sessionId!); }
    catch { return { ...base, closable: false, reason: 'This session could not be inspected. AltCLI will not close it.', panes: [], clients: 0 }; }
    if (!listed) return null;
    const panes: FinishPane[] = await Promise.all(listed.map(async (p) => {
      const agent = agents.find((a) => a.paneId === p.paneId && a.socketPath === p.socketPath);
      const cwd = await realpath(p.cwd).catch(() => p.cwd);
      const tree = p.dead ? { root: null, processes: [] } : await this.deps.host.processes(p.panePid).catch(() => ({ root: null, processes: [] }));
      return { paneId: p.paneId, windowId: p.windowId, cwd, command: p.command, dead: p.dead, agent: agent?.label ?? null, activity: agent?.state ?? null, ...tree };
    }));
    panes.sort((a, b) => a.paneId.localeCompare(b.paneId));
    const reason = listed.some((p) => p.sessionId !== item.sessionId || p.marker !== item.id || p.serverPid !== identity.serverPid || p.serverStarted !== identity.serverStarted || p.socketPath !== identity.socketPath)
      ? 'Its tmux server, session or launch marker changed. AltCLI will not close it.'
      : listed.some((p) => p.linked) ? 'A window is shared with another session. Close it yourself.'
      : panes.find((p) => !inside(worktree.root, p.cwd)) ? `A pane is in another directory (${panes.find((p) => !inside(worktree.root, p.cwd))!.cwd}). Close it yourself.` : null;
    return { ...base, sessionName: listed[0]?.sessionName ?? item.sessionName, closable: !reason, reason, panes, clients: await this.deps.host.clients(item.sessionId!).catch(() => 0) };
  }
  private async evidence(worktree: WorktreeIdentity): Promise<{ sessions: FinishSession[]; others: FinishPreview['others']; run: FinishPreview['run'] }> {
    const agents = await this.deps.agents();
    const sessions = (await Promise.all(this.launchesOf(worktree).map((item) => this.session(item, worktree, agents)))).filter((s): s is FinishSession => !!s);
    const launched = new Set(sessions.flatMap((s) => s.panes.map((p) => p.paneId)));
    const others: FinishPreview['others'] = [];
    for (const pane of await this.deps.host.allPanes()) {
      if (!launched.has(pane.paneId) && inside(worktree.root, await realpath(pane.cwd).catch(() => pane.cwd))) others.push({ paneId: pane.paneId, location: pane.location, command: pane.command });
    }
    const run = this.deps.owner(worktree.indexPath);
    return { sessions, others: others.sort((a, b) => a.paneId.localeCompare(b.paneId)), run: run && { id: run.id, status: run.status } };
  }
  async preview(value: unknown): Promise<FinishPreview> {
    const input = parseFinishInput(value);
    const { worktree, git } = await this.deps.projects.finishEvidence(input.projectId, input.worktreeId);
    const { sessions, others, run } = await this.evidence(worktree);
    const active = sessions.some((s) => s.closable && s.panes.some((p) => (p.activity !== null && ACTIVE.has(p.activity)) || taskProcesses(p).length > 0));
    const preview: FinishPreview = { ...input, requestId: randomUUID(), digest: digestOf(consentOf(worktree, git.branch, sessions, others, run)), worktree, branch: git.branch,
      sessions, others, git, run, blockers: this.blockers(input.projectId, worktree), active };
    for (const [id, held] of this.previews) if (held.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 32) throw new AppError('FINISH_PREVIEW_LIMIT', 'Too many Finish branch previews. Wait for older ones to expire.', 409);
    this.previews.set(preview.requestId, { preview, expires: Date.now() + 10 * 60_000 });
    return preview;
  }
  /** Stops exactly the previewed sessions. The digest must still match what the user saw; a change stops before any kill. */
  async confirm(value: unknown): Promise<TaskFinish> {
    const input = parseFinishConfirm(value);
    const existing = this.find(input.requestId);
    if (existing) { if (!isDeepStrictEqual(existing.input, input)) throw new AppError('ID_CONFLICT', 'This Finish branch ID belongs to a different request.', 409); return existing; }
    if (!this.deps.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled input.', 403);
    const held = this.previews.get(input.requestId);
    if (!held || held.expires < Date.now() || held.preview.digest !== input.digest) throw new AppError('FINISH_CHANGED', 'This preview expired or changed. Preview again.', 409);
    const { preview } = held;
    if (preview.blockers.length) throw new AppError('FINISH_BLOCKED', preview.blockers[0]!, 409);
    if (preview.active && !input.stopActive) throw new AppError('CONFIRM_REQUIRED', 'Some sessions are working or run task processes. Confirm stopping them anyway.');
    if (input.outcome === 'remove' && (preview.git.integration !== 'integrated' || preview.git.dirty !== false)) throw new AppError('FINISH_BLOCKED', 'Removal needs proven integration and a clean worktree. Close the sessions only, or discard.', 409);
    return this.deps.authority.automated(async () => {
      const operation: TaskFinish = { requestId: input.requestId, input, preview, status: 'applying', step: 'sessions', revision: 0, message: 'Checking the previewed sessions before closing them.',
        sessions: preview.sessions.filter((s) => s.closable).map((s) => ({ sessionId: s.sessionId, sessionName: s.sessionName, launchId: s.launchId, status: 'pending', retained: [], survivors: [], evidence: null })),
        child: null, updatedAt: now() };
      // Eligibility is rechecked and the owner claimed in one transaction; an identical concurrent request gets the record.
      const { claimed, prior } = this.store.db.transaction(() => {
        const recorded = this.find(input.requestId);
        if (recorded) { if (!isDeepStrictEqual(recorded.input, input)) throw new AppError('ID_CONFLICT', 'This Finish branch ID belongs to a different request.', 409); return { prior: recorded, claimed: null }; }
        const blockers = this.blockers(preview.projectId, preview.worktree);
        if (blockers.length) throw new AppError('FINISH_BLOCKED', blockers[0]!, 409);
        const saved = { ...operation, revision: 1 }; this.store.saveTaskFinish(saved, 0); return { claimed: saved, prior: null };
      }).immediate();
      if (prior) return prior;
      this.previews.delete(input.requestId);
      try { return await this.closeSessions(claimed!); }
      catch (error) {
        // Never leave the owner looking in progress: nothing attempted is a verified no-effect failure; anything else is uncertain.
        const latest = this.find(input.requestId)!;
        const attempted = latest.sessions.some((s) => s.status !== 'pending');
        return this.save({ ...latest, status: attempted ? 'uncertain' : 'failed', message: `${messageOf(error)} ${attempted ? 'Inspect the result; nothing is retried.' : 'Nothing was closed.'}` }, latest.revision);
      }
    });
  }
  private async closeSessions(claimed: TaskFinish): Promise<TaskFinish> {
    let op = claimed; const { preview } = op;
    const fail = (message: string) => this.save({ ...op, status: 'failed', message }, op.revision);
    try {
      const fresh = await this.evidence(preview.worktree);
      if (digestOf(consentOf(preview.worktree, preview.branch, fresh.sessions, fresh.others, fresh.run)) !== preview.digest) return fail('Something changed since the preview (sessions, panes, processes, activity, occupancy or the run). Nothing was closed. Preview again.');
    } catch (error) { return fail(`The sessions could not be inspected again: ${messageOf(error)} Nothing was closed.`); }
    const targets = preview.sessions.filter((s) => s.closable);
    await this.deps.closeTerminals(new Set(targets.flatMap((s) => s.panes.map((p) => p.paneId))), 'Finish branch closed this session.');
    if (this.deps.authority.pending().length) return fail('Manual terminal input began. Nothing was closed.');
    const agents = await this.deps.agents().catch(() => []);
    let killed = 0;
    for (const target of targets) {
      const item = this.deps.launches.batches().flatMap((b) => b.items).find((i) => i.id === target.launchId);
      // Immediately before each kill: the same server, marker, windows, panes, directories, activity and processes as consented.
      const current = item ? await this.session(item, preview.worktree, agents).catch(() => null) : null;
      if (!current || !isDeepStrictEqual(sessionConsent(current), sessionConsent(target))) {
        if (!killed) return fail(`${target.sessionName} changed before it was closed. Nothing was closed. Preview again.`);
        op = this.save({ ...op, sessions: op.sessions.map((s) => s.status === 'pending' ? { ...s, status: 'skipped' } : s) }, op.revision);
        break;
      }
      const retained = [...new Map(current.panes.flatMap((p) => [...(p.root ? [p.root] : []), ...p.processes]).map((p) => [p.pid, p])).values()];
      op = this.save({ ...op, message: `Closing ${target.sessionName}.`, sessions: op.sessions.map((s) => s.sessionId === target.sessionId ? { ...s, status: 'attempted', retained } : s) }, op.revision);
      try { await this.deps.host.kill(target.sessionId); } catch { /* Judged by verified absence below, never by the command's exit. */ }
      killed++;
      // Closing a server's last session also ends the server; give it a moment to exit before calling the result uncertain.
      const identity = { sessionId: target.sessionId, serverPid: target.server.pid, serverStarted: target.server.started };
      let gone = await this.deps.host.absent(identity);
      for (let attempt = 0; gone === null && attempt < 10; attempt++) { await this.pause(200); gone = await this.deps.host.absent(identity); }
      if (gone !== true) { op = this.save({ ...op, sessions: op.sessions.map((s) => s.sessionId === target.sessionId ? { ...s, status: 'uncertain' } : s) }, op.revision); continue; }
      this.deps.launches.retire(target.launchId, op.requestId);
      const after = await this.survivors(retained);
      op = this.save({ ...op, sessions: op.sessions.map((s) => s.sessionId === target.sessionId ? { ...s, status: 'closed', ...after } : s) }, op.revision);
    }
    return this.settleSessions(op);
  }
  /** Processes seen before the kill that are still alive with the same start time. Missing start evidence stays unknown. */
  private async survivors(retained: FinishProcess[]): Promise<Pick<FinishSessionResult, 'survivors' | 'evidence'>> {
    let alive: FinishProcess[] = retained;
    for (let attempt = 0; attempt < 10 && alive.length; attempt++) {
      if (attempt) await this.pause(200);
      const starts = await this.deps.host.starts();
      if (!starts) return { survivors: [], evidence: 'unknown' };
      alive = retained.filter((p) => starts.has(p.pid) && (p.started === null || starts.get(p.pid) === p.started));
    }
    return { survivors: alive, evidence: !alive.length ? 'clear' : alive.some((p) => p.started === null) ? 'unknown' : 'survivors' };
  }
  private settleSessions(op: TaskFinish, decided = false): TaskFinish {
    const uncertain = op.sessions.filter((s) => s.status === 'attempted' || s.status === 'uncertain');
    const lingering = op.sessions.filter((s) => s.evidence === 'survivors' || s.evidence === 'unknown');
    const skipped = op.sessions.filter((s) => s.status === 'skipped' || s.status === 'pending');
    const closed = op.sessions.filter((s) => s.status === 'closed').length;
    if (!decided && uncertain.length) return this.save({ ...op, status: 'uncertain', message: `${uncertain.map((s) => s.sessionName).join(', ')}: closing could not be verified. Inspect again; nothing is retried.` }, op.revision);
    if (!decided && lingering.length) return this.save({ ...op, status: 'attention', message: `${closed} session${closed === 1 ? '' : 's'} closed, but ${lingering.map((s) => s.evidence === 'unknown' ? `${s.sessionName} (process evidence unavailable)` : `${s.sessionName} (${s.survivors.map((p) => `${p.command} ${p.pid}`).join(', ')})`).join('; ')} may still be running. Stop them yourself if needed, then inspect again.` }, op.revision);
    if (!decided && skipped.length) return this.save({ ...op, status: 'attention', message: `${closed} session${closed === 1 ? '' : 's'} closed; ${skipped.map((s) => s.sessionName).join(', ')} changed and ${skipped.length === 1 ? 'was' : 'were'} not closed. Record your inspection to continue, or preview again later.` }, op.revision);
    const base = `${closed} app session${closed === 1 ? '' : 's'} closed${decided ? ' (settled by your recorded inspection)' : ''}.`;
    if (op.input.outcome === 'close') return this.save({ ...op, status: 'done', message: `${base} The worktree and branch are kept.` }, op.revision);
    const run = this.deps.owner(op.preview.worktree.indexPath);
    return this.save({ ...op, status: 'awaiting_git', message: `${base} ${run ? 'The paused run still owns this worktree: after checking its writers stopped, take it over in Console. Then continue' : 'Continue'} to preview the ${op.input.outcome === 'remove' ? 'removal (branch kept)' : 'discard (branch deleted)'}, or stop here.` }, op.revision);
  }
  /** The Git step: the existing confirmed removal or discard, bound to this finish as its only admitted child. */
  async continue(value: unknown): Promise<TaskFinish> {
    const input = parseFinishContinue(value);
    const op = this.find(input.requestId);
    if (!op) throw new AppError('NOT_FOUND', 'Finish branch operation not found.', 404);
    if (op.status !== 'awaiting_git' || op.revision !== input.revision) throw new AppError('FINISH_CHANGED', 'This Finish branch is not waiting for its Git step. Refresh it.', 409);
    const kind = op.input.outcome === 'remove' ? 'removal' : op.input.outcome === 'discard' ? 'discard' : null;
    const child = kind === 'removal' ? input.removal : input.discard;
    if (!kind || !child) throw new AppError('INVALID_WORKTREE', `Continue this finish with the confirmed ${kind ?? 'nothing'}.`);
    if (child.projectId !== op.preview.projectId || child.worktreeId !== op.preview.worktreeId || !sameWorktree(child.worktree, op.preview.worktree) || child.branch !== op.preview.branch) throw new AppError('INVALID_WORKTREE', 'That confirmation is for another worktree or branch.', 409);
    if (!this.deps.config.inputEnabled) throw new AppError('READ_ONLY', 'The host has disabled input.', 403);
    return this.deps.authority.automated(async () => {
      const claimed = this.save({ ...op, status: 'git_applying', step: 'git', child: { kind, requestId: child.requestId }, message: `Running the confirmed ${kind}.` }, op.revision);
      let result: WorktreeRemoval | WorktreeDiscard;
      try { result = kind === 'removal' ? await this.deps.remove(child as WorktreeRemoveInput, op.requestId) : await this.deps.discard(child as WorktreeDiscardConfirm, op.requestId); }
      catch (error) { return this.save({ ...claimed, status: 'awaiting_git', step: 'sessions', child: null, message: `${messageOf(error)} Nothing was removed.` }, claimed.revision); }
      return this.afterChild(claimed, result.status, result.message);
    });
  }
  private afterChild(op: TaskFinish, status: string, message: string): TaskFinish {
    const next: FinishStatus = ['removed', 'discarded'].includes(status) ? 'done' : status === 'failed' ? 'awaiting_git' : 'git_uncertain';
    if (next === 'git_uncertain' && op.status === 'git_uncertain' && op.message === message) return op;
    return this.save({ ...op, status: next, ...(next === 'awaiting_git' ? { step: 'sessions' as const, child: null } : {}),
      message: next === 'awaiting_git' ? `${message} Nothing was deleted; preview again to continue, or stop here.` : message }, op.revision);
  }
  /** Read-only inspection of an uncertain step, an explicit recorded human decision, or stopping before the Git step. */
  async reconcile(value: unknown): Promise<TaskFinish> {
    const input = parseFinishReconcile(value);
    const op = this.find(input.requestId);
    if (!op) throw new AppError('NOT_FOUND', 'Finish branch operation not found.', 404);
    if (op.revision !== input.revision) throw new AppError('FINISH_CHANGED', 'This Finish branch changed meanwhile. Refresh it.', 409);
    if (input.action === 'abandon') {
      if (op.status !== 'awaiting_git') throw new AppError('FINISH_CHANGED', 'Only a finish waiting for its Git step can stop there.', 409);
      return this.save({ ...op, status: 'done', message: `${op.message.split('. ')[0]}. Stopped before the Git step: the worktree and branch are kept.` }, op.revision);
    }
    if (op.status === 'git_uncertain' && op.child) {
      const child = await this.deps.reconcileChild(op.child.kind, op.child.requestId);
      return this.afterChild(op, child.status, child.message);
    }
    if (op.status !== 'uncertain' && op.status !== 'attention') return op;
    const sessions: FinishSessionResult[] = [];
    for (const s of op.sessions) {
      const target = op.preview.sessions.find((t) => t.sessionId === s.sessionId)!;
      if (s.status === 'attempted' || s.status === 'uncertain') {
        const gone = await this.deps.host.absent({ sessionId: s.sessionId, serverPid: target.server.pid, serverStarted: target.server.started });
        if (gone === true) { this.deps.launches.retire(s.launchId, op.requestId); sessions.push({ ...s, status: 'closed', ...await this.survivors(s.retained) }); }
        else sessions.push({ ...s, status: 'uncertain' });
      } else if (s.status === 'closed' && s.evidence !== 'clear') sessions.push({ ...s, ...await this.survivors(s.retained) });
      else sessions.push(s);
    }
    const decision = input.action === 'decide' ? { note: input.note!, at: now() } : op.decision;
    return this.settleSessions({ ...op, sessions, ...(decision ? { decision } : {}) }, input.action === 'decide');
  }
  /** Whether any finish is in a step that may act on sessions or Git right now; keyboard input waits for it. */
  busy(): boolean { return this.store.taskFinishes().some((op) => ['applying', 'uncertain', 'git_applying', 'git_uncertain'].includes(op.status)); }
  holding(): TaskFinish[] { return this.store.taskFinishes().filter((op) => FINISH_HOLDING.includes(op.status)); }
}

/** The real host: argument-array tmux calls on the configured socket, and the process table. */
export function tmuxFinishHost(config: Config, listPanes: () => Promise<ListedPane[]>): FinishHost {
  const run = terminalRunner(config);
  const FORMAT = ['#{session_id}', '#{session_name}', '#{window_id}', '#{pane_id}', '#{pane_pid}', '#{pid}', '#{start_time}', '#{socket_path}',
    '#{?pane_dead,exited,#{pane_current_command}}', '#{?pane_dead,#{pane_start_path},#{pane_current_path}}', '#{pane_dead}', '#{window_linked}', '#{@altcli_launch}'].join('\t');
  /** Sessions on the reachable server; null when no server runs. Anything else is unknown and throws. */
  async function sessions(): Promise<{ id: string; pid: string; started: string }[] | null> {
    try { return (await run(['list-sessions', '-F', '#{session_id}\t#{pid}\t#{start_time}'])).split('\n').filter(Boolean).map((line) => { const [id, pid, started] = line.split('\t'); return { id: id!, pid: pid!, started: started! }; }); }
    catch { if ((await listPanes()).length === 0) return null; throw new AppError('TERMINAL_INSPECTION', 'tmux sessions could not be listed.', 409); }
  }
  const serverGone = (pid: string) => { try { process.kill(Number(pid), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
  return {
    async sessionPanes(sessionId) {
      if (!/^\$\d+$/.test(sessionId)) throw new AppError('TERMINAL_INSPECTION', 'Invalid session identity.', 409);
      const listed = await sessions();
      if (!listed?.some((s) => s.id === sessionId)) return null;
      return (await run(['list-panes', '-s', '-t', sessionId, '-F', FORMAT])).split('\n').filter(Boolean).map((line) => {
        const f = line.split('\t');
        if (f.length !== 13) throw new AppError('INVALID_PANE', 'Unexpected tmux metadata. Refusing to infer session scope.', 409);
        return { sessionId: f[0]!, sessionName: f[1]!, windowId: f[2]!, paneId: f[3]!, panePid: f[4]!, serverPid: f[5]!, serverStarted: f[6]!, socketPath: f[7]!,
          command: f[8]!, cwd: f[9]!, dead: f[10] !== '0', linked: f[11] !== '0', marker: f[12]! };
      });
    },
    async clients(sessionId) { return (await run(['list-clients', '-t', sessionId, '-F', '#{client_tty}'])).split('\n').filter(Boolean).length; },
    async allPanes() { return (await listPanes()).map((p) => ({ paneId: p.identity.paneId, location: p.location, command: p.command, cwd: p.cwd })); },
    async kill(sessionId) { await run(['kill-session', '-t', sessionId]); },
    async absent(session) {
      let listed: Awaited<ReturnType<typeof sessions>>;
      try { listed = await sessions(); } catch { return serverGone(session.serverPid) ? true : null; }
      // A different or restarted server proves absence only when the original server process is gone.
      if (!listed || !listed.some((s) => s.pid === session.serverPid && s.started === session.serverStarted)) return serverGone(session.serverPid) ? true : null;
      return !listed.some((s) => s.id === session.sessionId);
    },
    processes: paneProcessTree,
    starts: processStarts,
  };
}
