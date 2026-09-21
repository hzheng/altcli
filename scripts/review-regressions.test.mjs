import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { backgroundState, claudeCompletion, claudeContinuation, claudeStart, claudeStartState, claudeStopContext, codexCompletion, codexInterruption, codexStartState, contextKey, isTaskNotification, marker, outcomeOf } from '../hooks/protocol.mjs';
import { claudeSettings, codexConfig, codexHooks } from './lib/hook-config.mjs';
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
  assert.equal(marker(`first line\nsecond line [codercrew-command:${ID}]`), ID);
  assert.equal(marker('relay'), undefined);
  assert.equal(marker(`relay: [codercrew-command:${ID}] altered`), undefined);
});
const codexStart = (prompt, turn = 'turn1', saved = null) => codexStartState({ hook_event_name: 'UserPromptSubmit', session_id: 'thread1', turn_id: turn, prompt }, identity, saved);
test('Codex completion uses the exact native turn even when notify contains many historical commands', () => {
  const old = 'Old command [codercrew-command:22345678-1234-4234-8234-123456789abc]';
  const prompt = `Finish this task. [codercrew-command:${ID}]`;
  const saved = codexStart(prompt);
  const payload = { type: 'agent-turn-complete', 'thread-id': 'thread1', 'turn-id': 'turn1',
    'input-messages': [old, prompt, 'Include the existing task changes.'], 'last-assistant-message': 'Finished.' };
  const result = codexCompletion(payload, identity, saved);
  assert.equal(result.commandId, ID); assert.equal(result.sourceTurnId, 'turn1'); assert.equal(result.prompt, prompt);
  assert.equal(result.settled, true); assert.equal(result.backgroundState, 'unknown');
  assert.deepEqual(codexCompletion(payload, identity, saved), result);
  assert.equal(codexCompletion({ ...payload, type: 'other-event' }, identity, saved), null);
  assert.equal(codexCompletion(payload, identity).commandId, undefined);
});
test('Codex steering preserves the native binding but conflicting commands and later unmarked turns do not borrow it', () => {
  const prompt = `Finish this task. [codercrew-command:${ID}]`;
  const first = codexStart(prompt);
  const steering = codexStart('Clarification.', 'turn1', first); assert.deepEqual(steering, first);
  const payload = { type: 'agent-turn-complete', thread_id: 'thread1', turn_id: 'turn1', input_messages: [prompt], last_assistant_message: 'Finished.' };
  assert.equal(codexCompletion(payload, identity, steering).commandId, ID);
  for (const changed of [{ ...payload, turn_id: 'later' }, { ...payload, turn_id: undefined }, { ...payload, thread_id: 'other' }]) {
    assert.equal(codexCompletion(changed, identity, first).commandId, undefined);
  }
  assert.equal(codexCompletion(payload, { ...identity, panePid: '99' }, first).commandId, undefined);
  const later = codexStart('Unmarked next turn.', 'later', first);
  assert.equal(codexCompletion({ ...payload, turn_id: 'later' }, identity, later).commandId, undefined);
  assert.equal(codexCompletion(payload, identity, later).commandId, undefined);
  const conflict = codexStart('Other [codercrew-command:22345678-1234-4234-8234-123456789abc]', 'turn1', first);
  assert.equal(conflict.phase, 'ambiguous');
  assert.equal(codexCompletion(payload, identity, codexStart('More steering.', 'turn1', conflict)).commandId, undefined);
  assert.equal(codexStartState({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt }, identity), null);
});
test('Codex native hook installation preserves unrelated hooks and is idempotent', () => {
  const input = { hooks: { Interrupt: [{ hooks: [{ type: 'command', command: 'foreign-interrupt' }] }], Stop: [{ hooks: [{ type: 'command', command: 'foreign-stop' }] }], UserPromptSubmit: [{ hooks: [
    { type: 'command', command: '/old/codercrew-turn-complete.sh codex-start' }, { type: 'command', command: 'foreign-start' }] }] }, custom: true };
  const next = codexHooks(JSON.stringify(input), '/new/codercrew-turn-complete.sh'); const parsed = JSON.parse(next);
  assert.deepEqual(parsed.hooks.Stop, input.hooks.Stop); assert.equal(parsed.custom, true);
  assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].command, 'foreign-start');
  assert.match(parsed.hooks.UserPromptSubmit[1].hooks[0].command, /^exec .* codex-start$/);
  assert.equal(parsed.hooks.Interrupt[0].hooks[0].command, 'foreign-interrupt');
  assert.equal(parsed.hooks.Interrupt[1].hooks[0].timeout, 3);
  assert.match(parsed.hooks.Interrupt[1].hooks[0].command, /codex-start$/);
  assert.equal(codexHooks(next, '/new/codercrew-turn-complete.sh'), next);
  assert.throws(() => codexHooks('{"hooks":[]}', '/hook'), /Unsupported/);
});
test('Codex interruption binds only the current native turn and process', () => {
  const saved = codexStart(`Task [codercrew-command:${ID}]`);
  saved.context.cliPid = '500'; saved.context.startedAt = '2026-09-20T20:00:00.000Z';
  const input = { hook_event_name: 'Interrupt', session_id: 'thread1', turn_id: 'turn1' };
  const interruption = codexInterruption(input, identity, saved, '500');
  assert.equal(interruption.commandId, ID); assert.equal(interruption.event, 'turn_interrupted');
  assert.equal(interruption.settled, false); assert.equal(interruption.backgroundState, 'unknown');
  for (const changed of [{ turn_id: 'older' }, { turn_id: undefined }, { session_id: 'other' }, { session_id: undefined }, { agent_id: 'subagent' }, { hook_event_name: 'Stop' }]) {
    assert.equal(codexInterruption({ ...input, ...changed }, identity, saved, '500'), null);
  }
  assert.equal(codexInterruption(input, identity, saved, '501'), null);
  assert.equal(codexInterruption(input, { ...identity, panePid: '99' }, saved, '500'), null);
  assert.equal(codexInterruption(input, identity, { ...saved, phase: 'ambiguous' }, '500'), null);
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
    // A plain copy: run in place, a linked worktree checkout would refuse to install itself.
    for (const name of ['scripts', 'hooks']) cpSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(home, 'clone', name), { recursive: true });
    const script = join(home, 'clone', 'scripts', 'install-hooks.mjs');
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
test('a task notification is not a turn start; the Stop closing it still completes the active command', () => {
  const notification = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt_id: 'p-note', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' };
  assert.equal(isTaskNotification(notification), true);
  assert.equal(isTaskNotification({ ...notification, prompt: '  <TASK-NOTIFICATION>\n...' }), true);
  assert.equal(isTaskNotification({ ...notification, prompt: 'Please read <task-notification> semantics.' }), false);
  assert.equal(isTaskNotification({ ...notification, hook_event_name: 'Stop' }), false);
  const saved = claudeStartState({ session_id: 's1', prompt_id: 'p-cmd', prompt: `relay: [codercrew-command:${ID}]` }, identity, null);
  const continued = claudeContinuation(notification, identity, saved);
  assert.deepEqual(continued, { ...saved, continuations: ['p-note'] });
  assert.equal(continued.context, saved.context); // the command, prompt and source turn are untouched
  assert.deepEqual(claudeContinuation({ ...notification, prompt_id: 'p-note-2' }, identity, continued).continuations, ['p-note', 'p-note-2']);
  assert.deepEqual(claudeContinuation(notification, identity, continued).continuations, ['p-note']);
  for (const stop of [{ session_id: 's1', prompt_id: 'p-cmd' }, { session_id: 's1', prompt_id: 'p-note' }]) assert.equal(claudeStopContext(stop, identity, continued), saved.context);
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-other' }, identity, continued), null);
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, continued), null);
  // Nothing active, another session, or another pane: not a re-entry, so the hook starts it as an ordinary prompt.
  assert.equal(claudeContinuation(notification, identity, { ...saved, phase: 'finished' }), null);
  const ordinary = claudeStartState({ ...notification, prompt: `${notification.prompt}\nPlease continue. [codercrew-command:${ID}]` }, identity, { ...saved, phase: 'finished' });
  assert.equal(ordinary.context.commandId, ID); assert.equal(ordinary.context.sourceTurnId, 'p-note');
  assert.equal(claudeStopContext({ session_id: 's1', prompt_id: 'p-note' }, identity, ordinary), ordinary.context);
  assert.equal(claudeContinuation({ ...notification, session_id: 's2' }, identity, saved), null);
  assert.equal(claudeContinuation(notification, { ...identity, panePid: '99' }, saved), null);
  assert.equal(claudeContinuation(notification, identity, null), null);
  // Without a native id there is nothing to remember, and a legacy slot keeps pairing by omission.
  const legacy = claudeStartState({ session_id: 's1', prompt: `relay: [codercrew-command:${ID}]` }, identity, null);
  assert.equal(claudeContinuation({ ...notification, prompt_id: undefined }, identity, legacy), legacy);
  assert.equal(claudeContinuation(notification, identity, legacy), legacy);
  assert.equal(claudeStopContext({ session_id: 's1' }, identity, legacy), legacy.context);
  // A real prompt afterwards starts a fresh slot without inherited continuations.
  assert.equal(Object.hasOwn(claudeStartState({ session_id: 's1', prompt_id: 'p-next', prompt: 'next' }, identity, continued), 'continuations'), false);
});
test('the real hooks preserve Claude prompt pairing and Codex correlation through steering', async () => {
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
    // Tmux and foreground process discovery are faked; hook subprocess, file I/O and HTTP are real.
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' '${Object.values(identity).join('\t')}'\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "500\\n"\n', { mode: 0o700 });
    const envFile = join(home, 'hook.env'); writeFileSync(envFile, `CODERCREW_TOKEN=${'a'.repeat(64)}\n`, { mode: 0o600 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, TMUX_PANE: identity.paneId,
      TMUX: `${identity.socketPath},${identity.serverPid},0`, CODERCREW_ENV: envFile, CODERCREW_URL: `http://127.0.0.1:${server.address().port}` };
    const hook = fileURLToPath(new URL('../hooks/codercrew-turn-complete.mjs', import.meta.url));
    const invoke = (payload, source = 'claude') => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [hook, source, ...(source === 'codex' ? [JSON.stringify(payload)] : [])], { env, timeout: 5000 }, (error, stdout, stderr) => {
        if (error) reject(error); else { try { assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(); } catch (failure) { reject(failure); } }
      });
      child.stdin.on('error', reject); child.stdin.end(source !== 'codex' ? JSON.stringify({ session_id: 's1', ...payload }) : undefined);
    });
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-old', prompt: 'desktop text' });
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-current', prompt: `relay: [codercrew-command:${ID}]` });
    assert.equal(events.length, 2); assert.equal(events[1].commandId, ID);
    const slot = join(home, '.local', 'share', 'codercrew', 'hook-turns', `${contextKey(identity, 's1')}.json`);
    // A background task finishing mid-turn re-enters the model with a synthetic prompt: nothing is posted and the command stays active.
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-note', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' });
    assert.equal(events.length, 2); assert.deepEqual(JSON.parse(readFileSync(slot, 'utf8')).continuations, ['p-note']);
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).context.commandId, ID);
    const before = readFileSync(slot, 'utf8'); assert.equal(JSON.parse(before).pairing, 'native');
    const response = { hook_event_name: 'Stop', last_assistant_message: 'RELAY-OUTCOME: strong_objection - Current response.', background_tasks: [], session_crons: [] };
    for (const fields of [{ prompt_id: 'p-old' }, {}, { prompt_id: 'bad\nid' }]) {
      await invoke({ ...response, ...fields }); assert.equal(events.length, 2);
      assert.equal(readFileSync(slot, 'utf8'), before);
    }
    // The Stop that closes the notification re-entry completes the command under its original source turn.
    await invoke({ ...response, prompt_id: 'p-note' });
    assert.equal(events.length, 3); assert.equal(events[2].commandId, ID);
    assert.equal(events[2].sourceTurnId, 'p-current'); assert.equal(events[2].outcome, 'strong_objection');
    await invoke({ ...response, prompt_id: 'p-current' }); assert.equal(events.length, 3); // already finished
    assert.equal(Object.hasOwn(events[2], 'pairing'), false);
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).phase, 'finished');
    await invoke({ ...response, prompt_id: 'p-current' }); assert.equal(events.length, 3); // duplicate Stop
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt: `relay: [codercrew-command:${ID}]` });
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).pairing, 'legacy');
    await invoke(response); assert.equal(events.length, 5);
    assert.equal(events[4].sourceTurnId, events[3].sourceTurnId);
    const prompt = `Finish the task. [codercrew-command:${ID}]`;
    const start = { hook_event_name: 'UserPromptSubmit', session_id: 'codex-session', turn_id: 'codex-turn', prompt };
    await invoke(start, 'codex-start'); assert.equal(events.length, 6);
    assert.equal(events[5].event, 'turn_started'); assert.equal(events[5].commandId, ID);
    await invoke({ ...start, prompt: 'One more clarification.' }, 'codex-start');
    assert.deepEqual({ ...events[6], reporterPid: events[5].reporterPid }, events[5]);
    const codex = { type: 'agent-turn-complete', 'thread-id': 'codex-session', 'turn-id': 'codex-turn',
      'input-messages': ['Earlier [codercrew-command:22345678-1234-4234-8234-123456789abc]', prompt, 'One more clarification.'], 'last-assistant-message': 'Finished.' };
    await invoke(codex, 'codex'); assert.equal(events.length, 8);
    assert.equal(events[7].commandId, ID); assert.equal(events[7].sourceTurnId, 'codex-turn');
    assert.equal(events[7].prompt, prompt); assert.equal(events[7].backgroundState, 'unknown');
    assert.deepEqual(events[7].identity, identity);
    await invoke({ ...codex, 'turn-id': 'later' }, 'codex');
    assert.equal(events.length, 9); assert.equal(events[8].commandId, undefined);
    assert.equal(JSON.parse(readFileSync(slot, 'utf8')).phase, 'finished');
    await invoke({ ...start, turn_id: 'manual-turn', prompt: 'Continue from the terminal.' }, 'codex-start');
    await invoke({ ...codex, 'turn-id': 'manual-turn' }, 'codex');
    assert.equal(events[9].commandId, undefined); assert.equal(events[10].commandId, undefined);
    assert.equal(events[10].sourceTurnId, 'manual-turn'); assert.equal(events[10].cliPid, '500');
    assert.equal(events[10].startedAt, events[9].startedAt); assert.ok(Date.parse(events[10].startedAt));
    const binding = readFileSync(join(home, '.local', 'share', 'codercrew', 'hook-turns', `${contextKey(identity, 'codex-session')}.codex.json`), 'utf8');
    await invoke({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'codex-session' }, 'codex-start');
    assert.equal(events[11].event, 'session_started'); assert.equal(events[11].sourceTurnId, undefined);
    assert.equal(events[11].commandId, undefined); assert.equal(events[11].cliPid, '500');
    assert.equal(readFileSync(join(home, '.local', 'share', 'codercrew', 'hook-turns', `${contextKey(identity, 'codex-session')}.codex.json`), 'utf8'), binding);
    await invoke({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'codex-session' }, 'codex-start');
    assert.equal(events.length, 12); // Compaction is not evidence of readiness.
    await invoke({ hook_event_name: 'SessionStart', source: 'resume' });
    assert.equal(events[12].event, 'session_started'); assert.equal(events[12].source, 'claude');
    // With no turn active, a notification-shaped prompt is an ordinary prompt: it starts and completes under its own id.
    await invoke({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p-late', prompt: '<task-notification>\n<task-id>b2</task-id>\n</task-notification>' });
    assert.equal(events[13].event, 'turn_started'); assert.equal(events[13].sourceTurnId, 'p-late'); assert.equal(events[13].commandId, undefined);
    await invoke({ ...response, prompt_id: 'p-note' }); assert.equal(events.length, 14); // the earlier continuation id does not carry over
    await invoke({ ...response, prompt_id: 'p-late' }); assert.equal(events[14].event, 'turn_complete'); assert.equal(events[14].sourceTurnId, 'p-late');
    const diagnostic = readFileSync(`${slot}.status`, 'utf8');
    assert.equal(JSON.parse(diagnostic).status, 'posted'); assert.equal(JSON.parse(diagnostic).httpStatus, 200);
    assert.doesNotMatch(diagnostic, /desktop text|Current response|codercrew-command|aaaaaaa/);
    const interrupted = { hook_event_name: 'Interrupt', session_id: 'codex-session', turn_id: 'cancel-me' };
    await invoke({ ...start, turn_id: 'cancel-me' }, 'codex-start');
    await invoke(interrupted, 'codex-start');
    assert.equal(events.at(-1).event, 'turn_interrupted'); assert.equal(events.at(-1).commandId, ID);
    const codexSlot = join(home, '.local', 'share', 'codercrew', 'hook-turns', `${contextKey(identity, 'codex-session')}.codex.json`);
    assert.equal(JSON.parse(readFileSync(codexSlot, 'utf8')).phase, 'interrupted');
    await invoke({ ...codex, 'turn-id': 'cancel-me' }, 'codex');
    assert.equal(events.at(-1).commandId, undefined); assert.equal(events.at(-1).cliPid, undefined);
    await invoke({ ...start, turn_id: 'new-turn' }, 'codex-start');
    const current = readFileSync(codexSlot, 'utf8'); const count = events.length;
    await invoke(interrupted, 'codex-start');
    assert.equal(events.length, count); assert.equal(readFileSync(codexSlot, 'utf8'), current);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
