/** M0: exercise the candidate per-card HTTP stream using real Next and Chromium.
 * Disposable fixture, loopback only; no AltCLI store or user tmux server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
const directory = await mkdtemp(join(tmpdir(), 'altcli-http-gate-'));
const modules = resolve(import.meta.dirname, '../node_modules');
const next = join(modules, 'next/dist/bin/next');
const delay = ms => new Promise(r => setTimeout(r, ms));
let browser, child;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(r => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await done; clearTimeout(timer);
}
async function start(args) {
  let log = '';
  child = spawn(process.execPath, [next, ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { log = (log + d).slice(-8000); });
  return () => log;
}
try {
  await mkdir(join(directory, 'app/stream'), { recursive: true });
  await mkdir(join(directory, 'app/control'), { recursive: true });
  await symlink(modules, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(directory, 'next.config.mjs'), 'export default { poweredByHeader:false };\n');
  await writeFile(join(directory, 'app/layout.js'), 'export default function Layout({children}) { return <html><body>{children}</body></html> }');
  await writeFile(join(directory, 'app/page.js'), 'export default function Page() { return <p>Transport probe</p> }');
  await writeFile(join(directory, 'app/stream/route.js'), `export async function GET(request) {
    let timer;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(8192)+'\\n')); timer=setInterval(()=>c.enqueue(new TextEncoder().encode('hb\\n')),1000); request.signal.addEventListener('abort',()=>{clearInterval(timer);try{c.close()}catch{}}); }, cancel(){clearInterval(timer);} });
    return new Response(stream,{headers:{'Content-Type':'text/plain','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
  }`);
  await writeFile(join(directory, 'app/control/route.js'), 'export async function POST(){return Response.json({accepted:true})}');
  browser = await chromium.launch();
  for (const mode of ['dev', 'start']) {
    if (mode === 'start') {
      const log = await start(['build', '--webpack']);
      const code = await new Promise(r => child.once('exit', r));
      assert.equal(code, 0, log());
    }
    const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port; await new Promise(r => listener.close(r));
    const log = await start([mode, ...(mode === 'dev' ? ['--webpack'] : []), '--hostname', '127.0.0.1', '--port', String(port)]);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let n=0;n<150;n++) {
      if (child.exitCode !== null) throw new Error(log());
      try { if ((await fetch(origin)).ok) { ready=true;break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, log());
    const page = await browser.newPage(); await page.goto(origin);
    // Warm compilation before measuring the connection pool.
    await page.evaluate(async () => { await fetch('/control',{method:'POST'}); const c=new AbortController(); const r=await fetch('/stream',{signal:c.signal}); await r.body.getReader().read(); c.abort(); });
    const result = await page.evaluate(async () => {
      const controllers = Array.from({length:6},()=>new AbortController());
      await Promise.all(controllers.map(async(c,i)=>{const r=await fetch(`/stream?card=${i}`,{signal:c.signal});const reader=r.body.getReader();await reader.read();void (async()=>{try{while(!(await reader.read()).done){}}catch{}})();}));
      const began=performance.now(); let settled=false;
      const control=fetch('/control',{method:'POST'}).then(r=>{settled=true;return r.ok;});
      await new Promise(r=>setTimeout(r,500));
      const starved=!settled;
      controllers.forEach(c=>c.abort());
      return {starved,controlEventuallyAccepted:await control,elapsedMs:Math.round(performance.now()-began)};
    });
    console.log(JSON.stringify({nextMode:mode,http:'1.1',streams:6,...result}));
    assert.ok(result.starved, 'Update the M0 decision if the browser connection limit changes.');
    assert.ok(result.controlEventuallyAccepted);
    await page.close(); await stop();
  }
} finally { await browser?.close(); await stop(); await rm(directory,{recursive:true,force:true}); }
