import type { ManualSession } from '../contracts/terminals.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';

/** Null covers every checkout; an operation can cover several exact Git indexes. */
export type InputScopes = readonly string[] | null;
export const scopesFor = (tree: WorktreeIdentity | null | undefined): InputScopes => tree ? [tree.indexPath] : null;
export const scopesOverlap = (a: InputScopes, b: InputScopes): boolean => a === null || b === null || a.some(index => b.includes(index));
export const manualCovers = (manual: ManualSession, scopes: InputScopes): boolean => scopesOverlap(scopesFor(manual.scope), scopes);
