/** Browser input-origin spike against the installed xterm; no mock DOM or private xterm API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { transpileModule, ModuleKind } from 'typescript';

test('direct entry preserves trusted first key, text, IME and paste without admitting terminal replies', async t => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<textarea aria-label="Terminal input"></textarea><div id="terminal"></div>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`http://127.0.0.1:${port}`);
  await page.addStyleTag({ path: new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url).pathname });
  await page.addScriptTag({ path: new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url).pathname });
  const source = await readFile(new URL('../src/client/terminal-entry.ts', import.meta.url), 'utf8');
  const js = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } }).outputText.replace('export function terminalEntry', 'function terminalEntry');
  await page.addScriptTag({ content: js + `
    window.intents=[];window.bytes=[];window.writer=false;
    window.term=new Terminal({allowProposedApi:false,disableStdin:false});term.open(document.querySelector('#terminal'));
    term.onData(data=>{if(writer)bytes.push(data)});
    window.entry=terminalEntry(document.querySelector('textarea'),i=>intents.push(i),()=>true);
    window.output=text=>new Promise(resolve=>term.write(text,resolve));
    window.admit=async()=>{term.reset();await output('\\x1b[?1h\\x1b[?2004h');writer=true;
      for(const i of intents.splice(0)){
        if(i.kind==='key'){term.textarea.dispatchEvent(new KeyboardEvent('keydown',i.key));term.textarea.dispatchEvent(new KeyboardEvent('keyup',i.key));}
        else if(i.kind==='paste')term.paste(i.text);else term.input(i.text,true);
      }
    };
  ` });
  const input = page.locator('body > textarea');
  await input.focus();
  await page.evaluate(async () => { const w = window as any; await w.output('\x1b[5n\x1b[c\x1b[?1004h'); w.term.focus(); });
  assert.deepEqual(await page.evaluate(() => (window as any).intents), []);
  await input.focus(); await input.press('ArrowUp'); await input.press('Control+c');
  await page.keyboard.insertText('é次🙂');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await page.evaluate(async () => { await (window as any).output('\x1b[6n'); });
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await input.press('Tab');
  await page.waitForFunction(() => (window as any).intents.some((i: any) => i.text === '日本'));
  await input.focus();
  await page.evaluate(() => navigator.clipboard.writeText('line1\nline2'));
  await input.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await page.waitForFunction(() => (window as any).intents.some((i: any) => i.kind === 'paste'));
  const intents = await page.evaluate(() => (window as any).intents);
  assert.deepEqual(intents.map((i: any) => i.kind), ['key', 'key', 'text', 'text', 'paste']);
  assert.deepEqual(intents.slice(2), [{ kind: 'text', text: 'é次🙂' }, { kind: 'text', text: '日本' }, { kind: 'paste', text: 'line1\nline2' }]);
  await page.evaluate(async () => { await (window as any).admit(); });
  assert.deepEqual(await page.evaluate(() => (window as any).bytes), ['\x1bOA', '\x03', 'é次🙂', '日本', '\x1b[200~line1\rline2\x1b[201~']);
  // Programmatically dispatched DOM events and output cannot manufacture a human admission.
  await page.evaluate(() => {
    const el = document.querySelector('textarea')!; el.value = 'untrusted';
    el.dispatchEvent(new InputEvent('input', { data: 'untrusted', inputType: 'insertText' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    (window as any).entry.cancel();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).intents), []);
});
