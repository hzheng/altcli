/** Deterministic attention: one current item per underlying issue, derived from recorded application state, never from terminal
 * text or a model. Helper reads and later Background jobs share these records; none of them grants an action. */
export type AttentionKind = 'run' | 'plan' | 'launch';
/** Typed causes that keep an owned run from progressing. `paused` is a recorded pause with no more specific typed cause. */
export type RunBlocker = 'delivery_uncertain' | 'interrupted' | 'completion_gate' | 'input_review' | 'restart' | 'paused';
/** What an agreed or disputed Plan checkpoint needs from the human. */
export type PlanNeed = 'approval' | 'disagreement' | 'branch' | 'continuation';
export type AttentionSubject =
  | { type: 'run'; runId: string; repository: string; phase: 'plan' | 'implementation' | 'stage' | 'standalone' | 'legacy'; participants: string[]; commandId: string }
  | { type: 'launch'; launchId: string; projectId: string; worktreeId: string; repository: string; sessionName: string; profileLabel: string }
  | { type: 'helper'; instanceId: string; sessionName: string; profileLabel: string };
/** Where the existing decision or recovery surface lives. Opening it is navigation only: it performs nothing. */
export type AttentionDestination =
  | { surface: 'control-access'; repository: string; runId: string }
  | { surface: 'launch'; projectId: string; worktreeId: string; repository: string; launchId: string }
  | { surface: 'helper-session'; instanceId: string };
export interface AttentionItem {
  id: string;
  /** The underlying issue, such as run:<id>; at most one open item has a key. A recurrence after resolution is a new item. */
  key: string;
  kind: AttentionKind;
  /** Typed facets of the current condition: run blockers, the plan decision needed, or the launch uncertainty. */
  facets: string[];
  subject: AttentionSubject;
  title: string;
  /** Recorded facts, such as the controller's own reason, flattened and bounded. Not an instruction. */
  detail: string;
  destination: AttentionDestination;
  /** Material revision within this incident; unchanged observations never raise it. */
  revision: number;
  /** Monotonic semantic version of the source at the last reconciliation; it moves on every relevant change, even A → B → A. */
  sourceVersion: number;
  status: 'open' | 'resolved';
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Deterministic disposition of a resolved item. It describes controller state, never task success or a stopped worker. */
  resolution: string | null;
  /** The revision the owner marked seen, or null. A newer material revision is unseen again. */
  seenRevision: number | null;
  /** The authoritative record could not be read at the last reconciliation; the item is kept, never resolved by absence. */
  stale: boolean;
}
export interface AttentionFeed {
  /** Counts cover every open item, not only the items listed here. */
  open: number;
  unseen: number;
  items: AttentionItem[];
  recent: AttentionItem[];
  /** More open items exist than `items` lists; page through GET /api/v1/attention. */
  truncated: boolean;
  /** Changes whenever any open item opens, resolves, changes or is marked seen. A copy of every page is current only while its
   * pages' revision equals this one. */
  revision: string;
  observedAt: string;
}
/** `revision` is the open set's revision when this page was read; pages that disagree were read across a change. */
export interface AttentionPage { items: AttentionItem[]; next: string | null; revision: string; observedAt: string }
/** Marks an exact revision seen for every browser. It changes no run, approval, hold, reservation or settlement evidence. */
export interface AttentionSeenInput { action: 'mark-seen'; itemId: string; revision: number }
