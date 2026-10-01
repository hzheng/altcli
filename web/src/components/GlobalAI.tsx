'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalAIPreview, GlobalAIView, ToolReply } from '../contracts/global-ai';
import type { LaunchProfile } from '../contracts/launches';
import { api, HttpError } from '../client/api';
import { findGlobalAIProfile } from '../core/policy';
import { NativeTerminal } from './NativeTerminal';
import styles from './GlobalAI.module.css';

/** Console's Helper tab sections; Guide is Console's own general explanation, the others are rendered here. */
export type HelperSection = 'chat' | 'session' | 'evidence' | 'guide';
type View = GlobalAIView & { profiles: LaunchProfile[]; fallback: string; capturedAt: string; manualHeld: boolean };
type RunSummary = { id: string; workspace: string; status: string; reason: string };
const examples = ['Why is this run blocked, and what should I do next?', 'Which runs need my attention?', 'Explain Commit versus Relay in this installed version.'];

/** Helper's Chat, Session and Evidence sections: the native conversation (or its explicit start flow), its app access, and the read
 * evidence. Not another task composer or autonomous scheduler. All stay mounted, so switching keeps the terminal connected and typing.
 * It uses Console's unlocked token and browser identity, so Lock ends it with the rest of the page. */
export function GlobalAI({ token, clientInstanceId, section, onSection, onSetup }: {
  token: string; clientInstanceId: string; section: HelperSection; onSection: (next: HelperSection) => void; onSetup: () => void;
}) {
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [profile, setProfile] = useState(''), [preview, setPreview] = useState<GlobalAIPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [unknownStart, setUnknownStart] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]), [evidence, setEvidence] = useState<ToolReply | null>(null);
  const reading = useRef(false), operating = useRef(false);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await api<View>(token, 'global-ai');
      setView(next); setError('');
      // Preselect the profile saved in Settings → Helper; choosing it still launches nothing.
      setProfile(current => current || (findGlobalAIProfile(next.profiles)?.id ?? ''));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read Helper state.'); }
    finally { reading.current = false; }
  }, [token]);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function action(body: unknown): Promise<unknown> {
    return api(token, 'global-ai', { body });
  }
  async function operate(work: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Operation failed; inspect its recorded state.'); }
    finally { operating.current = false; setBusy(false); await refresh(); }
  }
  const inspectRead = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await action({ action: 'read', name, arguments: args }) as ToolReply;
    setEvidence(result);
    if (name === 'list_runs') setRuns((result.data as { runs: RunSummary[] }).runs);
  };
  const change = () => { setPreview(null); setConfirmed(false); };
  /** One confirmation of the exact new command, then: stop the old CLI and its session, retire it, and start with the saved profile. */
  const restart = (instanceId: string, profileId: string) => void operate(async () => {
    const next = await action({ action: 'preview', profileId }) as GlobalAIPreview;
    if (!window.confirm(`Restart Helper with:\n${[next.executable, ...next.args].join(' ')}\n\nThis stops the current Codex and its tmux session, then starts a new conversation that shares AltCLI records for all projects with the model provider. Codex keeps its own session history; the new conversation does not continue the old one.`)) return;
    await action({ action: 'retire', instanceId, confirm: true, stop: true });
    setUnknownStart(true);
    try { await action({ action: 'start', id: next.id, digest: next.digest, requestId: crypto.randomUUID(), confirm: true }); }
    catch (e) { if (e instanceof HttpError && e.status < 500) setUnknownStart(false); throw e; }
    setUnknownStart(false); onSection('chat'); setNotice('Restarted Helper with the saved settings.');
  });
  // A running conversation keeps the profile it was launched with; Settings edits apply only after a restart.
  const launched = view?.instance?.profile, saved = launched && view.profiles.find(p => p.id === launched.id);
  const commandOf = (p: LaunchProfile) => [p.executable, ...p.args].join(' ');
  const outdated = !!(launched && saved && commandOf(saved) !== commandOf(launched));
  // Usually only the model or effort changed: show the arguments, and the executable only when it differs.
  const shownOf = (p: LaunchProfile) => launched && saved && launched.executable !== saved.executable ? commandOf(p) : p.args.join(' ') || '(no arguments)';
  const setup = <button type="button" className="inline-link" onClick={onSetup}>Settings → Helper</button>;
  const terminalReady = !!(view?.instance?.identity && view.instance.sessionId && view.nativeState !== 'unavailable');
  const allowance = <p>Uses the selected CLI&apos;s existing sign-in and allowance. No paid fallback is selected. Actual model and remaining quota are unknown.</p>;
  const disabled = view && !view.enabled && <p className={styles.warning}>Starting Helper requires a tmux host with input, native terminal and agent-launch flags enabled. App evidence remains readable.</p>;
  return <>
    <p className="muted">A separate conversation with read-only app context. No background jobs or automatic approvals.</p>
    {error && <p role="alert" className={styles.warning}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {outdated && <p role="status" className={styles.warning}>Helper settings changed after this conversation started: <code>{shownOf(launched!)}</code> → <code>{shownOf(saved!)}</code>.{' '}
      <button type="button" className="inline-link" disabled={busy || !view!.enabled} onClick={() => restart(view!.instance!.id, saved!.id)}>Restart with saved settings</button> applies them,
      or type <code>/model</code> in the terminal to switch this conversation&apos;s model without restarting.</p>}
    {!view && <p>Loading host state…</p>}
    {view && <>
      <div hidden={section !== 'chat'}>
        {view.instance ? <>
          {terminalReady ? <section className={styles.terminal} aria-label="Helper chat">
            {/* Always writable: this terminal is outside the manual-input barrier, so typing here holds no automation and needs no reconciliation. */}
            <NativeTerminal key={view.instance.id} token={token} target={{ launchId: view.instance.id }} clientInstanceId={clientInstanceId} label="Helper"
              fallback={<pre>{view.fallback || 'Waiting for an observed native terminal.'}</pre>} capturedAt={view.capturedAt} held={false}
              inputEnabled={view.enabled} autoInput refresh={refresh} viewEpoch={view.instance.id} />
          </section> : <p className={styles.panel}>The terminal is not available. {view.nativeMessage}{' '}
            <button type="button" className="inline-link" onClick={() => onSection('session')}>Open Session</button></p>}
        </> : <section className={styles.panel} aria-label="Start Helper">
          <h2>Start a conversation</h2>
          {allowance}{disabled}
          <label>Launch profile<select aria-label="Helper launch profile" value={profile} disabled={busy || unknownStart} onChange={e => { setProfile(e.target.value); change(); }}>
            <option value="">Choose a Codex profile</option>{view.profiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select></label>
          {!view.profiles.length && <p className={styles.warning}>No profile can launch Helper yet. Choose its model in {setup}; it appears here once saved.</p>}
          <p>Set the model in {setup}. Only enabled direct Codex profiles limited to model, reasoning effort, --no-daemon and --no-alt-screen are listed. Nothing launches on page load.</p>
          <p>Helper reads AltCLI records (runs, status, branches and agents) for every project on this host. The user-operated CLI is not an OS sandbox.</p>
          <p>Once it starts, ask in its terminal here. For example: {examples.join(' · ')}</p>
          <button type="button" disabled={busy || !profile || !view.enabled || unknownStart} onClick={() => void operate(async () => {
            setPreview(await action({ action: 'preview', profileId: profile }) as GlobalAIPreview); setConfirmed(false);
          })}>Preview Helper launch</button>
          {preview && <div className={styles.preview}><p>{preview.sessionName}</p><p>{preview.directory}</p><pre>{JSON.stringify([preview.executable, ...preview.args], null, 2)}</pre>
            <label className={styles.choice}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I approve this native launch and sharing AltCLI records for all projects on this host with its model provider.</label>
            <button type="button" disabled={busy || !confirmed || unknownStart} onClick={() => void operate(async () => {
              setUnknownStart(true); setConfirmed(false);
              try { await action({ action: 'start', id: preview.id, digest: preview.digest, requestId: crypto.randomUUID(), confirm: true }); }
              catch (e) { if (e instanceof HttpError && e.status < 500) setUnknownStart(false); throw e; }
              setUnknownStart(false); setPreview(null);
            })}>Start Helper</button>
          </div>}
          {unknownStart && <p role="alert">The start response needs inspection. Do not repeat it. <button type="button" onClick={() => void operate(async () => { const next = await api<View>(token, 'global-ai'); setView(next); if (next.instance) setUnknownStart(false); })}>Inspect recorded instance</button></p>}
        </section>}
      </div>
      <section className={styles.panel} aria-label="Helper session" hidden={section !== 'session'}>
        {view.instance ? <>
          <h2>Conversation · {view.instance.profile.label}</h2>
          {allowance}{disabled}
          <p><strong>{view.instance.status}</strong> · {view.nativeState}. {view.nativeMessage}</p>
          <p>AltCLI tools: {view.toolsEnabled ? `read-only access until ${view.toolsExpireAt}` : 'revoked, expired or not authorized in this host boot'}</p>
          <p>Shares AltCLI records for every project on this host.</p>
          <details><summary>Launch identity and command</summary><p>{view.instance.id}</p><p>{view.instance.directory}</p><pre>{JSON.stringify([view.instance.executable, ...view.instance.args], null, 2)}</pre></details>
          <div className={styles.tools}>
            <button type="button" disabled={busy || !saved || !view.enabled} onClick={() => restart(view.instance!.id, saved!.id)}>Restart with saved settings</button>
            <button type="button" disabled={busy} onClick={() => void operate(async () => { await action({ action: 'revoke' }); setNotice('AltCLI tool access revoked. The CLI and its conversation were not stopped.'); })}>Revoke app tools</button>
            <button type="button" disabled={busy || !view.enabled || view.instance.status !== 'started'} onClick={() => {
              const id = view.instance!.id;
              if (window.confirm('Restore read-only app tools for this conversation? This starts no task or new CLI.'))
                void operate(async () => { await action({ action: 'refresh-tools', instanceId: id, confirm: true }); });
            }}>Refresh app access</button>
            <button type="button" disabled={busy} onClick={() => {
              const id = view.instance!.id;
              if (window.confirm('Retire this app instance and revoke its tools? This does NOT stop its CLI, remove its tmux session or erase shared context. You can exit the CLI in its terminal first.'))
                void operate(async () => { await action({ action: 'retire', instanceId: id, confirm: true }); change(); setNotice('App access retired; original tmux session and history retained.'); });
            }}>Retire app access</button>
          </div>
          {!saved && <p>Its launch profile was deleted or can no longer launch Helper, so it cannot restart with saved settings. Retire it, then start with another profile.</p>}
        </> : <p>No Helper conversation is running.{' '}
          <button type="button" className="inline-link" onClick={() => onSection('chat')}>Start one in Chat</button></p>}
      </section>
      <section className={styles.panel} aria-label="Live app evidence" hidden={section !== 'evidence'}><h2>Evidence, not another prompt</h2>
        <p>These show the records Helper&apos;s read-only tools return, without asking the model.</p>
        <div className={styles.tools}>
          <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('list_runs'))}>Inspect runs</button>
          <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('get_capabilities'))}>Installed capabilities</button>
          <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('read_doc', { document: 'docs/GLOBAL-AI.md' }))}>Operating guide</button>
        </div>
        {runs.map(run => <article key={run.id} className={styles.run}><strong>{run.status}</strong> · {run.workspace}<p>{run.reason}</p><code>{run.id}</code>
          <button type="button" disabled={busy} onClick={() => void operate(() => inspectRead('get_run', { runId: run.id }))}>Inspect this run</button></article>)}
        {evidence && <details open><summary>{evidence.source} · observed {evidence.observedAt}</summary><p>Revision: <code>{evidence.revision}</code></p><pre className={styles.evidence}>{JSON.stringify(evidence.data, null, 2)}</pre></details>}
        <p>To act on a run, open its workspace in the Console tab and use Control access. Navigation never approves or resumes it.</p>
      </section>
    </>}
  </>;
}
