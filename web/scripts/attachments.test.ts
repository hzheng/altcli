import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { ControlPlane } from '../src/server/control-plane.ts';
import { MockAdapter, mockSessions } from '../src/server/adapters/mock.ts';
import { loadConfig } from '../src/server/config.ts';
import { endpoint } from '../src/server/http.ts';
import { AttachmentService, nativeReference } from '../src/server/attachments.ts';
import { ATTACHMENT_LIMITS as L, type AttachmentReceipt } from '../src/contracts/attachments.ts';
import type { TerminalConnection, TerminalFrame } from '../src/contracts/terminals.ts';
import type { ManagedSession } from '../src/contracts/workflow.ts';
import { chunk, jpeg, png, TOKEN, upload as uploadRequest } from './lib/images.ts';

// Real files and SQLite in disposable directories; the terminal and CLI are simulated. Image bytes are small synthetic fixtures.
const WORKSPACE = '/demo/project';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const upload = (body: Buffer | ReadableStream<Uint8Array>, more: Parameters<typeof uploadRequest>[2] & { workspace?: string } = {}) => uploadRequest(more.workspace ?? WORKSPACE, body, more);
/** A body that yields its chunks and then stays open until `end()` or `fail()`. */
function stalledBody(chunks: Uint8Array[]) {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { control = c; for (const piece of chunks) c.enqueue(piece); } });
  return { stream, end: () => control.close(), fail: () => control.error(new Error('client went away')) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const turns = () => new Promise((resolve) => setImmediate(resolve));

let directory: string, store: Store, plane: ControlPlane;
const attachmentsDir = () => join(plane.config.dataDir, 'attachments');
const files = () => existsSync(attachmentsDir()) ? readdirSync(attachmentsDir()).sort() : [];
const rows = () => store.db.prepare('SELECT id,status FROM attachments').all() as { id: string; status: string }[];
const refs = (id: string) => store.db.prepare('SELECT kind FROM attachment_refs WHERE attachment_id=?').all(id) as { kind: string }[];
function makePlane(env: Record<string, string> = {}) {
  return new ControlPlane(new Controller(loadConfig({ ALTCLI_ADAPTER: 'mock', ALTCLI_TOKEN: TOKEN, ALTCLI_DATA_DIR: directory, ALTCLI_ENABLE_TERMINAL: 'true', ...env }), store, new MockAdapter()));
}
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-attachments-'))); store = new Store(directory);
  for (const session of mockSessions()) store.saveSession(session);
  plane = makePlane(); await plane.attachments.recover();
});
afterEach(async () => { await plane.terminals.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });

