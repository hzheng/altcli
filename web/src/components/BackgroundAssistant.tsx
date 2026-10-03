'use client';
import { useEffect, useRef, useState } from 'react';
import type { BackgroundPreview, BackgroundView } from '../contracts/background';
import type { AttentionDestination, AttentionFeed } from '../contracts/attention';
import { api } from '../client/api';
import { AttentionList } from './AttentionList';
import { BackgroundActions } from './BackgroundActions';

export function BackgroundAssistant({ token, section, feed, stale, onOpen, onChanged }: {
  token: string; section: 'attention' | 'activity' | 'settings' | 'log'; feed: AttentionFeed | undefined; stale: boolean;
  onOpen: (destination: AttentionDestination) => void; onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<BackgroundView | null>(null), [profileId, setProfileId] = useState('');
  const [preview, setPreview] = useState<BackgroundPreview | null>(null), [requestId, setRequestId] = useState('');
  const [confirmed, setConfirmed] = useState(false), [stopConfirm, setStopConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [current, setCurrent] = useState(false);
  const readSequence = useRef(0);
  async function refresh(signal?: AbortSignal) {
    const sequence = ++readSequence.current;
    const next = await api<BackgroundView>(token, 'background', { signal });
    if (signal?.aborted || sequence !== readSequence.current) return;
    setView(next); setCurrent(true); setProfileId(old => old || next.profiles[0]?.id || '');
  }
  useEffect(() => {
    const abort = new AbortController(); let reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      try { await refresh(abort.signal); } catch (e) { if (!abort.signal.aborted) { setCurrent(false); setError(e instanceof Error ? e.message : 'Could not read Background status.'); } }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [token]);
  async function act(body: unknown) {
    if (busy) return; setBusy(true); setError('');
    try { await api(token, 'background', { body }); await refresh(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Background operation failed.'); return false; }
    finally { setBusy(false); }
  }
  const instance = view?.settings.instance, settings = view?.settings;
  const control = (action: string, extra = {}) => void act({ action, instanceId: instance?.id, ...extra });
  return <>
    {error && <p className="notice error" role="alert">{error}</p>}
    {(section === 'log' || section === 'settings') && <BackgroundActions token={token} mode={section} />}
    {section === 'attention' && <AttentionList token={token} feed={feed} stale={stale} onOpen={onOpen} onChanged={onChanged} attempts={current ? view?.explanations : []} />}
    {section === 'activity' && <section className="panel" aria-label="Background activity">
      <div className="section-heading"><h2>Activity</h2><span className="badge">{settings?.enabled ? settings.paused ? 'Paused' : 'Enabled' : 'Disabled'}</span></div>
      <p>{settings?.message ?? 'Reading Background status…'}</p>
      {instance && <p className="fine">{instance.profile.label} · {instance.sessionName} · {instance.status}</p>}
      {!view?.attempts.length ? <p>No Background jobs have run.</p> : <ul className="attention-items">{view.attempts.map(a => <li key={a.id}>
        <div className="section-heading"><strong>{a.status}</strong><span className="fine">{new Date(a.admittedAt).toLocaleString()}</span></div>
        <p>{a.message}</p><p className="fine">Issue {a.itemId} · revision {a.itemRevision} · {a.calls} tool calls · {a.model ?? 'model not reported'}</p>
        {a.assessment && <p>{a.assessment.summary}</p>}
        {['failed', 'canceled'].includes(a.status) && <button type="button" disabled={busy || !current || !settings?.enabled || settings.paused} onClick={() => control('retry', { attemptId: a.id })}>Retry diagnosis</button>}
      </li>)}</ul>}
      <p className="fine">The latest 20 attempts are shown. Attention notices remain available when diagnosis fails.</p>
    </section>}
    {section === 'settings' && <section className="panel background-settings" aria-label="Background assistant settings">
      <div className="section-heading"><h2>Settings</h2><span className="badge">{settings?.enabled ? settings.paused ? 'Paused' : 'Enabled' : 'Disabled'}</span></div>
      <p>{settings?.message ?? 'Reading Background status…'}</p>
      <p>Background uses its own private tmux session and your chosen Claude Code profile to investigate attention items. Its terminal stays closed.
        Profile names, models and reasoning effort are customized in Profiles. Saving a profile does not enable jobs.</p>
      {view && !view.available && <p className="notice">Enable host input, native terminals and agent launch to use Background. Attention remains available.</p>}
      {(!instance || instance.status === 'retired') ? <>
        <label>Background profile <select value={profileId} onChange={e => { setProfileId(e.target.value); setPreview(null); setConfirmed(false); }}>
          <option value="">Choose a profile</option>{view?.profiles.map(p => <option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
        <button type="button" disabled={busy || !view?.available || !profileId || !current} onClick={() => {
          setBusy(true); setError(''); setConfirmed(false);
          void api<BackgroundPreview>(token, 'background', { body: { action: 'preview', profileId } })
            .then(p => { setPreview(p); setRequestId(crypto.randomUUID()); }).catch(e => setError(e.message)).finally(() => setBusy(false));
        }}>Preview enablement</button>
        {!view?.profiles.length && <p>Create a named Background profile in Profiles first.</p>}
        {preview && <div className="notice">
          <h3>Enable {preview.profile.label}</h3><p>{preview.disclosure}</p>
          <p className="mono">{preview.executable} {preview.args.join(' ')}</p><p className="fine">{preview.providerVersion} · {preview.sessionName}</p>
          <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm this profile, provider usage, scoped data sharing and the limits below.</label>
          <button type="button" disabled={busy || !confirmed} onClick={() => void act({ action: 'enable', id: preview.id, digest: preview.digest, requestId, confirm: true }).then(ok => { if (ok) setPreview(null); })}>Enable Background</button>
        </div>}
      </> : <>
        <p><strong>{instance.profile.label}</strong> · {instance.profile.adapterHint}</p>
        <p className="mono">{instance.executable} {instance.args.join(' ')}</p>
        <p className="fine">Private session: {instance.sessionName}. Profile changes require stopping this instance and previewing the new configuration.</p>
        <div className="pane-buttons">
          <button type="button" disabled={busy || !current} onClick={() => control('inspect')}>Inspect Background</button>
          {settings?.enabled && <button type="button" disabled={busy || !current} onClick={() => control(settings.paused ? 'resume' : 'pause', settings.paused ? { confirm: true } : {})}>{settings.paused ? 'Resume Background' : 'Pause Background'}</button>}
          {settings?.enabled && <button type="button" disabled={busy || !current} onClick={() => control('disable')}>Disable Background</button>}
        </div>
        <details><summary>Stop this Background session</summary><p>Stop only {instance.sessionName}. Disable and inspect any unfinished job first.</p>
          <label><input type="checkbox" checked={stopConfirm} onChange={e => setStopConfirm(e.target.checked)} /> Stop and retire this exact private session.</label>
          <button type="button" disabled={busy || !current || !stopConfirm} onClick={() => control('stop', { confirm: true })}>Stop Background</button>
        </details>
      </>}
      <h3>Job limits</h3>
      <p className="fine">One job at a time after an issue is stable for 20 seconds; at most 10 starts per hour and 30 seconds between starts.
        Each job has 120 seconds, 12 tool calls, 64 KiB of evidence and an 8 KiB answer. Three consecutive failures pause admission.
        One automatic attempt per issue version; retry is explicit, and a completed action may request a bounded follow-up. Closing or locking the browser does not stop enabled jobs.</p>
    </section>}
  </>;
}
