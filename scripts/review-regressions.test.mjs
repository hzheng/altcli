import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { backgroundState, claudeCompletion, claudeStart, claudeStartState, claudeStopContext, codexCompletion, contextKey, marker, outcomeOf } from '../hooks/protocol.mjs';
import { claudeSettings, codexConfig } from './lib/hook-config.mjs';
const ID = '12345678-1234-4234-8234-123456789abc';
const context = { source: 'claude', commandId: ID, sessionId: 's1', sourceTurnId: 't1' };
const identity = { paneId: '%1', panePid: '11', serverPid: '12', serverStarted: '13', socketPath: '/tmp/tmux-test' };
test('current Stop rejection cannot be replaced with an older transcript acceptance', () => {
  const result = claudeCompletion({ last_assistant_message: 'RELAY-OUTCOME: strong_objection - Wrong behavior.', transcript_path: '/never/read/previous-acceptance.jsonl', background_tasks: [], session_crons: [] }, context);
  assert.equal(result.outcome, 'strong_objection'); assert.equal(result.commandId, ID); assert.equal(result.settled, true);
});
test('missing current response never falls back to a stale transcript', () => {
  const result = claudeCompletion({ transcript_path: '/old.jsonl' }, context);
  assert.equal(result.outcome, null); assert.equal(result.settled, false); assert.equal(result.backgroundState, 'unknown');
});
test('active or missing background evidence is not silently called idle', () => {
  assert.equal(backgroundState({ background_tasks: [], session_crons: [] }), 'clear');
  assert.equal(backgroundState({ background_tasks: [{}], session_crons: [] }), 'active');
  assert.equal(backgroundState({ background_tasks: [], session_crons: [{}] }), 'active');
  assert.equal(backgroundState({ background_tasks: [] }), 'unknown');
});
test('a native prompt_id pairs each Stop with its own start, so an interrupted turn cannot block the next command', () => {
  const prompt = `relay: [codercrew-command:${ID}]`;
  const interrupted = { phase: 'active', context: claudeStart({ session_id: 's1', prompt_id: 'p-old', prompt: 'desktop text' }, identity, null) };
  const start = claudeStart({ session_id: 's1', prompt_id: 'p-new', prompt }, identity, interrupted);
  assert.equal(start.commandId, ID); assert.equal(start.sourceTurnId, 'p-new');
  const saved = { phase: 'active', pairing: 'native', context: start };
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-old' }, identity, saved), null);
  assert.equal(claudeStopContext({ session_id: 's2', prompt_id: 'p-new' }, identity, saved), null);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-new' }, { ...identity, panePid: '99' }, saved), null);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-new' }, identity, saved), start);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-new' }, identity, { ...saved, phase: 'finished' }), null);
});
test('without a native prompt_id, a start during an active turn fails closed and the Stop pairs by session only', () => {
  const prompt = `relay: [codercrew-command:${ID}]`;
  const first = claudeStart({ session_id: 's1', prompt }, identity, null);
  assert.equal(first.commandId, ID); assert.match(first.sourceTurnId, /^[0-9a-f-]{36}$/);
  const queued = claudeStart({ session_id: 's1', prompt }, identity, { phase: 'active', context: first });
  assert.equal(queued.commandId, undefined);
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, { phase: 'active', pairing: 'legacy', context: first }), first);
  assert.equal(claudeStart({ session_id: 's1', prompt }, identity, { phase: 'finished', context: first }).commandId, ID);
});
test('only the final nonempty line is an outcome, not an example earlier in the response', () => {
  assert.equal(outcomeOf('RELAY-OUTCOME: accept_and_improve\nActually I could not finish.').outcome, null);
  assert.equal(outcomeOf('Details\nRELAY-OUTCOME: accept_without_improvement - Looks good.\n').outcome, 'accept_without_improvement');
});
test('a unique marker distinguishes identical relay instructions', () => {
  assert.equal(marker(`relay: [codercrew-command:${ID}]`), ID);
  assert.equal(marker('relay'), undefined);
  assert.equal(marker(`relay: [codercrew-command:${ID}] altered`), undefined);
});
test('Codex events use a stable command/turn identity and retain unknown background evidence', () => {
  const payload = { type: 'agent-turn-complete', 'thread-id': 'thread1', 'input-messages': [`relay: [codercrew-command:${ID}]`], 'last-assistant-message': 'RELAY-OUTCOME: accept_and_improve - Fixed.' };
  assert.deepEqual(codexCompletion(payload, identity), codexCompletion(payload, identity));
  assert.equal(codexCompletion(payload, identity).commandId, ID);
  assert.equal(codexCompletion(payload, identity).backgroundState, 'unknown');
  assert.equal(codexCompletion({ ...payload, type: 'other-event' }, identity), null);
});
test('Claude installation preserves unrelated hooks in the same group', () => {
  const input = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/old/codercrew-turn-complete.sh claude' }, { type: 'command', command: 'foreign-hook' }] }] }, custom: { keep: true } };
  const next = JSON.parse(claudeSettings(JSON.stringify(input), '/new/codercrew-turn-complete.sh'));
  assert.equal(next.hooks.Stop[0].hooks[0].command, 'foreign-hook');
  assert.equal(next.hooks.Stop[0].matcher, '*'); assert.deepEqual(next.custom, input.custom);
  assert.equal(next.hooks.UserPromptSubmit.length, 1);
  assert.equal(claudeSettings(JSON.stringify(next), '/new/codercrew-turn-complete.sh'), JSON.stringify(next, null, 2) + '\n');
});
test('multiline TOML string arrays and trailing comments are replaced as one value', () => {
  const original = `model = "example"\nnotify = [\n  'notify-send', # keep this command\n  "existing notifier",\n] # notify note\n[profiles.test]\nnotify = ["do-not-change"]\n`;
  const output = codexConfig(original, '/new/codercrew-turn-complete.sh');
  assert.match(output, /"--then","notify-send","existing notifier"/);
  assert.match(output, /\] # notify note/);
  assert.match(output, /\[profiles.test\]\nnotify = \["do-not-change"\]/);
  assert.equal(codexConfig(output, '/new/codercrew-turn-complete.sh'), output);
});
test('unsupported TOML is refused, never partially edited', () => {
  assert.throws(() => codexConfig('notify = ["""multiline"""]\n', '/hook'), /unsupported/i);
  assert.throws(() => codexConfig('other = [\n1,2\n]\n', '/hook'), /unsupported/i);
  assert.throws(() => codexConfig('notify = ["one"]\nnotify = ["two"]\n', '/hook'), /duplicate/i);
});
test('the installer validates both files before writing either and creates backups on success', () => {
  const home = mkdtempSync(join(tmpdir(), 'codercrew-config-'));
  try {
    const claude = join(home, '.claude'); const codex = join(home, '.codex'); mkdirSync(claude); mkdirSync(codex);
    const settings = '{"theme":"dark"}\n'; writeFileSync(join(claude, 'settings.json'), settings);
    writeFileSync(join(codex, 'config.toml'), 'notify = ["""unsupported"""]\n');
    const script = fileURLToPath(new URL('./install-hooks.mjs', import.meta.url));
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
    const failure = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.notEqual(failure.status, 0); assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), settings);
    writeFileSync(join(codex, 'config.toml'), 'notify = [\n "existing",\n]\n');
    const success = spawnSync(process.execPath, [script], { env, encoding: 'utf8' }); assert.equal(success.status, 0, success.stderr);
    assert.ok(readdirSync(claude).some((p) => p.includes('codercrew-backup')));
    assert.ok(readdirSync(codex).some((p) => p.includes('codercrew-backup')));
    const check = spawnSync(process.execPath, [script, '--check'], { env, encoding: 'utf8' }); assert.equal(check.status, 0, check.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a native start requires its exact valid prompt_id on Stop, not a session-only downgrade', () => {
  const saved = claudeStartState({ session_id: 's1', prompt_id: 'p-current', prompt: `relay: [codercrew-command:${ID}]` }, identity, null);
  assert.equal(saved.pairing, 'native');
  for (const fields of [{}, { prompt_id: null }, { prompt_id: '' }, { prompt_id: 7 }, { prompt_id: 'bad\nid' }, { prompt_id: 'p-other' }]) {
    assert.equal(claudeStopContext({ session_id: 's1', ...fields }, identity, saved), null, JSON.stringify(fields));
    assert.equal(saved.phase, 'active');
  }
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-current' }, identity, saved), saved.context);
});
test('a malformed present start ID is not silently treated as an older CLI', () => {
  for (const value of [null, '', 7, 'bad\nid', 'x'.repeat(201)]) {
    const payload = { session_id: 's1', prompt_id: value, prompt: `relay: [codercrew-command:${ID}]` };
    const saved = claudeStartState(payload, identity, null);
    assert.equal(saved.pairing, 'invalid'); assert.equal(saved.context.commandId, undefined);
    assert.equal(claudeStopContext({ session_id: 's1' }, identity, saved), null);
    assert.equal(claudeStopContext({ session_id: 's1', prompt_id: value }, identity, saved), null);
  }
});
test('legacy pairing requires both events to omit prompt_id, even if a supplied ID equals the generated UUID', () => {
  const payload = { session_id: 's1', prompt: `relay: [codercrew-command:${ID}]` };
  const saved = claudeStartState(payload, identity, null);
  assert.equal(saved.pairing, 'legacy'); assert.equal(saved.context.commandId, ID);
  for (const prompt_id of [null, '', 'bad\nid', saved.context.sourceTurnId]) {
    assert.equal(claudeStopContext({ session_id: 's1', prompt_id }, identity, saved), null);
  }
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, saved), saved.context);
  const overlapping = claudeStartState(payload, identity, saved);
  assert.equal(overlapping.context.commandId, undefined); // retain the user's conservative fallback
});
test('a fresh native ID recovers an interrupted legacy slot without accepting the old Stop', () => {
  const old = claudeStartState({ session_id: 's1', prompt: 'desktop text' }, identity, null);
  const saved = claudeStartState({ session_id: 's1', prompt_id: 'p-new', prompt: `relay: [codercrew-command:${ID}]` }, identity, old);
  assert.equal(saved.context.commandId, ID);
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, saved), null);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-new' }, identity, saved), saved.context);
});
test('unversioned on-disk slots do not guess whether a UUID was native or generated', () => {
  const start = claudeStart({ session_id: 's1', prompt_id: ID, prompt: `relay: [codercrew-command:${ID}]` }, identity, null);
  const unversioned = { phase: 'active', context: start };
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, unversioned), null);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: ID }, identity, unversioned), null);
});
test('pairing provenance survives JSON storage but stays out of the HTTP event context', () => {
  const saved = JSON.parse(JSON.stringify(claudeStartState({ session_id: 's1', prompt_id: 'p-new', prompt: `relay: [codercrew-command:${ID}]` }, identity, null)));
  const context = claudeStopContext({ session_id: 's1', prompt_id: 'p-new' }, identity, saved);
  const completion = claudeCompletion({ last_assistant_message: 'RELAY-OUTCOME: accept_without_improvement', background_tasks: [], session_crons: [] }, context);
  assert.equal(completion.commandId, ID); assert.equal(completion.sourceTurnId, 'p-new');
  assert.equal(completion.backgroundState, 'clear'); assert.equal(Object.hasOwn(completion, 'pairing'), false);
  assert.equal(Object.hasOwn({ ...saved.context, event: 'turn_started' }, 'pairing'), false);
});
test('the real hook entry point persists pairing mode and ignores invalid Stops without consuming the active slot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codercrew-prompt-pair-'));
  const events = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const bin = join(home, 'bin'); mkdirSync(bin);
    // Only tmux discovery is faked; run the actual hook subprocess, file I/O and loopback HTTP transport.
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' '${Object.values(identity).join('\t')}'\n`, { mode: 0o700 });
    const envFile = join(home, 'hook.env'); writeFileSync(envFile, `CODERCREW_TOKEN=${'a'.repeat(64)}\n`, { mode: 0o600 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, TMUX_PANE: identity.paneId,
      TMUX: `${identity.socketPath},${identity.serverPid},0`, CODERCREW_ENV: envFile, CODERCREW_URL: `http://127.0.0.1:${server.address().port}` };
    const hook = fileURLToPath(new URL('../hooks/codercrew-turn-complete.mjs', import.meta.url));
    const invoke = (payload) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [hook, 'claude'], { env, timeout: 5000 }, (error, stdout, stderr) => {
        if (error) reject(error); else { try { assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(); } catch (failure) { reject(failure); } }
      });
      child.stdin.on('error', reject); child.stdin.end(JSON.stringify({ session_id: 's1', ...payload }));
    });
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-old', prompt: 'desktop text' });
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-current', prompt: `relay: [codercrew-command:${ID}]` });
    assert.equal(events.length, 2); assert.equal(events[1].commandId, ID);
    const slot = join(home, '.local', 'share', 'codercrew', 'hook-turns', `${contextKey(identity, 's1')}.json`);
    const before = readFileSync(slot, 'utf8'); assert.equal(JSON.parse(before).pairing, 'native');
    const response = { hook_event_name: 'Stop', last_assistant_message: 'RELAY-OUTCOME: strong_objection - Current response.', background_tasks: [], session_crons: [] };
    for (const fields of [{ prompt_id: 'p-old' }, {}, { prompt_id: 'bad\nid' }]) {
      await invoke({ ...response, ...fields }); assert.equal(events.length, 2);
      assert.equal(readFileSync(slot, 'utf8'), before);
    }
    await invoke({ ...response, prompt_id: 'p-current' });
    assert.equal(events.length, 3); assert.equal(events[2].commandId, ID);
    assert.equal(events[2].sourceTurnId, 'p-current'); assert.equal(events[2].outcome, 'strong_objection');
    assert.equal(Object.hasOwn(events[2], 'pairing'), false);
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).phase, 'finished');
    await invoke({ ...response, prompt_id: 'p-current' }); assert.equal(events.length, 3); // duplicate Stop
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt: `relay: [codercrew-command:${ID}]` });
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).pairing, 'legacy');
    await invoke(response); assert.equal(events.length, 5);
    assert.equal(events[4].sourceTurnId, events[3].sourceTurnId);
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).phase, 'finished');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
