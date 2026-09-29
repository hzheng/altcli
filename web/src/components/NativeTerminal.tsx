'use client';
import { useEffect, useLayoutEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TerminalConnection, TerminalFrame, TerminalTarget, KeyboardResult, ManualWriter } from '../contracts/terminals';
import { api } from '../client/api';
import { terminalEntry, type TerminalIntent } from '../client/terminal-entry';
import { HelpTip, IconButton, StatusIcon } from './Hint';

/** A writer stopped locally before explicit stop or checked handoff; it may be restored only if nothing changed since. */
export interface FrozenWriter { readonly connection: object; readonly generation: string; readonly frames: number }
export interface NativeTerminalHandle {
  matches: (writer: ManualWriter) => boolean;
  abandon: (reason: string) => void;
  stopped: (frozen: FrozenWriter) => void;
  /** Freezes input for stop/handoff. Checked handoff refuses pending bytes; plain stop can discard unsent bytes. */
  freeze: (allowPending?: boolean) => FrozenWriter | null;
  /** Restores a frozen writer after a definite refusal, only when its connection, generation and keyboard frames are unchanged. */
  thaw: (frozen: FrozenWriter) => boolean;
}
const BADGES = {
  'Typing enabled': ['⌨️', 'This terminal can type independently of other terminals. Manual input holds automation across this tmux server until it is stopped and reconciled.'],
  Disconnected: ['🔌', 'Not connected to this pane. Open the terminal to watch it; that does not take the keyboard.'],
  'Manual CLI/shell': ['⚠️', 'The registered CLI process in this pane was replaced, for example it exited to a shell. Inspect the pane before sending.'],
  'Observing · manual input unresolved': ['⚠️', 'Watching read-only. Earlier manual input is not reconciled; review it in Control access before automated work continues.'],
  'Observing · manual input held': ['⚠️', 'Watching read-only. A keyboard or manual-input hold is active on this server, so automated work waits for it.'],
  Observing: ['👁️', 'Watching this pane. Type in Terminal input to begin writing; focus and output alone never enable input.'],
} as const;
const TOOL_HELP = [
  ['▶️', 'Open terminal / 🔄 Reconnect', 'watch this pane live; this does not take the keyboard'],
  ['📄', 'Captured text / 🖥️ Show terminal', 'a readable, selectable snapshot with its timestamp, not the live terminal'],
  ['⤢', 'Expand / ⤡ Collapse terminal', 'enlarge within the page without reconnecting or changing keyboard ownership'],
  ['♿', 'Screen reader mode', 'expose output to assistive technology; turn it off if a software keyboard cannot type'],
  ['📋', 'Paste text', 'paste clipboard text into this terminal; first paste enables input'],
  ['⌨️', 'Terminal input', 'type directly; stop typing and reconcile manual input in Control access. Ctrl+Shift+Esc leaves terminal focus'],
] as const;
/** Native bytes stay local. Only a human input intent begins admission; output and focus never do. */
export function NativeTerminal({ ref, token, target, clientInstanceId, label, fallback, capturedAt, held, holder, cliChanged = false, refresh, viewEpoch = 0, inputEnabled = true }: {
  ref?: Ref<NativeTerminalHandle>;
  token: string; target: TerminalTarget; clientInstanceId: string; label: string; fallback: ReactNode;
  capturedAt?: string; held: boolean; refresh: () => Promise<void>; viewEpoch?: string | number;
  /** Describes a shared manual-input hold independently of this terminal's writer. */
  holder?: 'other-browser' | 'this-browser' | 'unresolved' | null;
  /** The registered CLI process in this pane was replaced, e.g. it exited to a shell. */
  cliChanged?: boolean;
  /** Host input policy; observation remains available when input is disabled. */
  inputEnabled?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), root = useRef<HTMLElement>(null);
  const entryElement = useRef<HTMLTextAreaElement>(null), entry = useRef<ReturnType<typeof terminalEntry> | null>(null);
  // One input event may span several 4 KiB chunks; `start` marks each event's first chunk.
  const live = useRef<{ id: string; bootId: string; generation: string; writer: boolean; ready: boolean; seq: number; queue: { bytes: Uint8Array; start: boolean }[]; bytes: number; sending: boolean; draining: Promise<void> | null; ws: WebSocket } | null>(null);
  const [connected, setConnected] = useState(false), [native, setNative] = useState(false), [writer, setWriter] = useState(false);
  const [capture, setCapture] = useState(false), [notice, setNotice] = useState('Open a terminal to observe this pane.'), [active, setActive] = useState('');
  const [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(1);
  // Synchronous mirrors for the handle: a second decision must not start before React re-renders.
  const busyRef = useRef(false), connectedRef = useRef(false), frames = useRef(0);
  // A keyboard decision replaces the connection's generation; the next decision or input must carry the new one.
  const generationSeen = useRef<{ generation: string; writer: boolean; resolve: () => void } | null>(null);
  const [focused, setFocused] = useState(false), leaving = useRef(false);
  const [screenReader, setScreenReader] = useState(false);
  const screenReaderRef = useRef(screenReader); screenReaderRef.current = screenReader;
  const [expanded, setExpanded] = useState(false);
  const [pasting, setPasting] = useState(false);
  const transientRevision = useRef(0);
  const intents = useRef<{ connection: NonNullable<typeof live.current>; revision: number; values: TerminalIntent[]; bytes: number } | null>(null);
  const enabled = useRef(inputEnabled); enabled.current = inputEnabled;
  const refit = useRef<(() => void) | null>(null);
  const modifiers = useRef({ctrl:false,alt:false}); const [modifierState,setModifierState] = useState(modifiers.current);
  function clearModifiers() { modifiers.current = {ctrl:false,alt:false}; setModifierState(modifiers.current); }
  // Drops only events not yet started. Finishing a partly sent event keeps a large bracketed paste from being truncated.
  function clearTransient() {
    clearModifiers(); transientRevision.current++;
    entry.current?.cancel(); intents.current = null;
    const c=live.current; if(!c)return;
    const next=c.queue.findIndex(item=>item.start); if(next<0)return;
    c.queue=c.queue.slice(0,next); c.bytes=c.queue.reduce((n,item)=>n+item.bytes.length,0);
  }
  useLayoutEffect(() => { clearTransient(); }, [viewEpoch]);
  useEffect(() => { if(!expanded)clearTransient();else clearModifiers(); refit.current?.(); }, [expanded]);
  const targetKey = JSON.stringify(target);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  /** Ctrl+Shift+Escape leaves terminal focus without sending anything: to the visible Terminal/Control switch, else the Control access
   * entry. It never releases keyboard authority or dispatches. */
  function focusControl() {
    clearModifiers();
    const visible = (el: HTMLElement | null | undefined) => el && el.getClientRects().length ? el : null;
    const destination = visible(document.querySelector<HTMLElement>('.surface-switch button[aria-pressed=true]'))
      ?? visible(document.querySelector<HTMLElement>('.access-entry'))
      ?? mount.current?.closest('section')?.querySelector<HTMLButtonElement>('button');
    destination?.focus();
  }
  function loseInput(reason: string, c = live.current, generation = c?.generation) {
    if (!c || live.current !== c || c.generation !== generation) return;
    c.writer = c.ready = false; c.queue = []; c.bytes = 0; c.ws.close(); intents.current = null; busyRef.current = false; setBusy(false);
    if (terminal.current) terminal.current.options.disableStdin = true;
    clearModifiers(); setWriter(false); setNotice(reason); void refreshRef.current();
  }
  function drain(): Promise<void> {
    const c = live.current; if (!c || !c.writer) return Promise.resolve();
    if (c.sending) return c.draining ?? Promise.resolve();
    c.sending = true; const generation = c.generation;
    c.draining = (async () => {
      try {
        while (c.writer && c.generation === generation && c.queue.length && live.current === c) {
          const { bytes } = c.queue.shift()!; c.bytes -= bytes.length;
          const data = btoa(String.fromCharCode(...bytes)); const seq = ++c.seq;
          const receipt = await api<{generation: string; seq: number}>(token, `terminals/${c.id}/input`, { body: { generation, seq, encoding: 'binary', data } });
          if (receipt.generation !== generation || receipt.seq !== seq) throw Error('Input receipt changed.');
        }
      } catch { loseInput('Input may have occurred. Inspect the terminal; reconnect without resending.', c, generation); }
      finally { if (c.generation === generation) { c.sending = false; c.draining = null; } }
    })();
    return c.draining;
  }
  function enqueue(bytes: Uint8Array) {
    const c = live.current; if (!c?.writer) return;
    // A hidden terminal (Control shown, Focus, another tab) admits no new input event; one already queued still finishes draining.
    if (!root.current?.getClientRects().length) return;
    if (bytes.length + c.bytes > 256 * 1024) { loseInput('Paste exceeds the 256 KiB input limit. Inspect before reconnecting.'); return; }
    for (let i=0;i<bytes.length;i+=4096) c.queue.push({ bytes: bytes.slice(i,i+4096), start: i===0 });
    c.bytes += bytes.length; void drain();
  }
  function modifiedInput(data: string) {
    const {ctrl,alt} = modifiers.current; clearModifiers();
    if (ctrl && /^\x1b\[[ABCD]$/.test(data)) data = `\x1b[1;${alt?7:5}${data.at(-1)}`;
    else {
      if (ctrl && data.length === 1) { const code=data.toUpperCase().charCodeAt(0); if(code>=64&&code<=95)data=String.fromCharCode(code-64);else if(data===' ')data='\x00';else if(data==='?')data='\x7f'; }
      if (alt) data = `\x1b${data}`;
    }
    return data;
  }
  function textInput(data: string) { enqueue(new TextEncoder().encode(modifiedInput(data))); }
  function allowPaste(text: string) {
    if(!live.current?.writer)return false;
    const multiline=/[\r\n]/.test(text)&&!terminal.current?.modes.bracketedPasteMode;
    const large=new TextEncoder().encode(text).length>16*1024;
    return !(multiline||large)||window.confirm(multiline
      ? 'This terminal is not using bracketed paste. Newlines can execute commands immediately. Paste these lines?'
      : 'Paste more than 16 KiB into this terminal? The foreground program controls how pasted text is handled.');
  }
  async function pasteText() {
    const c=live.current;if(!c||pasting||!enabled.current)return;
    const generation=c.generation,seq=c.seq,revision=transientRevision.current,focused=document.activeElement;
    setPasting(true);
    try {
      if(!navigator.clipboard?.readText)throw Error('Clipboard text is unavailable. Use the keyboard or system Paste action in the terminal.');
      const text=await navigator.clipboard.readText();
      if(live.current!==c||c.generation!==generation||c.seq!==seq||revision!==transientRevision.current||document.activeElement!==focused||!root.current?.getClientRects().length){
        setNotice('Clipboard text was not pasted because input, focus or keyboard ownership changed. Paste again at the intended prompt.');return;
      }
      if(!c.ready){entryElement.current?.focus();inputIntent({kind:'paste',text});}
      else if(allowPaste(text)){clearModifiers();terminal.current?.paste(text);terminal.current?.focus();}
    } catch {setNotice('Clipboard text could not be read. Use the keyboard or system Paste action in the terminal.');}
    finally {setPasting(false);}
  }
  function forward(term: Terminal, intent: TerminalIntent) {
    if (intent.kind === 'key') {
      term.textarea?.dispatchEvent(new KeyboardEvent('keydown', intent.key));
      term.textarea?.dispatchEvent(new KeyboardEvent('keyup', intent.key));
    } else if (intent.kind === 'mouse') {
      const rect = term.element!.getBoundingClientRect();
      if (rect.width !== intent.width || rect.height !== intent.height) throw Error('Terminal size changed before mouse input was ready. Unsent input was discarded.');
      const init = { ...intent.event, clientX: rect.left + (intent.event.clientX ?? 0), clientY: rect.top + (intent.event.clientY ?? 0) };
      term.element!.dispatchEvent(intent.type === 'wheel' ? new WheelEvent(intent.type, init) : new MouseEvent(intent.type, init));
    } else if (intent.kind === 'paste') { if (intent.approved || allowPaste(intent.text)) term.paste(intent.text); }
    else term.input(intent.text, true);
  }
  async function beginInput(pending: NonNullable<typeof intents.current>) {
    let admittedGeneration: string | undefined;
    try {
      const result = await acquire(); admittedGeneration = result.generation;
      const c = live.current, term = terminal.current;
      if (!term || c !== pending.connection || intents.current !== pending || pending.revision !== transientRevision.current ||
          !result.writer || !c.writer || result.generation !== c.generation) throw Error('Input entry changed before it was ready. Unsent input was discarded.');
      // All output already received for the writer generation is parsed before encoding
      // deferred keys or paste. No input uses an old observer's application modes.
      await new Promise<void>(resolve => term.write('', resolve));
      await entry.current?.settled();
      if (intents.current !== pending || live.current !== c || pending.revision !== transientRevision.current || !c.writer) throw Error('Input entry changed. Unsent input was discarded.');
      c.ready = true;
      for (const intent of pending.values) {
        if (!c.writer) throw Error('Input stopped while forwarding the initial events. Inspect before continuing.');
        forward(term, intent);
      }
      intents.current = null; setWriter(true); setCapture(false); setNotice('Typing enabled. Automation is held until manual input is stopped and reconciled.');
      const focused = document.activeElement === entryElement.current;
      if (focused) requestAnimationFrame(() => { if (live.current === c && c.ready && (document.activeElement === entryElement.current || document.activeElement === document.body)) term.focus(); });
      await drain();
      if (live.current === c && c.ready) await refreshRef.current();
    } catch (error) { loseInput(error instanceof Error ? error.message : 'Input admission is uncertain. Inspect before typing.', pending.connection, admittedGeneration ?? pending.connection.generation); }
  }
  function inputIntent(intent: TerminalIntent) {
    const c = live.current;
    if (!enabled.current || !c || !connectedRef.current || !root.current?.getClientRects().length) return;
    if ((intent.kind === 'text' || intent.kind === 'paste') && !intent.text) return;
    if (intent.kind === 'text') intent = { ...intent, text: modifiedInput(intent.text) };
    if (intent.kind === 'key') { intent = { ...intent, key: { ...intent.key, ctrlKey: intent.key.ctrlKey || modifiers.current.ctrl, altKey: intent.key.altKey || modifiers.current.alt } }; clearModifiers(); }
    // The entry stays focused until the writer render hides it. Input typed there once ready is
    // this writer's input, never a second admission that would fail and drop the writer.
    if (c.ready && terminal.current) { forward(terminal.current, intent); return; }
    const bytes = intent.kind === 'key' || intent.kind === 'mouse' ? 128 : new TextEncoder().encode(intent.text).length;
    // A first paste has no verified application mode yet. Ask conservatively before
    // granting so cancelling a dangerous paste cannot create manual ownership.
    if (intent.kind === 'paste' && !c.ready && (/[\r\n]/.test(intent.text) || bytes > 16 * 1024)) {
      if (!window.confirm('Paste this text into the terminal? Newlines may execute commands; the native paste mode will be checked after connecting.')) return;
      intent = { ...intent, approved: true };
    }
    let pending = intents.current;
    if (!pending) {
      if (busyRef.current) { setNotice('An input decision is still pending. Nothing new was queued.'); return; }
      pending = { connection: c, revision: transientRevision.current, values: [], bytes: 0 }; intents.current = pending;
    }
    if (pending.bytes + bytes > 256 * 1024 || pending.values.length >= 2048) { loseInput('Pending input exceeds its bounded queue. Unsent input was discarded.'); return; }
    pending.values.push(intent); pending.bytes += bytes;
    if (pending.values.length === 1) void beginInput(pending);
  }
  const intentHandler = useRef(inputIntent); intentHandler.current = inputIntent;
  useEffect(() => {
    if (!entryElement.current) return;
    const binding = terminalEntry(entryElement.current, intent => intentHandler.current(intent), () => enabled.current && !!root.current?.getClientRects().length);
    entry.current = binding;
    return () => { binding.dispose(); if (entry.current === binding) entry.current = null; };
  }, []);
  useEffect(() => {
    if (!epoch) return;
    setConnected(false); setWriter(false); setNative(false); setActive(''); connectedRef.current = false;
    let disposed = false, ws: WebSocket | undefined, id: string | undefined, term: Terminal | undefined;
    let resize: ResizeObserver | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, fitViewport: (()=>void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined, sizing = false, lastSize = '';
    let removeMouse: (() => void) | undefined;
    let generation = '', sequence = 0, processedBytes = 0;
    const close = () => { ws?.close(); if (id) void api(token, `terminals/${id}/close`, {body:{}}).catch(() => {}); };
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !mount.current) return;
      term = new Terminal({ cols: 80, rows: 24, scrollback: 3000, disableStdin: true, convertEol: false, cursorBlink: false, allowProposedApi: false, screenReaderMode: screenReaderRef.current,
        linkHandler: { activate: (_event, text) => { try { const url=new URL(text); if(['http:','https:'].includes(url.protocol)&&window.confirm(`Open terminal link?\n${url.href}`)) window.open(url.href,'_blank','noopener,noreferrer'); } catch {} } }, theme: {background:'#101719',foreground:'#dae4e2'}, fontSize: 13 });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(mount.current); terminal.current = term;
      let mouseDown = false;
      const observerMouse = (event: MouseEvent | WheelEvent) => {
        const wasDown = mouseDown;
        if(event.type === 'mouseup' || event.type === 'mousemove' && !event.buttons) mouseDown = false;
        if ('deltaY' in event && event.deltaY === 0) return;
        if (!event.isTrusted || live.current?.ready || !enabled.current || event.shiftKey || term!.modes.mouseTrackingMode === 'none') return;
        if (event.type === 'mousedown' && document.activeElement !== entryElement.current && document.activeElement !== term!.textarea) return;
        if ((event.type === 'mouseup' || event.type === 'mousemove') && (!wasDown || event.type === 'mousemove' && !event.buttons)) return;
        if (event.type === 'mousedown') mouseDown = true;
        const rect = term!.element!.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        event.preventDefault(); event.stopImmediatePropagation();
        intentHandler.current({ kind: 'mouse', type: event.type, width: rect.width, height: rect.height,
          event: { clientX: event.clientX - rect.left, clientY: event.clientY - rect.top, button: event.button, buttons: event.buttons,
            ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true,
            ...('deltaY' in event ? { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode } : {}) } });
        if (event.type === 'mouseup') mouseDown = false;
      };
      const surface = mount.current;
      surface.addEventListener('mousedown', observerMouse, true); surface.addEventListener('wheel', observerMouse, { capture: true, passive: false });
      document.addEventListener('mouseup', observerMouse, true); document.addEventListener('mousemove', observerMouse, true);
      removeMouse = () => { surface.removeEventListener('mousedown', observerMouse, true); surface.removeEventListener('wheel', observerMouse, true);
        document.removeEventListener('mouseup', observerMouse, true); document.removeEventListener('mousemove', observerMouse, true); };
      // Consume clipboard/title-changing escapes; output never controls the browser clipboard, links or page title.
      term.parser.registerOscHandler(52, () => true); term.parser.registerOscHandler(0, () => true); term.parser.registerOscHandler(2, () => true);
      // Ctrl+Shift+Escape leaves on the first key release, not the press: xterm must see a keyup too, or it ignores the next inserted
      // text (IME, emoji, phone keyboards) after the user returns.
      term.attachCustomKeyEventHandler(e => {
        if(e.type==='keydown' && e.ctrlKey && e.shiftKey && e.key==='Escape') { leaving.current = true; return false; }
        if(e.type==='keyup' && leaving.current) { leaving.current = false; focusControl(); return false; }
        return !!live.current?.ready;
      });
      // xterm otherwise turns alternate-screen wheel events into arrow keys when mouse reporting is off.
      term.attachCustomWheelEventHandler(() => term!.buffer.active.type !== 'alternate' || term!.modes.mouseTrackingMode !== 'none');
      term.onData(textInput);
      term.onBinary(data => {clearModifiers();enqueue(Uint8Array.from(data, c => c.charCodeAt(0) & 255));});
      const sizeKey = () => {const c=live.current;return c?.generation&&term?`${c.generation}:${term.cols}:${term.rows}`:'';};
      const sendSize = async () => {
        const c=live.current,key=sizeKey();
        if(disposed||sizing||!c?.generation||!term||!mount.current?.clientWidth||!mount.current.clientHeight||key===lastSize)return;
        sizing=true;
        try {await api(token, `terminals/${c.id}/resize`, {body:{generation:c.generation,cols:term.cols,rows:term.rows}});lastSize=key;}
        catch { /* Identity/lease changes are handled by the stream; do not replay a failed request. */ }
        finally {sizing=false;if(!disposed&&sizeKey()!==key)scheduleSize();}
      };
      const scheduleSize = () => {clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>void sendSize(),120);};
      const fitVisible = () => {
        if (!mount.current?.clientWidth || !mount.current?.clientHeight || !term) {clearModifiers();return;}
        fit.fit(); scheduleSize();
      };
      fitVisible(); resize = new ResizeObserver(fitVisible); resize.observe(mount.current);
      fitViewport = () => { if(mount.current) mount.current.style.maxHeight=`${Math.max(120,(window.visualViewport?.height??window.innerHeight)*(mount.current.closest('section')?.dataset.expanded==='true'?0.8:0.6))}px`;fitVisible(); };
      refit.current=fitViewport;
      window.visualViewport?.addEventListener('resize',fitViewport); window.addEventListener('orientationchange',fitViewport); fitViewport();
      const opened = await api<TerminalConnection>(token, 'terminals', {body:{protocol:2,target:JSON.parse(targetKey),clientInstanceId,cols:term.cols,rows:term.rows}});
      id = opened.connectionId; if (disposed) { close(); return; }
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/terminals/socket`);
      const connection = {id,bootId:opened.bootId,generation:'',writer:false,ready:false,seq:0,queue:[] as {bytes:Uint8Array;start:boolean}[],bytes:0,sending:false,draining:null as Promise<void> | null,ws}; live.current = connection;
      ws.onopen = () => ws!.send(JSON.stringify({ticket:opened.ticket}));
      ws.onmessage = event => {
        if (disposed || live.current !== connection) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 24000) throw Error('Invalid frame.');
          const f = JSON.parse(event.data) as TerminalFrame;
          if (f.type === 'reset') {
            if (f.bootId !== opened.bootId) throw Error('Host boot changed.');
            generation = f.generation; connection.generation = generation; connection.writer = connection.ready = false; connection.seq = 0; connection.queue = []; connection.bytes = 0; connection.sending = false; connection.draining = null;
            sequence = processedBytes = 0; clearModifiers(); term!.reset(); term!.options.disableStdin = true; setWriter(false); setConnected(true); setNative(f.native); setNotice(f.reason || 'Type here to begin. Viewing and focus alone keep observation read-only.');
            frames.current++; connectedRef.current = true;
            if (generationSeen.current?.generation === f.generation && !generationSeen.current.writer) generationSeen.current.resolve();
            scheduleSize();
          } else if (f.type === 'out') {
            if (f.generation !== generation) return;
            const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
            if (bytes.length !== f.bytes || bytes.length > 16384 || f.sequence !== sequence+1) throw Error('Output sequence changed.');
            sequence = f.sequence; processedBytes += bytes.length; const total = processedBytes;
            term!.write(bytes, () => { if (!disposed && generation === f.generation && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'processed',generation,sequence:f.sequence,processedBytes:total})); });
          } else if (f.type === 'keyboard') {
            if(f.generation !== generation) return;
            clearModifiers(); frames.current++; connection.writer = f.writer; term!.options.disableStdin = !f.writer;
            if (!f.writer) { connection.ready = false; setWriter(false); }
            if (generationSeen.current?.generation === f.generation && generationSeen.current.writer === f.writer) generationSeen.current.resolve();
            setNotice(f.reason);
            void refreshRef.current();
          } else if (f.type === 'active') setActive(`${f.label} · ${f.paneId} · ${f.command}${f.size ? ` · ${f.size.replace('x', '×')} window` : ''}${f.sessionId !== opened.sessionId ? ' · navigated to another tmux session; the control target is unchanged' : ''}`);
          else if(f.type==='closed') {setNotice(f.reason); ws!.close();}
          else if(f.type!=='hb') throw Error('Unsupported frame.');
        } catch { loseInput('Terminal protocol changed. Reconnect as an observer.', connection, generation); }
      };
      ws.onclose = () => { if(disposed) return; clearModifiers(); connection.writer=connection.ready=false; connection.queue=[]; connection.bytes=0; intents.current=null; if(term) term.options.disableStdin=true; setConnected(false); setWriter(false);
        connectedRef.current = false; void refreshRef.current(); };
      ws.onerror = () => { if(!disposed) setNotice('Terminal disconnected. Inspect manual input before reconnecting.'); };
      heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN && generation) ws.send(JSON.stringify({type:'heartbeat',generation})); }, 10000);
    })().catch(error => { if (!disposed) { setNotice(error instanceof Error ? error.message : 'Terminal unavailable.'); } });
    return () => { disposed = true; removeMouse?.(); connectedRef.current = false; clearInterval(heartbeat); clearTimeout(resizeTimer); refit.current=null; resize?.disconnect(); if(fitViewport){window.visualViewport?.removeEventListener('resize',fitViewport);window.removeEventListener('orientationchange',fitViewport);} close(); term?.dispose(); terminal.current = null; live.current = null; };
    // Mounting, exact identity changes and explicit reconnect open observation. Never requests keyboard authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token,targetKey,clientInstanceId,epoch]);
  async function acquire(): Promise<KeyboardResult> {
    const c = live.current;
    if (!c?.generation || !connectedRef.current) throw Error(`Open ${label} first; the keyboard needs a connected terminal. Nothing was requested.`);
    if (busyRef.current) throw Error('Another keyboard decision for this terminal is still in progress.');
    busyRef.current = true; setBusy(true); clearModifiers();
    setNotice('Connecting input…');
    try {
      const result = await api<KeyboardResult>(token, `terminals/${c.id}/keyboard`, {body:{requestId:crypto.randomUUID(),action:'acquire',expectedGeneration:c.generation,expectedBootId:c.bootId}});
      if (live.current === c && !result.writer) setNotice(result.reason);
      // Wait for both the correlated HTTP result and writer frame, in either order; reset alone grants nothing.
      if (live.current === c && (c.generation !== result.generation || c.writer !== result.writer)) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { generationSeen.current = null; reject(Error('No matching writer-ready frame arrived. Inspect manual input.')); }, 5000);
        generationSeen.current = { generation: result.generation, writer: result.writer, resolve: () => { clearTimeout(timer); generationSeen.current = null; resolve(); } };
        if (c.generation === result.generation && c.writer === result.writer) generationSeen.current.resolve();
      });
      return result;
    } catch(error) {setNotice(error instanceof Error ? error.message : 'Keyboard decision uncertain. Inspect server state.'); throw error;}
    finally {busyRef.current = false; setBusy(false);void refreshRef.current();}
  }
  useImperativeHandle(ref, () => ({
  matches: (writer) => { const c=live.current; return !!c?.ready && c.writer && c.id===writer.connectionId && c.generation===writer.generation; },
  abandon: (reason) => loseInput(reason),
  stopped: (frozen) => { if (live.current === frozen.connection) { busyRef.current = false; setBusy(false); } },
  freeze: (allowPending = false) => {
    const c = live.current; if (!c?.writer) return null;
    if (!c.ready || intents.current || (!allowPending && (c.sending || c.queue.length || pasting))) throw Error(`Input is still being sent in ${label}. Wait for it to finish, then choose again. Nothing was requested.`);
    if (allowPending) { c.queue = []; c.bytes = 0; }
    busyRef.current = true; setBusy(true);
    c.writer = c.ready = false; setWriter(false); clearTransient(); if (terminal.current) terminal.current.options.disableStdin = true;
    return { connection: c, generation: c.generation, frames: frames.current };
  },
  thaw: (frozen) => {
    const c = live.current;
    if (!c || frozen.connection !== c || c.generation !== frozen.generation || frames.current !== frozen.frames || !connectedRef.current) return false;
    busyRef.current = false; setBusy(false); c.writer = c.ready = true; setWriter(true); if (terminal.current) terminal.current.options.disableStdin = false; return true;
  },
  }));
  const badge: keyof typeof BADGES = writer ? 'Typing enabled' : !connected ? 'Disconnected' : cliChanged ? 'Manual CLI/shell'
    : held ? (holder === 'unresolved' ? 'Observing · manual input unresolved' : 'Observing · manual input held') : 'Observing';
  return <section ref={root} className={`native-terminal${expanded?' expanded':''}`} data-expanded={expanded} aria-label={`${label} terminal`} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))clearTransient();}}
    onPasteCapture={event=>{
      if(!mount.current?.contains(event.target as Node))return;
      const text=event.clipboardData.getData('text/plain');
      if(!allowPaste(text)){event.preventDefault();event.stopPropagation();}else clearModifiers();
    }}>
    <div className="terminal-tools"><StatusIcon icon={BADGES[badge][0]} label={badge} help={BADGES[badge][1]} />
      {connected && inputEnabled && <IconButton icon="📋" label="Paste text" help="Paste clipboard text into this pane, subject to the paste checks." disabled={writer&&(capture||!native)} aria-disabled={pasting} aria-busy={pasting} onClick={event=>{if(event.isTrusted)void pasteText();}} />}
      {!connected && <IconButton icon={epoch ? '🔄' : '▶️'} label={epoch ? 'Reconnect' : 'Open terminal'} help="Watch this pane live. This does not take the keyboard." onClick={() => {setNotice('Reconnecting as observer…');setEpoch(x=>x+1);}} />}
      <IconButton icon={capture ? '🖥️' : '📄'} label={capture ? 'Show terminal' : 'Captured text'} help="A readable, selectable snapshot with its timestamp, not the live terminal." aria-pressed={capture} onClick={()=>setCapture(x=>!x)} />
      <IconButton icon={expanded ? '⤡' : '⤢'} label={expanded ? 'Collapse terminal' : 'Expand terminal'} help="Enlarge within the page. It does not reconnect or change keyboard ownership." aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} />
      <IconButton icon="♿" label="Screen reader mode" help="Expose terminal output to assistive technology. Turn it off if a software keyboard cannot type; Captured text is the alternative." aria-pressed={screenReader} onClick={()=>{setScreenReader(!screenReader);if(terminal.current)terminal.current.options.screenReaderMode=!screenReader;}} />
      <HelpTip label="Terminal tools help" help={<>{TOOL_HELP.map(([icon, name, text]) => <span key={name} className="legend-line">{icon} <strong>{name}</strong>: {text}</span>)}</>} /></div>
    {screenReader && <p className="fine">If your keyboard cannot enter text in this mode, turn it off. Captured text is also available for reading.</p>}
    <p className="fine" role="status">{notice}{active && ` · ${active}`}{focused && ' · Ctrl+Shift+Esc: leave terminal focus'}</p>
    <div ref={mount} className="xterm-mount" hidden={capture || !native} aria-label={`${label} native output`} onFocus={() => { setFocused(true); if(!live.current?.ready)entryElement.current?.focus(); }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); leaving.current = false; } }} />
    <textarea ref={entryElement} className="terminal-entry" aria-label={`${label} terminal input`} placeholder={connected ? 'Type here' : 'Connecting terminal…'}
      hidden={writer} disabled={!connected || !inputEnabled || busy && !intents.current} rows={1} maxLength={65536} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={e=>{if(e.ctrlKey&&e.shiftKey&&e.key==='Escape'){e.preventDefault();focusControl();}}} />
    {(capture || !native) && <><p className="fine">{capturedAt ? `Snapshot captured at ${new Date(capturedAt).toLocaleTimeString()}` : 'Snapshot only'}{connected && !native && ' · native observation unavailable'}</p>{fallback}</>}
    {connected && inputEnabled && <div className="terminal-keys" aria-label="Terminal keys">{(['ctrl','alt'] as const).map(key=><button type="button" key={key} aria-label={`${key==='ctrl'?'Ctrl':'Alt'} next key`} aria-pressed={modifierState[key]} onClick={()=>{modifiers.current={...modifiers.current,[key]:!modifiers.current[key]};setModifierState(modifiers.current);if(live.current?.ready)terminal.current?.focus();else entryElement.current?.focus();}}>{key==='ctrl'?'Ctrl':'Alt'}</button>)}{[['Esc','Escape',27],['Tab','Tab',9],['↑','ArrowUp',38],['↓','ArrowDown',40],['←','ArrowLeft',37],['→','ArrowRight',39],['Ctrl-C','c',67],['Enter','Enter',13]].map(([name,key,keyCode])=><button type="button" key={name} onClick={event=>{if(!event.isTrusted)return;const intent:TerminalIntent={kind:'key',key:{key:String(key),keyCode:Number(keyCode),ctrlKey:name==='Ctrl-C'||modifiers.current.ctrl,altKey:modifiers.current.alt,bubbles:true,cancelable:true}};if(live.current?.ready){clearModifiers();terminal.current?.textarea?.dispatchEvent(new KeyboardEvent('keydown',intent.key));terminal.current?.textarea?.dispatchEvent(new KeyboardEvent('keyup',intent.key));terminal.current?.focus();}else{entryElement.current?.focus();inputIntent(intent);}}}>{name}</button>)}</div>}
  </section>;
}
