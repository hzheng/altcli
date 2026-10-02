/** Opt-in real transport check. Private tmux server and a harmless prompt fixture only; no installed CLI or user session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, TmuxAdapter } from '../src/server/adapters/tmux.ts';
import type { SessionRegistration } from '../src/contracts/api.ts';

/** A stand-in for a CLI input area in Claude Code's layout (rules around a ❯ row, a footer below) or Codex's (a › row with a dim
 * placeholder when empty, then one blank row and a two-row footer). It records every raw byte, keeps an editable multi-line draft
 * with a cursor (Ctrl-A start, Ctrl-E end, Ctrl-U clear, Backspace), keeps newlines received inside a bracketed paste, writes the
 * exact draft to a file after every change, and records each draft submitted with Enter. */
const FIXTURE = String.raw`import{appendFileSync,writeFileSync}from'node:fs';const[layout,bytes,submitted,draftFile]=process.argv.slice(2);
let text=[],cursor=0,paste=false;const rule='─'.repeat(60);
const draw=()=>{const lines=text.join('').split('\n'),rows=['⏺ fixture transcript',''];let top;
  if(layout==='claude'){rows.push(rule);top=rows.length;lines.forEach((l,i)=>rows.push((i?'  ':'❯ ')+l));rows.push(rule,'  ⏵⏵ fixture footer');}
  else{top=rows.length;lines.forEach((l,i)=>rows.push((i?'  ':'› ')+l+(text.length?'':'\x1b[2mAsk the fixture anything\x1b[0m')));rows.push('','  fixture model · ~/fixture','  ? for shortcuts');}
  const before=text.slice(0,cursor).join('').split('\n');
  process.stdout.write('\x1b[2J\x1b[H'+rows.join('\r\n')+'\x1b['+(top+before.length)+';'+(3+before.at(-1).length)+'H');
  writeFileSync(draftFile,JSON.stringify(text.join('')));};
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?2004h');draw();
process.stdin.on('data',b=>{appendFileSync(bytes,b);let s=b.toString('utf8');
  while(s){if(s.startsWith('\x1b[200~')){paste=true;s=s.slice(6);continue;}if(s.startsWith('\x1b[201~')){paste=false;s=s.slice(6);continue;}
    const c=Array.from(s)[0];s=s.slice(c.length);
    if(c==='\r'&&!paste){appendFileSync(submitted,JSON.stringify(text.join(''))+'\n');text=[];cursor=0;}
    else if(c==='\r'){text.splice(cursor,0,'\n');cursor++;}
    else if(c==='\x01')cursor=0;
    else if(c==='\x05')cursor=text.length;
    else if(c==='\x15'){text=[];cursor=0;}
    else if(c==='\x7f'||c==='\b'){if(cursor>0){text.splice(cursor-1,1);cursor--;}}
    else if(c>=' '){text.splice(cursor,0,c);cursor++;}}
  draw();});
`;
/** Starts the fixture on a private tmux server. tmux names the foreground process after its executable and generic interpreters are
 * refused, so Node runs under a CLI-like name. */
