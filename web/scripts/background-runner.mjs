#!/usr/bin/env node
// One trusted, private tmux process. Only the host can issue jobs; the model sees a different scoped MCP descriptor.
import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostRead, connectionFile } from './global-ai-mcp.mjs';
import { invokeClaude } from './background-native.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function receipt(directory, value) {
  const path = join(directory, 'receipt.json'), temporary = `${path}.part`;
  const file = await open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export async function run(path) {
  const descriptor = await connectionFile(path);
  if (new URL(descriptor.endpoint).pathname !== '/api/v1/background/runner') throw new Error('Runner capability required.');
  const seen = new Set(); let shutdown = false, active = null;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shutdown = true; active?.abort(); });
  while (!shutdown) {
    let job;
    try { ({ job } = await hostRead(path, { method: 'poll' })); }
    catch { await delay(1000); continue; }
    if (!job) { await delay(1000); continue; }
    if (seen.has(job.id)) throw new Error('A claim was delivered twice; no invocation replayed.');
    seen.add(job.id); const abort = new AbortController(); active = abort;
    if (seen.size > 200) seen.delete(seen.values().next().value);
    let started = Promise.resolve();
    let heartbeatBusy = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatBusy) return; heartbeatBusy = true;
      try { if (!(await hostRead(path, { method: 'control', attemptId: job.id })).continue) abort.abort(); }
      catch { abort.abort(); } finally { heartbeatBusy = false; }
    }, 1000);
    const result = await invokeClaude({ ...job, signal: abort.signal, onStarted: pid => {
      // Persist identity before the started RPC; restart inspection can still locate this exact invocation after a lost receipt.
      started = receipt(job.directory, { attemptId: job.id, pid, sessionId: job.sessionId, phase: 'running' })
        .then(() => hostRead(path, { method: 'started', attemptId: job.id, pid })).catch(() => abort.abort());
    } });
    clearInterval(heartbeat); active = null;
    await started;
    await receipt(job.directory, { attemptId: job.id, phase: 'complete', result });
    // A lost completion ACK is retried as the same receipt. No subsequent claim is polled before it is acknowledged.
    while (!shutdown) {
      try { await hostRead(path, { method: 'complete', attemptId: job.id, result }); break; }
      catch { await delay(1000); }
    }
    if (!result.settled) break;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv[2] ?? '').catch(() => { process.stderr.write('Background runner stopped. Inspect its recorded instance.\n'); process.exitCode = 1; });
}
