'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TerminalConnection, TerminalFrame, TerminalTarget, KeyboardResult } from '../contracts/terminals';
import { api } from '../client/api';

/** Native bytes stay in this component. No replay, persistence, automatic grant or URL credentials. */
export function NativeTerminal({ token, target, clientInstanceId, label, fallback, capturedAt, held, holder, cliChanged = false, affected = [], inputEnabled, refresh, viewEpoch = 0 }: {
  token: string; target: TerminalTarget; clientInstanceId: string; label: string; fallback: ReactNode;
  capturedAt?: string; held: boolean; affected?: string[]; inputEnabled: boolean; refresh: () => Promise<void>; viewEpoch?: number;
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
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [epoch, setEpoch] = useState(0);
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
  function focusControl() {
    clearModifiers();
    const control=document.querySelector<HTMLElement>('.control-pane');
    if(control?.getClientRects().length){control.tabIndex=-1;control.focus();}
    else mount.current?.closest('section')?.querySelector<HTMLButtonElement>('button')?.focus();
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
    setConnected(false); setWriter(false); setNative(false); setActive(''); setConfirm(false);
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
      term.attachCustomKeyEventHandler(e => { if(e.type==='keydown' && e.ctrlKey && e.shiftKey && e.key==='Escape') { focusControl(); return false; } return true; });
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
            sequence = processedBytes = 0; clearModifiers(); term!.reset(); term!.options.disableStdin = true; setWriter(false); setConnected(true); setNative(f.native); setNotice(f.reason || 'Observing. Take keyboard to type.');
            scheduleSize();
          } else if (f.type === 'out') {
            if (f.generation !== generation) return;
            const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
            if (bytes.length !== f.bytes || bytes.length > 16384 || f.sequence !== sequence+1) throw Error('Output sequence changed.');
            sequence = f.sequence; processedBytes += bytes.length; const total = processedBytes;
            term!.write(bytes, () => { if (!disposed && generation === f.generation && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'processed',generation,sequence:f.sequence,processedBytes:total})); });
          } else if (f.type === 'keyboard') {
            if(f.generation !== generation) return;
            clearModifiers(); connection.writer = f.writer; term!.options.disableStdin = !f.writer; setWriter(f.writer);
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
      ws.onclose = () => { if(disposed) return; clearModifiers(); connection.writer=false; connection.queue=[]; connection.bytes=0; if(term) term.options.disableStdin=true; setConnected(false); setWriter(false); void refreshRef.current(); };
      ws.onerror = () => { if(!disposed) setNotice('Terminal disconnected. Inspect manual input before reconnecting.'); };
      heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN && generation) ws.send(JSON.stringify({type:'heartbeat',generation})); }, 10000);
    })().catch(error => { if (!disposed) setNotice(error instanceof Error ? error.message : 'Terminal unavailable.'); });
    return () => { disposed = true; clearInterval(heartbeat); clearTimeout(resizeTimer); refit.current=null; resize?.disconnect(); if(fitViewport){window.visualViewport?.removeEventListener('resize',fitViewport);window.removeEventListener('orientationchange',fitViewport);} close(); term?.dispose(); terminal.current = null; live.current = null; };
    // Only exact identity / explicit reconnect creates an observation connection. Never requests keyboard authority.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token,targetKey,clientInstanceId,epoch]);
  async function keyboard(action: 'acquire'|'release'|'releaseSettled') {
    const c = live.current; if(!c || busy) return; setBusy(true); setConfirm(false); clearModifiers();
    // The grant's keyboard frame decides focus, whichever of it and this response arrives first.
    pendingGrant.current = action === 'acquire' ? { focused: document.activeElement } : null;
    // Stop accepting browser keystrokes immediately; queued input is never migrated to another grant.
    if(action!=='acquire'){ c.writer=false; c.queue=[]; c.bytes=0; setWriter(false); if(terminal.current) terminal.current.options.disableStdin=true; }
    try {
      const result = await api<KeyboardResult>(token, `terminals/${c.id}/keyboard`, {body:{requestId:crypto.randomUUID(),action,expectedGeneration:c.generation,transfer:held,confirmReady:true}});
      if (live.current === c && !result.writer) setNotice(result.reason);
    } catch(error) {pendingGrant.current = null; setNotice(error instanceof Error ? error.message : 'Keyboard decision uncertain. Inspect server state.');}
    finally {setBusy(false);void refreshRef.current();}
  }
  return <section className={`native-terminal${expanded?' expanded':''}`} data-expanded={expanded} aria-label={`${label} terminal`} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget))clearTransient();}}
    onPasteCapture={event=>{
      if(!mount.current?.contains(event.target as Node))return;
      const text=event.clipboardData.getData('text/plain');
      if(!allowPaste(text)){event.preventDefault();event.stopPropagation();}else clearModifiers();
    }}>
    <div className="terminal-tools"><strong>{writer ? 'Keyboard here' : !connected ? 'Disconnected' : holder === 'other-browser' ? 'Controlled in another browser'
      : holder === 'this-browser' ? 'Keyboard in another terminal' : cliChanged ? 'Manual CLI/shell'
      : held ? (holder === 'unresolved' ? 'Observing · manual input unresolved' : 'Observing · manual input held') : 'Observing'}</strong>
      <button type="button" disabled={!connected || busy || !inputEnabled} onClick={() => writer ? void keyboard('release') : setConfirm(true)}>{writer ? 'Release keyboard' : held ? 'Transfer / recover keyboard…' : 'Take keyboard…'}</button>
      {writer && <button type="button" onClick={() => setConfirm(true)}>Release and record settled…</button>}
      {writer && <button type="button" disabled={capture||!native} aria-disabled={pasting} aria-busy={pasting} onClick={()=>void pasteText()}>Paste text</button>}
      {!connected && <button type="button" onClick={() => {setNotice('Reconnecting as observer…');setEpoch(x=>x+1);}}>{epoch ? 'Reconnect' : 'Open terminal'}</button>}
      <button type="button" aria-pressed={capture} onClick={()=>setCapture(x=>!x)}>{capture ? 'Show terminal' : 'Captured text'}</button>
      <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Collapse terminal':'Expand terminal'}</button>
      <button type="button" aria-pressed={screenReader} onClick={()=>{setScreenReader(!screenReader);if(terminal.current)terminal.current.options.screenReaderMode=!screenReader;}}>Screen reader mode</button>
      {'agentId' in target && <button type="button" className="quiet" onClick={focusControl}>Focus AltCLI control</button>}</div>
    {screenReader && <p className="fine">If your keyboard cannot enter text in this mode, turn it off. Captured text is also available for reading.</p>}
    {confirm && <div className="notice"><p>{writer ? 'Confirm every pane is settled, with empty prompts and no background writers. Each held run still needs checkpoint review.' : 'Take the one keyboard for this tmux server. AltCLI dispatch, setup and launch are held until manual input is reconciled. Terminal input can run commands and tmux shortcuts on this host.'}</p>{!writer && affected.length > 0 && <ul aria-label="Affected runs">{affected.map(run=><li key={run}>{run}</li>)}</ul>}
      <button type="button" disabled={busy} onClick={()=>void keyboard(writer?'releaseSettled':'acquire')}>Confirm {writer?'settled release':'keyboard'}</button><button type="button" onClick={()=>setConfirm(false)}>Cancel</button></div>}
    <p className="fine" role="status">{notice}{active && ` · ${active}`}{writer && ' · Ctrl+Shift+Escape: AltCLI control'}</p>
    <div ref={mount} className="xterm-mount" hidden={capture || !native} aria-label={`${label} native output`} />
    {(capture || !native) && <><p className="fine">{capturedAt ? `Snapshot captured at ${new Date(capturedAt).toLocaleTimeString()}` : 'Snapshot only'}{connected && !native && ' · native observation unavailable'}</p>{fallback}</>}
    {writer && <div className="terminal-keys" aria-label="Terminal keys">{(['ctrl','alt'] as const).map(key=><button type="button" key={key} aria-label={`${key==='ctrl'?'Ctrl':'Alt'} next key`} aria-pressed={modifierState[key]} onClick={()=>{modifiers.current={...modifiers.current,[key]:!modifiers.current[key]};setModifierState(modifiers.current);terminal.current?.focus();}}>{key==='ctrl'?'Ctrl':'Alt'}</button>)}{[['Esc','\x1b'],['Tab','\t'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C'],['Ctrl-C','\x03'],['Enter','\r']].map(([name,key])=><button type="button" key={name} onClick={()=>{textInput(key!);terminal.current?.focus();}}>{name}</button>)}</div>}
  </section>;
}
