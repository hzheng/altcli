import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ProcessRecord } from "../contracts/workflow.ts";
import type { FinishProcess } from "../contracts/projects.ts";
import { AppError } from "../core/errors.ts";
import { observationProcess } from './observation.ts';
export interface ProcessTableRow { pid: string; ppid: string; tty: string; command: string; args?: string }
/** One `ps` read of the host process table: pid, parent pid, controlling terminal and executable. */
function processTable(): Promise<ProcessTableRow[]> {
  return new Promise((resolve, reject) => {
    const probe = execFile("ps", ["-axo", "pid=,ppid=,tty=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, shell: false }, (error, stdout) => {
      if (error) return reject(new AppError("PS_FAILED", "Could not read the host process table.", 409));
      resolve(stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
        // Only this completed inspection is exempt, never other children of the server or other ps processes.
        return match && match[1] !== String(probe.pid) ? [{ pid: match[1]!, ppid: match[2]!, tty: match[3]!, command: match[4]! }] : [];
      }));
    });
  });
}
export interface HostPaneEvidence { foregroundPid: string; lineage: ProcessRecord[]; writers: ProcessRecord[]; backendChildren: string[] }
/** Prove that this pane contains the running backend itself, not merely a process named node. Only its shell/npm
 * launch chain is infrastructure. Agent ancestors, host children, siblings and reparented tty work remain blockers. */
export function hostProcessesForPane(rows: ProcessTableRow[], rootPid: string, hostPid: string, foreground: string | null): HostPaneEvidence | null {
  const lineage: ProcessTableRow[] = []; const seen = new Set<string>();
  let pid = hostPid;
  while (!seen.has(pid)) {
    const row = rows.find(p => p.pid === pid);
    if (!row) return null;
    seen.add(pid); lineage.push(row);
    if (pid === rootPid) break;
    pid = row.ppid;
  }
  if (lineage.at(-1)?.pid !== rootPid) return null;
  if (!foreground || !seen.has(foreground) || lineage.slice(1).some(p =>
    !/^(?:-?(?:sh|bash|zsh|fish|dash|ksh|tcsh|csh)|npm(?: run (?:start|dev))?)$/.test(basename(p.command)))) {
    throw new AppError('PS_FAILED', 'The AltCLI host launch chain or foreground process is not verified.', 409);
  }
  const members = paneMembers(rows, rootPid)!;
  const record = ({ pid, command }: ProcessTableRow): ProcessRecord => ({ pid, command });
  return { foregroundPid: foreground, lineage: lineage.map(record), writers: rows.filter(p => members.has(p.pid) && !seen.has(p.pid)).map(record),
    backendChildren: rows.filter(p => p.ppid === hostPid).map(p => p.pid) };
}
/** Sequential reads ensure the foreground probe has exited before scanning for surviving host-pane work. */
export async function hostPaneProcesses(rootPid: string): Promise<HostPaneEvidence | null> {
  const foreground = await foregroundPid(rootPid);
  return hostProcessesForPane(await processTable(), rootPid, String(process.pid), foreground);
}
/** Arguments are used transiently to identify CLI infrastructure, never returned or persisted. */
function processArguments(): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, shell: false }, (error, stdout) => {
      if (error) return reject(new AppError('PS_FAILED', 'Could not identify CLI infrastructure.', 409));
      resolve(new Map(stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line); return match ? [[match[1]!, match[2]!]] : [];
      })));
    });
  });
}
/** The process group in the foreground of the pane's tty: the CLI itself, or the pane shell when nothing runs. Null when the pane process is gone. */
export function foregroundPid(panePid: string): Promise<string | null> {
  return observationProcess(() => new Promise((resolve) => {
    execFile("ps", ["-o", "tpgid=", "-p", panePid], { encoding: "utf8", timeout: 5000, shell: false }, (error, stdout) => {
      const pid = stdout.trim();
      resolve(!error && /^\d+$/.test(pid) ? pid : null);
    });
  }));
}
/** Codex's own helper processes, started lazily by the CLI (code-mode host, the ChatGPT app's computer-use REPL).
 * They are part of Codex, not work it left running. Anything else that appears during a turn is judged as work. */
const CODEX_HELPERS = [/(^|\/)(codex-code-mode-host|codex-app-server)$/, /\/(ChatGPT|Codex Computer Use)\.app\/.*\/node_repl$/];
export const isCodexHelper = (command: string): boolean => CODEX_HELPERS.some((pattern) => pattern.test(command));
/** The browser tool's persistent REPL uses two sandboxed kernels and an app-server. Keep
 * real shell workers and other Codex turns visible, even when they descend from that REPL. */
