import { AppError } from "./errors.ts";
/** Most sessions one profile and branch may share: base, base-2 … base-SESSION_NAME_LIMIT. */
export const SESSION_NAME_LIMIT = 99;
/** The short name for a new launched tmux session: the base itself, else the first free `base-N`. tmux needs unique session
 * names on one server; safety never depends on the name (launch identity is the session ID and full-UUID marker). */
export function uniqueSessionName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n <= SESSION_NAME_LIMIT; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new AppError("LAUNCH_NAMES", `${SESSION_NAME_LIMIT} sessions already use the name ${base}. Close or rename some, then preview again.`, 409);
}
/** tmux session names in a pane listing: the part of `session:window.pane` before the last colon. */
export const sessionNamesOf = (panes: { location: string }[]): Set<string> =>
  new Set(panes.map((p) => p.location.slice(0, p.location.lastIndexOf(":"))).filter(Boolean));
