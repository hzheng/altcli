/** Opt-in real transport check. Private tmux server and cat only; no installed CLI or user session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, TmuxAdapter } from '../src/server/adapters/tmux.ts';
import type { SessionRegistration } from '../src/contracts/api.ts';

test('private tmux transmits literal UTF-8, multiline paste and key-only Enter/Escape exactly', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-terminal-')));
  const run = createRunner('tmux', join(directory, 'tmux.sock'));
  try {
    const script = join(directory, 'reader.sh');
    await writeFile(script, '#!/bin/sh\nstty raw -echo\nprintf "\\033[?2004h"\nexec /bin/cat > bytes\n');
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'input-fixture', '-c', directory, '/bin/sh', script]);
    const adapter = new TmuxAdapter(run);
    let pane = await adapter.inspect('%0');
    for (let i = 0; pane.command !== 'cat' && i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); pane = await adapter.inspect('%0'); }
    assert.equal(pane.command, 'cat');
    const session: SessionRegistration = { id: 'reader', label: 'Harmless byte reader', agentType: 'other', expectedCommand: 'cat', repository: directory, relayPrompt: '', registeredAt: new Date().toISOString(), identity: pane.identity };
    await adapter.send(session, '1'); await adapter.press(session, 'Enter'); await adapter.press(session, 'Escape'); await adapter.send(session, 'é\n次');
    const expected = Buffer.from('1\r\r\x1b\x1b[200~é\r次\x1b[201~\r');
    let bytes = await readFile(join(directory, 'bytes'));
    for (let i = 0; bytes.length < expected.length && i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); bytes = await readFile(join(directory, 'bytes')); }
    assert.deepEqual(bytes, expected);
    await run(['copy-mode', '-t', '%0']); await assert.rejects(adapter.press(session, 'Enter'), /copy mode/);
    assert.deepEqual(await readFile(join(directory, 'bytes')), expected);
  } finally { await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
