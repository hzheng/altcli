'use client';
import { useEffect, useState } from 'react';
import type { HostConfig } from '../contracts/api';
import type { LaunchProfile } from '../contracts/launches';
import { api } from '../client/api';
import { findGlobalAIProfile, GLOBAL_AI_CLAUDE_EFFORTS, GLOBAL_AI_EFFORTS, GLOBAL_AI_MODEL, GLOBAL_AI_PROFILE_LABEL, isDirectClaudeProfile, isDirectCodexProfile } from '../core/policy';

type Cli = 'codex' | 'claude';
const CLIS: Record<Cli, { name: string; efforts: readonly string[]; direct: (p: LaunchProfile) => boolean; enforcement: string }> = {
  codex: { name: 'Codex', efforts: GLOBAL_AI_EFFORTS, direct: isDirectCodexProfile,
    enforcement: 'Codex runs with --sandbox read-only: the operating system blocks its commands from writing files unless you approve an exception.' },
  claude: { name: 'Claude Code', efforts: GLOBAL_AI_CLAUDE_EFFORTS, direct: isDirectClaudeProfile,
    enforcement: 'Claude Code runs in manual permission mode: it prompts for file edits and shell commands unless already allowed, and built-in read-only commands run without prompting. Your allow rules and hooks still apply; this is not an OS sandbox.' },
};
const FLAGS = ['--no-daemon', '--no-alt-screen'];
const EFFORT = new RegExp(`^model_reasoning_effort="?(${GLOBAL_AI_EFFORTS.join('|')})"?$`);
/** Reads the model and effort back from a profile the host lists as launchable, whose arguments are only these. */
function parse(args: string[], cli: Cli) {
  let model = '', effort = ''; const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (cli === 'codex' && FLAGS.includes(arg)) flags.push(arg);
    else if ((arg === '--model' || (cli === 'codex' && arg === '-m')) && i + 1 < args.length) model = args[++i]!;
    else if (cli === 'codex' && (arg === '-c' || arg === '--config') && EFFORT.test(args[i + 1] ?? '')) effort = EFFORT.exec(args[++i]!)![1]!;
    else if (cli === 'claude' && arg === '--effort' && i + 1 < args.length) effort = args[++i]!;
  }
  return { model, effort, flags };
}

type Purpose = 'helper' | 'background';
const COPY: Record<Purpose, { name: string; region: string; first: string; intro: string; clis: Cli[]; deleted: string; saved: (label: string) => string }> = {
  helper: { name: 'Helper', region: 'Helper profiles', first: GLOBAL_AI_PROFILE_LABEL, clis: ['codex', 'claude'],
    intro: 'Each Helper profile names a CLI, Codex or Claude Code, with a model and reasoning effort. Chat starts a conversation with the one you choose, and Session can restart with another. Saving never launches anything: Chat previews the exact command and asks you to confirm.',
    deleted: 'A running Helper conversation keeps going.', saved: label => `Saved “${label}”. Choose it in Chat to start a conversation; nothing was launched.` },
  background: { name: 'Background', region: 'Background assistant profiles', first: 'Background', clis: ['claude'],
    intro: 'A Background assistant profile names Claude Code with a model and reasoning effort, for investigation and authorized actions. Codex is not yet a verified Background adapter. Choose this profile in Background Settings, preview its data sharing and limits, then explicitly enable it. Saving a profile launches and enables nothing.',
    deleted: 'The recorded Background instance keeps its bound profile; stop it before choosing another.', saved: label => `Saved “${label}”. Preview and enable it in Background Settings; nothing was launched or enabled.` },
};

/** Launch profiles for an app-wide agent, each a name, CLI, model and reasoning effort: Helper's (Chat starts a conversation with one and
 * Session can restart with another) or the Background assistant's. Each purpose lists only its own profiles, and the host accepts only
 * arguments that purpose allows. Saving or deleting launches and stops nothing. */
