import type { AgentId, AgentType, CommandInput, EventInput, HandoffOutcome, PairInput, RegistrationInput, RenameSession } from "../contracts/api.ts";
const OUTCOMES: HandoffOutcome[] = ["no_incoming_handoff", "strong_objection", "accept_without_improvement", "accept_and_improve"];
import { AppError } from "./errors.ts";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function agentId(value: unknown): AgentId {
  if (typeof value !== "string" || !SLUG.test(value)) throw new AppError("INVALID_AGENT", "Agent id must be a lowercase slug of 1-32 letters, digits, and hyphens.");
  return value;
}
/** Derives the stable agent id from a human label, e.g. "Claude Code" -> "claude-code". */
export function slugify(label: string): AgentId {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  if (!slug) throw new AppError("INVALID_LABEL", "The label needs at least one ASCII letter or digit to form an agent id.");
  return agentId(slug);
}
export function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("INVALID_LABEL", "Enter a label for this agent.");
  const trimmed = value.trim();
  if (trimmed.length > 40 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(trimmed)) throw new AppError("INVALID_LABEL", "Labels are at most 40 characters without control characters.");
  return trimmed;
}
export function agentType(value: unknown): AgentType {
  if (value !== "codex" && value !== "claude" && value !== "other") throw new AppError("INVALID_AGENT_TYPE", "Agent type must be codex, claude, or other.");
  return value;
}
export function paneId(value: unknown): string {
  if (typeof value !== "string" || !/^%\d+$/.test(value)) throw new AppError("INVALID_PANE", "Use an exact pane ID such as %1.");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_BODY", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError("INVALID_ID", "requestId must be a UUID v4.");
  }
  return value;
}
/** Prompt text for a CLI: one or more lines, CRLF normalized, no other control characters, at most 2,000 UTF-8 bytes. */
export function promptText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("INVALID_TEXT", "Enter a nonempty instruction.");
  const text = value.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) throw new AppError("INVALID_TEXT", "Text may not contain control characters other than line breaks.");
  if (new TextEncoder().encode(text).length > 2000) throw new AppError("INVALID_TEXT", "Maximum instruction size is 2,000 UTF-8 bytes.");
  return text;
}
export function singleLine(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("INVALID_TEXT", "Enter a nonempty instruction.");
  // Refuse terminal controls, line separators, DEL, and C1 controls.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw new AppError("INVALID_TEXT", "Only single-line text without control characters is allowed.");
  if (new TextEncoder().encode(value).length > 2000) throw new AppError("INVALID_TEXT", "Maximum instruction size is 2,000 UTF-8 bytes.");
  return value;
}
function onlyFields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new AppError("UNKNOWN_FIELD", "Unknown field.");
}
export function parseCommand(value: unknown): CommandInput {
  const body = object(value);
  onlyFields(body, ["requestId", "agentId", "kind", "text", "handoff", "confirmReady"]);
  if (body.confirmReady !== true) throw new AppError("READINESS_REQUIRED", "Confirm that the selected agent is at an empty input prompt and the other agent is not writing.");
  if (body.kind !== "relay" && body.kind !== "instruction") throw new AppError("INVALID_KIND", "Unknown command kind.");
  // An instruction needs text; a relay may carry context that the controller appends to the registered prompt.
  const text = body.kind === "instruction" || (body.text !== undefined && body.text !== "") ? promptText(body.text) : undefined;
  if (body.handoff !== undefined && typeof body.handoff !== "boolean") throw new AppError("INVALID_BODY", "handoff must be a boolean.");
  return { requestId: requestId(body.requestId), agentId: agentId(body.agentId), kind: body.kind, ...(text !== undefined ? { text } : {}),
    ...(body.handoff !== undefined ? { handoff: body.handoff } : {}), confirmReady: true };
}
export function parseRegistration(value: unknown): RegistrationInput {
  const body = object(value);
  onlyFields(body, ["paneId", "label", "agentType", "repository", "relayPrompt"]);
  if (body.repository !== undefined && (typeof body.repository !== "string" || !body.repository.startsWith("/"))) throw new AppError("INVALID_REPOSITORY", "Repository must be an absolute path.");
  return { paneId: paneId(body.paneId), label: label(body.label),
    ...(body.agentType !== undefined ? { agentType: agentType(body.agentType) } : {}),
    ...(body.repository !== undefined ? { repository: body.repository } : {}),
    ...(body.relayPrompt !== undefined ? { relayPrompt: singleLine(body.relayPrompt) } : {}) };
}
export function parseRenameSession(value: unknown): RenameSession {
  const body = object(value);
  onlyFields(body, ['label', 'expectedRegistrationId', 'expectedLabel']);
  return { label: label(body.label), expectedRegistrationId: requestId(body.expectedRegistrationId), expectedLabel: label(body.expectedLabel) };
}
export function parsePair(value: unknown): PairInput {
  const body = object(value);
  onlyFields(body, ["name", "sessions"]);
  if (!Array.isArray(body.sessions) || body.sessions.length !== 2) throw new AppError("INVALID_PAIR", "A pair names exactly two registered sessions.");
  const sessions: [AgentId, AgentId] = [agentId(body.sessions[0]), agentId(body.sessions[1])];
  if (sessions[0] === sessions[1]) throw new AppError("INVALID_PAIR", "A pair needs two different sessions.");
  return { name: label(body.name), sessions };
}
function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new AppError("INVALID_EVENT", `${field} must be plain text of at most ${max} characters.`);
  return value;
}
/** Hook payloads come from the same host, but they are still input: unknown fields and free-form text are refused. */
export function parseEvent(value: unknown): EventInput {
  const body = object(value);
  onlyFields(body, ["source", "event", "paneId", "socketPath", "cwd", "sessionId", "outcome", "reason", "settled", "prompt"]);
  if (body.event !== "turn_complete" && body.event !== "outcome") throw new AppError("INVALID_EVENT", "Only turn_complete and outcome events are accepted.");
  if (body.settled !== undefined && typeof body.settled !== "boolean") throw new AppError("INVALID_EVENT", "settled must be a boolean.");
  const socketPath = optionalText(body.socketPath, "socketPath", 512);
  if (socketPath !== undefined && !socketPath.startsWith("/")) throw new AppError("INVALID_EVENT", "socketPath must be an absolute path.");
  const cwd = optionalText(body.cwd, "cwd", 1024);
  if (cwd !== undefined && !cwd.startsWith("/")) throw new AppError("INVALID_EVENT", "cwd must be an absolute path.");
  const sessionId = optionalText(body.sessionId, "sessionId", 200);
  const prompt = optionalText(body.prompt, "prompt", 2000);
  if (body.outcome !== undefined && body.outcome !== null && !OUTCOMES.includes(body.outcome as HandoffOutcome)) throw new AppError("INVALID_EVENT", "outcome must be one of the four review-handoff outcomes.");
  const outcome = (body.outcome ?? undefined) as HandoffOutcome | undefined;
  const reason = optionalText(body.reason, "reason", 500);
  return { source: agentType(body.source), event: body.event, paneId: paneId(body.paneId),
    ...(socketPath !== undefined ? { socketPath } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(sessionId !== undefined ? { sessionId } : {}),
    ...(outcome !== undefined ? { outcome } : {}), ...(reason !== undefined ? { reason } : {}), ...(body.settled !== undefined ? { settled: body.settled } : {}),
    ...(prompt !== undefined ? { prompt } : {}) };
}
