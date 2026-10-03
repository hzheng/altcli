import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeClaude, jobEnvironment } from './background-native.mjs';

test('native environment drops owner credentials, hook correlation and tmux identity', () => {
  const env = jobEnvironment({ HOME: '/synthetic', PATH: '/bin', ALTCLI_TOKEN: 'fixture', ALTCLI_ENV: '/secret', TMUX: '/socket', TMUX_PANE: '%1',
    NODE_OPTIONS: '--require /unsafe', CLAUDE_CODE_SKIP_PERMISSIONS: 'true' });
  assert.equal(env.HOME, '/synthetic'); for (const key of ['ALTCLI_TOKEN', 'ALTCLI_ENV', 'TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'CLAUDE_CODE_SKIP_PERMISSIONS']) assert.equal(env[key], undefined);
});
async function native(body: string, deadlineMs = 500) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'altcli-native-boundary-'))), sessionId = randomUUID();
  const path = join(directory, 'fixture.cjs');
  const prefix = `const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
    const sid=${JSON.stringify(sessionId)};
    send({type:'system',subtype:'init',session_id:sid,tools:['StructuredOutput'],mcp_servers:[{name:'altcli_job',status:'connected'}],plugins:[],model:'fixture'});`;
  try {
    await writeFile(path, prefix + body);
    return await invokeClaude({ executable: process.execPath, args: [path], directory, prompt: 'synthetic', sessionId, deadlineMs });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test('JSON before exit never settles the invocation; timeout terminates the exact native process group', async () => {
  const result = await native(`send({type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{ok:true}});setInterval(()=>{},1000);`);
  assert.equal(result.status, 'failed'); assert.equal(result.category, 'deadline'); assert.equal(result.settled, true); assert.equal(result.assessment, null);
});
test('wrong provider session, oversized output, duplicate results and inherited tools are refused', async () => {
  for (const body of [
    `send({type:'result',subtype:'success',is_error:false,session_id:'another',structured_output:{ok:true}});`,
    `process.stdout.write('x'.repeat(1048577));`,
    `send({type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{tooLarge:'x'.repeat(9000)}});`,
    `send({type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{ok:true}});process.stdout.write('unfinished');`,
    `const r={type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{ok:true}};send(r);send(r);`,
    `send({type:'system',subtype:'init',session_id:sid,tools:['Bash'],mcp_servers:[],plugins:[]});`,
  ]) { const result = await native(body); assert.equal(result.status, 'failed'); assert.equal(result.assessment, null); }
});
test('observed successful structured output is returned only after clean process-group exit', async () => {
  const result = await native(`send({type:'result',subtype:'success',is_error:false,session_id:sid,structured_output:{ok:true}});`);
  assert.equal(result.status, 'succeeded'); assert.equal(result.settled, true); assert.deepEqual(result.assessment, { ok: true });
});
