'use client';
import { useEffect, useRef, useState } from 'react';
import type { CheckoutObservation, DirectoryListing } from '../contracts/projects';
import { api } from '../client/api';
import { useTildify } from '../client/home';

type Chosen = { path: string; checkout: CheckoutObservation };
/** What deserves a second look before adding: the project's starting checkout is normally the main checkout on its default branch. */
function warningsOf(c: CheckoutObservation): string[] {
  return [
    ...(c.kind === 'linked' ? ['This is a linked task worktree. A project usually starts from its main checkout.'] : []),
    ...(!c.branch ? ['It has a detached HEAD, not a branch.'] : c.defaultBranch && c.branch !== c.defaultBranch ? [`It is on ${c.branch}, not the default branch ${c.defaultBranch}.`] : []),
  ];
}

/** Adds a project by its main/default starting checkout, typed or browsed. Add sends what was shown, and the host refuses if the
 * directory, repository or branch changed since; adding creates metadata only, never files, sessions or Git changes. */
export function AddProject({ token, onAdded }: { token: string; onAdded: () => Promise<void> }) {
  const [directory, setDirectory] = useState(''), [chosen, setChosen] = useState<Chosen | null>(null), [browsing, setBrowsing] = useState(false);
  const [checking, setChecking] = useState(false), [error, setError] = useState(''); const tilde = useTildify();
  const choice = useRef(0);
  useEffect(() => () => { choice.current++; }, [token]);
  async function inspect(path: string, version: number): Promise<Chosen | null> {
    const listing = await api<DirectoryListing>(token, 'directories', { body: { path } });
    if (version !== choice.current) return null;
    if (!listing.checkout) { setError(listing.checkoutError ?? `${listing.path} is not inside a Git checkout. Choose the repository's main checkout.`); return null; }
    const next = { path: listing.path, checkout: listing.checkout }; setChosen(next); setDirectory(listing.checkout.root); return next;
  }
  async function add() {
    if (checking) return; setChecking(true); setError('');
    const version = choice.current;
    try {
      // A typed path gets the same read-only inspection as a browsed one; anything worth a second look is shown before adding.
      const target = chosen ?? await inspect(directory.trim(), version);
      if (!target || (!chosen && warningsOf(target.checkout).length)) return;
      const { root, commonDir, branch } = target.checkout;
      await api(token, 'projects', { body: { path: root, expected: { root, commonDir, branch } } });
      if (version === choice.current) { setDirectory(''); setChosen(null); }
      await onAdded();
    } catch (caught) { if (version === choice.current) setError(caught instanceof Error ? caught.message : 'Could not add the project.'); }
    finally { setChecking(false); }
  }
  async function useMain(path: string) { const version = ++choice.current; setChecking(true); setError(''); try { await inspect(path, version); } catch (caught) { if (version === choice.current) setError(caught instanceof Error ? caught.message : 'Could not inspect the main checkout.'); } finally { setChecking(false); } }
  const c = chosen?.checkout; const warnings = c ? warningsOf(c) : [];
  return <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
    <label htmlFor="project-path">Main/default starting checkout</label>
    <div className="row-tools"><input id="project-path" value={directory} onChange={(e) => { choice.current++; setDirectory(e.target.value); setChosen(null); setError(''); }} placeholder="/absolute/path/to/main/checkout" autoComplete="off" />
      <button type="button" className="quiet" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>Browse…</button>
      <button type="submit" disabled={checking || !directory.trim()}>Add project</button></div>
    <p className="fine">Choose the checkout you use as the project’s starting point, usually on its default branch. Its actual branch is shown before adding. Task worktrees are found automatically; create task branches from Projects. Adding creates no files or tmux sessions.</p>
    {browsing && <DirectoryPicker token={token} start={directory.trim() || null} onCancel={() => setBrowsing(false)}
      onSelect={(listing) => { choice.current++; setChosen({ path: listing.path, checkout: listing.checkout! }); setDirectory(listing.checkout!.root); setBrowsing(false); setError(''); }} />}
    {c && <div className="notice" role="region" aria-label="Chosen checkout">
      <p><strong>{c.kind === 'main' ? 'Main checkout' : 'Linked worktree'}</strong> <span className="mono">{tilde(c.root)}</span></p>
      <p>Branch <span className="mono">{c.branch ?? 'detached HEAD'}</span> · default branch {c.defaultBranch ? <span className="mono">{c.defaultBranch}</span> : 'not recorded'}</p>
      {chosen.path !== c.root && <p className="fine">The chosen folder is inside this checkout; the checkout is what gets added.</p>}
      {warnings.map((w) => <p key={w} className="warning-text">{w}</p>)}
      {c.kind === 'linked' && (c.mainCheckout ? <button type="button" disabled={checking} onClick={() => void useMain(c.mainCheckout!)}>Use main checkout {c.mainCheckout} instead</button> : c.mainCheckoutNote && <p className="fine">{c.mainCheckoutNote}</p>)}
      {warnings.length > 0 && <p className="fine">Add project adds it anyway; nothing is switched or changed.</p>}
    </div>}
    {error && <p role="alert">{tilde(error)}</p>}
  </form>;
}

