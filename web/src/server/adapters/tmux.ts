import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { PaneState, SessionRegistration } from "../../contracts/api.ts";
import { AppError } from "../../core/errors.ts";
import { assertIdentity } from "../../core/policy.ts";
import { paneId as validPaneId, promptText, singleLine } from "../../core/validation.ts";
import { inputAfterTyping, inputEraseCount } from "../../core/prompt-leftover.ts";
import type { ProcessRecord } from "../../contracts/workflow.ts";
import type { ListedPane, TerminalAdapter } from "./terminal.ts";
import { foregroundPid, hostPaneProcesses, paneProcesses } from "../processes.ts";
/** `input`, when given, is written to tmux's stdin (only `load-buffer -` reads it). */
export type Runner = (args: string[], input?: string) => Promise<string>;
export function createRunner(binary = "tmux", socket?: string): Runner {
  return (args, input) => new Promise((resolve, reject) => {
    const child = execFile(binary, [...(socket ? ["-S", socket] : []), ...args],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        // tmux's own first line ("no server running on ...", "can't find pane ...") is what the operator needs to see.
        const detail = (stderr || error.message).split("\n")[0]?.trim();
        if (args[0] === 'list-panes' && typeof error.code === 'number' && /^(no server running on .+|error connecting to .+ \(No such file or directory\))$/.test(detail ?? '')) return reject(new AppError('TMUX_ABSENT', 'No tmux server is running.', 409));
        reject(new AppError("TMUX_FAILED", `tmux ${args[0]} failed${detail ? `: ${detail}` : ""}. Inspect tmux on the host.`, 409));
      });
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  });
}
const SEP = "\t";
const PANE_FIELDS = ["pane_id", "pane_pid", "pid", "start_time", "socket_path", "pane_current_command", "pane_current_path", "pane_dead", "pane_in_mode", "synchronize-panes"];
const paneField = (x: string) => x === 'pane_current_command' ? '#{?pane_dead,exited,#{pane_current_command}}' : x === 'pane_current_path' ? '#{?pane_dead,#{pane_start_path},#{pane_current_path}}' : `#{${x}}`;
const FORMAT = PANE_FIELDS.map(paneField).join(SEP);
const LIST_FORMAT = ["session_name", "window_index", "pane_index", ...PANE_FIELDS].map(paneField).join(SEP);
function parsePane(parts: string[]): PaneState {
  if (parts.length !== PANE_FIELDS.length || parts.slice(0, 7).some((s) => !s)) throw new AppError("INVALID_PANE", "Unexpected tmux metadata. Refusing to infer target identity.", 409);
  const [id, panePid, serverPid, serverStarted, socketPath, command, cwd, dead, inMode, synchronized] = parts as [string,string,string,string,string,string,string,string,string,string];
  return { identity: { paneId: id, panePid, serverPid, serverStarted, socketPath }, command, cwd,
    dead: dead !== "0", inMode: inMode !== "0", synchronized: synchronized !== "0" && synchronized !== "off" };
}
export async function inspectPane(run: Runner, paneId: string): Promise<PaneState> {
  return parsePane((await run(["display-message", "-p", "-t", validPaneId(paneId), FORMAT])).trimEnd().split(SEP));
}
export async function listPanes(run: Runner): Promise<ListedPane[]> {
  let output: string;
  try { output = await run(["list-panes", "-a", "-F", LIST_FORMAT]); }
  catch (error) { if (error instanceof AppError && error.code === 'TMUX_ABSENT') return []; throw error; }
  const lines = output.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => {
    const parts = line.split(SEP);
    if (parts.length !== PANE_FIELDS.length + 3) throw new AppError("INVALID_PANE", "Unexpected tmux metadata. Refusing to infer target identity.", 409);
    const [session, windowIndex, paneIndex] = parts as [string, string, string];
    return { ...parsePane(parts.slice(3)), location: `${session}:${windowIndex}.${paneIndex}` };
  });
}
// Codex's TUI treats a fast burst of characters as a paste and, for 120 ms after it, inserts Enter as a
// newline instead of submitting (codex-rs/tui paste_burst.rs). Wait that window out before pressing Enter.
export const ENTER_SETTLE_MS = 300;
/** Hex input avoids tmux treating an argument ending in ';' as a command separator. */
export function inputArgs(paneId: string, text: string): string[] {
  return ["send-keys", "-H", "-t", validPaneId(paneId), ...Array.from(Buffer.from(singleLine(text), "utf8"), (b) => b.toString(16).padStart(2, "0"))];
}
export class TmuxAdapter implements TerminalAdapter {
  readonly run: Runner;
  constructor(run: Runner) { this.run = run; }
  listPanes(): Promise<ListedPane[]> { return listPanes(this.run); }
  inspect(paneId: string): Promise<PaneState> { return inspectPane(this.run, paneId); }
  async peek(paneId: string): Promise<string> { return this.run(["capture-pane", "-p", "-J", "-S", "-12", "-t", validPaneId(paneId)]); }
  async preflight(session: SessionRegistration): Promise<void> {
    const pane = await inspectPane(this.run, session.identity.paneId);
    assertIdentity(session, pane);
    const root = await realpath(session.repository);
    const cwd = await realpath(pane.cwd);
    const rel = relative(root, cwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AppError("WRONG_DIRECTORY", "Pane is outside its registered repository.", 409);
  }
  async capture(session: SessionRegistration): Promise<string> {
    await this.preflight(session);
    return this.run(["capture-pane", "-p", "-J", "-S", "-250", "-t", session.identity.paneId]);
  }
  private async typePrompt(session: SessionRegistration, text: string): Promise<string> {
    await this.preflight(session);
    if (text.includes("\n")) {
      // A multi-line prompt arrives the way a terminal delivers a paste: one bracketed paste, which both CLIs insert
      // without submitting (LF becomes CR as a terminal would send it). A single line is still typed as keystrokes.
      const buffer = `altcli-${randomUUID()}`;
      await this.run(["load-buffer", "-b", buffer, "-"], promptText(text));
      await this.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", validPaneId(session.identity.paneId)]);
    } else await this.run(inputArgs(session.identity.paneId, text));
    await new Promise((resolve) => setTimeout(resolve, ENTER_SETTLE_MS));
    // Do not submit text if the CLI exited while characters were being delivered.
    // This narrows but cannot eliminate the terminal check/use race.
    await this.preflight(session);
    return this.run(["capture-pane", "-p", "-t", validPaneId(session.identity.paneId)]);
  }
  async send(session: SessionRegistration, text: string, options: { replaceDraft?: boolean } = {}): Promise<void> {
    const screen = await this.typePrompt(session, text);
    // Text someone left in the input area would be submitted with the command and change what the agent is asked. Submit only when the
    // input area visibly holds just this command. Otherwise nothing is submitted: a typed line that shows up next to other text is
    // erased character by character (the cursor sits right after it); a paste or an unreadable layout is left as it is, since
    // backspacing there could delete someone else's text.
    let found = inputAfterTyping(screen, text);
    if (found === "mixed" && options.replaceDraft === true && ['codex', 'claude'].includes(session.agentType)) {
      const count = inputEraseCount(screen);
      if (count !== null && count <= 16384) {
        // One human-confirmed replacement, before Enter has ever been sent. The cursor may be inside a multiline draft:
        // remove both sides with editing keys, then independently verify the complete new prompt. Never retry a submission.
        await this.preflight(session);
        await this.run(["send-keys", "-N", String(count), "-t", session.identity.paneId, "BSpace"]);
        await this.preflight(session);
        await this.run(["send-keys", "-N", String(count), "-t", session.identity.paneId, "DC"]);
        found = inputAfterTyping(await this.typePrompt(session, text), text);
        if (found !== 'only') throw new AppError('INPUT_UNVERIFIED', 'The confirmed draft replacement could not be verified. Nothing was submitted. Inspect the terminal before starting again.', 409);
      }
    }
    if (found !== "only") {
      const erase = found === "mixed" && !text.includes("\n");
      if (erase) await this.run(["send-keys", "-N", String(Array.from(text).length), "-t", validPaneId(session.identity.paneId), "BSpace"]);
      throw new AppError(found === "mixed" ? "LEFTOVER_INPUT" : "INPUT_UNVERIFIED", `${found === "mixed" ? "The agent's input line held other text besides this command."
        : "The agent's input line could not be confirmed to hold only this command."} Nothing was submitted${erase ? " and the typed command was erased; the other text is still there"
        : "; the command may still be in the input line"}. Clear it in the terminal, take control, then start again.`, 409);
    }
    await this.run(["send-keys", "-t", session.identity.paneId, "Enter"]);
  }
  async processes(session: SessionRegistration): Promise<ProcessRecord[]> {
    const pane = await inspectPane(this.run, session.identity.paneId);
    // Reading process evidence cannot type into the pane; delivery-only mode gates must not lose completions.
    assertIdentity(session, { ...pane, inMode: false, synchronized: false });
    return paneProcesses(session.identity.panePid);
  }
  async press(session: SessionRegistration, key: 'Enter' | 'Escape'): Promise<void> {
    if (key !== 'Enter' && key !== 'Escape') throw new AppError('INVALID_KEY', 'Unsupported terminal key.');
    await this.preflight(session);
    await this.run(['send-keys', '-t', validPaneId(session.identity.paneId), key]);
  }
  foreground(session: SessionRegistration): Promise<string | null> { return foregroundPid(session.identity.panePid); }
  hostProcesses(panePid: string) { return hostPaneProcesses(panePid); }
}