async function fixture(directory: string, layout: 'claude' | 'codex') {
  const run = createRunner('tmux', join(directory, 'tmux.sock'));
  const script = join(directory, 'prompt.mjs'), cli = join(directory, 'prompt-cli'), files = ['bytes', 'submitted', 'draft'].map((name) => join(directory, name));
  await writeFile(script, FIXTURE); await copyFile(process.execPath, cli, constants.COPYFILE_FICLONE); await chmod(cli, 0o755);
  await run(['-f', '/dev/null', 'new-session', '-d', '-x', '400', '-y', '30', '-s', 'prompt-fixture', '-c', directory, cli, script, layout, ...files]);
  const adapter = new TmuxAdapter(run);
  let pane = await adapter.inspect('%0');
  for (let i = 0; pane.command !== 'prompt-cli' && i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); pane = await adapter.inspect('%0'); }
  assert.equal(pane.command, 'prompt-cli');
  const session: SessionRegistration = { id: 'prompt', label: 'Prompt fixture', agentType: 'other', expectedCommand: 'prompt-cli', repository: directory, relayPrompt: '', registeredAt: new Date().toISOString(), identity: pane.identity };
  const read = (file: string) => readFile(file).catch(() => Buffer.alloc(0));
  const draft = async () => { const value = (await read(files[2]!)).toString('utf8'); return value ? JSON.parse(value) as string : null; };
  const submitted = async () => (await read(files[1]!)).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string);
  const wait = async (check: () => Promise<boolean>) => { for (let i = 0; !await check() && i < 100; i++) await new Promise((r) => setTimeout(r, 20)); };
  // Like a real CLI, the fixture is ready once it draws its input area; typed earlier, keys would reach the terminal's own echo.
  await wait(async () => await draft() === ''); assert.equal(await draft(), '');
  /** Leaves `value` in the draft as a person would: typed, or pasted when it has several lines. */
  const setDraft = async (value: string) => {
    await run(['send-keys', '-t', '%0', 'C-u']);
    if (value.includes('\n')) { await run(['load-buffer', '-b', 'draft', '-'], value); await run(['paste-buffer', '-p', '-d', '-b', 'draft', '-t', '%0']); }
    else if (value) await run(['send-keys', '-t', '%0', '-l', value]);
    await wait(async () => await draft() === value); assert.equal(await draft(), value);
  };
  return { run, adapter, session, draft, setDraft, submitted, wait, bytes: () => read(files[0]!) };
}

test('private tmux transmits literal UTF-8, multiline paste and key-only Enter/Escape exactly', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-terminal-')));
  const { run, adapter, session, wait, bytes } = await fixture(directory, 'codex');
  try {
    await adapter.send(session, '1'); await adapter.press(session, 'Enter'); await adapter.press(session, 'Escape'); await adapter.send(session, 'é\n次');
    const expected = Buffer.from('1\r\r\x1b\x1b[200~é\r次\x1b[201~\r');
    await wait(async () => (await bytes()).length >= expected.length);
    assert.deepEqual(await bytes(), expected);
    await run(['copy-mode', '-t', '%0']); await assert.rejects(adapter.press(session, 'Enter'), /copy mode/);
    assert.deepEqual(await bytes(), expected);
  } finally { await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

for (const layout of ['claude', 'codex'] as const) test(`private tmux (${layout} layout) submits only an input area holding just the command, blank rows included`, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-leftover-')));
  const { run, adapter, session, draft, setDraft, submitted, wait } = await fixture(directory, layout);
  try {
    const command = 'relay [altcli-command:11111111-1111-4111-8111-111111111111]';
    const refused = /held other text besides this command\. Nothing was submitted and the typed command was erased/;
    // Each unsent draft, with the cursor at its end or moved to its start, stays exactly as it was and nothing is submitted.
    // Border-looking draft text is content: an indented rule or box edge never closes the input area, and a literal border stays in it.
    for (const [value, start] of [['i mean', false], ['i mean', true], ['compare a >', false], ['\n\nold instructions', true],
      ['\n───\nold instructions', true], ['\n╰ copied box\nold instructions', true], ['│', true], ['\n\n', true]] as const) {
      await setDraft(value); if (start) await run(['send-keys', '-t', '%0', 'C-a']);
      await assert.rejects(adapter.send(session, command), refused, JSON.stringify([value, start]));
      await wait(async () => await draft() === value); assert.equal(await draft(), value, JSON.stringify([value, start]));
    }
    assert.deepEqual(await submitted(), []);
    // With the input area empty, a multi-line command containing an empty line and the correlated command are both submitted as sent.
    await setDraft(''); await adapter.send(session, 'first\n\nsecond');
    await adapter.send(session, command);
    await wait(async () => (await submitted()).length === 2);
    assert.deepEqual(await submitted(), ['first\n\nsecond', command]);
    // Context resets use the same input-area guard, but arrive as a bare native slash command.
    const reset = '/clear';
    await setDraft('unfinished instruction'); await assert.rejects(adapter.send(session, reset), refused);
    assert.equal(await draft(), 'unfinished instruction');
    await setDraft(''); await adapter.send(session, reset);
    await wait(async () => (await submitted()).length === 3);
    assert.deepEqual(await submitted(), ['first\n\nsecond', command, reset]);
  } finally { await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
