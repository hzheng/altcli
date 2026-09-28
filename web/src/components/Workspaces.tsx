'use client';
import { useRef, useState } from 'react';
import type { SessionRegistration } from '../contracts/api';
import type { Group } from '../contracts/implementation';
import type { ManagedSession, RelayRun, Workspace, WorkspaceDiscovery, WorkspaceResetResult } from '../contracts/workflow';
import type { ProjectWorktree } from '../contracts/projects';
import { api } from '../client/api';
import { LifecycleResults, WorktreeActions } from './RemoveWorktree';
import { LaunchAgents } from './LaunchAgents';
import { CreateWorktree } from './CreateWorktree';
import { AddProject } from './DirectoryPicker';
export const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
export const workspaceKey = (w: Workspace) => `${w.socketPath}\0${w.cwd}`;
interface Props {
  token: string; disabled: boolean;
  launchEnabled?: boolean; manualHeld?: boolean;
  discovery: WorkspaceDiscovery | null; discoveryError: string; onRecheck: () => Promise<void>;
  sessions: SessionRegistration[]; pairs: Group[]; lockedRepositories: string[];
  onSelectWorkspace: (workspace: Workspace) => void;
  selectedRoot: string | null; onSelectWorktree: (worktree: ProjectWorktree) => void;
  inputEnabled: boolean; runs: RelayRun[];
  deliveryRepositories?: string[];
  /** Something changed on the server: show the notice and refresh. */
  onChanged: (notice: string) => Promise<void>;
  /** Increases whenever the view changes; confirmations in this section are revoked when it is hidden. */
  viewEpoch?: number;
}
/** Read-only workspace navigation; only explicit name/membership edits persist configuration. */
export function Workspaces(props: Props) {
  const { discovery, discoveryError, onRecheck, selectedRoot, onSelectWorkspace, onSelectWorktree } = props;
  const [checking, setChecking] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [launchRequest, setLaunchRequest] = useState<{treeId:string; nonce:number}|null>(null);
  const [directoryRoot, setDirectoryRoot] = useState<string | null>(null);
  const [expandedWorktrees, setExpandedWorktrees] = useState<Record<string, boolean>>({});
  const workspaces = discovery?.workspaces ?? [];
  const projects = discovery?.projects ?? [];
  const project = projects.find((p) => p.id === projectId) ?? projects.find((p) => p.worktrees.some((w) => w.path === selectedRoot)) ?? projects[0];
  return <>
    <section className="panel workspaces" aria-labelledby="workspaces-heading">
      <div className="section-heading"><div><p className="eyebrow">LOCAL REPOSITORIES</p><h2 id="workspaces-heading">Projects</h2></div>
        <div className="row-tools"><span className="muted">{discovery ? `Checked ${new Date(discovery.discoveredAt).toLocaleTimeString()}` : 'Checking…'}</span>
          <button type="button" className="quiet" disabled={checking} onClick={() => { setChecking(true); void onRecheck().finally(() => setChecking(false)); }}>Recheck</button></div></div>
      <p className="muted">Choose a project, then a worktree. Linked worktrees belong to the same local repository, even in different directories.</p>
      <AddProject token={props.token} onAdded={onRecheck} />
      {discoveryError && <p className="notice error" role="alert">{discoveryError}</p>}
      {discovery?.error && <p className="notice error" role="alert">{discovery.error}</p>}
      {discovery && !projects.length && <p>No known Git project. Start a coding CLI in tmux inside a repository, then Recheck.</p>}
      <ul className="workspace-cards" aria-label="Available projects">{projects.map((p) => <li key={p.id} className={p.id === project?.id ? 'selected' : ''}>
        <button type="button" className="workspace-card" aria-pressed={p.id === project?.id} aria-label={`Project ${p.name}`} onClick={() => { setProjectId(p.id); setDirectoryRoot(null); }}>
          <div className="workspace-title"><strong>{p.name}</strong><span className="badge">{p.worktrees.length} WORKTREES</span></div>
          <span className="mono cwd" title={p.commonDir}>{p.commonDir}</span>
          <span className="muted">{p.error ?? `${workspaces.filter((w) => p.worktrees.some((tree) => tree.path === w.worktree.root)).reduce((n, w) => n + w.agents.filter((a) => a.eligible).length, 0)} eligible agents`}</span>
        </button></li>)}</ul>
      {!!discovery?.skipped.length && <details className="skipped"><summary>{discovery.skipped.reduce((n, s) => n + s.panes, 0)} pane(s) not in a discovered workspace</summary>
        <ul>{discovery.skipped.map((s) => <li key={s.cwd}><span className="mono">{s.cwd}</span> · {s.panes} pane(s) · {s.reason}</li>)}</ul></details>}
    </section>
    {project && <section className="panel workspaces" aria-label={`Project worktrees ${project.name}`}>
      <div className="section-heading worktrees-heading"><div><p className="eyebrow">{project.name}</p><h2>Worktrees</h2></div>
      <CreateWorktree onLaunch={props.launchEnabled ? path => {const tree=project.worktrees.find(t=>t.path===path);if(tree){setDirectoryRoot(path);setExpandedWorktrees(previous=>({...previous,[tree.id]:true}));setLaunchRequest({treeId:tree.id,nonce:Date.now()});}} : undefined} key={project.id} project={project} token={props.token} disabled={props.disabled || !props.inputEnabled || !!discoveryError || !!project.error} onChanged={props.onChanged} viewEpoch={props.viewEpoch} />
      </div>
      <p className="muted">Each worktree has an independent execution lock. Only agents started in a worktree's root directory belong to it.</p>
      {project.error && <p className="notice error" role="alert">{project.error}</p>}
      <ul className="workspace-cards worktree-cards" aria-label="Available worktrees">{[...project.worktrees].sort((a, b) => Number(b.main) - Number(a.main)).map((tree) => {
        // Discovery offers only a worktree's root directory, so one tmux server yields at most one workspace per worktree.
        const workspace = workspaces.find((w) => w.worktree.root === tree.path); const agents = workspace?.agents ?? [];
        const run = props.runs.find((r) => r.repository === tree.path && ['running', 'waiting', 'paused'].includes(r.status));
        // Hard blocks make a click pointless; everything else is left to the server's preview, whose exact refusal is shown on click.
        const hardReason = !props.inputEnabled ? 'The host is read-only. Enable input before changing worktrees.'
          : props.disabled ? 'Another request is in progress. Wait for it to finish.'
          : discoveryError || discovery?.error || tree.error || project.error || '';
        const ownerReason = (!tree.branch ? 'The task worktree has detached HEAD. Check out its task branch, then Recheck.' : '')
          || (run ? `The controller is ${run.status} on this worktree. Let it finish or take over in Console first.` : '')
          || (props.deliveryRepositories?.includes(tree.path) ? 'An unresolved delivery owns this worktree. Inspect it in Console first.' : '');
        const squashReason = hardReason || ownerReason;
        const occupied = agents.length ? `${agents.map((a) => a.label).join(', ')} ${agents.length === 1 ? 'is' : 'are'} still in this worktree; the server refuses removal while a pane is inside it. Finish branch closes sessions AltCLI launched; close or move other panes yourself, then Recheck.` : '';
        const selected = (directoryRoot ?? selectedRoot) === tree.path;
        const expanded = expandedWorktrees[tree.id] ?? false;
        return <li key={tree.id} className={selected ? 'selected' : ''}><details open={expanded} onToggle={event => {
          const next = event.currentTarget.open;
          setExpandedWorktrees(previous => previous[tree.id] === next ? previous : { ...previous, [tree.id]: next });
        }}>
          <summary className="workspace-card" aria-label={`Worktree ${nameOf(tree.path)}`}>
          <span className="workspace-title"><strong><span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{tree.main ? 'Main checkout' : nameOf(tree.path)}</strong><span className="badge">{agents.filter((a) => a.eligible).length} AGENTS</span></span>
          <span className="mono cwd" title={tree.path}>{tree.path}</span>
          <span>Branch: <span className="mono">{tree.branch ?? 'detached HEAD'}</span></span>
          <span className="muted">{tree.error ?? (run ? `${run.implementation ? 'Implementation' : run.planning ? 'Plan' : run.standalone ? 'Send' : 'Stage relay'} · ${run.status}` : agents.length ? agents.map((a) => a.label).join(', ') : 'No agents · start coding CLIs here, then Recheck')}</span>
        </summary>{workspace && <WorkspaceDetail key={workspaceKey(workspace)} workspace={workspace} {...props} />}<div className="worktree-controls"><button type="button" className="quiet" aria-pressed={selected} aria-label={`Open ${nameOf(tree.path)}`} onClick={() => {
          setDirectoryRoot(tree.path);
          if (workspace) onSelectWorkspace(workspace); else onSelectWorktree(tree);
        }}>Open console</button>{!tree.main && <WorktreeActions project={project} tree={tree} token={props.token}
          disabled={!!squashReason} disabledReason={squashReason} deletionReason={hardReason} deletionHint={ownerReason || occupied}
          onChanged={props.onChanged} viewEpoch={props.viewEpoch} />}
          <LaunchAgents requested={launchRequest?.treeId === tree.id ? launchRequest.nonce : 0} token={props.token} projectId={project.id} tree={tree} enabled={props.launchEnabled === true && props.inputEnabled} inputEnabled={props.inputEnabled} held={props.manualHeld === true} onChanged={props.onChanged} viewEpoch={props.viewEpoch} busy={props.disabled}/></div></details></li>;
      })}</ul>
      <LifecycleResults project={project} token={props.token} onChanged={props.onChanged} />
    </section>}
  </>;
}
/** Agents and groups of one workspace. Keyed by workspace so form drafts never carry over to another card. */
function WorkspaceDetail({ workspace, token, disabled, sessions, pairs, lockedRepositories, onChanged }: Props & { workspace: Workspace }) {
  const [resetting, setResetting] = useState(false);
  const [pendingMembers, setPendingMembers] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const root = workspace.worktree.root;
  const locked = disabled || busy || lockedRepositories.includes(root);
  const groups = pairs.filter((p) => p.repository === root && (!p.cwd || p.cwd === workspace.cwd));
  const group = groups[0];
  // Reset covers the whole checkout, including agents named from another directory of it.
  const named = sessions.filter((s) => s.repository === root);
  const labelOf = (id: string) => sessions.find((s) => s.id === id)?.label ?? id;
  const selected = pendingMembers ?? group?.members ?? [];
  async function act(work: () => Promise<string>) {
    if (busy) return; setBusy(true); setError('');
    try { await onChanged(await work()); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Request failed.'); } finally { setBusy(false); }
  }
  const saveSelection = (members: string[]) => {
    setPendingMembers(members);
    return act(async () => {
      await api<Group>(token, `groups/${encodeURIComponent(group!.id)}`, { method: 'PATCH', body: { members, expectedRevision: group!.revision,
        registrations: Object.fromEntries(members.map((id) => [id, (sessions.find((session) => session.id === id) as ManagedSession).registrationId])) } });
      return 'Workspace group updated. Nothing was sent.';
    }).finally(() => setPendingMembers(null));
  };
  const rename = (session: ManagedSession, label: string) => act(async () => {
    await api(token, `sessions/${encodeURIComponent(session.id)}`, { method: 'PATCH', body: { label, expectedLabel: session.label, expectedRegistrationId: session.registrationId } });
    return `Renamed "${session.label}" to "${label.trim()}". The tmux session is unchanged.`;
  });
  const reset = () => act(async () => {
    const result = await api<WorkspaceResetResult>(token, 'workspaces/reset', { body: { repository: root, confirmReady: true } });
    setResetting(false);
    return `Reset ${nameOf(workspace.cwd)}: cleared ${result.sessions.length} saved name(s) and ${result.groups.length} group setting(s). Live agents are rediscovered; history is kept.`;
  });
  // Every worktree card carries its own editor, whether or not Console currently shows that worktree.
  return <details className="workspace-detail"><summary>Agents &amp; group · {selected.length ? selected.map(labelOf).join(' ⇄ ') : 'no members selected'}</summary>
    <section aria-label={`Workspace ${nameOf(workspace.cwd)}`}>
    {lockedRepositories.includes(root) && <p className="notice">A run or setup operation owns this worktree. Reconcile it before changing agents or groups.</p>}
    <div className="table-scroll"><table><thead><tr><th>Agent</th><th>Name</th><th>Process</th><th>Pane</th><th>Eligibility</th></tr></thead>
      <tbody>{workspace.agents.map((a) => {
        const session = a.session ?? sessions.find((candidate) => candidate.id === a.registeredAs) as ManagedSession | undefined;
        const agent = `${a.kind === 'codex' ? 'Codex' : a.kind === 'claude' ? 'Claude' : a.command} ${a.identity.paneId}`;
        return <tr key={a.identity.paneId}><td><label className="agent-choice"><input type="checkbox" aria-label={`Include ${a.label}`} checked={!!session && selected.includes(session.id)}
          disabled={locked || !a.eligible || !session || !group} onChange={(event) => void saveSelection(event.target.checked ? [...selected, session!.id] : selected.filter((id) => id !== session!.id))} />{agent}</label></td>
        <td>{session ? <AgentName key={`${session.id}:${session.registrationId}:${session.label}`} session={session} agent={agent} disabled={locked || !a.eligible} onSave={rename} /> : agent}</td>
        <td className="mono">{a.command}</td><td className="mono muted">{a.location} · {a.identity.paneId}</td>
        <td>{a.eligible ? <span className="badge">{a.kind}</span> : <span className="muted">{a.reason}</span>}</td>
        </tr>;
      })}</tbody></table></div>
    <p className="fine">Edit a name in place; Enter or leaving the field saves it, Escape cancels. Names do not rename tmux sessions.</p>
    <h3>Workspace group</h3>
    <p className="muted">{selected.length === 1 ? 'Solo · 1 agent' : selected.length === 2 ? 'Pair · 2 agents' : `Group · ${selected.length} agents`}. Use the checkboxes to choose members. Excluded agents must remain settled.</p>
    <p aria-label="Workspace group members">{selected.length ? selected.map(labelOf).join(' ⇄ ') : 'Select at least one agent before starting.'}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {resetting ? <div className="notice">Reset saved names and group selection on this checkout? Live agents will appear with their default names. Running CLIs and command history are not touched.
      <button type="button" disabled={locked} aria-label={`Confirm reset ${nameOf(workspace.cwd)}`} onClick={() => void reset()}>Reset</button><button type="button" onClick={() => setResetting(false)}>Keep</button></div>
      : <button type="button" className="quiet" disabled={locked || !named.length} aria-label={`Reset ${nameOf(workspace.cwd)}`} onClick={() => setResetting(true)}>Reset…</button>}
    </section>
  </details>;
}
function AgentName({ session, agent, disabled, onSave }: { session: ManagedSession; agent: string; disabled: boolean; onSave: (session: ManagedSession, label: string) => Promise<void> }) {
  const [name, setName] = useState(session.label); const cancel = useRef(false);
  return <input className="agent-name" aria-label={`Name for ${agent}`} value={name} maxLength={40} disabled={disabled}
    onChange={(event) => setName(event.target.value)} onBlur={() => { if (cancel.current) { cancel.current = false; return; } if (name.trim() !== session.label) void onSave(session, name); }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); if (event.key === 'Escape') { cancel.current = true; setName(session.label); } event.currentTarget.blur(); } }} />;
}
