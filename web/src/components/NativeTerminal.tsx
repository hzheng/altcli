'use client';
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TerminalConnection, TerminalFrame, TerminalTarget, KeyboardResult, KeyboardSettlement, ManualSession } from '../contracts/terminals';
import { api } from '../client/api';
import { HelpTip, IconButton, StatusIcon } from './Hint';

/** A writer stopped locally while keyboard authority moves elsewhere; it may be restored only if nothing changed since. */
export interface FrozenWriter { readonly connection: object; readonly generation: string; readonly frames: number }
export interface NativeTerminalHandle {
  releaseForSend: (manual: ManualSession, requestId: string) => Promise<KeyboardSettlement>;
  /** Opens the observer connection when needed and resolves on its first reset frame. It never requests keyboard authority. */
  connect: () => Promise<void>;
  /** One explicit keyboard decision on this terminal's current connection. It throws when the decision failed or is uncertain. */
  keyboard: (action: 'acquire' | 'release' | 'releaseSettled', transfer: boolean) => Promise<KeyboardResult>;
  /** Stops local input before authority moves to another terminal; refuses while input is still being sent. Null when not writing. */
  freeze: () => FrozenWriter | null;
  /** Restores a frozen writer after a definite refusal, only when its connection, generation and keyboard frames are unchanged. */
  thaw: (frozen: FrozenWriter) => boolean;
}
const BADGES = {
  'Keyboard here': ['⌨️', 'This browser holds the one keyboard for this tmux server, and typing here goes to this pane. Dispatch, setup and launch stay held until you release it and reconcile manual input.'],
  Disconnected: ['🔌', 'Not connected to this pane. Open the terminal to watch it; that does not take the keyboard.'],
  'Controlled in another browser': ['🔒', 'Another browser holds the keyboard for this tmux server. Transfer it with the Keyboard selector only after checking with that browser’s user.'],
  'Keyboard in another terminal': ['↔️', 'This browser’s keyboard is in another pane. Choose this pane in the Keyboard selector to move it here.'],
  'Manual CLI/shell': ['⚠️', 'The registered CLI process in this pane was replaced, for example it exited to a shell. Inspect the pane before sending.'],
  'Observing · manual input unresolved': ['⚠️', 'Watching read-only. Earlier manual input is not reconciled; review it in the manual input notice before automated work continues.'],
  'Observing · manual input held': ['⚠️', 'Watching read-only. A keyboard or manual-input hold is active on this server, so automated work waits for it.'],
  Observing: ['👁️', 'Watching this pane live, read-only. Choose it in the Keyboard selector to type here.'],
} as const;
const TOOL_HELP = [
  ['▶️', 'Open terminal / 🔄 Reconnect', 'watch this pane live; this does not take the keyboard'],
  ['📄', 'Captured text / 🖥️ Show terminal', 'a readable, selectable snapshot with its timestamp, not the live terminal'],
  ['⤢', 'Expand / ⤡ Collapse terminal', 'enlarge within the page without reconnecting or changing keyboard ownership'],
  ['♿', 'Screen reader mode', 'expose output to assistive technology; turn it off if a software keyboard cannot type'],
  ['📋', 'Paste text', 'paste clipboard text while this pane has the keyboard'],
  ['⌨️', 'Keyboard', 'choose which pane types in the Keyboard selector; Ctrl+Shift+Esc leaves terminal focus'],
] as const;
/** Native bytes stay in this component. No replay, persistence, automatic grant or URL credentials. Keyboard decisions come only
 * from the shared Keyboard selector through the handle; this card shows the state and the terminal tools. */