function isReplInfrastructure(row: ProcessTableRow, rows: ProcessTableRow[]): boolean {
  const parent = rows.find((p) => p.pid === row.ppid);
  if (!parent) return false;
  const repl = /\/(ChatGPT|Codex Computer Use)\.app\/.*\/node_repl$/;
  const codex = /\/(ChatGPT|Codex Computer Use)\.app\/Contents\/Resources\/codex$/;
  const kernel = / -- \/.*\/(ChatGPT|Codex Computer Use)\.app\/Contents\/Resources\/cua_node\/bin\/node --experimental-vm-modules \/[^\n]+\/(kernel|trusted-worker)\.js(?: |$)/;
  if (codex.test(row.command) && repl.test(parent.command)) {
    return row.args === `${row.command} app-server --listen stdio://` ||
      (row.args?.startsWith(`${row.command} sandbox `) === true && kernel.test(row.args));
  }
  return /\/(ChatGPT|Codex Computer Use)\.app\/Contents\/Resources\/cua_node\/bin\/node$/.test(row.command) &&
    codex.test(parent.command) && parent.args?.startsWith(`${parent.command} sandbox `) === true && kernel.test(parent.args) &&
    rows.some((p) => p.pid === parent.ppid && repl.test(p.command)) &&
    row.args?.startsWith(`${row.command} --experimental-vm-modules `) === true && /\/(kernel|trusted-worker)\.js(?: |$)/.test(row.args);
}
/** Claude's bounded macOS sleep-prevention helper runs no utility. Keep other caffeinate invocations and any children
 * visible as work. Arguments are transient evidence, never returned or persisted. */
function isSleepPrevention(row: ProcessTableRow): boolean {
  return (row.command === '/usr/bin/caffeinate' || row.command === 'caffeinate') &&
    /^(?:\/usr\/bin\/)?caffeinate -i -t 300$/.test(row.args ?? '');
}
/** Select the pane's descendants plus processes still attached to its tty. The tty union retains ordinary
 * background children after their short-lived parent exits and the OS reparents them. */
export function processesForPane(rows: ProcessTableRow[], rootPid: string): ProcessRecord[] {
  const ids = paneMembers(rows, rootPid);
  if (!ids) throw new AppError("PS_FAILED", "The pane process is no longer present.", 409);
  return rows.filter((row) => ids.has(row.pid) && !isReplInfrastructure(row, rows) && !isSleepPrevention(row)).map(({ pid, command }) => ({ pid, command }));
}
/** PIDs of the root's descendants plus processes still on its terminal (excluding the root); null when the root is gone. */
function paneMembers(rows: ProcessTableRow[], rootPid: string): Set<string> | null {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return null;
  const ids = new Set<string>(); const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) if (row.ppid === parent && !ids.has(row.pid)) { ids.add(row.pid); queue.push(row.pid); }
  }
  // ps prints "??" (macOS) or "?" (Linux) for no controlling terminal; a root without one must not sweep in every daemon.
  if (!["??", "?", "-", ""].includes(root.tty)) for (const row of rows) if (row.pid !== rootPid && row.tty === root.tty) ids.add(row.pid);
  return ids;
}
/** Start time of every live PID (ps `lstart`), so a reused PID is never mistaken for a process seen earlier. Null when ps fails. */
export function processStarts(): Promise<Map<string, string> | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,lstart="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, shell: false }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(new Map(stdout.split("\n").flatMap((line) => { const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line); return match ? [[match[1]!, match[2]!] as const] : []; })));
    });
  });
}
/** Every process of a pane, for Finish branch: the root (the CLI), its descendants and other processes on its terminal, with start
 * times. Known CLI helpers are labelled, never dropped: closing the session ends them too, and they can survive like any other. */
export async function paneProcessTree(rootPid: string): Promise<{ root: FinishProcess | null; processes: FinishProcess[] }> {
  const [rows, args, starts] = await Promise.all([processTable(), processArguments(), processStarts()]);
  const table = rows.map((row) => ({ ...row, args: args.get(row.pid) }));
  const ids = paneMembers(table, rootPid);
  const evidence = (row: ProcessTableRow): FinishProcess => ({ pid: row.pid, command: row.command, started: starts?.get(row.pid) ?? null,
    infrastructure: isCodexHelper(row.command) || isReplInfrastructure(row, table) || isSleepPrevention(row) });
  const root = table.find((row) => row.pid === rootPid);
  return { root: root ? evidence(root) : null, processes: ids ? table.filter((row) => ids.has(row.pid)).map(evidence) : [] };
}
/** Live task processes belonging to the pane, excluding the pane itself and verified REPL infrastructure. */
export async function paneProcesses(rootPid: string): Promise<ProcessRecord[]> {
  const [rows, args] = await Promise.all([processTable(), processArguments()]);
  return processesForPane(rows.map((row) => ({ ...row, args: args.get(row.pid) })), rootPid);
}
