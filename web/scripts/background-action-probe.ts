// Opt-in real Claude → scoped MCP proposal → explicit owner decision → real temporary file write.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/server/store.ts';
import { BackgroundActions, ACTION_TOOLS, operation } from '../src/server/background/actions.ts';
import { executeCommand } from '../src/server/background/action-executor.ts';
import { hash } from '../src/server/global-ai/reads.ts';
import { claudeJobArgs, invokeClaude, VERIFIED_CLAUDE_VERSION } from './background-native.mjs';
import { ASSESSMENT_SCHEMA, validateAssessment } from '../src/server/attention/assessment.ts';
import type { BackgroundAttempt, BackgroundSettings } from '../src/contracts/background.ts';
import type { AttentionItem } from '../src/contracts/attention.ts';
import type { BackgroundOperation } from '../src/contracts/background-actions.ts';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-action-probe-'))), store = new Store(directory);
const itemId = randomUUID(), sessionId = randomUUID(), token = randomBytes(32).toString('hex');
const item = { id: itemId, status: 'open', stale: false, revision: 1, sourceVersion: 1, kind: 'run', title: 'Synthetic output file is absent.' } as AttentionItem;
const settings = { revision: 1, enabled: true, paused: false, needsInspection: false, instance: { id: 'probe' } } as BackgroundSettings;
const attempt = { id: randomUUID(), instanceId: 'probe', enablement: 1, itemId, itemRevision: 1, sourceVersion: 1 } as BackgroundAttempt;
const expected: BackgroundOperation = { kind: 'command', directory, executable: process.execPath,
  args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "background action probe\\n");console.log("fixture written")', join(directory, 'proof.txt')] };
let calls = 0, executions = 0;
const actions = new BackgroundActions({ db: store.db, settings: () => settings, item: id => id === itemId ? item : undefined, enabled: () => true, settled: () => {},
  execute: (action, signal, started, admitted) => { assert.deepEqual(action.operation, expected); executions++; return executeCommand(action, signal, started, admitted); } });
const served = new Map<string, { source: string; revision: string }>();
const outputSchema = { type: 'object', properties: { source: { type: 'string' }, revision: { type: 'string' }, observedAt: { type: 'string' }, evidenceId: { type: 'string' }, data: { type: 'object' } }, required: ['source', 'revision', 'observedAt', 'evidenceId', 'data'], additionalProperties: false };
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === 'list') {
      response.end(JSON.stringify({ tools: [{ name: 'get_attention_item', description: 'Read the synthetic issue.', inputSchema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'], additionalProperties: false }, outputSchema, annotations: { readOnlyHint: true } }, ...ACTION_TOOLS.map(t => ({ ...t, outputSchema }))] })); return;
    }
    assert.equal(body.method, 'call'); assert.ok(++calls <= 12);
    let data: unknown;
    if (body.name === 'get_attention_item') { assert.equal(body.arguments.itemId, itemId); data = { item }; }
    else {
      assert.ok(ACTION_TOOLS.some(t => t.name === body.name));
      if (body.name === 'request_action') assert.deepEqual(operation(body.arguments.operation), expected); // The probe can propose only this exact synthetic write.
      data = await actions.tool(body.name, body.arguments ?? {}, attempt);
    }
    const evidenceId = randomUUID(), reply = { source: `probe:${body.name}`, revision: hash(data), observedAt: new Date().toISOString(), data, evidenceId };
    served.set(evidenceId, reply); response.end(JSON.stringify(reply));
  } catch { response.writeHead(403); response.end(JSON.stringify({ error: { message: 'Only the exact synthetic probe action is allowed.' } })); }
});
try {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const descriptor = join(directory, 'job.json');
  await writeFile(descriptor, JSON.stringify({ schema: 1, endpoint: `http://127.0.0.1:${address.port}/api/v1/background/tools`, token }), { mode: 0o600 });
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(); assert.equal(version, VERIFIED_CLAUDE_VERSION);
  const result = await invokeClaude({ executable: 'claude', directory, sessionId, deadlineMs: 120000,
    args: claudeJobArgs(['--model', 'haiku', '--effort', 'low'], sessionId, ASSESSMENT_SCHEMA, resolve('scripts/global-ai-mcp.mjs'), descriptor),
    prompt: `This is a disposable Background action probe. Read get_attention_item for ${itemId}, then get_action_permissions. Use request_action exactly once to propose this exact operation: ${JSON.stringify(expected)}. Use requestKey "probe-write" and a brief reason. It must stay pending for owner approval. Do not try to approve it or claim it executed. Finish now with a structured assessment for itemId ${itemId}, itemRevision 1, surface control_access, citing evidenceId actually returned by tools and explaining that confirmation is pending.` });
  assert.equal(result.settled, true); assert.equal(result.status, 'succeeded', JSON.stringify({ category: result.category, calls }));
  validateAssessment(result.assessment, { itemId, itemRevision: 1, kind: 'run', served });
  const pending = actions.view().actions; assert.equal(pending.length, 1); assert.equal(pending[0]!.status, 'pending'); assert.equal(executions, 0);
  await assert.rejects(readFile(join(directory, 'proof.txt')));
  const a = pending[0]!, approval = { action: 'approve', id: a.id, digest: a.digest, confirm: true };
  actions.decide(approval); await actions.drain(); assert.equal(executions, 1);
  assert.equal(await readFile(join(directory, 'proof.txt'), 'utf8'), 'background action probe\n');
  actions.decide(approval); await actions.drain(); assert.equal(executions, 1);
  assert.ok(actions.view().entries.some(e => e.kind === 'completed'));
  console.log(JSON.stringify({ provider: version, model: result.model, toolCalls: calls, proposal: 'pending until explicit fixture-owner decision',
    action: 'exact temporary file write executed once', audit: 'SQLite proposed, authorized and completed records', nativeInvocation: 'settled', evidence: 'synthetic only' }));
} finally { await actions.shutdown(); await new Promise<void>(r => server.close(() => r())); store.close(); await rm(directory, { recursive: true, force: true }); }
