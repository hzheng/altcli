import { createContext, useCallback, useContext } from "react";

/** The host user's home directory, from the host configuration; empty until it is read. */
export const HomeContext = createContext('');

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Display text with the home directory shown as ~ wherever it begins a path: /Users/me/repo → ~/repo. A longer name that only starts
 * like it (/Users/me2) or a path that merely contains it (/private/Users/me) is unchanged. Display only; requests keep full paths. */
export function tildify(text: string, home: string): string {
  const root = home.replace(/\/+$/, '');
  if (!root) return text;
  return text.replace(new RegExp(`(?<![\\w./~-])${escape(root)}(?=/|$|[\\s'"”’),;:\\]]|\\.(?:\\s|$))`, 'g'), '~');
}

/** tildify bound to the console's home directory. */
export function useTildify() {
  const home = useContext(HomeContext);
  return useCallback((text: string) => tildify(text, home), [home]);
}
