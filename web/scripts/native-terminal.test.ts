/** M0 native probes on private sockets. Tokens are dummy fixtures; unsafe native observation uses captured fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, inspectPane } from '../src/server/adapters/tmux.ts';
import { attachTmux, inspectAttach, type Attachment } from './lib/tmux-attach.ts';
import { loadConfig } from '../src/server/config.ts';
import { paneProcesses } from '../src/server/processes.ts';
import { tmuxLiteral } from './lib/terminal-environment.ts';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function eventually(check: () => Promise<boolean>) { for (let n=0;n<100;n++) { if (await check()) return; await delay(20); } assert.fail('Native condition timed out'); }

// Native observer refusal preserves the worker instead of changing tmux settings.
test('captured fallback preserves an unattended automatically sized session', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-observer-gate-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  let observer: Attachment | undefined;
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'unattended', '-x', '120', '-y', '40', '/usr/bin/env', '/bin/sleep', '300']);
    const target = await inspectAttach(config, (await inspectPane(run, '%0')).identity);
    await assert.rejects(attachTmux(config, target, false, 60, 12, () => {}, () => {}), /Captured text/);
    assert.equal((await run(['display-message', '-p', '-t', '%0', '#{window_width}x#{window_height}'])).trim(), '120x40',
      'Observation must not resize the unattended worker.');
  } finally { await observer?.close(); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('private tmux: observer isolation, native bytes, resize, exact client identity and detach lifetime', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-native-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  let observer: Attachment | undefined, writer: Attachment | undefined, desktop: Attachment | undefined;
  try {
    await writeFile(join(dir, 'reader.sh'), '#!/bin/sh\nstty raw -echo\nprintf "\\033[?2004hNative fixture\\r\\n"\nexec /bin/cat > bytes\n');
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'native', '-c', dir, '-x', '120', '-y', '40', '/bin/sh', join(dir, 'reader.sh')]);
    await eventually(async () => (await inspectPane(run, '%0')).command === 'cat');
    const pane = await inspectPane(run, '%0');
    const target = await inspectAttach(config, pane.identity);
    desktop = await attachTmux(config, target, true, 120, 41, () => {}, () => {});
    await eventually(async () => { try { return !!await desktop!.active(); } catch { return false; } });
    await run(['set-option', '-w', '-t', '%0', 'window-size', 'manual']);
    let output = Buffer.alloc(0);
    observer = await attachTmux(config, target, false, 60, 12, b => { output = Buffer.concat([output, b]); }, () => {});
    await eventually(async () => output.includes(Buffer.from('Native fixture')));
    await observer.active();
    observer.write(Buffer.from('observer must not type\r'));
    observer.resize(30, 8); await delay(100);
    assert.equal((await run(['display-message', '-p', '-t', '%0', '#{window_width}x#{window_height}'])).trim(), '120x40');
    assert.equal((await readFile(join(dir, 'bytes'))).length, 0);
    const before = await paneProcesses(pane.identity.panePid);
    assert.ok(!before.some(p => p.pid === String(observer!.pid)), 'attach is not pane background work');
    await observer.close(); observer = undefined;
    await run(['set-option', '-w', '-t', '%0', 'window-size', 'latest']);
    writer = await attachTmux(config, target, true, 90, 25, () => {}, () => {});
    await eventually(async () => { try { return (await writer!.active()).paneId === '%0'; } catch { return false; } });
    const bytes = Buffer.from('é次🙂\x1b[A\x1b\t\x03\x04\x12\x15\x1b[200~line1\nline2\x1b[201~');
    writer.write(bytes);
    await eventually(async () => (await readFile(join(dir, 'bytes'))).length === bytes.length);
    assert.deepEqual(await readFile(join(dir, 'bytes')), bytes);
    writer.resize(70, 20); await delay(100);
    assert.equal((await run(['display-message', '-p', '-t', '%0', '#{window_width}x#{window_height}'])).trim(), '70x19');
    assert.equal((await writer.active()).size, '70x19', 'the status line reports the effective window, not the browser grid');
    await run(['copy-mode', '-t', '%0']);
    assert.equal((await inspectPane(run, '%0')).inMode, true);
    assert.equal((await writer.active()).paneId, '%0', 'copy mode keeps the native writer attached');
    writer.write(Buffer.from('q'));
    await eventually(async () => !(await inspectPane(run, '%0')).inMode);
    assert.deepEqual(await readFile(join(dir, 'bytes')), bytes, 'leaving copy mode must not type q into the worker');
    await writer.close(); writer = undefined;
    assert.deepEqual((await inspectPane(run, '%0')).identity, pane.identity);
    await run(['set-option', '-t', target.sessionId, 'destroy-unattached', 'on']);
    await assert.rejects(inspectAttach(config, pane.identity), /destroy-unattached/);
    await run(['set-option', '-t', target.sessionId, 'destroy-unattached', 'off']);
    await desktop.close(); desktop = undefined;
  } finally { await writer?.close(); await observer?.close(); await desktop?.close(); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('private tmux: a writer follows deliberate session navigation; observers never follow and a lost target closes', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-follow-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  let writer: Attachment | undefined, observer: Attachment | undefined;
  const clientName = async (a: Attachment) => (await run(['list-clients', '-F', '#{client_pid}\t#{client_name}'])).trimEnd().split('\n').map(l => l.split('\t')).find(p => p[0] === String(a.pid))![1]!;
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'origin', '-c', dir, '-x', '100', '-y', '30', '/bin/sleep', '300']);
    await run(['new-session', '-d', '-s', 'other', '-c', dir, '/bin/sleep', '300']);
    const target = await inspectAttach(config, (await inspectPane(run, '%0')).identity);
    writer = await attachTmux(config, target, true, 100, 30, () => {}, () => {});
    await eventually(async () => { try { return (await writer!.active()).sessionId === target.sessionId; } catch { return false; } });
    await run(['switch-client', '-c', await clientName(writer), '-t', 'other']);
    await eventually(async () => { try { return (await writer!.active()).label === 'other'; } catch { return false; } });
    await run(['set-option', '-w', '-t', 'origin', 'window-size', 'manual']);
    observer = await attachTmux(config, target, false, 60, 12, () => {}, () => {});
    await eventually(async () => { try { return !!await observer!.active(); } catch { return false; } });
    await run(['switch-client', '-c', await clientName(observer), '-t', 'other']);
    await eventually(async () => { try { await observer!.active(); return false; } catch { return true; } });
    // The navigated writer still closes once its original target is gone; nothing falls back to another session.
    await run(['kill-session', '-t', 'origin']);
    await assert.rejects(writer.active());
  } finally { await writer?.close(); await observer?.close(); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('private tmux: shell-free respawn preserves literal argv and retains instant exit after options/marker setup', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-launch-gate-')));
  const run = createRunner('tmux', join(dir, 't.sock'));
  try {
    const fixture = join(dir, 'fixture.mjs'), result = join(dir, 'result.json');
    await writeFile(fixture, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify({argv:process.argv.slice(3),cwd:process.cwd()}));\n");
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'launch', '-c', dir, '/usr/bin/env', '/bin/sleep', '300']);
    const before = (await run(['display-message', '-p', '-t', 'launch', '#{session_id} #{pane_id}'])).trim();
    await run(['set-option', '-t', 'launch', 'destroy-unattached', 'off']);
    await run(['set-option', '-w', '-t', 'launch', 'remain-on-exit', 'on']);
    await run(['set-option', '-t', 'launch', '@altcli_launch', 'exact-operation']);
    const args = ['', 'space here', "quotes'\"", '$HOME', '`uname`', '-leading', 'tail;', ';', '\\;', '次'];
    await run(['respawn-pane', '-k', '-t', 'launch:0.0', '/usr/bin/env', process.execPath, fixture, result, ...args.map(tmuxLiteral)]);
    await eventually(async () => { try { return !!await readFile(result); } catch { return false; } });
    assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { argv: args, cwd: dir });
    await eventually(async () => (await run(['display-message', '-p', '-t', '%0', '#{pane_dead}'])).trim() === '1');
    assert.equal((await run(['display-message', '-p', '-t', 'launch', '#{session_id} #{pane_id}'])).trim(), before);
    assert.equal((await run(['display-message', '-p', '-t', 'launch', '#{remain-on-exit} #{@altcli_launch}'])).trim(), 'on exact-operation');
  } finally { await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
