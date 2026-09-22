import { createContext, useCallback, useContext, useState } from "react";

/** Page memory for drafts and choices: it survives tab, view and workspace switches, never uses browser storage, and Lock clears it.
 * It initializes forms only; readiness, confirmations and server previews are never kept here. */
export type PageMemory = Map<string, unknown>;
export const MemoryContext = createContext<PageMemory>(new Map());

/** Like useState, but remembered under `key` in page memory. A changed key reads that key's own remembered value, and a
 * replaced memory (Lock) discards what a still-mounted hook held, so a returning key cannot revive a cleared value. */
export function useRemembered<T>(key: string, initial: T, store?: PageMemory): [T, (next: T | ((current: T) => T)) => void] {
  const context = useContext(MemoryContext); const memory = store ?? context;
  const read = useCallback(() => (memory.has(key) ? memory.get(key) : initial) as T, [memory, key, initial]);
  const [entry, setEntry] = useState(() => ({ memory, key, value: read() }));
  const current = (candidate: typeof entry) => candidate.memory === memory && candidate.key === key;
  const value = current(entry) ? entry.value : read();
  const set = useCallback((next: T | ((current: T) => T)) => setEntry((held) => {
    const previous = current(held) ? held.value : read();
    const resolved = typeof next === "function" ? (next as (current: T) => T)(previous) : next;
    memory.set(key, resolved); return { memory, key, value: resolved };
  }), [memory, key, read]);
  return [value, set];
}
