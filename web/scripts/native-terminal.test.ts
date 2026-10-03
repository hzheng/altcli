/** M0 native probes on private sockets. Tokens are dummy fixtures; unsafe native observation uses captured fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRunner, inspectPane } from '../src/server/adapters/tmux.ts';
import { attachTmux, inspectAttach, type Attachment } from './lib/tmux-attach.ts';
import { loadConfig } from '../src/server/config.ts';
import { paneProcesses } from '../src/server/processes.ts';
import { tmuxLiteral } from './lib/terminal-environment.ts';
import { nativeReference } from '../src/server/attachments.ts';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function eventually(check: () => Promise<boolean>, diagnostic?: () => string) { for (let n=0;n<100;n++) { if (await check()) return; await delay(20); } assert.fail(diagnostic?.() ?? 'Native condition timed out'); }
async function bytesArrive(path: string, expected: Buffer) {
  let actual = Buffer.alloc(0);
  await eventually(async () => { actual = await readFile(path); return actual.equals(expected); },
    () => `Native bytes timed out: expected ${expected.length} bytes (${expected.toString('hex')}), received ${actual.length} bytes (${actual.toString('hex')})`);
}

for (const launch of ['direct', 'npm'] as const)
test(`private tmux: exact ${launch} backend process is infrastructure but its child is work`, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-host-process-')));
  const socket = join(dir, 't.sock'); const run = createRunner('tmux', socket);
  const result = join(dir, 'result.json');
  try {
    const processes = new URL('../src/server/processes.ts', import.meta.url).href;
    await writeFile(join(dir, 'fixture.mjs'), `
      import { execFileSync, spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { once } from 'node:events';
      import { hostPaneProcesses } from ${JSON.stringify(processes)};
      const root = execFileSync('tmux', ['-S', ${JSON.stringify(socket)}, 'display-message', '-p', '-t', process.env.TMUX_PANE, '#{pane_pid}'], { encoding: 'utf8' }).trim();
      try {
        const clear = await hostPaneProcesses(root);
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await once(child, 'spawn');
        const busy = await hostPaneProcesses(root);
        child.kill(); await once(child, 'exit');
        const settled = await hostPaneProcesses(root);
        writeFileSync(${JSON.stringify(result)}, JSON.stringify({ pid: String(process.pid), child: String(child.pid), clear, busy, settled }));
      } catch (error) { writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(error) })); }
      setInterval(() => {}, 1000);
    `);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { start: 'node --experimental-strip-types fixture.mjs' } }));
    const args = launch === 'direct' ? [process.execPath, '--experimental-strip-types', join(dir, 'fixture.mjs')]
      : ['npm', 'run', 'start'];
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'host', '-c', dir, '/usr/bin/env', `PATH=${dirname(process.execPath)}:${process.env.PATH ?? ''}`, ...args]);
    await eventually(async () => { try { await readFile(result); return true; } catch { return false; } });
    const evidence = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(evidence.error, undefined);
    assert.equal(evidence.clear.lineage[0].pid, evidence.pid);
    assert.deepEqual(evidence.clear.writers, []);
    assert.deepEqual(evidence.clear.backendChildren, []);
    assert.deepEqual(evidence.busy.writers.map((p: { pid: string }) => p.pid), [evidence.child]);
    assert.deepEqual(evidence.busy.backendChildren, [evidence.child]);
    assert.deepEqual(evidence.settled, evidence.clear);
    if (launch === 'npm') assert.ok(evidence.clear.lineage.some((p: { command: string }) => p.command.startsWith('npm')));
  } finally { await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

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
    writer = await attachTmux(config, target, true, 90, 25, () => {}, () => {}, true);
    await eventually(async () => { try { return (await writer!.active()).paneId === '%0'; } catch { return false; } });
    const bytes = Buffer.from('é次🙂\x1b[A\x1b\t\x03\x04\x12\x15\x1b[200~line1\nline2\x1b[201~');
    await writer.write(bytes);
    await bytesArrive(join(dir, 'bytes'), bytes);
    writer.resize(70, 20); await delay(100);
    assert.equal((await run(['display-message', '-p', '-t', '%0', '#{window_width}x#{window_height}'])).trim(), '70x19');
    assert.equal((await writer.active()).size, '70x19', 'the status line reports the effective window, not the browser grid');
    await run(['copy-mode', '-t', '%0']);
    assert.equal((await inspectPane(run, '%0')).inMode, true);
    assert.equal((await writer.active()).paneId, '%0', 'copy mode keeps the native writer attached');
    await writer.write(Buffer.from('q'));
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

test('private tmux: pane-directed Helper and workspace bytes stay on their original pane despite tmux shortcuts or a moved display', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-helper-input-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  let writer: Attachment | undefined;
  try {
    await writeFile(join(dir, 'reader.sh'), '#!/bin/sh\nstty raw -echo\nprintf "Ready\\r\\n"\nexec /bin/cat > "$1"\n');
    for (const name of ['helper', 'project']) {
      await run(['-f', '/dev/null', 'new-session', '-d', '-s', name, '-c', dir, '/bin/sh', join(dir, 'reader.sh'), join(dir, `${name}.bytes`)]);
    }
    await eventually(async () => (await inspectPane(run, '%0')).command === 'cat' && (await inspectPane(run, '%1')).command === 'cat');
    const target = await inspectAttach(config, (await inspectPane(run, '%0')).identity);
    writer = await attachTmux(config, target, true, 80, 24, () => {}, () => {}, true);
    await writer.ready;
    // Prefixes, Unicode, binary controls and bracketed paste are CLI input, never tmux client commands.
    const bytes = Buffer.from('\x02:switch-client -t project\r\x00é次🙂\x1b[A\x03\x1b[200~line1\nline2\x1b[201~');
    await writer.write(bytes);
    await bytesArrive(join(dir, 'helper.bytes'), bytes);
    assert.equal((await writer.active()).sessionId, target.sessionId);
    // Even a host-side client switch between inspection and writing cannot redirect a frame.
    const client = (await run(['list-clients', '-F', '#{client_pid}\t#{client_name}'])).trimEnd().split('\n').map(l => l.split('\t')).find(p => p[0] === String(writer!.pid))![1]!;
    await run(['switch-client', '-c', client, '-t', 'project']);
    await writer.write(Buffer.from('still Helper'));
    await eventually(async () => (await readFile(join(dir, 'helper.bytes'))).length === bytes.length + 12);
    assert.equal((await readFile(join(dir, 'project.bytes'))).length, 0);
    await assert.rejects(writer.active(), /changed sessions/);
    await run(['switch-client', '-c', client, '-t', 'helper']);
    writer.resize(70, 20);
    await eventually(async () => (await writer!.active()).size === '70x19');
    await writer.close();
    await assert.rejects(async () => writer!.write(Buffer.from('after close')));
  } finally { await writer?.close(); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('private tmux: synchronized panes cannot broadcast a browser writer into another pane',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'altcli-sync-input-'))),socket=join(dir,'t.sock');
  const config=loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(dir,'data'),ALTCLI_TMUX_SOCKET:socket});
  const run=createRunner('tmux',socket);let writer:Attachment|undefined;
  try {
    await writeFile(join(dir,'reader.sh'),'#!/bin/sh\nstty raw -echo\nprintf "Ready\\r\\n"\nexec /bin/cat > "$1"\n');
    await run(['-f','/dev/null','new-session','-d','-s','sync','-c',dir,'/bin/sh',join(dir,'reader.sh'),join(dir,'one')]);
    await run(['split-window','-d','-t','%0','-c',dir,'/bin/sh',join(dir,'reader.sh'),join(dir,'two')]);
    await eventually(async()=>(await inspectPane(run,'%0')).command==='cat'&&(await inspectPane(run,'%1')).command==='cat');
    const target=await inspectAttach(config,(await inspectPane(run,'%0')).identity);
    writer=await attachTmux(config,target,true,80,24,()=>{},()=>{},true);await writer.ready;
    await run(['set-window-option','-t','%0','synchronize-panes','on']);
    const bytes=Buffer.from('only here\x02:next-window\r\x00é');await writer.write(bytes);
    await bytesArrive(join(dir,'one'),bytes);
    assert.equal((await readFile(join(dir,'two'))).length,0);
    assert.equal((await inspectPane(run,'%0')).synchronized,true);
  } finally {await writer?.close();await run(['kill-server']).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('private tmux: mouse reports reach only a requesting original pane, with pane-relative coordinates', async () => {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'altcli-pane-mouse-')));
  const config=loadConfig({ALTCLI_TOKEN:'a'.repeat(64),ALTCLI_DATA_DIR:join(dir,'data'),ALTCLI_TMUX_SOCKET:join(dir,'t.sock')});
  const run=createRunner('tmux',config.tmuxSocket);let writer:Attachment|undefined;
  try {
    await writeFile(join(dir,'reader.sh'),'#!/bin/sh\nstty raw -echo\nprintf "Ready\\r\\n"\nexec /bin/cat > bytes\n');
    await run(['-f','/dev/null','new-session','-d','-s','mouse','-c',dir,'/bin/sh',join(dir,'reader.sh')]);
    await run(['split-window','-hbd','-t','%0','/bin/sleep','300']);
    await run(['set-option','-t','mouse','status-position','top']);
    await eventually(async()=>(await inspectPane(run,'%0')).command==='cat');
    const target=await inspectAttach(config,(await inspectPane(run,'%0')).identity);
    writer=await attachTmux(config,target,true,80,24,()=>{},()=>{},true);await writer.ready;
    const [left,top]=(await run(['display-message','-p','-t','%0','#{pane_left}\t#{pane_top}'])).trim().split('\t').map(Number);
    assert.ok(left!>0);
    const point=`${left!+3};${top!+5}`; // One status row above the window.
    await writer.write(Buffer.from(`\x1b[<0;${point}M`));assert.equal((await readFile(join(dir,'bytes'))).length,0);
    // Output from the program, simulated through its tty, enables its own mouse reporting.
    const tty=(await run(['display-message','-p','-t','%0','#{pane_tty}'])).trim();
    await writeFile(tty,'\x1b[?1000h\x1b[?1006h');
    await eventually(async()=>(await run(['display-message','-p','-t','%0','#{mouse_sgr_flag}'])).trim()==='1');
    await writer.write(Buffer.from(`\x1b[<0;${point}M`));await writer.write(Buffer.from(`\x1b[<0;${point}m`));
    await writer.write(Buffer.from('\x1b[<0;3;4M')); // The other pane never receives or redirects a click.
    await writer.write(Buffer.from('\x1b[<0;500;500M'));await writer.write(Buffer.from(`\x1b[<35;${point}M`));
    await bytesArrive(join(dir,'bytes'),Buffer.from('\x1b[<0;3;4M\x1b[<0;3;4m'));
  } finally {await writer?.close();await run(['kill-server']).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test('private tmux: an image reference reaches the pane as one bracketed paste only where the program enabled it, never with Enter', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-image-ref-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  const attachments: Attachment[] = [];
  try {
    for (const [name, mode] of [['bracketed', '\\033[?2004h'], ['plain', '']] as const) {
      await writeFile(join(dir, `${name}.sh`), `#!/bin/sh\nstty raw -echo\nprintf "${mode}Ready\\r\\n"\nexec /bin/cat > ${name}.bytes\n`);
      await run(['-f', '/dev/null', ...(name === 'bracketed' ? ['new-session', '-d', '-s', 'images', '-x', '100', '-y', '30'] : ['new-window', '-d', '-t', 'images']), '-c', dir, '/bin/sh', join(dir, `${name}.sh`)]);
    }
    const path = join(dir, 'data', 'attachments', '9f1c2d3e-0000-4000-8000-000000000001.png'), reference = nativeReference(path);
    for (const [paneId, name, expected] of [['%0', 'bracketed', reference], ['%1', 'plain', Buffer.from(`'${path}'`)]] as const) {
      await eventually(async () => (await inspectPane(run, paneId)).command === 'cat');
      await run(['select-window', '-t', paneId]);
      const target = await inspectAttach(config, (await inspectPane(run, paneId)).identity);
      const writer = await attachTmux(config, target, true, 100, 30, () => {}, () => {}, true); attachments.push(writer);
      await eventually(async () => { try { return (await writer.active()).paneId === paneId; } catch { return false; } });
      // Exercise text paste split across HTTP-sized frames, including a split end marker.
      await writer.write(reference.subarray(0, reference.length - 3));
      await writer.write(reference.subarray(reference.length - 3));
      await eventually(async () => (await readFile(join(dir, `${name}.bytes`))).length === expected.length);
      await delay(100);
      assert.deepEqual(await readFile(join(dir, `${name}.bytes`)), expected);
      assert.ok(!(await readFile(join(dir, `${name}.bytes`))).includes(0x0d));
      // Image Insert uses the paste entry point; copy mode must not hide input into the program.
      await run(['copy-mode', '-t', paneId]);
      await assert.rejects(writer.paste!(reference), /Leave copy mode/);
      assert.deepEqual(await readFile(join(dir, `${name}.bytes`)), expected);
      await writer.write(Buffer.from('q')); await writer.paste!(reference);
      await eventually(async () => (await readFile(join(dir, `${name}.bytes`))).length === expected.length * 2);
      assert.deepEqual(await readFile(join(dir, `${name}.bytes`)), Buffer.concat([expected, expected]));
      await writer.close();
    }
  } finally { for (const a of attachments) await a.close().catch(() => {}); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

// tmux 3.7 sanitizes pasted content unless asked not to; only typed bytes opt out (see the Helper test above).
test('private tmux: pasted text cannot end the program\'s bracketed paste early', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-paste-marker-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  let writer: Attachment | undefined;
  try {
    await writeFile(join(dir, 'paste.sh'), '#!/bin/sh\nstty raw -echo\nprintf "\\033[?2004hReady\\r\\n"\nexec /bin/cat > paste.bytes\n');
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'paste', '-x', '80', '-y', '24', '-c', dir, '/bin/sh', join(dir, 'paste.sh')]);
    if (!/^paste-buffer \([^\n]+\) \[-[^\]]*S/m.test(await run(['list-commands']))) return t.skip('tmux before 3.7 pastes buffers literally');
    await eventually(async () => (await inspectPane(run, '%0')).command === 'cat');
    writer = await attachTmux(config, await inspectAttach(config, (await inspectPane(run, '%0')).identity), true, 80, 24, () => {}, () => {}, true);
    await eventually(async () => { try { return (await writer!.active()).paneId === '%0'; } catch { return false; } });
    await writer.write(Buffer.from('\x1b[200~a\x1b[201~b\x1b[201~'));
    let bytes = Buffer.alloc(0);
    await eventually(async () => (bytes = await readFile(join(dir, 'paste.bytes'))).subarray(-6).equals(Buffer.from('\x1b[201~')));
    const inner = bytes.subarray(6, -6).toString();
    assert.ok(bytes.subarray(0, 6).equals(Buffer.from('\x1b[200~')) && !inner.includes('\x1b') && inner.startsWith('a') && inner.endsWith('[201~b'), JSON.stringify(bytes.toString()));
  } finally { await writer?.close(); await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

// node-pty 1.1.0 on macOS leaks a spare master, the slave copy and the exit watcher's kqueue per spawn.
test('private tmux: closed and self-exiting attachments return descriptors to their steady count', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'altcli-attach-cycles-')));
  const config = loadConfig({ ALTCLI_TOKEN: 'a'.repeat(64), ALTCLI_DATA_DIR: join(dir, 'data'), ALTCLI_TMUX_SOCKET: join(dir, 't.sock') });
  const run = createRunner(config.tmuxBin, config.tmuxSocket);
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'cycles', '-x', '80', '-y', '24', '/bin/sleep', '600']);
    const target = await inspectAttach(config, (await inspectPane(run, '%0')).identity);
    const cycle = async (detach: boolean) => {
      let exited!: () => void; const gone = new Promise<void>(resolve => { exited = resolve; });
      const attachment = await attachTmux(config, target, true, 80, 24, () => {}, () => exited());
      await attachment.ready;
      if (detach) { await run(['detach-client', '-s', target.sessionId]); await gone; } else await attachment.close();
    };
    const descriptors = async () => { await delay(100); return (await readdir('/dev/fd')).length; };
    await cycle(false); await cycle(true);
    const steady = await descriptors();
    for (let n = 0; n < 20; n++) await cycle(n % 2 === 1);
    assert.equal(await descriptors(), steady);
    assert.equal((await run(['list-clients'])).trim(), '');
  } finally { await run(['kill-server']).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
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
