import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
const rawBuffer = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
import type { KeyboardResult, ManualReconcile, ManualSession, TerminalConnection, TerminalFrame, TerminalOpen, TerminalTarget } from '../contracts/terminals.ts';
import { TERMINAL_LIMITS as L } from '../contracts/terminals.ts';
import { parseKeyboard, parseNativeInput, parseTerminalOpen, terminalFields, terminalNumber, terminalSize, terminalText } from '../core/terminal-validation.ts';
import { AppError, messageOf } from '../core/errors.ts';
import type { Config } from './config.ts';
import { InputAuthority } from './input-authority.ts';
import { assertObserverSize, attachTmux, type Attachment, type AttachTarget } from './tmux-attach.ts';
import type { TerminalGateway } from './terminal-gateway.ts';

interface Connection {
  id: string; input: TerminalOpen; target: AttachTarget; ticket: string | null; expires: number;
  generation: string; ws?: WebSocket; attachment?: Attachment; native: boolean; writer: boolean; closed: boolean;
  manualId: string | null; lastRenew: number; lastAck: number; lastHb: number; checking: boolean;
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
  begin(input: TerminalOpen, connectionId: string, generation: string, prior?: ManualSession): Promise<ManualSession>;
  reconcile(input: ManualReconcile): Promise<ManualSession>;
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
    const c: Connection = { id, input, target, ticket, expires: now + L.ticketMs, generation: randomUUID(), native: false, writer: false, closed: false,
      manualId: null, lastRenew: now, lastAck: now, lastHb: now, checking: false, sequence: 0, acknowledged: 0, sentBytes: 0, acknowledgedBytes: 0,
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
  private async startAttachment(c: Connection, writer: boolean): Promise<void> {
    // Retire callbacks before detaching: the old PTY exits during this awaited close.
    const old = c.attachment; c.attachment = undefined; c.generation = randomUUID(); await old?.close();
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
      () => { if (c.generation === generation && !c.closed) void this.close(c.id, 'Attached client exited; inspect manual input.'); });
    if (c.closed || c.generation !== generation) { await attachment.close(); return; }
    c.attachment = attachment;
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
    const bytes = Buffer.from(input.data, input.encoding === 'binary' ? 'base64' : 'utf8');
    if (bytes.length > L.inputFrame || !bytes.length || (input.encoding === 'binary' ? bytes.toString('base64') !== input.data : bytes.toString('utf8') !== input.data)) throw new AppError('TERMINAL_INPUT', 'Invalid or oversized terminal byte frame.');
    if (!c.writer || !c.manualId || c.pendingBytes + bytes.length > 32 * 1024) throw new AppError('KEYBOARD_REQUIRED', 'This connection has no available keyboard grant.', 409);
    if (Date.now() - c.rateStart >= 1000) { c.rateStart = Date.now(); c.rateBytes = 0; }
    if (c.rateBytes + bytes.length > L.inputQueue) throw new AppError('INPUT_RATE', 'Terminal input rate exceeded. Inspect the input before continuing.', 429);
    c.rateBytes += bytes.length; c.pendingBytes += bytes.length;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const work = c.tail.catch(() => {}).then(async () => {
      this.current(id, input.generation);
      if (!c.writer || !c.manualId) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended.', 409);
      if (input.seq <= c.inputSeq) {
        if (c.receipts.get(input.seq) !== digest) throw new AppError('INPUT_SEQUENCE', 'Conflicting or expired input receipt.', 409);
        return { generation: c.generation, seq: input.seq };
      }
      if (input.seq !== c.inputSeq + 1) throw new AppError('INPUT_SEQUENCE', 'Input sequence gap. Nothing was replayed.', 409);
      await c.attachment?.active();
      if (!c.writer || c.closed || !c.attachment) throw new AppError('KEYBOARD_REVOKED', 'Keyboard authority ended before writing.', 409);
      this.authority.markInput(c.manualId, bytes.length);
      try { c.attachment.write(bytes); }
      catch { void this.close(c.id, 'Input may have occurred. Inspect it; never resend.'); throw new AppError('INPUT_UNCERTAIN', 'Input may have occurred. Inspect it; never resend.', 409); }
      c.inputSeq = input.seq; c.receipts.set(input.seq, digest);
      while (c.receipts.size > 64) c.receipts.delete(c.receipts.keys().next().value!);
      return { generation: c.generation, seq: input.seq };
    });
    c.tail = work;
    try { return await work; } finally { c.pendingBytes -= bytes.length; }
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
  private async endWriter(c: Connection, reason: string, observe: boolean): Promise<void> {
    c.writer = false;
    if (c.manualId && this.authority.get(c.manualId).live && this.authority.get(c.manualId).connectionId === c.id) this.authority.release(c.manualId, reason);
    await c.tail.catch(() => {});
    if (observe && !c.closed) await this.startAttachment(c, false);
  }
  async keyboard(id: string, value: unknown): Promise<KeyboardResult> {
    const work = this.decisionTail.catch(() => {}).then(() => this.keyboardDecision(id, value));
    this.decisionTail = work; return work;
  }
  private async keyboardDecision(id: string, value: unknown): Promise<KeyboardResult> {
    const input = parseKeyboard(value), request = { connectionId: id, ...input };
    const prior = this.authority.duplicate<KeyboardResult>(input.requestId, request); if (prior) return prior;
    const c = this.current(id, input.expectedGeneration);
    if (input.action === 'acquire') {
      this.enabled(true);
      return this.authority.acquire(async () => {
        const pending = this.authority.pending();
        if (pending.length > 1) throw new AppError('MANUAL_CHANGED', 'Reconcile earlier manual sessions first.', 409);
        if (pending.length && !input.transfer) throw new AppError('KEYBOARD_HELD', 'Keyboard or unresolved manual input already exists. Confirm transfer/recovery.', 409);
        const owner = pending[0];
        if (owner?.live) { const old = this.connections.get(owner.connectionId); if (old) await this.endWriter(old, 'Keyboard transferred; prior input still requires reconciliation.', true); }
        this.current(id); const generation = randomUUID();
        const record = await this.services.begin(c.input, c.id, generation, owner && this.authority.get(owner.id));
        c.manualId = record.id;
        try {
          this.enabled(true); this.current(id); await this.startAttachment(c, true); this.enabled(true); this.current(id);
          c.writer = true; c.lastRenew = Date.now();
          const saved = this.authority.save({ ...this.authority.get(record.id), generation: c.generation });
          const result = { generation: c.generation, manualSession: saved, writer: true, reason: 'Keyboard here; dispatch, setup and launch are held across this server.' };
          this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: record.id, writer: true, reason: result.reason });
          this.authority.decide(input.requestId, request, result); return result;
        } catch (error) { this.authority.release(record.id, 'Keyboard setup did not settle; inspect before automating.'); throw error; }
      });
    }
    await this.endWriter(c, 'Keyboard released; manual input requires reconciliation.', true);
    let manual = c.manualId ? this.authority.get(c.manualId) : null;
    let reason = manual?.reason ?? 'Observing.';
    if (input.action === 'releaseSettled' && manual) {
      try { manual = await this.services.reconcile({ requestId: randomUUID(), manualSessionId: manual.id, expectedRevision: manual.revision, confirmReady: true }); reason = manual.reason; }
      catch (error) { reason = `Released; barrier retained. ${messageOf(error)}`; }
    }
    const result = { generation: c.generation, manualSession: manual, writer: false, reason };
    this.emit(c, { type: 'keyboard', generation: c.generation, manualSessionId: manual?.id ?? null, writer: false, reason });
    this.authority.decide(input.requestId, request, result); return result;
  }
  async close(id: string, reason = 'Terminal closed; reconcile manual input.'): Promise<void> {
    const c = this.connections.get(id); if (!c || c.closed) return;
    this.emit(c, { type: 'closed', reason }); c.closed = true; c.ticket = null;
    await this.endWriter(c, reason, false);
    const child = c.attachment; c.attachment = undefined; await child?.close();
    c.ws?.close(); c.queued = []; c.receipts.clear(); this.connections.delete(id);
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
