#!/usr/bin/env node
// Small stdio MCP bridge: newline JSON-RPC only. It has no database or owner token, and never executes app mutations.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export async function connectionFile(path) {
  if (!isAbsolute(path)) throw new Error('A private connection descriptor is required.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 4096) throw new Error('Invalid private connection descriptor.');
    const bytes = Buffer.alloc(4097), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Connection descriptor is oversized.');
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), url = new URL(value.endpoint);
    if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.token) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/global-ai/tools') throw new Error('Invalid private connection descriptor.');
    return { endpoint: url.href, token: value.token };
  } finally { await file.close(); }
}
export async function hostRead(path, body) {
  // Re-read after explicit owner renewal; old credentials never resume automatically after host restart.
  const descriptor = await connectionFile(path);
  const response = await fetch(descriptor.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${descriptor.token}`, Origin: new URL(descriptor.endpoint).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const reader = response.body?.getReader(); if (!reader) throw new Error('No app-tool response.');
  const parts = []; let count = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; count += value.byteLength;
      if (count > 160 * 1024) { await reader.cancel(); throw new Error('App-tool response exceeded its bound.'); } parts.push(value); }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!response.ok) throw new Error(result?.error?.message ?? 'App-tool read refused.');
  return result;
}
export function createProtocol(call) {
  let initialized = false;
  return async (request) => {
    const id = request?.id;
    const error = (code, message) => ({ jsonrpc: '2.0', id: typeof id === 'number' || typeof id === 'string' ? id : null, error: { code, message } });
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || Array.isArray(request) ||
      id !== undefined && !(typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id))) return error(-32600, 'Invalid JSON-RPC request.');
    if (id === undefined) return null; // Notifications, including initialized/cancelled, never produce a response.
    if (request.method === 'initialize') {
      if (initialized) return error(-32600, 'Already initialized.');
      initialized = true;
      return { jsonrpc: '2.0', id, result: { protocolVersion: request.params?.protocolVersion === '2025-06-18' ? '2025-06-18' : '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'altcli-read', version: '1.0.0' },
        instructions: 'Read-only AltCLI tools. Cite returned source/revision and document lines. No approval or execution tools exist.' } };
    }
    if (!initialized) return error(-32002, 'Initialize first.');
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (!['tools/list', 'tools/call'].includes(request.method)) return error(-32601, 'Method not supported.');
    try {
      if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: await call({ method: 'list' }) };
      if (typeof request.params?.name !== 'string') return error(-32602, 'A tool name is required.');
      const result = await call({ method: 'call', name: request.params.name, arguments: request.params.arguments ?? {} });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
    } catch (cause) {
      // Never print fetch options, credentials or provider output on stdout/stderr.
      const message = cause instanceof Error ? cause.message.slice(0, 500) : 'App-tool read unavailable.';
      return request.method === 'tools/call' ? { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } }
        : error(-32000, 'App tools unavailable. Check the host and refresh app access.');
    }
  };
}
/** @param {string} path @param {import('node:stream').Readable} [input] @param {import('node:stream').Writable} [output] */
export async function main(path, input = process.stdin, output = process.stdout) {
  await connectionFile(path);
  const protocol = createProtocol(body => hostRead(path, body));
  let pending = ''; const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    // A bridge handles one read at a time and relies on stream backpressure, never an unbounded request queue.
    if (Buffer.byteLength(pending) > 128 * 1024) throw new Error('MCP input exceeded its bound.');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 16 * 1024) throw new Error('MCP request exceeded its bound.');
      let response;
      try { response = await protocol(JSON.parse(line)); }
      catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }; }
      if (response && !output.write(JSON.stringify(response) + '\n')) await once(output, 'drain');
    }
    if (Buffer.byteLength(pending) > 16 * 1024) throw new Error('MCP request exceeded its bound.');
  }
  pending += decoder.end();
  if (pending.trim()) throw new Error('Incomplete MCP frame at EOF.');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2] ?? '').catch(() => { process.stderr.write('AltCLI read bridge stopped. Check host app access and its private descriptor.\n'); process.exitCode = 1; });
}
