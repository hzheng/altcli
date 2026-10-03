'use client';
import { useEffect, useState } from 'react';
import type { AttentionDestination, AttentionFeed, AttentionItem, AttentionPage } from '../contracts/attention';
import { api } from '../client/api';
import { useTildify } from '../client/home';

const OPEN: Record<AttentionDestination['surface'], string> = { 'control-access': 'Open Control access', launch: 'Open launch card', 'helper-session': 'Open Helper session' };
const FACETS: Record<string, string> = {
  delivery_uncertain: 'delivery uncertain', interrupted: 'turn interrupted', completion_gate: 'completion gate', input_review: 'input review',
  restart: 'backend restarted', paused: 'paused', approval: 'approval needed', disagreement: 'disagreement', branch: 'branch consent needed',
  continuation: 'manual continuation', start_uncertain: 'start uncertain', cleanup_uncertain: 'cleanup uncertain',
};
const unseen = (item: AttentionItem) => item.status === 'open' && item.seenRevision !== item.revision;
const timeOf = (iso: string) => new Date(iso).toLocaleString();
/** Every open item, read page by page, and the open-set revision all of its pages agreed on. */
interface Snapshot { revision: string; items: AttentionItem[] }
const PAGES = 20, ATTEMPTS = 3;

/** The host-wide Attention list: deterministic records that a run, plan or launch needs the owner. Open only navigates to the existing
 * surface, and Mark seen records an acknowledgement shared by every browser; neither changes a run, approval, hold or launch. */
export function AttentionList({ token, feed, stale, onOpen, onChanged }: {
  token: string; feed: AttentionFeed | undefined; stale: boolean; onOpen: (destination: AttentionDestination) => void; onChanged: () => Promise<void>;
}) {
  const tilde = useTildify();
  const [expanded, setExpanded] = useState(false), [snapshot, setSnapshot] = useState<Snapshot | null>(null), [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const wanted = expanded && !!feed?.truncated, target = feed?.revision;
  /** Reads every page. Pages that disagree on the revision were read across a change, so the read starts again, a bounded number of
   * times; the copy is never assembled from two different states. */
  async function readAll(signal: AbortSignal): Promise<Snapshot> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const items: AttentionItem[] = []; let cursor: string | null = null, revision: string | null = null, complete = false;
      for (let page = 0; page < PAGES; page++) {
        const result: AttentionPage = await api<AttentionPage>(token, `attention?status=open${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (revision !== null && result.revision !== revision) break;
        revision = result.revision; items.push(...result.items); cursor = result.next;
        if (!cursor) { complete = true; break; }
      }
      if (complete && revision !== null) return { revision, items };
      if (cursor && revision !== null && items.length >= PAGES * 50) throw new Error(`More than ${PAGES * 50} items are open; showing the newest.`);
    }
    throw new Error('The open items kept changing while they were read; showing the newest. Show all reads them again on the next change.');
  }
  // Show all follows the authoritative feed: whenever the feed's revision differs from the copy's, every page is read again. A change
  // while a read is in flight cancels it, and only a copy whose revision equals the current feed's is ever shown.
  useEffect(() => {
    if (!wanted || !target || snapshot?.revision === target) return;
    const abort = new AbortController();
    setReading(true); setError('');
    readAll(abort.signal).then(next => { if (!abort.signal.aborted) setSnapshot(next); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Could not read every attention item.'); })
      .finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  // The copy's own revision is compared above; reading again whenever it changes would only repeat a read that just finished.
  }, [wanted, target, token]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); } finally { setBusy(false); }
  }
  // The refreshed feed carries the new revision, which also refreshes the full list.
  const markSeen = (item: AttentionItem) => void act(async () => {
    try { await api(token, 'attention', { body: { action: 'mark-seen', itemId: item.id, revision: item.revision } }); }
    finally { await onChanged(); }
  });
  if (!feed) return <section className="panel" aria-label="Attention"><p className="muted">Reading attention records…</p></section>;
  const full = wanted && snapshot?.revision === feed.revision;
  const items = full ? snapshot!.items : feed.items;
  const subjectOf = (item: AttentionItem) => item.subject.type === 'helper' ? `Helper · ${item.subject.sessionName}`
    : item.subject.type === 'run' ? `${tilde(item.subject.repository)} · ${item.subject.participants.join(' ⇄ ')}` : `${tilde(item.subject.repository)} · ${item.subject.profileLabel}`;
  return <section className="panel attention" aria-label="Attention">
    <div className="section-heading"><h2>Attention</h2><span className="badge">{feed.open} OPEN · {feed.unseen} NOT SEEN</span></div>
    <p className="muted">Recorded runs, plans and launches that need you, for every project on this host. These notices come from the controller&apos;s
      own records and need no model. Opening one shows the existing control; it approves, resumes or retries nothing.</p>
    {stale && <p className="notice" role="status">The console is not current; these items are the last reported state.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!items.length ? <p>Nothing needs attention.</p> : <ul className="attention-items" aria-label="Open attention items">{items.map(item => <li key={item.id} className={unseen(item) ? 'unseen' : undefined}>
      <div className="attention-title"><span className="badge">{item.kind}</span><strong>{item.title}</strong>{unseen(item) && <span className="badge warning">Not seen</span>}</div>
      <p className="mono attention-subject" title={item.subject.type === 'helper' ? item.subject.instanceId : item.subject.repository}>{subjectOf(item)}</p>
      {item.detail && <p className="attention-detail">{item.detail}</p>}
      <p className="fine">{item.facets.map(f => FACETS[f] ?? f).join(' · ')} · revision {item.revision} · updated {timeOf(item.updatedAt)}
        {item.stale && ' · its record could not be read; kept open until it can'}</p>
      <div className="pane-buttons">
        <button type="button" onClick={() => onOpen(item.destination)}>{OPEN[item.destination.surface]}</button>
        {unseen(item) && <button type="button" className="quiet" disabled={busy || stale} onClick={() => markSeen(item)}>Mark seen</button>}
      </div>
    </li>)}</ul>}
    {wanted && !full && <p className="fine" role="status">{reading ? `Reading all ${feed.open} open items…` : 'Showing the newest open items.'}</p>}
    {feed.truncated && (expanded
      ? <button type="button" className="quiet" onClick={() => setExpanded(false)}>Show only the newest {feed.items.length}</button>
      : <button type="button" className="quiet" disabled={busy} onClick={() => setExpanded(true)}>Show all {feed.open} open items</button>)}
    {!!feed.recent.length && <details className="attention-recent"><summary>Recently resolved ({feed.recent.length})</summary>
      <ul>{feed.recent.map(item => <li key={item.id}><strong>{item.title}</strong> · {subjectOf(item)}<p className="fine">{item.resolution} · {item.resolvedAt && timeOf(item.resolvedAt)}</p></li>)}</ul>
    </details>}
  </section>;
}
