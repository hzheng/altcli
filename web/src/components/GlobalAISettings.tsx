'use client';
import { useEffect, useState } from 'react';
import type { HostConfig } from '../contracts/api';
import type { LaunchProfile } from '../contracts/launches';
import { api } from '../client/api';
import { findGlobalAIProfile, GLOBAL_AI_EFFORTS, GLOBAL_AI_MODEL, GLOBAL_AI_PROFILE_LABEL, isDirectCodexProfile } from '../core/policy';

const FLAGS = ['--no-daemon', '--no-alt-screen'];
const EFFORT = new RegExp(`^model_reasoning_effort="?(${GLOBAL_AI_EFFORTS.join('|')})"?$`);
/** Reads the model and effort back from literal arguments; anything Helper cannot launch with is reported, not hidden. */
function parse(args: string[]) {
  let model = '', effort = ''; const flags: string[] = [], other: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (FLAGS.includes(arg)) flags.push(arg);
    else if ((arg === '-m' || arg === '--model') && i + 1 < args.length) model = args[++i]!;
    else if ((arg === '-c' || arg === '--config') && EFFORT.test(args[i + 1] ?? '')) effort = EFFORT.exec(args[++i]!)![1]!;
    else other.push(arg);
  }
  return { model, effort, flags, other };
}

/** Helper's model and reasoning effort, saved as the ordinary launch profile that Helper preselects. Saving launches nothing; it also
 * applies the current label to a profile saved under the old one. */
export function GlobalAISettings({ token, config, enabled, onSaved }: { token: string; config: HostConfig | null; enabled: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState<LaunchProfile | null>(null), [loaded, setLoaded] = useState(false);
  const [model, setModel] = useState(''), [effort, setEffort] = useState(''), [flags, setFlags] = useState<string[]>([]), [other, setOther] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  function show(profile: LaunchProfile | null) {
    const parsed = parse(profile?.args ?? []);
    setSaved(profile); setModel(parsed.model); setEffort(parsed.effort); setFlags(parsed.flags); setOther(parsed.other); setLoaded(true);
  }
  useEffect(() => {
    api<LaunchProfile[]>(token, 'launch-profiles').then(all => show(findGlobalAIProfile(all.filter(p => p.adapterHint === 'codex')) ?? null))
      .catch(e => setError(e instanceof Error ? e.message : 'Could not read launch profiles.'));
  }, [token]);
  const executable = saved && isDirectCodexProfile(saved) ? saved.executable : 'codex';
  const args = [...new Set(['--no-daemon', ...flags]), ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])];
  const invalid = !!model && !GLOBAL_AI_MODEL.test(model);
  const missing = !config ? [] : [config.mode !== 'tmux' && 'ALTCLI_ADAPTER=tmux', !config.inputEnabled && 'ALTCLI_ENABLE_INPUT',
    !config.terminalEnabled && 'ALTCLI_ENABLE_TERMINAL', !config.launchEnabled && 'ALTCLI_ENABLE_AGENT_LAUNCH'].filter(Boolean);
  async function save() {
    if (busy || invalid) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = { label: GLOBAL_AI_PROFILE_LABEL, executable, args, adapterHint: 'codex', enabled: true };
      const result = await api<LaunchProfile>(token, `launch-profiles${saved ? `/${saved.id}` : ''}`,
        { method: saved ? 'PATCH' : 'POST', body: saved ? { ...body, expectedRevision: saved.revision } : body });
      show(result); onSaved();
      setNotice(`Saved as the launch profile “${GLOBAL_AI_PROFILE_LABEL}”. Helper preselects it; nothing was launched.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Profile changed.'); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-label="Helper settings">
    <div className="section-heading"><h2>Helper</h2><span className="badge">LAUNCH PROFILE</span></div>
    <p className="muted">A separate Codex conversation with read-only app tools. Choose its model here, then open <strong>Helper</strong>.
      Saving never launches it: Helper previews the exact command and asks you to confirm.</p>
    {missing.length > 0 && <p className="warning-text" role="status">Starting Helper also needs {missing.join(', ')}. Set {missing.length > 1 ? 'these' : 'it'} for the host and restart it; Host configuration shows what is in effect.</p>}
    {!enabled && <p>Profile changes require agent launch and input to be enabled on the host.</p>}
    {loaded && <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>Model<input value={model} maxLength={128} placeholder="Codex's configured default" onChange={e => setModel(e.target.value)} /></label>
      {invalid && <p className="warning-text" role="alert">A model name uses only letters, digits and . _ : / - and starts with a letter or digit.</p>}
      <label>Reasoning effort<select value={effort} onChange={e => setEffort(e.target.value)}>
        <option value="">Codex&apos;s configured default</option>{GLOBAL_AI_EFFORTS.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
      <pre aria-label="Helper command preview">{JSON.stringify([executable, ...args], null, 2)}</pre>
      {other.length > 0 && <p className="warning-text" role="status">Saving removes arguments Helper cannot launch with: {other.join(' ')}</p>}
      <p className="fine">AltCLI does not list or verify the models your Codex sign-in offers; Codex reports an unavailable model in its terminal.</p>
      <button disabled={!enabled || busy || invalid}>{saved ? 'Save Helper profile' : 'Create Helper profile'}</button>
    </form>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