export function NativeTerminal({ ref, token, target, clientInstanceId, label, fallback, capturedAt, held, holder, cliChanged = false, refresh, viewEpoch = 0 }: {
  ref?: Ref<NativeTerminalHandle>;
  token: string; target: TerminalTarget; clientInstanceId: string; label: string; fallback: ReactNode;
  capturedAt?: string; held: boolean; refresh: () => Promise<void>; viewEpoch?: number;
  /** Who holds the server-wide keyboard when this card does not: another browser, another card here, or an unresolved record. */
  holder?: 'other-browser' | 'this-browser' | 'unresolved' | null;
  /** The registered CLI process in this pane was replaced, e.g. it exited to a shell. */
  cliChanged?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null);
  // One input event may span several 4 KiB chunks; `start` marks each event's first chunk.
  const live = useRef<{ id: string; generation: string; writer: boolean; seq: number; queue: { bytes: Uint8Array; start: boolean }[]; bytes: number; sending: boolean; ws: WebSocket } | null>(null);
  const [connected, setConnected] = useState(false), [native, setNative] = useState(false), [writer, setWriter] = useState(false);
  const [capture, setCapture] = useState(false), [notice, setNotice] = useState('Open a terminal to observe this pane.'), [active, setActive] = useState('');
  const [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0);
  // Synchronous mirrors for the handle: a second decision must not start before React re-renders.
  const busyRef = useRef(false), connectedRef = useRef(false), connectingRef = useRef(false), frames = useRef(0);
  const waiters = useRef<{ resolve: () => void; reject: (error: Error) => void }[]>([]);
  function settleWaiters(error: Error | null) { const pending = waiters.current; waiters.current = []; for (const w of pending) if (error) w.reject(error); else w.resolve(); }
  // A keyboard decision replaces the connection's generation; the next decision or input must carry the new one.
  const generationSeen = useRef<{ generation: string; resolve: () => void } | null>(null);
  const [focused, setFocused] = useState(false), leaving = useRef(false);
  const [screenReader, setScreenReader] = useState(false);
  const screenReaderRef = useRef(screenReader); screenReaderRef.current = screenReader;
  const [expanded, setExpanded] = useState(false);
  const [pasting, setPasting] = useState(false);
  const transientRevision = useRef(0);
  const pendingGrant = useRef<{ focused: Element | null } | null>(null);
  const refit = useRef<(() => void) | null>(null);
  const modifiers = useRef({ctrl:false,alt:false}); const [modifierState,setModifierState] = useState(modifiers.current);
  function clearModifiers() { modifiers.current = {ctrl:false,alt:false}; setModifierState(modifiers.current); }
  // Drops only events not yet started. Finishing a partly sent event keeps a large bracketed paste from being truncated.
  function clearTransient() {
    clearModifiers(); transientRevision.current++;
    const c=live.current; if(!c)return;
    const next=c.queue.findIndex(item=>item.start); if(next<0)return;
    c.queue=c.queue.slice(0,next); c.bytes=c.queue.reduce((n,item)=>n+item.bytes.length,0);
  }
  useEffect(() => { clearTransient(); }, [viewEpoch]);
  useEffect(() => { if(!expanded)clearTransient();else clearModifiers(); refit.current?.(); }, [expanded]);
  const targetKey = JSON.stringify(target);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  /** Ctrl+Shift+Escape leaves terminal focus without sending anything: to the visible Control region, else the phone drawer toggle, else
   * the nearest Keyboard selector. It never releases keyboard authority. */
  function focusControl() {
    clearModifiers();
    const visible = (el: HTMLElement | null | undefined) => el && el.getClientRects().length ? el : null;
    const control = visible(document.querySelector<HTMLElement>('.control-pane'));
    const scope = mount.current?.closest('.launch-agents, .section-panel');
    const destination = control ?? visible(document.querySelector<HTMLElement>('.drawer-toggle'))
      ?? visible(scope?.querySelector<HTMLElement>('.keyboard-selector input:checked, .keyboard-selector select, .keyboard-selector input'))
      ?? mount.current?.closest('section')?.querySelector<HTMLButtonElement>('button');
    if (destination === control && control) control.tabIndex = -1;
    destination?.focus();
  }
  function loseInput(reason: string, c = live.current, generation = c?.generation) {
    if (!c || live.current !== c || c.generation !== generation) return;
    c.writer = false; c.queue = []; c.bytes = 0; c.ws.close();
    if (terminal.current) terminal.current.options.disableStdin = true;
    clearModifiers(); setWriter(false); setNotice(reason); void refreshRef.current();
  }
  async function drain() {
    const c = live.current; if (!c || c.sending || !c.writer) return;
    c.sending = true; const generation = c.generation;
    try {
      while (c.writer && c.generation === generation && c.queue.length && live.current === c) {
        const { bytes } = c.queue.shift()!; c.bytes -= bytes.length;
        const data = btoa(String.fromCharCode(...bytes)); const seq = ++c.seq;
        const receipt = await api<{generation: string; seq: number}>(token, `terminals/${c.id}/input`, { body: { generation, seq, encoding: 'binary', data } });
        if (receipt.generation !== generation || receipt.seq !== seq) throw Error('Input receipt changed.');
      }
    } catch { loseInput('Input may have occurred. Inspect the terminal; reconnect without resending.', c, generation); }
    finally { if (c.generation === generation) c.sending = false; }
  }
  function enqueue(bytes: Uint8Array) {
    const c = live.current; if (!c?.writer) return;
    if (bytes.length + c.bytes > 256 * 1024) { loseInput('Paste exceeds the 256 KiB input limit. Inspect before reconnecting.'); return; }
    for (let i=0;i<bytes.length;i+=4096) c.queue.push({ bytes: bytes.slice(i,i+4096), start: i===0 });
    c.bytes += bytes.length; void drain();
  }
  function textInput(data: string) {
    const {ctrl,alt} = modifiers.current; clearModifiers();
    if (ctrl && /^\x1b\[[ABCD]$/.test(data)) data = `\x1b[1;${alt?7:5}${data.at(-1)}`;
    else {
      if (ctrl && data.length === 1) { const code=data.toUpperCase().charCodeAt(0); if(code>=64&&code<=95)data=String.fromCharCode(code-64);else if(data===' ')data='\x00';else if(data==='?')data='\x7f'; }
      if (alt) data = `\x1b${data}`;
    }
    enqueue(new TextEncoder().encode(data));
  }
  function allowPaste(text: string) {
    if(!live.current?.writer)return false;
    const multiline=/[\r\n]/.test(text)&&!terminal.current?.modes.bracketedPasteMode;
    const large=new TextEncoder().encode(text).length>16*1024;
    return !(multiline||large)||window.confirm(multiline
      ? 'This terminal is not using bracketed paste. Newlines can execute commands immediately. Paste these lines?'
      : 'Paste more than 16 KiB into this terminal? The foreground program controls how pasted text is handled.');
  }
  async function pasteText() {
    const c=live.current;if(!c?.writer||pasting)return;
    const generation=c.generation,seq=c.seq,revision=transientRevision.current,focused=document.activeElement;
    setPasting(true);
    try {
      if(!navigator.clipboard?.readText)throw Error('Clipboard text is unavailable. Use the keyboard or system Paste action in the terminal.');
      const text=await navigator.clipboard.readText();
      if(live.current!==c||!c.writer||c.generation!==generation||c.seq!==seq||revision!==transientRevision.current||document.activeElement!==focused||!mount.current?.clientWidth){
        setNotice('Clipboard text was not pasted because input, focus or keyboard ownership changed. Paste again at the intended prompt.');return;
      }
      if(allowPaste(text)){clearModifiers();terminal.current?.paste(text);terminal.current?.focus();}
    } catch {setNotice('Clipboard text could not be read. Use the keyboard or system Paste action in the terminal.');}
    finally {setPasting(false);}
  }
  useEffect(() => {
    if (!epoch) return;
    setConnected(false); setWriter(false); setNative(false); setActive(''); connectedRef.current = false; connectingRef.current = true;
    let disposed = false, ws: WebSocket | undefined, id: string | undefined, term: Terminal | undefined;
    let resize: ResizeObserver | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, fitViewport: (()=>void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined, sizing = false, lastSize = '';
    let generation = '', sequence = 0, processedBytes = 0;
    const close = () => { ws?.close(); if (id) void api(token, `terminals/${id}/close`, {body:{}}).catch(() => {}); };
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !mount.current) return;
      term = new Terminal({ cols: 80, rows: 24, scrollback: 3000, disableStdin: true, convertEol: false, cursorBlink: false, allowProposedApi: false, screenReaderMode: screenReaderRef.current,
        linkHandler: { activate: (_event, text) => { try { const url=new URL(text); if(['http:','https:'].includes(url.protocol)&&window.confirm(`Open terminal link?\n${url.href}`)) window.open(url.href,'_blank','noopener,noreferrer'); } catch {} } }, theme: {background:'#101719',foreground:'#dae4e2'}, fontSize: 13 });
      const fit = new FitAddon(); term.loadAddon(fit); term.open(mount.current); terminal.current = term;
      // Consume clipboard/title-changing escapes; output never controls the browser clipboard, links or page title.
      term.parser.registerOscHandler(52, () => true); term.parser.registerOscHandler(0, () => true); term.parser.registerOscHandler(2, () => true);
      // Ctrl+Shift+Escape leaves on the first key release, not the press: xterm must see a keyup too, or it ignores the next inserted
      // text (IME, emoji, phone keyboards) after the user returns.
      term.attachCustomKeyEventHandler(e => {
        if(e.type==='keydown' && e.ctrlKey && e.shiftKey && e.key==='Escape') { leaving.current = true; return false; }
        if(e.type==='keyup' && leaving.current) { leaving.current = false; focusControl(); return false; }
        return true;
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
      const opened = await api<TerminalConnection>(token, 'terminals', {body:{target:JSON.parse(targetKey),clientInstanceId,cols:term.cols,rows:term.rows}});
      id = opened.connectionId; if (disposed) { close(); return; }
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/terminals/socket`);
      const connection = {id,generation:'',writer:false,seq:0,queue:[] as {bytes:Uint8Array;start:boolean}[],bytes:0,sending:false,ws}; live.current = connection;
      ws.onopen = () => ws!.send(JSON.stringify({ticket:opened.ticket}));
      ws.onmessage = event => {
        if (disposed || live.current !== connection) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 24000) throw Error('Invalid frame.');
          const f = JSON.parse(event.data) as TerminalFrame;
          if (f.type === 'reset') {
            generation = f.generation; connection.generation = generation; connection.writer = false; connection.seq = 0; connection.queue = []; connection.bytes = 0; connection.sending = false;
            sequence = processedBytes = 0; clearModifiers(); term!.reset(); term!.options.disableStdin = true; setWriter(false); setConnected(true); setNative(f.native); setNotice(f.reason || 'Observing. Choose this pane in the Keyboard selector to type.');
            frames.current++; connectedRef.current = true; connectingRef.current = false; settleWaiters(null);
            if (generationSeen.current?.generation === f.generation) generationSeen.current.resolve();
            scheduleSize();
          } else if (f.type === 'out') {
            if (f.generation !== generation) return;
            const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
            if (bytes.length !== f.bytes || bytes.length > 16384 || f.sequence !== sequence+1) throw Error('Output sequence changed.');
            sequence = f.sequence; processedBytes += bytes.length; const total = processedBytes;
            term!.write(bytes, () => { if (!disposed && generation === f.generation && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'processed',generation,sequence:f.sequence,processedBytes:total})); });
          } else if (f.type === 'keyboard') {
            if(f.generation !== generation) return;
            clearModifiers(); frames.current++; connection.writer = f.writer; term!.options.disableStdin = !f.writer; setWriter(f.writer);
            const pending = pendingGrant.current; pendingGrant.current = null;
            // If the user moved elsewhere while the grant was pending, never pull focus back into the terminal.
            const focusNow = f.writer && !!pending && !!mount.current?.clientWidth && (document.activeElement === pending.focused || document.activeElement === document.body);
            setNotice(f.writer && pending && !focusNow ? `Keyboard ready for ${label}. Select the terminal to type. ${f.reason}` : f.reason);
            if (focusNow) term!.focus();
            void refreshRef.current();
          } else if (f.type === 'active') setActive(`${f.label} · ${f.paneId} · ${f.command}${f.size ? ` · ${f.size.replace('x', '×')} window` : ''}${f.sessionId !== opened.sessionId ? ' · navigated to another tmux session; the control target is unchanged' : ''}`);
          else if(f.type==='closed') {setNotice(f.reason); ws!.close();}
          else if(f.type!=='hb') throw Error('Unsupported frame.');
        } catch { loseInput('Terminal protocol changed. Reconnect as an observer.', connection, generation); }
      };
      ws.onclose = () => { if(disposed) return; clearModifiers(); connection.writer=false; connection.queue=[]; connection.bytes=0; if(term) term.options.disableStdin=true; setConnected(false); setWriter(false);
        connectedRef.current = false; connectingRef.current = false; settleWaiters(Error('The terminal disconnected before it was ready. Nothing was requested.')); void refreshRef.current(); };
      ws.onerror = () => { if(!disposed) setNotice('Terminal disconnected. Inspect manual input before reconnecting.'); };
      heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN && generation) ws.send(JSON.stringify({type:'heartbeat',generation})); }, 10000);
    })().catch(error => { if (!disposed) { setNotice(error instanceof Error ? error.message : 'Terminal unavailable.'); connectingRef.current = false; settleWaiters(Error('The terminal could not connect. Nothing was requested.')); } });
    return () => { disposed = true; connectedRef.current = false; connectingRef.current = false; settleWaiters(Error('The terminal closed. Nothing was requested.')); clearInterval(heartbeat); clearTimeout(resizeTimer); refit.current=null; resize?.disconnect(); if(fitViewport){window.visualViewport?.removeEventListener('resize',fitViewport);window.removeEventListener('orientationchange',fitViewport);} close(); term?.dispose(); terminal.current = null; live.current = null; };
    // Only exact identity / explicit reconnect creates an observation connection. Never requests keyboard authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token,targetKey,clientInstanceId,epoch]);
  async function keyboard(action: 'acquire'|'release'|'releaseSettled', transfer: boolean): Promise<KeyboardResult> {
    const c = live.current;
    if (!c?.generation || !connectedRef.current) throw Error(`Open ${label} first; the keyboard needs a connected terminal. Nothing was requested.`);
    if (busyRef.current) throw Error('Another keyboard decision for this terminal is still in progress.');
    busyRef.current = true; setBusy(true); clearModifiers();
    // The grant's keyboard frame decides focus, whichever of it and this response arrives first.
    pendingGrant.current = action === 'acquire' ? { focused: document.activeElement } : null;
    // Stop accepting browser keystrokes immediately; queued input is never migrated to another grant.
    if(action!=='acquire'){ c.writer=false; c.queue=[]; c.bytes=0; setWriter(false); if(terminal.current) terminal.current.options.disableStdin=true; }
    try {
      const result = await api<KeyboardResult>(token, `terminals/${c.id}/keyboard`, {body:{requestId:crypto.randomUUID(),action,expectedGeneration:c.generation,transfer,confirmReady:true}});
      if (live.current === c && !result.writer) setNotice(result.reason);
      // The reset for the returned generation travels on the socket, not with this response: wait (bounded) until it is applied.
      if (live.current === c && c.generation !== result.generation) await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { generationSeen.current = null; resolve(); }, 5000);
        generationSeen.current = { generation: result.generation, resolve: () => { clearTimeout(timer); generationSeen.current = null; resolve(); } };
        if (c.generation === result.generation || live.current !== c) generationSeen.current.resolve();
      });
      return result;
    } catch(error) {pendingGrant.current = null; setNotice(error instanceof Error ? error.message : 'Keyboard decision uncertain. Inspect server state.'); throw error;}
    finally {busyRef.current = false; setBusy(false);void refreshRef.current();}
  }
  useImperativeHandle(ref, () => ({ releaseForSend: async (manual, requestId) => {
    const c = live.current;
    if (!c?.writer || !connected || busy || busyRef.current || c.id !== manual.connectionId || c.generation !== manual.generation || manual.clientInstanceId !== clientInstanceId)
      throw Error('Keyboard ownership changed. Inspect the terminal and confirm readiness again.');
    if (c.sending || c.queue.length || pasting) throw Error('Terminal input is still pending. Wait for it to finish, then inspect and confirm readiness again.');
    // Freeze local input before release. Never truncate a pending paste or replay an uncertain decision.
    c.writer = false; setWriter(false); busyRef.current = true; setBusy(true); pendingGrant.current = null; clearTransient();
    if (terminal.current) terminal.current.options.disableStdin = true;
    try {
      const result = await api<KeyboardResult>(token, `terminals/${c.id}/keyboard`, {body:{requestId:crypto.randomUUID(),action:'releaseSettled',expectedGeneration:manual.generation,expectedRevision:manual.revision,handoffRequestId:requestId,confirmReady:true}}).catch(error => {
        // A lost response may have released ownership. Reconnect only as an observer; never restore input here.
        loseInput('Keyboard handoff stopped. Inspect manual input before sending.', c);
        throw error;
      });
      setNotice(result.reason);
      if (result.writer !== false || result.manualSession?.id !== manual.id || result.manualSession.live !== false || result.manualSession.reconciliationRequired !== false || result.manualSession.settlement?.requestId !== requestId)
        throw Error(result.reason || 'Manual input could not be settled. Inspect the terminal before sending.');
      return { manualSessionId: manual.id, revision: result.manualSession.revision };
    } finally {busyRef.current = false; setBusy(false);void refreshRef.current();}
  },
  connect: () => new Promise<void>((resolve, reject) => {
    if (connectedRef.current && live.current?.generation) return resolve();
    const timer = setTimeout(() => { waiters.current = waiters.current.filter(w => w !== waiter); reject(Error(`${label} did not connect in time. Nothing was requested.`)); }, 15000);
    const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
    waiters.current.push(waiter);
    // An observer connection already opening is awaited, never restarted.
    if (!connectingRef.current) { connectingRef.current = true; setNotice('Connecting as observer…'); setEpoch(x => x + 1); }
  }),
  keyboard,
  freeze: () => {
    const c = live.current; if (!c?.writer) return null;
    if (c.sending || c.queue.length || pasting) throw Error(`Input is still being sent in ${label}. Wait for it to finish, then choose again. Nothing was requested.`);
    c.writer = false; setWriter(false); clearTransient(); if (terminal.current) terminal.current.options.disableStdin = true;
    return { connection: c, generation: c.generation, frames: frames.current };
  },
  thaw: (frozen) => {
    const c = live.current;
    if (!c || frozen.connection !== c || c.generation !== frozen.generation || frames.current !== frozen.frames || !connectedRef.current) return false;
    c.writer = true; setWriter(true); if (terminal.current) terminal.current.options.disableStdin = false; return true;
  },
  }));
  const badge: keyof typeof BADGES = writer ? 'Keyboard here' : !connected ? 'Disconnected' : holder === 'other-browser' ? 'Controlled in another browser'
    : holder === 'this-browser' ? 'Keyboard in another terminal' : cliChanged ? 'Manual CLI/shell'
    : held ? (holder === 'unresolved' ? 'Observing · manual input unresolved' : 'Observing · manual input held') : 'Observing';
  return <section className={`native-terminal${expanded?' expanded':''}`} data-expanded={expanded} aria-label={`${label} terminal`} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))clearTransient();}}
    onPasteCapture={event=>{
      if(!mount.current?.contains(event.target as Node))return;
      const text=event.clipboardData.getData('text/plain');
      if(!allowPaste(text)){event.preventDefault();event.stopPropagation();}else clearModifiers();
    }}>
    <div className="terminal-tools"><StatusIcon icon={BADGES[badge][0]} label={badge} help={BADGES[badge][1]} />
      {writer && <IconButton icon="📋" label="Paste text" help="Paste clipboard text into this pane, subject to the paste checks." disabled={capture||!native} aria-disabled={pasting} aria-busy={pasting} onClick={()=>void pasteText()} />}
      {!connected && <IconButton icon={epoch ? '🔄' : '▶️'} label={epoch ? 'Reconnect' : 'Open terminal'} help="Watch this pane live. This does not take the keyboard." onClick={() => {setNotice('Reconnecting as observer…');connectingRef.current = true;setEpoch(x=>x+1);}} />}
      <IconButton icon={capture ? '🖥️' : '📄'} label={capture ? 'Show terminal' : 'Captured text'} help="A readable, selectable snapshot with its timestamp, not the live terminal." aria-pressed={capture} onClick={()=>setCapture(x=>!x)} />
      <IconButton icon={expanded ? '⤡' : '⤢'} label={expanded ? 'Collapse terminal' : 'Expand terminal'} help="Enlarge within the page. It does not reconnect or change keyboard ownership." aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} />
      <IconButton icon="♿" label="Screen reader mode" help="Expose terminal output to assistive technology. Turn it off if a software keyboard cannot type; Captured text is the alternative." aria-pressed={screenReader} onClick={()=>{setScreenReader(!screenReader);if(terminal.current)terminal.current.options.screenReaderMode=!screenReader;}} />
      <HelpTip label="Terminal tools help" help={<>{TOOL_HELP.map(([icon, name, text]) => <span key={name} className="legend-line">{icon} <strong>{name}</strong>: {text}</span>)}</>} /></div>
    {screenReader && <p className="fine">If your keyboard cannot enter text in this mode, turn it off. Captured text is also available for reading.</p>}
    <p className="fine" role="status">{notice}{active && ` · ${active}`}{focused && ' · Ctrl+Shift+Esc: leave terminal focus'}</p>
    <div ref={mount} className="xterm-mount" hidden={capture || !native} aria-label={`${label} native output`} onFocus={() => setFocused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); leaving.current = false; } }} />
    {(capture || !native) && <><p className="fine">{capturedAt ? `Snapshot captured at ${new Date(capturedAt).toLocaleTimeString()}` : 'Snapshot only'}{connected && !native && ' · native observation unavailable'}</p>{fallback}</>}
    {writer && <div className="terminal-keys" aria-label="Terminal keys">{(['ctrl','alt'] as const).map(key=><button type="button" key={key} aria-label={`${key==='ctrl'?'Ctrl':'Alt'} next key`} aria-pressed={modifierState[key]} onClick={()=>{modifiers.current={...modifiers.current,[key]:!modifiers.current[key]};setModifierState(modifiers.current);terminal.current?.focus();}}>{key==='ctrl'?'Ctrl':'Alt'}</button>)}{[['Esc','\x1b'],['Tab','\t'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C'],['Ctrl-C','\x03'],['Enter','\r']].map(([name,key])=><button type="button" key={name} onClick={()=>{textInput(key!);terminal.current?.focus();}}>{name}</button>)}</div>}
  </section>;
}