test('a PNG or JPEG upload is validated, stored privately and returned as a draft receipt; the same request ID is idempotent', async () => {
  const bytes = png(), requestId = randomUUID();
  const receipt = await plane.attachments.upload(upload(bytes, { requestId, name: 'shot.png' }));
  assert.equal(receipt.mediaType, 'image/png'); assert.equal(receipt.width, 3); assert.equal(receipt.height, 2); assert.equal(receipt.sha256, sha(bytes));
  assert.equal(receipt.name, 'shot.png'); assert.equal(receipt.workspace, WORKSPACE);
  assert.equal(Date.parse(receipt.draftExpiresAt!) - Date.parse(receipt.createdAt), L.draftMs);
  assert.deepEqual(files(), [`${receipt.id}.png`]);
  assert.deepEqual(readFileSync(join(attachmentsDir(), `${receipt.id}.png`)), bytes);
  assert.equal(statSync(join(attachmentsDir(), `${receipt.id}.png`)).mode & 0o777, 0o600);
  assert.equal(statSync(attachmentsDir()).mode & 0o777, 0o700);
  assert.deepEqual(await plane.attachments.upload(upload(bytes, { requestId, name: 'shot.png' })), receipt);
  await assert.rejects(plane.attachments.upload(upload(png(3, 2, 9), { requestId })), /bound to another image/);
  const photo = await plane.attachments.upload(upload(jpeg(), { type: 'image/jpeg' }));
  assert.equal(photo.mediaType, 'image/jpeg'); assert.ok(files().includes(`${photo.id}.jpg`));
  assert.deepEqual(rows().map((row) => row.status), ['ready', 'ready']);
});
test('authentication precedes body consumption and allocation; read-only hosts refuse uploads', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ALTCLI_ADAPTER: 'mock', ALTCLI_TOKEN: TOKEN, ALTCLI_DATA_DIR: directory });
  try {
    for (const headers of [{ authorization: 'Bearer ' + 'b'.repeat(64) }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      const request = upload(png(), { headers });
      const response = await endpoint(request, () => plane.attachments.upload(request));
      assert.ok([401, 403].includes(response.status)); assert.equal(request.bodyUsed, false);
    }
    assert.deepEqual(rows(), []); assert.deepEqual(files(), []);
  } finally { process.env = saved; }
  await plane.terminals.shutdown(); plane = makePlane({ ALTCLI_ENABLE_INPUT: 'false' });
  const request = upload(png());
  await assert.rejects(plane.attachments.upload(request), /Input is disabled/); assert.equal(request.bodyUsed, false); assert.deepEqual(rows(), []);
});
test('type, structure, size and length violations leave no row or partial file', async () => {
  await assert.rejects(plane.attachments.upload(upload(png(), { type: 'image/gif' })), /Only PNG and JPEG/);
  await assert.rejects(plane.attachments.upload(upload(jpeg(), { type: 'image/png' })), /JPEG image but was sent as image\/png/);
  await assert.rejects(plane.attachments.upload(upload(png().subarray(0, 40))), /truncated/);
  await assert.rejects(plane.attachments.upload(upload(Buffer.concat([png().subarray(0, 33), chunk('acTL', Buffer.alloc(8)), png().subarray(33)]))), /Animated/);
  const early = upload(png(), { headers: { 'content-length': String(L.fileBytes + 1) } });
  await assert.rejects(plane.attachments.upload(early), /limited to 10 MiB/); assert.equal(early.bodyUsed, false);
  await assert.rejects(plane.attachments.upload(upload(png(), { headers: { 'content-length': '5000' } })), /empty or incomplete/);
  const big = new Uint8Array(1024 * 1024);
  const oversized = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 11; i++) c.enqueue(big); c.close(); } });
  await assert.rejects(plane.attachments.upload(upload(oversized)), /limited to 10 MiB/);
  await assert.rejects(plane.attachments.upload(upload(png(), { workspace: '/elsewhere' })), /not for a current workspace/);
  assert.deepEqual(rows(), []); assert.deepEqual(files(), []);
});
test('an upload that stalls past its time bound is cancelled and reclaimed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = stalledBody([png().subarray(0, 20)]);
  const pending = plane.attachments.upload(upload(body.stream));
  for (let i = 0; i < 200 && !rows().length; i++) await turns();
  assert.deepEqual(rows().map((row) => row.status), ['uploading']);
  const rejected = assert.rejects(pending, /took too long/);
  t.mock.timers.tick(L.uploadMs); await rejected;
  assert.deepEqual(rows(), []); assert.deepEqual(files(), []);
});
test('concurrent uploads are bounded and an aborted client leaves nothing behind', async () => {
  const first = stalledBody([new Uint8Array(8)]), second = stalledBody([new Uint8Array(8)]);
  const a = plane.attachments.upload(upload(first.stream)), b = plane.attachments.upload(upload(second.stream));
  for (let i = 0; i < 200 && rows().length < 2; i++) await turns();
  await assert.rejects(plane.attachments.upload(upload(png())), /At most 2 images upload at once/);
  first.fail(); second.fail();
  await assert.rejects(a, /interrupted/); await assert.rejects(b, /interrupted/);
  assert.deepEqual(rows(), []); assert.deepEqual(files(), []);
  assert.ok(await plane.attachments.upload(upload(png())));
});
test('the retained quota refuses new uploads with a diagnostic instead of evicting anything', async () => {
  const kept = await plane.attachments.upload(upload(png()));
  store.db.prepare('INSERT INTO attachments(id,request_id,status,value) VALUES (?,?,?,?)').run(randomUUID(), randomUUID(), 'ready',
    JSON.stringify({ reservedBytes: L.retainedBytes - 100, createdAt: new Date().toISOString(), status: 'ready' }));
  await assert.rejects(plane.attachments.upload(upload(png())), (error: Error) => /Image storage is full: 512 MiB in 2 files/.test(error.message) && /no in-app way to release/.test(error.message) && /Deleting files by hand/.test(error.message));
  assert.ok(files().includes(`${kept.id}.png`));
});
test('storage refuses symlinked or foreign directories, a data directory inside the workspace, and hard-linked files', async () => {
  const target = join(directory, 'elsewhere'); mkdirSync(target);
  rmSync(attachmentsDir(), { recursive: true }); symlinkSync(target, attachmentsDir());
  await assert.rejects(plane.attachments.upload(upload(png())), /ordinary directory/);
  assert.deepEqual(readdirSync(target), []); assert.deepEqual(rows(), []);
  unlinkSync(attachmentsDir()); await plane.attachments.prepare();
  // A tmux host whose data directory is inside the workspace cannot store images outside it.
  const workspace = join(directory, 'repo'); mkdirSync(workspace);
  const inside = new AttachmentService({ ...plane.config, mode: 'tmux', dataDir: join(workspace, '.altcli') }, store, async () => [workspace]);
  await assert.rejects(inside.upload(upload(png(), { workspace })), /inside this workspace/);
  // A second name for a stored file means it may change underneath its hash: every use refuses it.
  const receipt = await plane.attachments.upload(upload(png()));
  linkSync(join(attachmentsDir(), `${receipt.id}.png`), join(directory, 'second-name.png'));
  await assert.rejects(plane.attachments.describe([receipt.id], WORKSPACE), /missing or changed/);
});
test('removal deletes only unreferenced drafts; possible use is pinned server-side and wins or loses atomically', async () => {
  const draft = await plane.attachments.upload(upload(png()));
  assert.deepEqual(await plane.attachments.remove(draft.id), { ok: true, removed: true }); assert.deepEqual(files(), []);
  assert.deepEqual(await plane.attachments.remove(draft.id), { ok: true, removed: false });
  await assert.rejects(plane.attachments.remove('../etc'), /UUID/);
  const used = await plane.attachments.upload(upload(png()));
  const [descriptor] = await plane.attachments.describe([used.id], WORKSPACE);
  plane.attachments.pin([descriptor!], 'native', 'connection:generation:1');
  await assert.rejects(plane.attachments.remove(used.id), /may already have been used/); assert.ok(files().includes(`${used.id}.png`));
  // Deletion first: a later pin of the resolved descriptor fails before any write or dispatch.
  const raced = await plane.attachments.upload(upload(png()));
  const [late] = await plane.attachments.describe([raced.id], WORKSPACE);
  await plane.attachments.remove(raced.id);
  assert.throws(() => plane.attachments.pin([late!], 'run', randomUUID()), /removed or changed/);
  // A changed file is refused at verification; nothing is regenerated.
  writeFileSync(join(attachmentsDir(), `${used.id}.png`), png(3, 2, 1));
  await assert.rejects(plane.attachments.verify([descriptor!]), /missing or changed/);
});
test('reclaiming removes expired drafts and abandoned uploads but never referenced images; restart recovers interrupted uploads', async () => {
  const draft = await plane.attachments.upload(upload(png())), used = await plane.attachments.upload(upload(png()));
  plane.attachments.pin(await plane.attachments.describe([used.id], WORKSPACE), 'run', randomUUID());
  assert.equal(await plane.attachments.reclaim(Date.now() + L.draftMs - 1000), 0);
  assert.equal(await plane.attachments.reclaim(Date.now() + L.draftMs + 1000), 1);
  assert.deepEqual(files(), [`${used.id}.png`]); assert.deepEqual(rows().map((row) => row.id), [used.id]);
  assert.equal(await plane.attachments.reclaim(Date.now() + 365 * L.draftMs), 0);
  // An interrupted upload, its published file, a stale partial for a ready row, an orphan and an unrelated file.
  const interrupted = randomUUID(), orphan = randomUUID();
  store.db.prepare('INSERT INTO attachments(id,request_id,status,value) VALUES (?,?,?,?)').run(interrupted, randomUUID(), 'uploading',
    JSON.stringify({ id: interrupted, status: 'uploading', reservedBytes: 10, createdAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }));
  for (const name of [`${interrupted}.part`, `${interrupted}.png`, `${used.id}.part`, `${orphan}.jpg`, 'notes.txt']) writeFileSync(join(attachmentsDir(), name), 'x');
  await plane.terminals.shutdown(); plane = makePlane(); await plane.attachments.recover();
  assert.deepEqual(files(), [`${used.id}.png`, 'notes.txt']); assert.deepEqual(rows().map((row) => row.id), [used.id]);
  assert.equal(draft.id !== used.id, true);
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; frames: TerminalFrame[] = [];
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
async function connect(agentId = 'codex') {
  const s = (await plane.state()).sessions.find((session) => session.id === agentId)!;
  const opened: TerminalConnection = await plane.terminals.open({ protocol: 2, target: { agentId: s.id, registrationId: s.registrationId }, cols: 80, rows: 24, clientInstanceId: randomUUID() });
  const socket = new Socket(); plane.terminals.connect(socket as unknown as WebSocket); socket.frame({ ticket: opened.ticket }); await settle();
  const reset = socket.frames.find((f) => f.type === 'reset'); assert.ok(reset?.type === 'reset');
  const owner = await plane.terminals.keyboard(opened.connectionId, { requestId: randomUUID(), expectedBootId: plane.authority.bootId, expectedGeneration: reset.generation, action: 'acquire' });
  return { opened, generation: owner.generation };
}
/** A writer attachment that records every write and can report navigation or hold its destination check. */
function fixture() {
  const state = { writes: [] as Buffer[], pane: null as string | null, hold: null as Promise<void> | null, fail: false };
  plane.terminals.services.attach = async (_config, target) => ({ pid: 1, resize: () => {}, pause: () => {}, resume: () => {}, close: async () => {},
    write: (bytes) => { if (state.fail) throw Error('pty closed'); state.writes.push(Buffer.from(bytes)); },
    active: async () => { if (state.hold) await state.hold; return { paneId: state.pane ?? target.identity.paneId, sessionId: target.sessionId, label: target.label, command: 'fixture' }; } });
  return state;
}
const image = (c: Awaited<ReturnType<typeof connect>>, receipt: AttachmentReceipt, seq = 1, more: Partial<{ bootId: string; paneId: string; sessionId: string }> = {}) =>
  plane.terminals.input(c.opened.connectionId, { generation: c.generation, seq, image: { attachmentId: receipt.id, bootId: plane.authority.bootId, paneId: c.opened.paneId, sessionId: c.opened.sessionId, ...more } });

test('an explicit image insertion writes exactly one quoted bracketed-paste reference, never Enter, after pinning it', async () => {
  const pty = fixture(), c = await connect(), receipt = await plane.attachments.upload(upload(png()));
  assert.deepEqual(await image(c, receipt), { generation: c.generation, seq: 1 });
  const path = join(realpathSync(attachmentsDir()), `${receipt.id}.png`);
  assert.deepEqual(pty.writes, [Buffer.from(`\x1b[200~'${path}'\x1b[201~`)]);
  assert.ok(!pty.writes[0]!.includes('\r') && !pty.writes[0]!.includes('\n'));
  assert.deepEqual(refs(receipt.id), [{ kind: 'native' }]);
  assert.equal(plane.authority.pending()[0]!.bytes, pty.writes[0]!.length);
  await assert.rejects(plane.attachments.remove(receipt.id), /may already have been used/);
  // A duplicate receipt is returned without writing again; a different image under that sequence conflicts.
  assert.deepEqual(await image(c, receipt), { generation: c.generation, seq: 1 }); assert.equal(pty.writes.length, 1);
  const other = await plane.attachments.upload(upload(png(3, 2, 2)));
  await assert.rejects(image(c, other), /Conflicting or expired input receipt/);
  // Ordinary typed input keeps the same lane and sequence.
  await plane.terminals.input(c.opened.connectionId, { generation: c.generation, seq: 2, encoding: 'utf8', data: ' describe it' });
  assert.equal(pty.writes.length, 2);
});
test('image insertion refuses a changed boot, pane, session, navigation, CLI type, workspace or deleted image before writing or pinning', async () => {
  const pty = fixture(), c = await connect(), receipt = await plane.attachments.upload(upload(png()));
  await assert.rejects(image(c, receipt, 1, { bootId: randomUUID() }), /not the one the image was chosen for/);
  await assert.rejects(image(c, receipt, 1, { paneId: '%9' }), /not the one the image was chosen for/);
  await assert.rejects(image(c, receipt, 1, { sessionId: 'mock-%9' }), /not the one the image was chosen for/);
  pty.pane = '%7';
  await assert.rejects(image(c, receipt), /another pane or session/);
  pty.pane = null;
  const foreign = await plane.attachments.upload(upload(png(), { workspace: WORKSPACE }));
  store.db.prepare("UPDATE attachments SET value=json_set(value,'$.workspace','/other') WHERE id=?").run(foreign.id);
  await assert.rejects(image(c, foreign), /belongs to another workspace/);
  const removed = await plane.attachments.upload(upload(png(3, 2, 5))); await plane.attachments.remove(removed.id);
  await assert.rejects(image(c, removed), /missing, still uploading/);
  const session = store.sessions().find((s) => s.id === 'codex') as ManagedSession;
  store.saveSession({ ...session, agentType: 'other' });
  await assert.rejects(image(c, receipt), /verified only for Claude Code and Codex/);
  assert.deepEqual(pty.writes, []); assert.deepEqual(refs(receipt.id), []);
  assert.equal(plane.authority.pending()[0]!.bytes, 0);
});
test('navigation while the image is prepared refuses before pinning or writing; returning first still inserts once', async () => {
  const pty = fixture(), c = await connect(), receipt = await plane.attachments.upload(upload(png()));
  const prepare = plane.terminals.services.image.bind(plane.terminals.services);
  let release!: () => void, preparing = false;
  plane.terminals.services.image = async (...args) => { const prepared = await prepare(...args); preparing = true; await new Promise<void>((resolve) => { release = resolve; }); return prepared; };
  const navigated = assert.rejects(image(c, receipt), /another pane or session/);
  for (let i = 0; i < 200 && !preparing; i++) await settle();
  pty.pane = '%7'; release(); await navigated;
  assert.deepEqual(pty.writes, []); assert.deepEqual(refs(receipt.id), []); assert.equal(plane.authority.pending()[0]!.bytes, 0);
  // The failed sequence leaves a gap, so a new connection makes the next attempt; the writer went away and came back meanwhile.
  const next = await connect(); preparing = false; pty.pane = null;
  const returned = image(next, receipt);
  for (let i = 0; i < 200 && !preparing; i++) await settle();
  pty.pane = '%7'; pty.pane = null; release();
  assert.deepEqual(await returned, { generation: next.generation, seq: 1 });
  assert.equal(pty.writes.length, 1); assert.deepEqual(refs(receipt.id), [{ kind: 'native' }]);
});
test('stopping input during the destination check wins; a failed write is uncertain, pinned and never retried', async () => {
  const pty = fixture(), c = await connect(), receipt = await plane.attachments.upload(upload(png()));
  let release!: () => void; pty.hold = new Promise<void>((resolve) => { release = resolve; });
  const pending = assert.rejects(image(c, receipt), /ended before writing|Keyboard authority ended/);
  await settle();
  const stopped = plane.terminals.keyboard(c.opened.connectionId, { requestId: randomUUID(), expectedBootId: plane.authority.bootId, expectedGeneration: c.generation, action: 'release' });
  await settle(); pty.hold = null; release(); await pending; await stopped;
  assert.deepEqual(pty.writes, []); assert.deepEqual(refs(receipt.id), []);
  const next = await connect(); pty.fail = true;
  await assert.rejects(image(next, receipt), /may have been inserted/);
  assert.deepEqual(refs(receipt.id), [{ kind: 'native' }]);
});
test('a launch-only terminal and a reference that cannot be quoted are refused', async () => {
  assert.throws(() => nativeReference("/tmp/it's.png"), /cannot be referenced safely/);
  assert.throws(() => nativeReference('/tmp/a\nb.png'), /cannot be referenced safely/);
  assert.throws(() => nativeReference('relative.png'), /cannot be referenced safely/);
  assert.deepEqual(nativeReference('/tmp/图片 é.png'), Buffer.from("\x1b[200~'/tmp/图片 é.png'\x1b[201~"));
  const receipt = await plane.attachments.upload(upload(png()));
  const attach = { identity: mockSessions()[0]!.identity, sessionId: 'mock-%0', label: 'x' };
  await assert.rejects(plane.terminals.services.image({ launchId: randomUUID() }, attach, receipt.id), /registered agent terminal/);
});
