import { isDeepStrictEqual } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionRegistration } from '../contracts/api.ts';
import type { AgentActivity, HookEvent, ManagedSession } from '../contracts/workflow.ts';
import type { TerminalAdapter } from './adapters/terminal.ts';
import { classifyAgent } from '../core/workspaces.ts';
import { AppError } from '../core/errors.ts';

interface Observation {
  sessionId: string; sourceTurnId: string | null; startedAt: string;
  state: AgentActivity['state']; updatedAt: string; detail: string;
  finished: boolean;
  humanConfirmed?: true;
  completionSequence?: number;
}
/** A fresh completion can recover its exact native start after a backend restart. Never scan history. */
export async function hasCurrentNativeBinding(input: HookEvent, directory = join(homedir(), '.local', 'share', 'altcli', 'hook-turns')): Promise<boolean> {
  if (!input.identity || !input.sessionId || !input.sourceTurnId || !input.cliPid || !input.startedAt) return false;
  try {
    // Same private slot key as hooks/protocol.mjs; no directory scan or prompt lookup.
    const key = createHash('sha256').update(JSON.stringify([input.identity, input.sessionId])).digest('hex');
    const path = join(directory, `${key}${input.source === 'codex' ? '.codex' : ''}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return false;
    const saved = JSON.parse(await readFile(path, 'utf8')); const c = saved.context;
    const phase = input.source === 'codex' ? saved.phase === (input.event === 'turn_interrupted' ? 'interrupted' : 'active')
      : (saved.phase === 'finished' || (saved.phase === 'active' && input.completionSequence !== undefined)) && saved.completionSequence === input.completionSequence;
    return phase &&
      c?.source === input.source && c.sessionId === input.sessionId && c.sourceTurnId === input.sourceTurnId &&
      c.cliPid === input.cliPid && c.startedAt === input.startedAt && isDeepStrictEqual(c.identity, input.identity);
  } catch { return false; }
}
/** Native turn activity, independent of background processes and workflow ownership.
 * Only an exact, settled completion makes a turn idle; process liveness cannot prove the CLI is still answering. */
export class AgentActivityTracker {
  private readonly observations = new Map<string, Observation>();
  private readonly adapter: TerminalAdapter;
  private readonly currentBinding: typeof hasCurrentNativeBinding;
  constructor(adapter: TerminalAdapter, currentBinding = hasCurrentNativeBinding) { this.adapter = adapter; this.currentBinding = currentBinding; }
  private key(session: SessionRegistration, cliPid: string): string {
    const i = session.identity;
    return JSON.stringify([session.agentType, i.socketPath, i.serverPid, i.serverStarted, i.paneId, i.panePid, cliPid]);
  }
  read(session: ManagedSession): AgentActivity {
    const observation = session.cliPid ? this.observations.get(this.key(session, session.cliPid)) : undefined;
    return { agentId: session.id, state: observation?.state ?? 'unknown', updatedAt: observation?.updatedAt ?? null,
      detail: observation?.detail ?? 'No current lifecycle evidence. Inspect the terminal; missing evidence does not mean idle.' };
  }
  /** Caller verifies the current registration/process and absence of execution ownership. */
  confirmReady(session: ManagedSession, expectedUpdatedAt: string | null): AgentActivity {
    const current = this.read(session);
    if (!session.cliPid || current.state !== 'unknown' || current.updatedAt !== expectedUpdatedAt) throw new AppError('ACTIVITY_CHANGED', 'Activity changed or the CLI is unverified. Refresh and inspect the terminal again.', 409);
    const now = new Date().toISOString();
    this.observations.set(this.key(session, session.cliPid), { sessionId: '', sourceTurnId: null, startedAt: now,
      state: 'ready', updatedAt: now, detail: 'Ready confirmed by you after inspecting the terminal. Native activity will update on the next turn.', finished: false, humanConfirmed: true });
    return this.read(session);
  }
  async record(input: HookEvent, observed?: ManagedSession): Promise<void> {
    if (!input.identity || !input.cliPid || !input.startedAt || !input.sessionId || input.event === 'outcome' ||
      (input.event !== 'session_started' && !input.sourceTurnId)) return;
    let session: SessionRegistration;
    try {
      const pane = await this.adapter.inspect(input.paneId);
      // Copy mode and synchronized input forbid delivery, not observing a real CLI's lifecycle.
      const agent = classifyAgent({ ...pane, inMode: false, synchronized: false, location: '' }, []);
      if (!agent.eligible || agent.kind !== input.source || !isDeepStrictEqual(pane.identity, input.identity)) return;
      // Hooks may arrive before the browser discovers/registers the pane. This ephemeral descriptor
      // is only for process inspection; it never registers a session or binds workflow ownership.
      session = observed && observed.cliPid === input.cliPid && observed.expectedCommand === pane.command && observed.agentType === input.source && isDeepStrictEqual(observed.identity, input.identity) ? observed : {
        id: input.paneId, label: agent.label, identity: pane.identity, agentType: input.source,
        expectedCommand: pane.command, repository: pane.cwd, relayPrompt: '', registeredAt: input.startedAt,
      };
      if (await this.adapter.foreground(session) !== input.cliPid) return;
    } catch { return; }
    const key = this.key(session, input.cliPid); const prior = this.observations.get(key);
    if (input.event === 'session_started') {
      // Startup hooks can run asynchronously. Never let a late startup overwrite a prompt or finish.
      if (prior) return;
      this.observations.set(key, { sessionId: input.sessionId, sourceTurnId: null, startedAt: input.startedAt,
        state: 'ready', updatedAt: new Date().toISOString(), detail: 'The CLI reported session startup. No turn has been observed for this process.', finished: false });
      return;
    }
    const matches = prior?.sessionId === input.sessionId && prior.sourceTurnId === input.sourceTurnId && prior.startedAt === input.startedAt;
    // Recovery is a deliberate observation boundary. Delayed pre-reset callbacks cannot undo it.
    if (prior?.humanConfirmed && input.startedAt <= prior.startedAt) return;
    if (input.event === 'turn_started') {
      // A duplicate start cannot resurrect a finished turn; delayed earlier starts cannot replace a newer one.
      if (matches || (prior?.sourceTurnId && input.startedAt <= prior.startedAt)) return;
      const next: Observation = { sessionId: input.sessionId, sourceTurnId: input.sourceTurnId!, startedAt: input.startedAt,
        state: 'working', updatedAt: new Date().toISOString(), detail: 'The CLI reported a turn started; no matching finish has arrived.', finished: false };
      this.observations.set(key, next);
      return;
    }
    // After restart, only a live finish matching the hook's current, exact native binding can
    // recover display activity. This cannot advance a run or accept an older turn's finish.
    let completion = prior;
    if (!matches) {
      if (prior?.sourceTurnId || (prior?.sessionId && prior.sessionId !== input.sessionId) || !await this.currentBinding(input)) return;
      completion = { sessionId: input.sessionId, sourceTurnId: input.sourceTurnId!, startedAt: input.startedAt,
        state: 'unknown', updatedAt: '', detail: '', finished: false };
    }
    if (!completion || completion.finished) return;
    if (input.completionSequence !== undefined && input.completionSequence <= (completion.completionSequence ?? 0)) return;
    if (this.observations.get(key) !== prior) return;
    completion.finished = true; completion.updatedAt = new Date().toISOString();
    if (input.event === 'turn_interrupted') {
      completion.state = 'interrupted';
      completion.detail = 'The CLI reported this turn was interrupted. Work may be unfinished; background processes and relay ownership require separate reconciliation.';
      this.observations.set(key, completion); return;
    }
    // Codex notify runs after Stop hooks and certifies the response ended. Servers/watchers can
    // outlive it indefinitely; they still gate continuation in ControlPlane/WorkflowStore.
    // Claude Stop can continue the agent, so retain its source-specific background evidence guard.
    completion.state = input.source === 'claude' && input.backgroundState === 'active' ? 'working'
      : input.settled === true && (input.source === 'codex' || input.backgroundState === 'clear') ? 'idle' : 'unknown';
    completion.finished = completion.state === 'idle';
    completion.completionSequence = input.completionSequence;
    completion.detail = completion.state === 'idle'
      ? 'The matching CLI turn finished. Background work and handoff readiness are checked separately.'
      : completion.state === 'working' ? 'Claude reported a Stop with continued or background work active.'
        : 'The matching CLI completion lacked settled-turn evidence.';
    this.observations.set(key, completion);
  }
}
