// Opt-in installed-provider probe. Uses synthetic issue evidence and a private temporary MCP descriptor; no workspace data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeJobArgs, invokeClaude, VERIFIED_CLAUDE_VERSION } from './background-native.mjs';
import { ASSESSMENT_SCHEMA, validateAssessment } from '../src/server/attention/assessment.ts';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-background-probe-')));
const itemId = randomUUID(), sessionId = randomUUID(), evidenceId = randomUUID(), token = randomBytes(32).toString('hex');
let calls = 0;
const reply = { source: 'altcli:get_attention_item', observedAt: new Date().toISOString(), revision: 'b'.repeat(64), evidenceId,
  data: { item: { id: itemId, revision: 1, kind: 'run', facets: ['delivery_uncertain'], title: 'Delivery uncertain',
    detail: 'Synthetic probe: the transport did not return a receipt. Do not retry until the original delivery is inspected.' } } };
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.method === 'list') response.end(JSON.stringify({ tools: [{ name: 'get_attention_item', description: 'Read this synthetic issue.',
    inputSchema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { source: { type: 'string' }, revision: { type: 'string' }, observedAt: { type: 'string' }, evidenceId: { type: 'string' }, data: { type: 'object' } }, required: ['source', 'revision', 'observedAt', 'evidenceId', 'data'] },
    annotations: { readOnlyHint: true } }] }));
  else if (body.method === 'call' && body.name === 'get_attention_item' && body.arguments?.itemId === itemId) { calls++; response.end(JSON.stringify(reply)); }
  else { response.writeHead(403); response.end(JSON.stringify({ error: { message: 'Out of scope.' } })); }
});
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const descriptor = join(directory, 'job.json');
  await writeFile(descriptor, JSON.stringify({ schema: 1, endpoint: `http://127.0.0.1:${address.port}/api/v1/background/tools`, token }), { mode: 0o600 });
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, VERIFIED_CLAUDE_VERSION);
  const result = await invokeClaude({ executable: 'claude', directory, sessionId, deadlineMs: 120000,
    onInit: event => console.log(JSON.stringify({ initialization: event })),
    args: claudeJobArgs(['--model', 'haiku', '--effort', 'low'], sessionId, ASSESSMENT_SCHEMA, resolve('scripts/global-ai-mcp.mjs'), descriptor),
    prompt: `Read get_attention_item for itemId ${itemId}. Explain this synthetic issue, citing the returned evidenceId. Return itemId ${itemId}, itemRevision 1 and surface control_access in the structured assessment. Do not invent facts or claim the delivery completed.` });
  assert.equal(result.settled, true, JSON.stringify({ category: result.category }));
  assert.equal(result.status, 'succeeded', JSON.stringify({ category: result.category, model: result.model, calls }));
  assert.ok(calls >= 1 && calls <= 12);
  validateAssessment(result.assessment, { itemId, itemRevision: 1, kind: 'run', served: new Map([[evidenceId, reply]]) });
  console.log(JSON.stringify({ provider: version, model: result.model, toolCalls: calls, structuredAssessment: 'validated', processGroup: 'settled', inheritedToolsAndPlugins: 'absent', hookEvents: 'absent', evidence: 'synthetic only' }));
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
