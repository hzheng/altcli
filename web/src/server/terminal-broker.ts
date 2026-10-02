import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
const rawBuffer = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
import type { KeyboardResult, ManualReconcile, ManualSession, NativeImageInput, TerminalConnection, TerminalFrame, TerminalOpen, TerminalTarget } from '../contracts/terminals.ts';
import type { AttachmentDescriptor } from '../contracts/attachments.ts';
import { TERMINAL_LIMITS as L } from '../contracts/terminals.ts';
import { parseKeyboard, parseKeyboardBatch, parseNativeInput, parseTerminalOpen, terminalFields, terminalNumber, terminalSize, terminalText } from '../core/terminal-validation.ts';
import { AppError, messageOf } from '../core/errors.ts';
import type { Config } from './config.ts';
import { InputAuthority } from './input-authority.ts';
import { scopesFor } from '../core/input-scope.ts';
import type { WorktreeIdentity } from '../contracts/workflow.ts';
import { assertObserverSize, attachTmux, type Attachment, type AttachTarget } from './tmux-attach.ts';
import type { TerminalGateway } from './terminal-gateway.ts';

interface Connection {
  id: string; input: TerminalOpen; target: AttachTarget; ticket: string | null; expires: number;
  generation: string; ws?: WebSocket; attachment?: Attachment; native: boolean; writer: boolean; closed: boolean;
  /** This connection's last few replaced generations: acknowledgments and heartbeats already in flight for them are ignored. */
  retired: string[];
  manualId: string | null; lastRenew: number; lastAck: number; lastHb: number; checking: boolean;
  /** A writer on an exempt target: granted outside the manual-input barrier, so it has no manual record. */
  free: boolean;
  sequence: number; acknowledged: number; sentBytes: number; acknowledgedBytes: number;
  credit: Map<number, number>; queued: Buffer[]; queuedBytes: number; paused: boolean;
  inputSeq: number; receipts: Map<number, string>; tail: Promise<unknown>; pendingBytes: number;
  rateStart: number; rateBytes: number;
  resizing: boolean; lastResize: number;
}
export interface TerminalServices {
  config: Config; authority: InputAuthority;
  attach?: typeof attachTmux; // Injectable native boundary for fault/flow-control fixtures.
  resolve(target: TerminalTarget): Promise<AttachTarget>;
  begin(input: TerminalOpen, connectionId: string, generation: string, prior?: ManualSession, scope?: WorktreeIdentity | null): Promise<ManualSession>;
  scope?(target: TerminalTarget): Promise<WorktreeIdentity | null>;
  /** An app-role terminal (Global AI) that no project or run uses. Its input stays outside the server-wide manual-input barrier. */
  exempt?(target: TerminalTarget): boolean;
  reconcile(input: ManualReconcile, handoffRequestId?: string): Promise<ManualSession>;
  /** Re-resolves the registered CLI and its directory, then returns the verified reference for one attachment in its workspace. */
  image(target: TerminalTarget, attach: AttachTarget, attachmentId: string): Promise<{ descriptor: AttachmentDescriptor; bytes: Buffer }>;
  /** Records possible use of the image durably, before the write. */
  pinImage(descriptor: AttachmentDescriptor, refId: string): void;
}
/** Ephemeral PTYs/credit/input queues; only authority metadata is durable. */
export class TerminalBroker implements TerminalGateway {
  readonly services: TerminalServices;
  private readonly connections = new Map<string, Connection>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  private decisionTail: Promise<unknown> = Promise.resolve();
  constructor(services: TerminalServices) {
    this.services = services;
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
  }
  private get authority() { return this.services.authority; }
  private enabled(input = false) {
    if (this.closing || !this.services.config.terminalEnabled) throw new AppError('TERMINAL_DISABLED', 'Native terminals are disabled on this host.', 403);
    if (input && !this.services.config.inputEnabled) throw new AppError('READ_ONLY', 'Input is disabled on this host.', 403);
  }
  authorize(origin: string | undefined, host: string | undefined): boolean {
    return !this.closing && this.services.config.terminalEnabled === true && !!origin && origin !== 'null' &&
      this.services.config.allowedOrigins.includes(origin) && this.services.config.allowedOrigins.some(o => new URL(o).host === host);
  }
  async open(value: unknown): Promise<TerminalConnection> {
    this.enabled(); const input = parseTerminalOpen(value);
    const target = await this.services.resolve(input.target); this.enabled();
    if (this.connections.size >= L.hostConnections || [...this.connections.values()].filter(c => c.target.sessionId === target.sessionId).length >= L.sessionConnections) throw new AppError('TERMINAL_LIMIT', 'The host has reached its terminal connection limit. Close an existing terminal first.', 409);
    const id = randomUUID(), ticket = randomBytes(32).toString('hex'), now = Date.now();
    const c: Connection = { id, input, target, ticket, expires: now + L.ticketMs, generation: randomUUID(), retired: [], native: false, writer: false, closed: false,
      manualId: null, free: false, lastRenew: now, lastAck: now, lastHb: now, checking: false, sequence: 0, acknowledged: 0, sentBytes: 0, acknowledgedBytes: 0,
      credit: new Map(), queued: [], queuedBytes: 0, paused: false, inputSeq: 0, receipts: new Map(), tail: Promise.resolve(), pendingBytes: 0, rateStart: now, rateBytes: 0, resizing: false, lastResize: 0 };
    this.connections.set(id, c);
    return { connectionId: id, ticket, bootId: this.authority.bootId, label: target.label, paneId: target.identity.paneId, sessionId: target.sessionId };
  }
  connect(ws: WebSocket): void {
    let connection: Connection | undefined;
    const deadline = setTimeout(() => ws.terminate(), L.handshakeMs);
    ws.once('close', () => { clearTimeout(deadline); if (connection) void this.close(connection.id, 'Connection closed; reconcile any manual input.'); });
    ws.on('error', () => ws.terminate());
    ws.once('message', (bytes, binary) => {
      void (async () => {
        if (binary || rawBuffer(bytes).length > 1024) throw new Error('Invalid handshake');
        const body = terminalFields(JSON.parse(rawBuffer(bytes).toString()), ['ticket']);
        if (typeof body.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(body.ticket)) throw new Error('Invalid ticket');
        connection = [...this.connections.values()].find(c => c.ticket === body.ticket && !c.ws && !c.closed && c.expires > Date.now());
        if (!connection) throw new Error('Expired ticket');
        const c = connection; c.ticket = null; c.ws = ws; c.lastRenew = Date.now(); clearTimeout(deadline);
        ws.on('message', (frame, isBinary) => {
          try {
            if (isBinary || rawBuffer(frame).length > 16384) throw new Error('Invalid frame');
            const v = JSON.parse(rawBuffer(frame).toString());
            // A keyboard grant or release replaces the generation while the browser may still be acknowledging the old one.
            if ((v.type === 'processed' || v.type === 'heartbeat') && c.retired.includes(v.generation)) return;
            if (v.type === 'processed') this.processed(c.id, { generation: v.generation, sequence: v.sequence, processedBytes: v.processedBytes });
            else if (v.type === 'heartbeat') this.heartbeat(c.id, { generation: v.generation });
            else throw new Error('Unsupported frame');
          } catch { void this.close(c.id, 'Invalid terminal control frame.'); }
        });
        await this.startAttachment(c, false);
      })().catch(() => { ws.close(1008, 'Terminal authorization or target verification failed.'); });
    });
  }
  private current(id: string, generation?: string): Connection {
    const c = this.connections.get(id);
    if (!c || c.closed || !c.ws || c.ws.readyState !== 1 || (generation !== undefined && c.generation !== generation)) throw new AppError('TERMINAL_CHANGED', 'The terminal connection changed. Reconnect as an observer.', 409);
    return c;
  }
  private emit(c: Connection, frame: TerminalFrame) {
    if (!c.closed && c.ws?.readyState === 1) c.ws.send(JSON.stringify(frame));
  }
  private async startAttachment(c: Connection, writer: boolean, paneInput = false): Promise<void> {
    // Retire callbacks before detaching: the old PTY exits during this awaited close.
    const old = c.attachment; c.attachment = undefined; c.retired = [...c.retired, c.generation].slice(-4); c.generation = randomUUID(); await old?.close();
    if (c.closed || c.ws?.readyState !== 1) throw new AppError('TERMINAL_CHANGED', 'Terminal closed before attachment.', 409);
    const target = await this.services.resolve(c.input.target);
    if (JSON.stringify(target.identity) !== JSON.stringify(c.target.identity) || target.sessionId !== c.target.sessionId) throw new AppError('TARGET_CHANGED', 'The terminal target changed.', 409);
    c.sequence = c.acknowledged = c.sentBytes = c.acknowledgedBytes = 0;
    c.credit.clear(); c.queued = []; c.queuedBytes = 0; c.paused = false; c.inputSeq = 0; c.receipts.clear(); c.lastAck = Date.now();
    let native = true, reason = '';
    if (!writer && this.services.config.mode !== 'mock') {
      try { await assertObserverSize(this.services.config, target.sessionId); }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'CAPTURE_FALLBACK') throw error; native = false; reason = error.message; }
    }
    c.native = native;
    this.emit(c, { type: 'reset', generation: c.generation, bootId: this.authority.bootId, ...terminalSize(c.input), native, reason });
    if (!native) return;
    if (this.services.config.mode === 'mock' && !this.services.attach) {
      c.attachment = { pid: 0, write: bytes => this.output(c, bytes), resize: () => {}, pause: () => {}, resume: () => {}, close: async () => {},
        active: async () => ({ paneId: target.identity.paneId, command: 'mock', sessionId: target.sessionId, label: target.label, size: `${c.input.cols}x${c.input.rows}` }) };
      this.output(c, Buffer.from('Simulated native terminal — no host process\r\n')); return;
    }
    const generation = c.generation;
    const attachment = await (this.services.attach ?? attachTmux)(this.services.config, target, writer, c.input.cols, c.input.rows,
      bytes => { if (c.generation === generation) this.output(c, bytes); },
      () => { if (c.generation === generation && !c.closed) void this.close(c.id, 'Attached client exited; inspect manual input.'); }, paneInput);
    if (c.closed || c.generation !== generation) { await attachment.close(); return; }
    c.attachment = attachment;
    if (writer && attachment.ready) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([attachment.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AppError('TERMINAL_NOT_READY', 'The native screen did not become ready. Inspect manual input before reconnecting.', 409)), 5000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  private output(c: Connection, bytes: Buffer) {
    if (c.closed) return;
    const outstanding = c.sentBytes - c.acknowledgedBytes + c.queuedBytes;
    if (!outstanding) c.lastAck = Date.now();
    if (c.credit.size + c.queued.length > 16384 || bytes.length > 65536 || outstanding + bytes.length > L.outputHigh + 65536) { void this.close(c.id, 'Terminal output limit reached. Reconnect for a fresh screen.'); return; }
    for (let offset = 0; offset < bytes.length; offset += L.outputFrame) { const part = Buffer.from(bytes.subarray(offset, offset + L.outputFrame)); c.queued.push(part); c.queuedBytes += part.length; }
    if (outstanding + bytes.length >= L.outputHigh - 65536 && !c.paused) { c.paused = true; c.attachment?.pause(); }
    this.flush(c);
  }
  private flush(c: Connection) {
    while (!c.closed && c.queued.length && c.ws?.readyState === 1 && c.ws.bufferedAmount < 128 * 1024 && c.sentBytes - c.acknowledgedBytes + c.queued[0]!.length <= L.outputHigh) {
      const bytes = c.queued.shift()!; c.queuedBytes -= bytes.length; c.sentBytes += bytes.length; c.credit.set(++c.sequence, c.sentBytes);
      this.emit(c, { type: 'out', generation: c.generation, sequence: c.sequence, bytes: bytes.length, data: bytes.toString('base64') });
    }
  }
  processed(id: string, value: unknown): void {
    const b = terminalFields(value, ['generation', 'sequence', 'processedBytes']);
    const c = this.current(id, terminalText(b.generation));
    const seq = terminalNumber(b.sequence, 0, Number.MAX_SAFE_INTEGER), bytes = terminalNumber(b.processedBytes, 0, Number.MAX_SAFE_INTEGER);
    if (seq === c.acknowledged && bytes === c.acknowledgedBytes) return;
    if (seq <= c.acknowledged || c.credit.get(seq) !== bytes) throw new AppError('TERMINAL_CREDIT', 'Invalid processed-output acknowledgment.', 409);
    c.acknowledged = seq; c.acknowledgedBytes = bytes; c.lastAck = Date.now();
    for (const key of c.credit.keys()) if (key <= seq) c.credit.delete(key);
    if (c.paused && c.sentBytes - bytes + c.queuedBytes < L.outputLow) { c.paused = false; c.attachment?.resume(); }
    this.flush(c);
  }
  heartbeat(id: string, value: unknown): void {
    const b = terminalFields(value, ['generation']); this.current(id, terminalText(b.generation)).lastRenew = Date.now();
  }
  async input(id: string, value: unknown): Promise<{ generation: string; seq: number }> {
    this.enabled(true); const input = parseNativeInput(value), c = this.current(id, input.generation);
    if ('image' in input) return this.image(c, input);
    const bytes = Buffer.from(input.data, input.encoding === 'binary' ? 'base64' : 'utf8');
    if (bytes.length > L.inputFrame || !bytes.length || (input.encoding === 'binary' ? bytes.toString('base64') !== input.data : bytes.toString('utf8') !== input.data)) throw new AppError('TERMINAL_INPUT', 'Invalid or oversized terminal byte frame.');
    if (!c.writer || !(c.manualId || c.free) || c.pendingBytes + bytes.length > 32 * 1024) throw new AppError('KEYBOARD_REQUIRED', 'This connection has no available keyboard grant.', 409);
    if (Date.now() - c.rateStart >= 1000) { c.rateStart = Date.now(); c.rateBytes = 0; }
    if (c.rateBytes + bytes.length > L.inputQueue) throw new AppError('INPUT_RATE', 'Terminal input rate exceeded. Inspect the input before continuing.', 429);
    c.rateBytes += bytes.length; c.pendingBytes += bytes.length;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const work = c.tail.catch(() => {}).then(async () => {
      this.current(id, input.generation);
      if (!c.writer || !(c.manualId || c.free)) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended.', 409);
      if (input.seq <= c.inputSeq) {
        if (c.receipts.get(input.seq) !== digest) throw new AppError('INPUT_SEQUENCE', 'Conflicting or expired input receipt.', 409);
        return { generation: c.generation, seq: input.seq };
      }
      if (input.seq !== c.inputSeq + 1) throw new AppError('INPUT_SEQUENCE', 'Input sequence gap. Nothing was replayed.', 409);
      await c.attachment?.active();
      if (!c.writer || c.closed || !c.attachment) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended before writing.', 409);
      if (c.manualId) this.authority.markInput(c.manualId, c.id, c.generation, bytes.length);
      try { await c.attachment.write(bytes); }
      catch { void this.close(c.id, 'Input may have occurred. Inspect it; never resend.'); throw new AppError('INPUT_UNCERTAIN', 'Input may have occurred. Inspect it; never resend.', 409); }
      c.inputSeq = input.seq; c.receipts.set(input.seq, digest);
      while (c.receipts.size > 64) c.receipts.delete(c.receipts.keys().next().value!);
      return { generation: c.generation, seq: input.seq };
    });
    c.tail = work;
    try { return await work; } finally { c.pendingBytes -= bytes.length; }
  }
  /** One explicit image insertion, ordered with this connection's typed input. The reference is derived server-side and written once,
   * never followed by Enter. The strongest available checks run immediately before the write: the writer's actual pane and session,
   * the registered CLI and its directory, and the attachment's bytes. tmux's own inspection/write race and interleaving with other
   * writers remain; an exception after the write is uncertain and never retried. */
  private async image(c: Connection, input: NativeImageInput): Promise<{ generation: string; seq: number }> {
    const { attachmentId, bootId, paneId, sessionId } = input.image;
    if (bootId !== this.authority.bootId || paneId !== c.target.identity.paneId || sessionId !== c.target.sessionId) throw new AppError('TARGET_CHANGED', 'This terminal is not the one the image was chosen for. Nothing was inserted.', 409);
    if (!c.writer || !c.manualId || c.pendingBytes + L.inputFrame > 32 * 1024) throw new AppError('KEYBOARD_REQUIRED', 'This connection has no available keyboard grant.', 409);
    const digest = createHash('sha256').update(`image:${attachmentId}`).digest('hex');
    c.pendingBytes += L.inputFrame;
    const work = c.tail.catch(() => {}).then(async () => {
      this.current(c.id, input.generation);
      if (!c.writer || !c.manualId) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended. Nothing was inserted.', 409);
      if (input.seq <= c.inputSeq) {
        if (c.receipts.get(input.seq) !== digest) throw new AppError('INPUT_SEQUENCE', 'Conflicting or expired input receipt.', 409);
        return { generation: c.generation, seq: input.seq };
      }
      if (input.seq !== c.inputSeq + 1) throw new AppError('INPUT_SEQUENCE', 'Input sequence gap. Nothing was replayed.', 409);
      // A writer may have navigated tmux: the actual destination must still be the original pane in the original session.
      const active = await c.attachment?.active();
      if (!active || active.paneId !== c.target.identity.paneId || active.sessionId !== c.target.sessionId) throw new AppError('TARGET_CHANGED', 'This terminal now shows another pane or session. Return to the original pane; nothing was inserted.', 409);
      const prepared = await this.services.image(c.input.target, c.target, attachmentId);
      if (prepared.bytes.length > L.inputFrame) throw new AppError('IMAGE_REFERENCE', 'This image reference is too long for one input frame. Nothing was inserted.', 409);
      // The writer can navigate while the image is prepared: fresh destination evidence is the last await, and authority, pin and write
      // follow it without awaiting.
      const destination = await c.attachment?.active();
      if (!destination || destination.paneId !== c.target.identity.paneId || destination.sessionId !== c.target.sessionId) throw new AppError('TARGET_CHANGED', 'This terminal now shows another pane or session. Return to the original pane; nothing was inserted.', 409);
      this.current(c.id, input.generation);
      if (!c.writer || c.closed || !c.attachment || !c.manualId) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended before writing. Nothing was inserted.', 409);
      if (Date.now() - c.rateStart >= 1000) { c.rateStart = Date.now(); c.rateBytes = 0; }
      if (c.rateBytes + prepared.bytes.length > L.inputQueue) throw new AppError('INPUT_RATE', 'Terminal input rate exceeded. Nothing was inserted.', 429);
      c.rateBytes += prepared.bytes.length;
      this.services.pinImage(prepared.descriptor, `${c.id}:${input.generation}:${input.seq}`);
      this.authority.markInput(c.manualId, c.id, c.generation, prepared.bytes.length);
      try { await (c.attachment.paste ? c.attachment.paste(prepared.bytes) : c.attachment.write(prepared.bytes)); }
      catch { void this.close(c.id, 'An image reference may have been inserted. Inspect it; never resend.'); throw new AppError('INPUT_UNCERTAIN', 'An image reference may have been inserted. Inspect it; never resend.', 409); }
      c.inputSeq = input.seq; c.receipts.set(input.seq, digest);
      while (c.receipts.size > 64) c.receipts.delete(c.receipts.keys().next().value!);
      return { generation: c.generation, seq: input.seq };
    });
    c.tail = work;
    try { return await work; } finally { c.pendingBytes -= L.inputFrame; }
  }
  async resize(id: string, value: unknown): Promise<void> {
    const b = terminalFields(value, ['generation', 'cols', 'rows']), c = this.current(id, terminalText(b.generation));
    const size = terminalSize(b), generation = c.generation;
    if(c.resizing||Date.now()-c.lastResize<100)throw new AppError('TERMINAL_RESIZE_BUSY','Terminal resizing is limited to one request per 100 ms, with one in flight.',429);
    c.resizing=true;c.lastResize=Date.now();
    try {
      await c.attachment?.active(); this.current(id, generation);
      c.input.cols = size.cols; c.input.rows = size.rows; c.attachment?.resize(size.cols, size.rows);
    } finally {c.resizing=false;}
  }
  private async endWriter(c: Connection, reason: string, observe: boolean, uncertain = false): Promise<void> {
    const end = async () => {
      c.writer = false; c.free = false;
      const wasLive = c.manualId && this.authority.get(c.manualId).writers.some(w => w.connectionId === c.id && w.live);
      if (wasLive) this.authority.release(c.manualId!, c.id, reason, uncertain);
      try {
        await c.tail.catch(() => {});
        if (observe && !c.closed) await this.startAttachment(c, false);
      } catch (error) {
        if (wasLive) this.authority.release(c.manualId!, c.id, `Typing stopped but attachment replacement failed. ${messageOf(error)}`, true);
        throw error;
      }
    };
    // Finishing Helper input is local to its pane and must not delay another terminal's keyboard grant or reconciliation.
    if (c.free) await end(); else await this.authority.draining(end, scopesFor(c.manualId ? this.authority.get(c.manualId).scope : null));
  }
  async keyboard(id: string, value: unknown): Promise<KeyboardResult> {
    const work = this.decisionTail.catch(() => {}).then(() => this.keyboardDecision(id, value));
    this.decisionTail = work; return work;
  }
  private async keyboardDecision(id: string, value: unknown): Promise<KeyboardResult> {
    const input = parseKeyboard(value), request = { connectionId: id, ...input };
    if (input.expectedBootId !== this.authority.bootId) throw new AppError('TERMINAL_CHANGED', 'The host restarted. Reconnect as an observer.', 409);
    const prior = this.authority.duplicate<KeyboardResult>(input.requestId, request); if (prior) return prior;
    const c = this.current(id, input.expectedGeneration);
    if (input.action === 'acquire' && this.services.exempt?.(c.input.target)) {
      // No manual record, run checkpoint or server-wide hold: deliveries, setup and launches never use this pane.
      this.enabled(true);
      if (c.writer) throw new AppError('KEYBOARD_HELD', 'This connection is already writable.', 409);
      try {
        await this.startAttachment(c, true, true); this.enabled(true); this.current(id);
        c.writer = c.free = true; c.lastRenew = Date.now();
        const result = { generation: c.generation, manualSession: null, writer: true, reason: 'Typing goes to this terminal. It does not hold automation.' };
        this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: null, writer: true, reason: result.reason });
        this.authority.decide(input.requestId, request, result); return result;
      } catch (error) { await this.close(c.id, 'Input setup did not settle; reconnect to type.'); throw error; }
    }
    if (input.action === 'acquire') {
      this.enabled(true);
      const targetScope = await this.services.scope?.(c.input.target) ?? null;
      const global = this.authority.pending().find(s => !s.scope);
      const scope = global ? null : targetScope;
      return this.authority.acquire(async () => {
        // New input joins the newest unsettled period, even one that needs recovery or began before a restart:
        // typing never waits for reconciliation. Its evidence and recovery flag stay, so automation remains held.
        const owner = global ?? this.authority.pending().find(s => (s.scope?.indexPath ?? null) === (scope?.indexPath ?? null));
        if (c.writer) throw new AppError('KEYBOARD_HELD', 'This connection is already writable.', 409);
        this.current(id); const generation = randomUUID();
        const record = await this.services.begin(c.input, c.id, generation, owner && this.authority.get(owner.id), scope);
        c.manualId = record.id;
        try {
          this.enabled(true); this.current(id); await this.startAttachment(c, true, true); this.enabled(true); this.current(id);
          c.writer = true; c.lastRenew = Date.now();
          const saved = this.authority.updateWriter(record.id, c.id, { generation: c.generation });
          const result = { generation: c.generation, manualSession: saved, writer: true, reason: saved.reason };
          this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: record.id, writer: true, reason: result.reason });
          this.authority.decide(input.requestId, request, result); return result;
        } catch (error) { this.authority.release(record.id, c.id, 'Keyboard setup did not settle; inspect before automating.', true); await this.close(c.id, 'Input setup did not settle; inspect before reconnecting.'); throw error; }
      }, scopesFor(scope));
    }
    if (input.expectedRevision !== undefined) {
      const manual = c.manualId ? this.authority.get(c.manualId) : null;
      const writer = manual?.writers.find(w => w.connectionId === c.id);
      if (!c.writer || !writer?.live || writer.generation !== c.generation || manual?.revision !== input.expectedRevision)
        throw new AppError('MANUAL_CHANGED', 'Manual input changed. Inspect the terminal and confirm readiness again.', 409);
    }
    await this.endWriter(c, 'Keyboard released; manual input requires reconciliation.', true);
    let manual = c.manualId ? this.authority.get(c.manualId) : null;
    let reason = manual?.reason ?? 'Observing.';
    if (input.action === 'releaseSettled' && manual) {
      try { manual = await this.services.reconcile({ requestId: randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision, confirmReady: true }, input.handoffRequestId); reason = manual.reason; }
      catch (error) { reason = `Released; barrier retained. ${messageOf(error)}`; }
    }
    const result = { generation: c.generation, manualSession: manual, writer: false, reason };
    this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: manual?.id ?? null, writer: false, reason });
    this.authority.decide(input.requestId, request, result); return result;
  }
  async stop(value: unknown): Promise<ManualSession> {
    const work = this.decisionTail.catch(() => {}).then(async () => {
      const input = parseKeyboardBatch(value);
      if (input.expectedBootId !== this.authority.bootId) throw new AppError('TERMINAL_CHANGED', 'The host restarted. Inspect manual input.', 409);
      const prior = this.authority.duplicate<ManualSession>(input.requestId, input); if (prior) return prior;
      let manual = this.authority.get(input.manualSessionId);
      // A plain stop only removes authority and retains all input evidence. Bytes from
      // this or another writer may advance the period since the last UI poll. Settlement
      // additionally requires the exact inspected revision, since it can release the hold.
      if (manual.revision < input.expectedRevision || input.confirmReady && manual.revision !== input.expectedRevision)
        throw new AppError('MANUAL_CHANGED', 'The writer set or input changed. Inspect and choose again.', 409);
      const selected = input.writers.map(w => {
        const c = this.current(w.connectionId, w.generation), saved = manual.writers.find(x => x.connectionId === c.id);
        if (!c.writer || c.manualId !== manual.id || !saved?.live || saved.revision < w.revision || input.confirmReady && saved.revision !== w.revision || saved.generation !== w.generation)
          throw new AppError('MANUAL_CHANGED', 'A selected writer changed. Nothing was stopped.', 409);
        if (input.confirmReady && c.pendingBytes) throw new AppError('INPUT_BUSY', 'Terminal input is still pending. Nothing was stopped.', 409);
        return c;
      });
      if (input.handoffRequestId && (manual.runs.length || manual.recoveryRequired || manual.writers.some(w => w.live && !selected.some(c => c.id === w.connectionId))))
        throw new AppError('MANUAL_CHANGED', 'Stop other writers and review affected checkpoints in Control access first.', 409);
      // Freeze the complete set before the first await; subsequent input frames cannot slip between releases.
      for (const c of selected) c.writer = false;
      await Promise.all(selected.map(c => this.endWriter(c, 'Typing stopped; manual input still requires reconciliation.', true)));
      manual = this.authority.get(manual.id);
      if (input.confirmReady) {
        try { manual = await this.services.reconcile({ requestId: randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision, confirmReady: true }, input.handoffRequestId); }
        catch (error) { manual = this.authority.save({ ...this.authority.get(manual.id), reason: `Typing stopped; barrier retained. ${messageOf(error)}` }); }
      }
      for (const c of selected) this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: manual.id, writer: false, reason: manual.reason });
      this.authority.decide(input.requestId, input, manual); return manual;
    });
    this.decisionTail = work; return work;
  }
  async close(id: string, reason = 'Terminal closed; reconcile manual input.'): Promise<void> {
    const c = this.connections.get(id); if (!c || c.closed) return;
    this.emit(c, { type: 'closed', reason }); c.closed = true; c.ticket = null;
    await this.endWriter(c, reason, false, true);
    const child = c.attachment; c.attachment = undefined; await child?.close();
    c.ws?.close(); c.queued = []; c.receipts.clear(); this.connections.delete(id);
  }
  /** Closes observer connections on these panes before Finish branch closes their sessions. A live keyboard already refuses it. */
  async closePanes(paneIds: Set<string>, reason: string): Promise<void> {
    await Promise.all([...this.connections.values()].filter(c => paneIds.has(c.target.identity.paneId)).map(c => this.close(c.id, reason)));
  }
  async revoke(clientInstanceId: string): Promise<void> { await Promise.all([...this.connections.values()].filter(c => c.input.clientInstanceId === clientInstanceId).map(c => this.close(c.id, 'Browser locked; reconcile manual input.'))); }
  private tick() {
    const now = Date.now();
    for (const c of this.connections.values()) {
      if ((!c.ws && now > c.expires) || now - c.lastRenew > L.leaseMs || (c.sentBytes > c.acknowledgedBytes && now - c.lastAck > L.stallMs)) { void this.close(c.id, 'Terminal expired or stopped processing output; reconcile input.'); continue; }
      this.flush(c);
      if (now - c.lastHb >= 15_000) { this.emit(c, { type: 'hb' }); c.lastHb = now; }
      if (c.attachment && !c.checking) {
        c.checking = true; const generation=c.generation, attachment=c.attachment;
        void attachment.active().then(active => { if(c.generation===generation && c.attachment===attachment) this.emit(c, { type: 'active', ...active }); })
          .catch(() => { if(c.generation===generation && c.attachment===attachment) return this.close(c.id, 'Terminal identity, lifetime or sizing policy changed.'); }).finally(() => { c.checking = false; });
      }
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    await Promise.all([...this.connections.keys()].map(id => this.close(id, 'Host shutdown; inspect and reconcile manual input.')));
    await this.decisionTail.catch(() => {});
  }
}