export function GlobalAISettings({ token, config, enabled, onSaved, purpose = 'helper' }: { token: string; config: HostConfig | null; enabled: boolean; onSaved: () => void; purpose?: Purpose }) {
  const copy = COPY[purpose];
  const [profiles, setProfiles] = useState<LaunchProfile[] | null>(null), [selected, setSelected] = useState<LaunchProfile | null>(null);
  const [label, setLabel] = useState(''), [cli, setCli] = useState<Cli>('codex');
  const [model, setModel] = useState(''), [effort, setEffort] = useState(''), [flags, setFlags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  /** Shows a profile's values for the chosen CLI; another CLI, or a new profile, starts from that CLI's defaults. */
  function show(profile: LaunchProfile | null, next: Cli = profile?.adapterHint === 'claude' ? 'claude' : 'codex', name = profile?.label ?? '') {
    const parsed = parse(profile?.adapterHint === next ? profile.args : [], next);
    setSelected(profile); setLabel(name); setCli(next); setModel(parsed.model); setEffort(parsed.effort); setFlags(parsed.flags);
  }
  // The first profile is named Helper, which Chat preselects; later ones need a name of their own.
  const startNew = (listed: LaunchProfile[]) => show(null, copy.clis[0], listed.some(p => p.label === copy.first) ? '' : copy.first);
  async function reload(choose: string | null) {
    const listed = (await api<LaunchProfile[]>(token, 'launch-profiles')).filter(p => p.purpose === purpose);
    setProfiles(listed);
    const next = listed.find(p => p.id === choose) ?? (purpose === 'helper' ? findGlobalAIProfile(listed) : undefined) ?? listed[0];
    if (next) show(next); else startNew(listed);
  }
  useEffect(() => { reload(null).catch(e => setError(e instanceof Error ? e.message : `Could not read ${copy.name} profiles.`)); }, [token]);
  const { name: cliName, efforts, direct, enforcement } = CLIS[cli];
  const executable = selected && selected.adapterHint === cli && direct(selected) ? selected.executable : cli;
  const args = cli === 'claude' ? [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
    : [...new Set(['--no-daemon', ...flags]), ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])];
  const invalid = !!model && !GLOBAL_AI_MODEL.test(model);
  const missing = !config || purpose !== 'helper' ? [] : [config.mode !== 'tmux' && 'ALTCLI_ADAPTER=tmux', !config.inputEnabled && 'ALTCLI_ENABLE_INPUT',
    !config.terminalEnabled && 'ALTCLI_ENABLE_TERMINAL', !config.launchEnabled && 'ALTCLI_ENABLE_AGENT_LAUNCH'].filter(Boolean);
  async function operate(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Profile changed.'); }
    finally { setBusy(false); }
  }
  const save = () => void operate(async () => {
    const body = { label: label.trim(), executable, args, adapterHint: cli, enabled: true, purpose };
    const result = await api<LaunchProfile>(token, `launch-profiles${selected ? `/${selected.id}` : ''}`,
      { method: selected ? 'PATCH' : 'POST', body: selected ? { ...body, expectedRevision: selected.revision } : body });
    await reload(result.id); onSaved();
    setNotice(copy.saved(result.label));
  });
  const remove = (profile: LaunchProfile) => {
    if (!window.confirm(`Delete the ${copy.name} profile “${profile.label}”? ${copy.deleted}`)) return;
    void operate(async () => {
      await api(token, `launch-profiles/${profile.id}`, { method: 'DELETE', body: { expectedRevision: profile.revision } });
      await reload(null); onSaved();
      setNotice(`Deleted “${profile.label}”. Nothing was stopped.`);
    });
  };
  return <section className="panel" aria-label={copy.region}>
    <div className="section-heading"><h2>Profiles</h2></div>
    <p className="muted">{copy.intro}</p>
    {missing.length > 0 && <p className="warning-text" role="status">Starting Helper also needs {missing.join(', ')}. Set {missing.length > 1 ? 'these' : 'it'} for the host and restart it; Settings → Host configuration shows what is in effect.</p>}
    {!enabled && <p>Profile changes require agent launch and input to be enabled on the host.</p>}
    {profiles && <>
      <div className="profile-bar">
        <div className="profile-row" role="group" aria-label={`Saved ${copy.region}`}>{profiles.map(p => <button type="button" key={p.id} className={p.id === selected?.id ? 'selected' : ''}
          aria-pressed={p.id === selected?.id} disabled={busy} onClick={() => show(p)}>{p.label}{!p.enabled && <span className="muted"> · disabled</span>}</button>)}
          {!profiles.length && <span className="muted">No {copy.name} profiles yet. Create one below.</span>}</div>
        <button type="button" disabled={busy || !selected} onClick={() => startNew(profiles)}>New profile</button>
      </div>
      <form onSubmit={e => { e.preventDefault(); if (!busy && !invalid && label.trim()) save(); }}>
        <h3>{selected ? `Edit ${selected.label}` : 'New profile'}</h3>
        <label>Name<input value={label} maxLength={100} placeholder="For example, Claude Opus max" onChange={e => setLabel(e.target.value)} /></label>
        <label>CLI<select value={cli} onChange={e => show(selected, e.target.value as Cli, label)}>
          {copy.clis.map(c => <option key={c} value={c}>{CLIS[c].name}</option>)}</select></label>
        {purpose === 'helper' ? <p className="fine">{enforcement}</p>
          : <p className="fine">Background jobs use scoped AltCLI tools and structured output. The adapter disables built-in tools and inherited customizations, and checks each invocation.</p>}
        <label>Model<input value={model} maxLength={128} placeholder={purpose === 'background' ? `${cliName} default` : `${cliName}'s configured default`} onChange={e => setModel(e.target.value)} /></label>
        {invalid && <p className="warning-text" role="alert">A model name uses only letters, digits and . _ : / - and starts with a letter or digit.</p>}
        <label>Reasoning effort<select value={effort} onChange={e => setEffort(e.target.value)}>
          <option value="">{purpose === 'background' ? `${cliName} default` : `${cliName}'s configured default`}</option>{efforts.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
        <pre aria-label={`${copy.name} command preview`}>{JSON.stringify([executable, ...args], null, 2)}</pre>
        <p className="fine">AltCLI does not list or verify the models your {cliName} sign-in offers. {purpose === 'background' ? 'Background reports failed jobs in Activity.' : `${cliName} reports an unavailable model in its terminal.`}</p>
        <button disabled={!enabled || busy || invalid || !label.trim()}>{selected ? `Save ${copy.name} profile` : `Create ${copy.name} profile`}</button>
        {selected && <button type="button" disabled={!enabled || busy} onClick={() => remove(selected)}>Delete {copy.name} profile</button>}
        {!selected && !!profiles.length && <button type="button" className="quiet" disabled={busy}
          onClick={() => show((purpose === 'helper' ? findGlobalAIProfile(profiles) : undefined) ?? profiles[0]!)}>Cancel</button>}
      </form>
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
