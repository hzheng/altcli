import type { BranchConsent, CollaborationPolicy, ImplementationStart, StandaloneStart } from "../contracts/implementation.ts";
import type { StartInput } from "../contracts/workflow.ts";

/** One click in an agent card. The card names the action explicitly instead of inferring it from kind and handoff. */
export type PaneAction = "send" | "send_stage_relay" | "send_commit" | "send_commit_relay" | "commit" | "commit_relay" | "relay";
/** What happens after the card's agent finishes a sent instruction. */
export type AfterSend = "nothing" | "stage_relay" | "commit" | "commit_relay";
export const sendAction = (after: AfterSend): PaneAction => after === "stage_relay" ? "send_stage_relay" : after === "commit" ? "send_commit" : after === "commit_relay" ? "send_commit_relay" : "send";

export interface PaneRequestInput {
  action: PaneAction;
  requestId: string;
  groupId: string;
  groupRevision: number;
  registrations: Record<string, string>;
  /** The card's own agent: the first recipient of every action in that card. */
  agentId: string;
  policy: CollaborationPolicy;
  workerId?: string;
  /** The instruction for a Send, or the review context for a clean review; empty for a snapshot. */
  text: string;
  /** The human's note for the peer when a relay is involved; delivered with the peer's review assignment. */
  reviewNote?: string;
  branch: BranchConsent;
  automatic: boolean;
  turnLimit: number;
  pauseOnObjection: boolean;
  logPath?: string;
  /** Only snapshot relay and existing-commit review carry a baseline; new work never does. */
  reviewBase?: string;
}
export type PaneRequest = { path: "instructions"; body: StandaloneStart } | { path: "commands"; body: StartInput } | { path: "implementation"; body: ImplementationStart };

/** The single initial request for a card action. Plain Send, Stage relay and committed work keep their own contracts;
 * the server schedules any later turns. */
export function paneRequest(input: PaneRequestInput): PaneRequest {
  const { action, requestId, groupId, groupRevision, registrations, agentId, policy } = input;
  const text = input.text.trim(); const worker = policy === "worker_reviewer" ? { workerId: input.workerId! } : {};
  if (action === "send") return { path: "instructions", body: { requestId, groupId, groupRevision, registrations, agentId, text, policy, ...worker, confirmReady: true } };
  if (action === "send_stage_relay") return { path: "commands", body: { requestId, agentId, pairId: groupId, kind: "instruction", text, handoff: true,
    stage: { branch: input.branch.branch!, head: input.branch.head }, autoContinue: input.automatic, turnLimit: input.turnLimit,
    confirmReady: true } };
  const kind = action === "send_commit" || action === "send_commit_relay" ? "work" : action === "relay" ? "review" : "commit";
  const handoff = action === "send_commit_relay" || action === "commit_relay" || action === "relay";
  const solo = policy === "solo";
  return { path: "implementation", body: { requestId, groupId, groupRevision, registrations, agentId, kind, ...(text ? { text } : {}), handoff, policy, ...worker,
    autoContinue: !solo && handoff && input.automatic, turnLimit: input.turnLimit, pauseOnObjection: !solo && input.pauseOnObjection,
    ...(input.logPath ? { logPath: input.logPath } : {}), branch: input.branch,
    ...(kind !== "work" && handoff && input.reviewBase ? { reviewBase: input.reviewBase } : {}),
    ...(kind !== "review" && handoff && input.reviewNote?.trim() ? { reviewNote: input.reviewNote.trim() } : {}), confirmReady: true } };
}
