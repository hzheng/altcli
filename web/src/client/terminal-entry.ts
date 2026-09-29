/** Human input before a native writer exists. A real textarea owns composition; terminal
 * output never enters this surface or authorizes a grant through xterm's mixed onData. */
export type TerminalIntent = { kind: 'text' | 'paste'; text: string; approved?: boolean } | { kind: 'key'; key: KeyboardEventInit }
  | { kind: 'mouse'; type: string; event: WheelEventInit; width: number; height: number };

export function terminalEntry(element: HTMLTextAreaElement, emit: (intent: TerminalIntent) => void, allowed: () => boolean) {
  let composing = false, cancelledComposition = false, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const settle = (error?: Error) => { for (const w of waiters.splice(0)) if (error) w.reject(error); else w.resolve(); };
  const takeText = () => {
    if (disposed || composing) return;
    const text = element.value; element.value = '';
    if (text && !cancelledComposition && allowed()) emit({ kind: 'text', text });
    cancelledComposition = false; settle();
  };
  const start = (event: CompositionEvent) => { if (event.isTrusted) { composing = true; cancelledComposition = false; } };
  const end = () => {
    // The intent is the trusted compositionstart/input sequence. Some browser IME
    // integrations mark the final notification untrusted; it cannot start a sequence.
    if (!composing) return;
    composing = false;
    // Read the actual textarea after composition updates, never compositionend.data or
    // an arbitrary future onData. A following composition keeps the text in the textarea.
    clearTimeout(timer); timer = setTimeout(() => { timer = undefined; takeText(); }, 0);
  };
  const input = (event: Event) => {
    if (event.isTrusted && !(event as InputEvent).isComposing) takeText();
  };
  const paste = (event: ClipboardEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    if (allowed()) emit({ kind: 'paste', text: event.clipboardData?.getData('text/plain') ?? '' });
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || composing || event.keyCode === 229) return;
    if (event.ctrlKey && event.shiftKey && event.key === 'Escape') return;
    if (event.metaKey || ['Dead', 'Process', 'Unidentified', 'AltGraph', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    if (event.ctrlKey && ['c', 'x', 'v'].includes(event.key.toLowerCase()) && (event.key.toLowerCase() === 'v' || element.selectionStart !== element.selectionEnd)) return;
    const special = /^(Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/.test(event.key);
    // Option/dead-key text is emitted by the browser's input/composition path.
    if (!special && !event.ctrlKey) return;
    event.preventDefault();
    takeText();
    if (allowed()) emit({ kind: 'key', key: { key: event.key, code: event.code, keyCode: event.keyCode,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat, bubbles: true, cancelable: true } });
  };
  element.addEventListener('compositionstart', start);
  element.addEventListener('compositionend', end);
  element.addEventListener('input', input);
  element.addEventListener('paste', paste);
  element.addEventListener('keydown', key);
  return {
    get composing() { return composing; },
    settled() { return composing || timer ? new Promise<void>((resolve, reject) => waiters.push({ resolve, reject })) : Promise.resolve(); },
    cancel() { clearTimeout(timer); timer = undefined; element.value = ''; cancelledComposition = composing; settle(Error('Input composition was cancelled.')); },
    dispose() {
      disposed = true; clearTimeout(timer); element.value = ''; settle(Error('Input entry closed.'));
      element.removeEventListener('compositionstart', start); element.removeEventListener('compositionend', end);
      element.removeEventListener('input', input); element.removeEventListener('paste', paste); element.removeEventListener('keydown', key);
    },
  };
}
