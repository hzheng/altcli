import type { PaneState, SessionRegistration } from "../../contracts/api.ts";
import type { ProcessRecord } from "../../contracts/workflow.ts";
export type ListedPane = PaneState & { location: string };
export interface TerminalAdapter {
  /** Every pane on the configured tmux server, read-only, so a human can choose one to register. */
  listPanes(): Promise<ListedPane[]>;
  inspect(paneId: string): Promise<PaneState>;
  /** Short read-only tail of any live pane so a human can identify it before registering. No identity check applies yet. */
  peek(paneId: string): Promise<string>;
  capture(session: SessionRegistration): Promise<string>;
  preflight(session: SessionRegistration): Promise<void>;
  /** Any failure after this method begins must be treated as uncertain delivery. */
  send(session: SessionRegistration, text: string): Promise<void>;
  press(session: SessionRegistration, key: 'Enter' | 'Escape'): Promise<void>;
  /** Live processes under or attached to the pane, read-only, as current background-work evidence. */
  processes(session: SessionRegistration): Promise<ProcessRecord[]>;
  /** Pid of the process in the foreground of the pane right now; null when unknown. Cheap enough for every state read. */
  foreground(session: SessionRegistration): Promise<string | null>;
}