/** Host directory browsing: one bounded listing at a time, directories only. Choosing a folder navigates; only a Git checkout can be
 * selected, and a later response never overwrites a newer navigation. */
export function DirectoryPicker({ token, start, onSelect, onCancel }: { token: string; start: string | null; onSelect: (listing: DirectoryListing) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null), [hidden, setHidden] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0); const tilde = useTildify();
  async function open(path: string | undefined, showHidden = hidden): Promise<boolean> {
    const n = ++sequence.current; setBusy(true); setError('');
    try { const next = await api<DirectoryListing>(token, 'directories', { body: { ...(path ? { path } : {}), hidden: showHidden } }); if (n === sequence.current) setListing(next); return true; }
    catch (caught) { if (n === sequence.current) setError(caught instanceof Error ? caught.message : 'Could not read that directory.'); return false; }
    finally { if (n === sequence.current) setBusy(false); }
  }
  // Start at the typed path when it can be read, otherwise at the host's home directory.
  useEffect(() => { void open(start ?? undefined).then((ok) => { if (!ok && start) void open(undefined); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const crumbs = listing ? listing.path.split('/').filter(Boolean).map((name, i, parts) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` })) : [];
  const c = listing?.checkout;
  return <div className="directory-picker" role="region" aria-label="Choose a directory">
    <div className="picker-path"><button type="button" className="quiet" disabled={!listing?.parent || busy} onClick={() => void open(listing!.parent!)}>Up</button>
      <nav className="breadcrumbs" aria-label="Current path"><button type="button" className="quiet" disabled={busy} onClick={() => void open('/')}>/</button>
        {crumbs.map((crumb) => <button type="button" key={crumb.path} className="quiet" disabled={busy} aria-current={crumb.path === listing?.path ? 'location' : undefined} onClick={() => void open(crumb.path)}>{crumb.name}</button>)}</nav></div>
    <label className="readiness"><input type="checkbox" checked={hidden} disabled={busy} onChange={(e) => { setHidden(e.target.checked); void open(listing?.path, e.target.checked); }} />Show hidden folders</label>
    {listing && <p className="fine">{c ? <>{c.kind === 'main' ? 'Main checkout' : 'Linked worktree'} <span className="mono">{tilde(c.root)}</span> · branch <span className="mono">{c.branch ?? 'detached HEAD'}</span> · default {c.defaultBranch ?? 'not recorded'}</>
      : listing.checkoutError ?? 'Not inside a Git checkout. Open the repository’s main checkout.'}</p>}
    <ul className="directory-list" aria-label="Folders">{listing?.entries.map((entry) => <li key={entry.name}><button type="button" className="quiet" disabled={busy} onClick={() => void open(entry.path)}>
      <span aria-hidden="true">📁</span>{entry.name}{entry.linkedFrom && <span className="muted"> → {tilde(entry.path)}</span>}{entry.gitCandidate && <span className="badge">Git candidate</span>}</button></li>)}</ul>
    {listing && !listing.entries.length && <p className="fine">No folders here.</p>}
    {listing?.truncated && <p className="fine">Only some folders are shown. Type a path in the field above to go elsewhere.</p>}
    <div className="row-tools"><button type="button" disabled={!c || busy} onClick={() => listing && onSelect(listing)}>Select this directory</button><button type="button" className="quiet" onClick={onCancel}>Cancel</button></div>
    {error && <p role="alert">{tilde(error)}</p>}
  </div>;
}
