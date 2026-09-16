// CoderCrew turn-complete hook, one script for both CLIs, run through codercrew-turn-complete.sh:
//   Claude Code (Stop hook):  codercrew-turn-complete.sh claude                       JSON on stdin
//   Codex (notify):           codercrew-turn-complete.sh codex '<json>'               JSON as the last argument
//   Codex, chained:           codercrew-turn-complete.sh codex --then CMD ARGS... '<json>'
//     Codex allows one notify command; with --then the previous one still runs, with the same JSON, after we post.
// It posts {source, paneId, socketPath, cwd, sessionId, prompt, settled, outcome, reason} to the local CoderCrew at
// once. The prompt is the text that started the turn, so the server can tell which console command, if any, the turn
// answered; the outcome is the reviewer's final "RELAY-OUTCOME:" line. Both come from the CLI's own record of the
// conversation, never from the screen. Claude Code's Stop hook can fire before its transcript has the final entry; then the first post says
// settled:false and a detached waiter posts a follow-up "outcome" event when the entry lands, so the CLI is never held.
// Exits 0 always and never prints, so it cannot block, fail, or clutter a CLI turn. Does nothing outside tmux.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const OUTCOMES = ["no_incoming_handoff", "strong_objection", "accept_without_improvement", "accept_and_improve"];
const SELF = fileURLToPath(import.meta.url);
const [source = "other", ...rest] = process.argv.slice(2);
try {
  if (source === "claude" && rest[0] === "--follow-up") await followUp(JSON.parse(rest[1] ?? "{}"));
  else await main();
} catch { /* never let a hook failure reach the CLI */ }
if (source === "codex" && rest[0] === "--then" && rest.length > 2) spawnSync(rest[1], rest.slice(2), { stdio: "ignore" });
process.exit(0);

async function main() {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return;
  const payloadText = source === "claude" ? readStdin() : source === "codex" ? rest[rest.length - 1] ?? "" : "";
  const payload = parse(payloadText);
  const context = { source, paneId, socketPath: (process.env.TMUX ?? "").split(",")[0], cwd: process.cwd(),
    sessionId: String(payload.session_id ?? payload["thread-id"] ?? payload.thread_id ?? "") };
  if (source === "claude") {
    const { text, prompt, settled } = readClaudeMessage(payload.transcript_path);
    await postEvent({ ...context, event: "turn_complete", prompt, settled, ...outcomeOf(text) });
    if (!settled && payload.transcript_path) {
      spawn(process.execPath, [SELF, "claude", "--follow-up", JSON.stringify({ ...context, transcriptPath: payload.transcript_path })], { detached: true, stdio: "ignore" }).unref();
    }
  } else {
    const message = String(payload["last-assistant-message"] ?? payload.last_assistant_message ?? "");
    const inputs = payload["input-messages"] ?? payload.input_messages;
    const prompt = Array.isArray(inputs) && inputs.length ? plain(String(inputs[inputs.length - 1])) : null;
    await postEvent({ ...context, event: "turn_complete", prompt, settled: true, ...outcomeOf(message) });
  }
}
/** Detached: keep reading the transcript until the entry that ended the turn is there, then report the outcome. */
async function followUp(context) {
  const { transcriptPath, ...rest } = context;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { text, prompt, settled } = readClaudeMessage(transcriptPath);
    if (settled) { await postEvent({ ...rest, event: "outcome", prompt, settled: true, ...outcomeOf(text) }); return; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await postEvent({ ...rest, event: "outcome", settled: true, outcome: null, reason: null });
}
function readStdin() { try { return readFileSync(0, "utf8"); } catch { return ""; } }
/** One line of plain text, bounded, for transport as a prompt echo. */
function plain(text) { const t = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim(); return t ? t.slice(0, 2000) : null; }
function parse(text) { try { return JSON.parse(text); } catch { return {}; } }
/** The last "RELAY-OUTCOME: <outcome> — <reason>" line of a message, or nulls. */
function outcomeOf(text) {
  const matches = [...String(text ?? "").matchAll(/^\s*RELAY-OUTCOME:\s*([a-z_]+)\s*(?:[—–-]+\s*(.*?))?\s*$/gm)];
  const last = matches[matches.length - 1];
  if (!last || !OUTCOMES.includes(last[1])) return { outcome: null, reason: null };
  return { outcome: last[1], reason: (last[2] ?? "").slice(0, 500) || null };
}
/**
 * Claude Code's transcript is JSONL. The final assistant message may span entries sharing one message id; the entry
 * that ended the turn has a stop_reason other than tool_use. Until it is there, the transcript is not settled. The
 * turn's prompt is the last user entry a human typed (origin human, not isMeta; skill text is injected as isMeta).
 */
function readClaudeMessage(transcriptPath) {
  let rows = [];
  try {
    const size = statSync(transcriptPath).size;
    let text = readFileSync(transcriptPath, "utf8");
    if (size > 8 * 1024 * 1024) text = text.slice(-2 * 1024 * 1024);
    rows = text.split("\n").filter(Boolean).map(parse);
  } catch { return { text: "", prompt: null, settled: false }; }
  const entries = rows.filter((e) => e.type === "assistant" && e.message);
  const humans = rows.filter((e) => e.type === "user" && e.message && !e.isMeta && (!e.origin || e.origin.kind === "human"));
  const promptOf = (e) => { const c = e.message.content; return typeof c === "string" ? c : Array.isArray(c) && !c.some((b) => b.type === "tool_result") ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : ""; };
  const prompt = plain(humans.map(promptOf).filter(Boolean).pop());
  const last = entries[entries.length - 1];
  if (!last) return { text: "", prompt, settled: false };
  const settled = Boolean(last.message.stop_reason) && last.message.stop_reason !== "tool_use";
  const id = last.message.id;
  const text = entries.filter((e) => e.message.id === id).flatMap((e) => Array.isArray(e.message.content) ? e.message.content : [{ type: "text", text: String(e.message.content ?? "") }])
    .filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, prompt, settled };
}
async function postEvent(body) {
  const root = join(dirname(SELF), "..");
  const env = readFileSync(process.env.CODERCREW_ENV ?? join(root, "web", ".env.local"), "utf8");
  const token = env.split("\n").map((l) => l.match(/^CODERCREW_TOKEN=(.*)$/)).filter(Boolean).pop()?.[1]?.trim();
  if (!token) return;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${process.env.CODERCREW_URL ?? "http://127.0.0.1:8787"}/api/v1/events`, { method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } finally { clearTimeout(timer); }
}
