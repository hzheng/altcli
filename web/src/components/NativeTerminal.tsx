'use client';
import { useEffect, useLayoutEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TerminalConnection, TerminalFrame, TerminalTarget, KeyboardResult, ManualWriter } from '../contracts/terminals';
import { api, HttpError } from '../client/api';
import { clipboardImages, type ImageItem } from '../client/attachments';
import { HelpTip, IconButton, StatusIcon } from './Hint';
import { AttachImageButton, AttachmentTray, IMAGE_LIMIT_NOTE, pasteImages, useImageTray } from './AttachmentTray';

/** A writer stopped locally before an explicit stop; it may be restored only if nothing changed since. */
export interface FrozenWriter { readonly connection: object; readonly generation: string; readonly frames: number }
export interface NativeTerminalHandle {
  matches: (writer: ManualWriter) => boolean;
  abandon: (reason: string) => void;
  stopped: (frozen: FrozenWriter) => void;
  /** Freezes input for a stop. With allowPending, unsent bytes are dropped; otherwise pending input refuses. */
  freeze: (allowPending?: boolean) => FrozenWriter | null;
  /** Restores a frozen writer after a definite refusal, only when its connection, generation and keyboard frames are unchanged. */
  thaw: (frozen: FrozenWriter) => boolean;
}
const BADGES = {
  'Typing enabled': ['⌨️', 'Terminal mode: keys, paste and mouse go to this pane, independently of other terminals. Manual input holds automation across this tmux server until it is stopped and reconciled.'],
  Disconnected: ['🔌', 'Not connected to this pane. Switch to Terminal, or Reconnect to watch it.'],
  'Manual CLI/shell': ['⚠️', 'The registered CLI process in this pane was replaced, for example it exited to a shell. Inspect the pane before sending.'],
  'Observing · manual input unresolved': ['⚠️', 'Display mode: view only. Earlier manual input is not reconciled; automated work waits until an action’s acknowledgement or Control access records it.'],
  'Observing · manual input held': ['⚠️', 'Display mode: view only. Manual input is active on this server, so automated work waits for it.'],
  Observing: ['👁️', 'Display mode: view only. Use the Terminal toggle to type; focus and output alone never enable input.'],
} as const;
const TOOL_HELP = [
  ['⌨️', 'Terminal / 👁️ Display', 'the toggle: type in this pane, or only view it. Toggling again resets a failed connection'],
  ['▶️', 'Open terminal / 🔄 Reconnect', 'watch this pane live; this does not start typing'],
  ['📄', 'Captured text / 🖥️ Show terminal', 'a readable, selectable snapshot with its timestamp, not the live terminal'],
  ['⤢', 'Expand / ⤡ Collapse terminal', 'enlarge within the page without reconnecting or changing the mode'],
  ['♿', 'Screen reader mode', 'expose output to assistive technology; turn it off if a software keyboard cannot type'],
  ['📋', 'Paste text', 'paste clipboard text in Terminal mode. Ctrl+Shift+Esc leaves terminal focus'],
  ['🖼️', 'Attach image', 'paste or choose PNG or JPEG images in Terminal mode. They upload to this host; Insert adds one image reference to the prompt, never Enter'],
] as const;
/** One queued input event: terminal bytes, or one explicit image insertion that the server turns into a verified reference. */
type Queued = { bytes: Uint8Array; start: boolean; image?: undefined } | { image: { key: string; attachmentId: string }; start: true; bytes?: undefined };
/** Refused by the server before anything was written: the image stays ready for a later, deliberate Insert. */
class ImageRefused extends Error {}
/** Workspace input starts only with the Terminal toggle. Independent app terminals start input on connection. */
export function NativeTerminal({ ref, token, target, clientInstanceId, label, fallback, capturedAt, held, holder, cliChanged = false, refresh, viewEpoch = 0, inputEnabled = true, autoInput = false, workspace, imagesSupported = false }: {
  ref?: Ref<NativeTerminalHandle>;
  token: string; target: TerminalTarget; clientInstanceId: string; label: string; fallback: ReactNode;
  /** Canonical worktree root of this pane's workspace; images uploaded here belong to it. */
  workspace?: string;
  /** Image insertion is verified for this registered CLI (Claude Code or Codex). */
  imagesSupported?: boolean;
  capturedAt?: string; held: boolean; refresh: () => Promise<void>; viewEpoch?: string | number;
  /** Describes a shared manual-input hold independently of this terminal's writer. */
  holder?: 'other-browser' | 'this-browser' | 'unresolved' | null;
  /** The registered CLI process in this pane was replaced, e.g. it exited to a shell. */
  cliChanged?: boolean;
  /** Host input policy; observation remains available when input is disabled. */
  inputEnabled?: boolean;
  /** An app terminal outside the manual-input barrier (Global AI): input starts once connected, with no Display/Terminal switch. */
  autoInput?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), root = useRef<HTMLElement>(null);
  // One input event may span several 4 KiB chunks; `start` marks each event's first chunk. `failed` makes the next toggle reconnect first.
  const live = useRef<{ id: string; bootId: string; paneId: string; sessionId: string; generation: string; writer: boolean; ready: boolean; failed: boolean; seq: number; queue: Queued[]; bytes: number; sending: boolean; draining: Promise<void> | null; ws: WebSocket } | null>(null);
  const [connected, setConnected] = useState(false), [native, setNative] = useState(false), [writer, setWriter] = useState(false);
  const [capture, setCapture] = useState(false), [notice, setNotice] = useState(autoInput ? 'Connecting to terminal…' : 'Open a terminal to observe this pane.'), [active, setActive] = useState('');
  const [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(1);
  // Synchronous mirrors for the handle: a second decision must not start before React re-renders.
  const busyRef = useRef(false), connectedRef = useRef(false), frames = useRef(0);
  // Set when Terminal was chosen before this connection was ready (still connecting, or failed and replaced): typing starts once it is.
  const enterAfterReset = useRef(false), connecting = useRef(false);
  // Where focus was when Terminal was chosen. It is kept through connecting and reconnecting, so a grant that completes later never
  // pulls focus from a control the user has moved to meanwhile.
  const focusOrigin = useRef<Element | null>(null);
  // A keyboard decision replaces the connection's generation; the next decision or input must carry the new one.
  const generationSeen = useRef<{ generation: string; writer: boolean; resolve: () => void } | null>(null);
  const [focused, setFocused] = useState(false), leaving = useRef(false);
  const [screenReader, setScreenReader] = useState(false);
  const screenReaderRef = useRef(screenReader); screenReaderRef.current = screenReader;
  const [expanded, setExpanded] = useState(false);
  const [pasting, setPasting] = useState(false);
  const transientRevision = useRef(0);
  const enabled = useRef(inputEnabled); enabled.current = inputEnabled;
  const viewEpochRef = useRef(viewEpoch); viewEpochRef.current = viewEpoch;
  /** The picker is bound to the connection, generation, view and target at the click; a change before files return discards them. */
  const pickerIntent = useRef<{ connection: object; generation: string; view: string | number; target: string } | null>(null);
  const refit = useRef<(() => void) | null>(null);
  const modifiers = useRef({ctrl:false,alt:false}); const [modifierState,setModifierState] = useState(modifiers.current);
  // This card's images, remembered per exact target in page memory. Uploading never inserts, grants input or moves focus.
  const targetMemory = JSON.stringify(target);
  const images = useImageTray(token, workspace ?? '', `native-images:${targetMemory}`);
  const imagesRef = useRef(images); imagesRef.current = images;
  // The writer navigated tmux away from the original pane or session: images are not inserted until it returns.
  const [navigated, setNavigated] = useState(false);
  /** Image insertions dropped before they were sent return to Ready; nothing was written for them. */
  function unsentImages(items: Queued[]) { for (const item of items) if (item.image) imagesRef.current.setStatus(item.image.key, 'ready'); }
  function clearModifiers() { modifiers.current = {ctrl:false,alt:false}; setModifierState(modifiers.current); }
  // Drops only events not yet started. Finishing a partly sent event keeps a large bracketed paste from being truncated.
  function clearTransient() {
    clearModifiers(); transientRevision.current++;
    const c=live.current; if(!c)return;
    const next=c.queue.findIndex(item=>item.start); if(next<0)return;
    unsentImages(c.queue.slice(next));
    c.queue=c.queue.slice(0,next); c.bytes=c.queue.reduce((n,item)=>n+(item.bytes?.length??0),0);
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
    unsentImages(c.queue);
    c.writer = c.ready = false; c.failed = true; c.queue = []; c.bytes = 0; c.ws.close(); busyRef.current = false; setBusy(false);
    if (terminal.current) terminal.current.options.disableStdin = true;
    clearModifiers(); setWriter(false); setNotice(`${reason} ${autoInput ? 'Reconnect to continue typing.' : 'Toggle Terminal to reconnect.'}`); void refreshRef.current();
  }
  function drain(): Promise<void> {
    const c = live.current; if (!c || !c.writer) return Promise.resolve();
    if (c.sending) return c.draining ?? Promise.resolve();
    c.sending = true; const generation = c.generation;
    c.draining = (async () => {
      try {
        while (c.writer && c.generation === generation && c.queue.length && live.current === c) {
          const item = c.queue.shift()!;
          if (item.image) {
            const { key, attachmentId } = item.image; const seq = ++c.seq;
            try {
              const receipt = await api<{generation: string; seq: number}>(token, `terminals/${c.id}/input`, { body: { generation, seq, image: { attachmentId, bootId: c.bootId, paneId: c.paneId, sessionId: c.sessionId } } });
              if (receipt.generation !== generation || receipt.seq !== seq) throw Error('Input receipt changed.');
              imagesRef.current.setStatus(key, 'inserted');
            } catch (error) {
              // A server refusal before writing is definite; a lost response or a failed write is not, and is never resent.
              if (error instanceof HttpError && error.status < 500 && error.code !== 'INPUT_UNCERTAIN') { imagesRef.current.setStatus(key, 'ready', error.message); throw new ImageRefused(error.message); }
              imagesRef.current.setStatus(key, 'uncertain'); throw error;
            }
            continue;
          }
          const { bytes } = item; c.bytes -= bytes.length;
          const data = btoa(String.fromCharCode(...bytes)); const seq = ++c.seq;
          const receipt = await api<{generation: string; seq: number}>(token, `terminals/${c.id}/input`, { body: { generation, seq, encoding: 'binary', data } });
          if (receipt.generation !== generation || receipt.seq !== seq) throw Error('Input receipt changed.');
        }
      } catch (error) { loseInput(error instanceof ImageRefused ? `${error.message}` : 'Input may have occurred. Inspect the terminal; nothing is resent.', c, generation); }
      finally { if (c.generation === generation) { c.sending = false; c.draining = null; } }
    })();
    return c.draining;
  }
  function enqueue(bytes: Uint8Array) {
    const c = live.current; if (!c?.writer || !c.ready) return;
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
    if(!live.current?.ready)return false;
    const multiline=/[\r\n]/.test(text)&&!terminal.current?.modes.bracketedPasteMode;
    const large=new TextEncoder().encode(text).length>16*1024;
    return !(multiline||large)||window.confirm(multiline
      ? 'This terminal is not using bracketed paste. Newlines can execute commands immediately. Paste these lines?'
      : 'Paste more than 16 KiB into this terminal? The foreground program controls how pasted text is handled.');
  }
  /** Attaches pasted or chosen images to this card's tray, only in Terminal mode on a visible card; nothing is uploaded otherwise. */
  function attachImages(files: File[]) {
    const c = live.current;
    if (!enabled.current || !c?.ready || !root.current?.getClientRects().length) { setNotice('Switch this terminal to Terminal mode to attach images. Nothing was uploaded.'); return; }
    if (!imagesSupported || !workspace) { setNotice('Image insertion is verified only for registered Claude Code and Codex terminals. Nothing was uploaded.'); return; }
    const problems = imagesRef.current.add(files);
    setNotice(problems.length ? `${problems.join(' ')}` : 'Image attached below. Choose Insert to add its reference to the prompt; nothing is inserted or submitted automatically.');
  }
  /** Why Insert is unavailable now, or empty. The server repeats every check before writing. */
  const insertBlocked = !writer ? 'Switch to Terminal to insert an image.' : cliChanged ? 'The registered CLI in this pane was replaced. Inspect the pane; images are not inserted.'
    : navigated ? 'This terminal shows another pane or session. Return to the original pane to insert.' : busy ? 'Wait for the current input decision.' : '';
  /** One explicit insertion, frozen to this connection, generation and sequence, queued behind nothing: typed input must finish first. */
  function insertImage(item: ImageItem) {
    const c = live.current;
    if (insertBlocked || !c?.ready || !c.writer || !item.receipt || !root.current?.getClientRects().length) { setNotice(insertBlocked || 'Switch to Terminal to insert an image.'); return; }
    if (c.queue.length || c.sending) { setNotice('Wait for typed input to finish sending, then insert the image.'); return; }
    clearModifiers(); imagesRef.current.setStatus(item.key, 'inserting');
    c.queue.push({ image: { key: item.key, attachmentId: item.receipt.id }, start: true }); void drain();
    terminal.current?.focus();
  }
  async function pasteText() {
    const c=live.current;if(!c||pasting||!enabled.current)return;
    if(!c.ready){setNotice('Switch to Terminal to paste into this pane.');return;}
    const generation=c.generation,seq=c.seq,revision=transientRevision.current,focused=document.activeElement;
    setPasting(true);
    try {
      if(!navigator.clipboard?.readText)throw Error('Clipboard text is unavailable. Use the keyboard or system Paste action in the terminal.');
      const text=await navigator.clipboard.readText();
      if(live.current!==c||!c.ready||c.generation!==generation||c.seq!==seq||revision!==transientRevision.current||document.activeElement!==focused||!root.current?.getClientRects().length){
        setNotice('Clipboard text was not pasted because input, focus or the terminal mode changed. Paste again at the intended prompt.');return;
      }
      if(allowPaste(text)){clearModifiers();terminal.current?.paste(text);terminal.current?.focus();}
    } catch {setNotice('Clipboard text could not be read. Use the keyboard or system Paste action in the terminal.');}
    finally {setPasting(false);}
  }
  /** Starts a fresh observer connection. Nothing is replayed; a writer on the old connection ends with it. */
  function reset(reason: string, enter: boolean) {
    enterAfterReset.current = enter; busyRef.current = false; setBusy(false); setNotice(reason); setEpoch(x => x + 1);
  }
  /** The Terminal side of the toggle: one deliberate request for input on this connection. A failed or closed connection is replaced
   * first, and typing starts once the replacement is connected. Output, focus and clicks never start input. */
  async function enterTerminal(origin: Element | null = document.activeElement) {
    if (!enabled.current || busyRef.current) return;
    const c = live.current;
    if (connecting.current && !c?.failed) { focusOrigin.current = origin; enterAfterReset.current = true; setNotice('Connecting, then starting input…'); return; }
    if (!c || c.failed || !connectedRef.current || c.ws.readyState !== WebSocket.OPEN) { focusOrigin.current = origin; reset('Resetting the terminal connection, then starting input…', true); return; }
    if (c.ready) { terminal.current?.focus(); return; }
    // Focus moves into the terminal only if the user has not gone elsewhere since choosing Terminal.
    try {
      const result = await acquire();
      const term = terminal.current;
      if (live.current !== c || !term || !result.writer || !c.writer || result.generation !== c.generation) throw Error('The terminal changed before input was ready.');
      // Output already received for the writer generation is parsed first, so input never uses an old observer's modes.
      await new Promise<void>(resolve => term.write('', resolve));
      if (live.current !== c || !c.writer) throw Error('Input stopped before it was ready.');
      c.ready = true; term.options.disableStdin = false; setWriter(true); setCapture(false);
      setNotice(autoInput ? result.reason : 'Terminal mode: typing goes to this pane. Automation is held until manual input is stopped and reconciled.');
      if (document.activeElement === origin || document.activeElement === document.body) term.focus();
      void refreshRef.current();
    } catch (error) {
      if (live.current === c) { c.failed = true; setNotice(`${error instanceof Error ? error.message : 'Input could not start.'} ${autoInput ? 'Reconnect to continue typing.' : 'Toggle Terminal again to reset the connection and retry.'}`); }
    }
  }
  /** The Display side: ends this connection's input and keeps watching. Anything that fails resets to a fresh observer. */
  async function enterDisplay() {
    const c = live.current;
    if (!c?.writer) { if (!c || c.failed || !connectedRef.current) reset('Resetting the terminal connection…', false); return; }
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); clearModifiers();
    // No new keys are admitted while stopping; input already queued finishes first.
    c.ready = false; setWriter(false); if (terminal.current) terminal.current.options.disableStdin = true;
    try {
      await drain();
      if (live.current !== c || !c.writer) throw Error('The terminal changed while stopping input.');
      const result = await api<KeyboardResult>(token, `terminals/${c.id}/keyboard`, {body:{requestId:crypto.randomUUID(),action:'release',expectedGeneration:c.generation,expectedBootId:c.bootId}});
      if (live.current === c) setNotice(`Display mode. ${result.reason}`);
    } catch (error) { if (live.current === c) reset(`${error instanceof Error ? error.message : 'Input could not be stopped cleanly.'} Reconnecting as an observer; inspect the terminal.`, false); }
    finally { if (live.current === c) { busyRef.current = false; setBusy(false); } void refreshRef.current(); }
  }
  useEffect(() => {
    if (!epoch) return;
    setConnected(false); setWriter(false); setNative(false); setActive(''); connectedRef.current = false; connecting.current = true;
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
      const connection = {id,bootId:opened.bootId,paneId:opened.paneId,sessionId:opened.sessionId,generation:'',writer:false,ready:false,failed:false,seq:0,queue:[] as Queued[],bytes:0,sending:false,draining:null as Promise<void> | null,ws}; live.current = connection;
      ws.onopen = () => ws!.send(JSON.stringify({ticket:opened.ticket}));
      ws.onmessage = event => {
        if (disposed || live.current !== connection) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 24000) throw Error('Invalid frame.');
          const f = JSON.parse(event.data) as TerminalFrame;
          if (f.type === 'reset') {
            if (f.bootId !== opened.bootId) throw Error('Host boot changed.');
            const first = !connectedRef.current; connecting.current = false;
            generation = f.generation; connection.generation = generation; connection.writer = connection.ready = false; connection.seq = 0; connection.queue = []; connection.bytes = 0; connection.sending = false; connection.draining = null;
            sequence = processedBytes = 0; clearModifiers(); term!.reset(); term!.options.disableStdin = true; setWriter(false); setConnected(true); setNative(f.native); setNotice(autoInput ? 'Connecting terminal input…' : f.reason || 'Display mode: view only. Use the Terminal toggle to type.');
            frames.current++; connectedRef.current = true;
            if (generationSeen.current?.generation === f.generation && !generationSeen.current.writer) generationSeen.current.resolve();
            scheduleSize();
            // The toggle chose Terminal on a failed connection: start input once this replacement is connected. An autoInput terminal
            // always does, without taking focus from wherever the user is.
            if (first && (enterAfterReset.current || autoInput)) { const origin = enterAfterReset.current ? focusOrigin.current : null; enterAfterReset.current = false; void enterTerminal(origin); }
          } else if (f.type === 'out') {
            if (f.generation !== generation) return;
            const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
            if (bytes.length !== f.bytes || bytes.length > 16384 || f.sequence !== sequence+1) throw Error('Output sequence changed.');
            sequence = f.sequence; processedBytes += bytes.length; const total = processedBytes;
            term!.write(bytes, () => { if (!disposed && generation === f.generation && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'processed',generation,sequence:f.sequence,processedBytes:total})); });
          } else if (f.type === 'keyboard') {
            if(f.generation !== generation) return;
            clearModifiers(); frames.current++; connection.writer = f.writer; term!.options.disableStdin = !(f.writer && connection.ready);
            if (!f.writer) { connection.ready = false; setWriter(false); }
            if (generationSeen.current?.generation === f.generation && generationSeen.current.writer === f.writer) generationSeen.current.resolve();
            setNotice(f.reason);
            void refreshRef.current();
          } else if (f.type === 'active') { setNavigated(f.sessionId !== opened.sessionId || f.paneId !== opened.paneId); setActive(`${f.label} · ${f.paneId} · ${f.command}${f.size ? ` · ${f.size.replace('x', '×')} window` : ''}${f.sessionId !== opened.sessionId ? ' · navigated to another tmux session; the control target is unchanged' : ''}`); }
          else if(f.type==='closed') {setNotice(`${f.reason} ${autoInput ? 'Reconnect to continue typing.' : 'Toggle Terminal to reconnect.'}`); ws!.close();}
          else if(f.type!=='hb') throw Error('Unsupported frame.');
        } catch { loseInput('Terminal protocol changed.', connection, generation); }
      };
      ws.onclose = () => { if(disposed) return; connecting.current = false; clearModifiers(); connection.writer=connection.ready=false; connection.failed=true; unsentImages(connection.queue); connection.queue=[]; connection.bytes=0; if(term) term.options.disableStdin=true; setConnected(false); setWriter(false);
        connectedRef.current = false; void refreshRef.current(); };
      ws.onerror = () => { if(!disposed) setNotice(autoInput ? 'Terminal disconnected. Reconnect to continue typing.' : 'Terminal disconnected. Inspect manual input, then toggle Terminal to reconnect.'); };
      heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN && generation) ws.send(JSON.stringify({type:'heartbeat',generation})); }, 10000);
    })().catch(error => { if (!disposed) { connecting.current = enterAfterReset.current = false; setNotice(error instanceof Error ? error.message : 'Terminal unavailable.'); } });
    return () => { disposed = true; connectedRef.current = false; clearInterval(heartbeat); clearTimeout(resizeTimer); refit.current=null; resize?.disconnect(); if(fitViewport){window.visualViewport?.removeEventListener('resize',fitViewport);window.removeEventListener('orientationchange',fitViewport);} close(); term?.dispose(); terminal.current = null; live.current = null; };
    // Workspace terminals reconnect in Display mode. Independent app terminals also start their own input above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token,targetKey,clientInstanceId,epoch]);
  async function acquire(): Promise<KeyboardResult> {
    const c = live.current;
    if (!c?.generation || !connectedRef.current) throw Error(`Open ${label} first; input needs a connected terminal. Nothing was requested.`);
    if (busyRef.current) throw Error('Another input decision for this terminal is still in progress.');
    busyRef.current = true; setBusy(true); clearModifiers();
    setNotice('Starting input…');
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
    } finally {busyRef.current = false; setBusy(false);void refreshRef.current();}
  }
  useImperativeHandle(ref, () => ({
  matches: (writer) => { const c=live.current; return !!c?.ready && c.writer && c.id===writer.connectionId && c.generation===writer.generation; },
  abandon: (reason) => loseInput(reason),
  stopped: (frozen) => { if (live.current === frozen.connection) { busyRef.current = false; setBusy(false); } },
  freeze: (allowPending = false) => {
    const c = live.current; if (!c?.writer) return null;
    if (!c.ready || (!allowPending && (c.sending || c.queue.length || pasting))) throw Error(`Input is still being sent in ${label}. Wait for it to finish, then choose again. Nothing was requested.`);
    if (allowPending) { unsentImages(c.queue); c.queue = []; c.bytes = 0; }
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
  const softKey = (key: KeyboardEventInit) => { clearModifiers(); terminal.current?.textarea?.dispatchEvent(new KeyboardEvent('keydown', key)); terminal.current?.textarea?.dispatchEvent(new KeyboardEvent('keyup', key)); terminal.current?.focus(); };
  return <section ref={root} className={`native-terminal${expanded?' expanded':''}`} data-expanded={expanded} aria-label={`${label} terminal`} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))clearTransient();}}
    onPasteCapture={event=>{
      if(!mount.current?.contains(event.target as Node))return;
      // Image files take a separate upload path; the same paste never also types text. Display mode uploads nothing and asks nothing.
      if(!live.current?.ready&&clipboardImages(event.clipboardData).images.length){event.preventDefault();event.stopPropagation();setNotice('Switch this terminal to Terminal mode to attach images. Nothing was uploaded.');return;}
      if(pasteImages(event,attachImages))return;
      const text=event.clipboardData.getData('text/plain');
      if(!allowPaste(text)){event.preventDefault();event.stopPropagation();}else clearModifiers();
    }}>
    {/* The mode toggle already shows typing or viewing; the status badge appears only for states the toggle cannot show. */}
    <div className="terminal-tools">{!autoInput && (!inputEnabled || (badge !== 'Typing enabled' && badge !== 'Observing')) && <StatusIcon icon={BADGES[badge][0]} label={badge} help={BADGES[badge][1]} />}
      {inputEnabled && !autoInput && <IconButton icon={writer ? '⌨️' : '👁️'} label="Terminal mode" className="mode-toggle" aria-pressed={writer} aria-busy={busy} disabled={busy}
        help={writer ? 'Terminal: typing goes to this pane. Press to switch to Display (view only); input already sent stays, and automation waits until manual input is reconciled.'
          : 'Display: view only. Press to switch to Terminal and type here. If the connection failed, this reconnects first.'}
        onClick={event=>{if(!event.isTrusted)return;void (writer ? enterDisplay() : enterTerminal());}} />}
      {connected && writer && <IconButton icon="📋" label="Paste text" help="Paste clipboard text into this pane, subject to the paste checks." disabled={capture||!native} aria-disabled={pasting} aria-busy={pasting} onClick={event=>{if(event.isTrusted)void pasteText();}} />}
      {connected && writer && imagesSupported && <AttachImageButton label="Attach image" icon="🖼️" help="Choose PNG or JPEG images for this pane. They upload to this host; Insert adds one reference to the prompt, never Enter." disabled={capture||!native}
        onOpen={() => { const c = live.current; if (!c?.ready) return false; pickerIntent.current = { connection: c, generation: c.generation, view: viewEpochRef.current, target: targetMemory }; return true; }}
        onFiles={files => { const intent = pickerIntent.current; pickerIntent.current = null; const c = live.current;
          if (!intent || intent.connection !== c || !c?.ready || c.generation !== intent.generation || intent.view !== viewEpochRef.current || intent.target !== targetMemory) { setNotice('The terminal changed while choosing images. Nothing was attached.'); return; }
          attachImages(files); }} />}
      {(!connected || (autoInput && !writer)) && <IconButton icon={epoch ? '🔄' : '▶️'} label={epoch ? 'Reconnect' : 'Open terminal'} disabled={autoInput && busy}
        help={autoInput ? 'Reconnect to continue typing. Input already sent is never replayed.' : 'Watch this pane live. This does not start typing.'}
        onClick={() => reset(autoInput ? 'Reconnecting terminal input…' : 'Reconnecting as observer…', false)} />}
      <IconButton icon={capture ? '🖥️' : '📄'} label={capture ? 'Show terminal' : 'Captured text'} help="A readable, selectable snapshot with its timestamp, not the live terminal." aria-pressed={capture} onClick={()=>setCapture(x=>!x)} />
      <IconButton icon={expanded ? '⤡' : '⤢'} label={expanded ? 'Collapse terminal' : 'Expand terminal'} help="Enlarge within the page. It does not reconnect or change the terminal mode." aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} />
      <IconButton icon="♿" label="Screen reader mode" help="Expose terminal output to assistive technology. Turn it off if a software keyboard cannot type; Captured text is the alternative." aria-pressed={screenReader} onClick={()=>{setScreenReader(!screenReader);if(terminal.current)terminal.current.options.screenReaderMode=!screenReader;}} />
      <HelpTip label="Terminal tools help" help={autoInput ? 'Typing starts when Helper connects. Keys and paste go to Helper independently of workspace terminals. Reconnect restores input without replaying it.' : <>{TOOL_HELP.map(([icon, name, text]) => <span key={name} className="legend-line">{icon} <strong>{name}</strong>: {text}</span>)}</>} /></div>
    {screenReader && <p className="fine">If your keyboard cannot enter text in this mode, turn it off. Captured text is also available for reading.</p>}
    <AttachmentTray label={`Images for ${label}`} tray={images} onMessage={setNotice} insert={{ onInsert: insertImage, blocked: insertBlocked }} />
    {images.items.length > 0 && <p className="fine">{IMAGE_LIMIT_NOTE} Images stay on this host; a submitted prompt may send them to the CLI’s provider.</p>}
    <p className="fine" role="status">{notice}{active && ` · ${active}`}{focused && ' · Ctrl+Shift+Esc: leave terminal focus'}</p>
    <div ref={mount} className="xterm-mount" hidden={capture || !native} aria-label={`${label} native output`} onFocus={() => setFocused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); leaving.current = false; } }} />
    {(capture || !native) && <><p className="fine">{capturedAt ? `Snapshot captured at ${new Date(capturedAt).toLocaleTimeString()}` : 'Snapshot only'}{connected && !native && ' · native observation unavailable'}{writer && !native ? autoInput ? ' · Waiting for the terminal screen' : ' · Terminal mode: this pane has no native screen here, switch to Display' : ''}</p>{fallback}</>}
    {connected && writer && <div className="terminal-keys" aria-label="Terminal keys">{(['ctrl','alt'] as const).map(key=><button type="button" key={key} aria-label={`${key==='ctrl'?'Ctrl':'Alt'} next key`} aria-pressed={modifierState[key]} onClick={()=>{modifiers.current={...modifiers.current,[key]:!modifiers.current[key]};setModifierState(modifiers.current);terminal.current?.focus();}}>{key==='ctrl'?'Ctrl':'Alt'}</button>)}{[['Esc','Escape',27],['Tab','Tab',9],['↑','ArrowUp',38],['↓','ArrowDown',40],['←','ArrowLeft',37],['→','ArrowRight',39],['Ctrl-C','c',67],['Enter','Enter',13]].map(([name,key,keyCode])=><button type="button" key={name} onClick={event=>{if(!event.isTrusted)return;softKey({key:String(key),keyCode:Number(keyCode),ctrlKey:name==='Ctrl-C'||modifiers.current.ctrl,altKey:modifiers.current.alt,bubbles:true,cancelable:true});}}>{name}</button>)}</div>}
  </section>;
}
