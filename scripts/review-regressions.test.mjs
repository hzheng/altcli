import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeCompletion, codexCompletion, marker, outcomeOf, backgroundState } from '../hooks/protocol.mjs';
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
