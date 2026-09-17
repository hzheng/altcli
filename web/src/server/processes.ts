import { execFile } from "node:child_process";
import type { ProcessRecord } from "../contracts/workflow.ts";
import { AppError } from "../core/errors.ts";
export interface ProcessTableRow { pid: string; ppid: string; tty: string; command: string }
/** One `ps` read of the host process table: pid, parent pid, controlling terminal and executable. */
function processTable(): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,tty=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, shell: false }, (error, stdout) => {
      if (error) return reject(new AppError("PS_FAILED", "Could not read the host process table.", 409));
      resolve(stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
        return match ? [{ pid: match[1]!, ppid: match[2]!, tty: match[3]!, command: match[4]! }] : [];
      }));
    });
  });
}
/** The process group in the foreground of the pane's tty: the CLI itself, or the pane shell when nothing runs. Null when the pane process is gone. */
export function foregroundPid(panePid: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "tpgid=", "-p", panePid], { encoding: "utf8", timeout: 5000, shell: false }, (error, stdout) => {
      const pid = stdout.trim();
      resolve(!error && /^\d+$/.test(pid) ? pid : null);
    });
  });
}
/** Codex's own helper processes, started lazily by the CLI (code-mode host, the ChatGPT app's computer-use REPL).
 * They are part of Codex, not work it left running. Anything else that appears during a turn is judged as work. */
const CODEX_HELPERS = [/(^|\/)(codex-code-mode-host|codex-app-server)$/, /\/(ChatGPT|Codex Computer Use)\.app\/.*\/node_repl$/];
export const isCodexHelper = (command: string): boolean => CODEX_HELPERS.some((pattern) => pattern.test(command));
/** Select the pane's descendants plus processes still attached to its tty. The tty union retains ordinary
 * background children after their short-lived parent exits and the OS reparents them. */
export function processesForPane(rows: ProcessTableRow[], rootPid: string): ProcessRecord[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) throw new AppError("PS_FAILED", "The pane process is no longer present.", 409);
  const ids = new Set<string>(); const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) if (row.ppid === parent && !ids.has(row.pid)) { ids.add(row.pid); queue.push(row.pid); }
  }
  // ps prints "??" (macOS) or "?" (Linux) for no controlling terminal; a root without one must not sweep in every daemon.
  if (!["??", "?", "-", ""].includes(root.tty)) for (const row of rows) if (row.pid !== rootPid && row.tty === root.tty) ids.add(row.pid);
  return rows.filter((row) => ids.has(row.pid)).map(({ pid, command }) => ({ pid, command }));
}
/** Every live process belonging to the pane. The pane process itself is not included. */
export async function paneProcesses(rootPid: string): Promise<ProcessRecord[]> {
  return processesForPane(await processTable(), rootPid);
}
