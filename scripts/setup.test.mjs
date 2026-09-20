import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t, customDirectories = false) {
  const scratch = mkdtempSync(join(tmpdir(), 'codercrew-setup-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'clone with spaces'); const testHome = join(scratch, 'test-home'); const bin = join(scratch, 'bin');
  mkdirSync(join(root, 'web'), { recursive: true }); mkdirSync(testHome); mkdirSync(bin);
  for (const name of ['scripts', 'skills', 'hooks']) cpSync(join(source, name), join(root, name), { recursive: true });
  cpSync(join(source, 'web', '.env.example'), join(root, 'web', '.env.example'));
  // Only npm is stubbed: no network/dependency installation. Skill and hook installers run for real.
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.exit(Number(process.env.SETUP_TEST_NPM_EXIT ?? 0));
`, { mode: 0o755 });
  const claude = join(testHome, customDirectories ? 'custom-claude' : '.claude');
  const codex = join(testHome, customDirectories ? 'custom-codex' : '.codex');
  // Isolate every child installer from the user's actual CLI configuration.
  const env = { ...process.env, HOME: testHome, PATH: `${bin}:${process.env.PATH}`, SETUP_TEST_CALLS: join(scratch, 'npm-calls.jsonl'), SETUP_TEST_NPM_EXIT: '0' };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  if (customDirectories) { env.CLAUDE_CONFIG_DIR = claude; env.CODEX_HOME = codex; }
  const run = (extra = {}) => spawnSync(process.execPath, [join(root, 'scripts', 'setup.mjs')], { cwd: scratch, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, claude, codex, env, run };
}
for (const custom of [false, true]) test(`one setup command installs and verifies hooks/skills, preserving config on repeat (${custom ? 'custom' : 'default'} CLI directories)`, (t) => {
  const f = fixture(t, custom);
  mkdirSync(f.claude); mkdirSync(f.codex);
  writeFileSync(join(f.claude, 'settings.json'), '{"theme":"dark"}\n');
  writeFileSync(join(f.codex, 'config.toml'), 'model = "fixture-model"\n');
  const first = f.run(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /Setup complete/);
  assert.deepEqual(JSON.parse(readFileSync(f.env.SETUP_TEST_CALLS, 'utf8').trim()), { cwd: realpathSync(f.root), args: ['--prefix', 'web', 'ci'] });
  const settings = readFileSync(join(f.claude, 'settings.json'), 'utf8'); const config = readFileSync(join(f.codex, 'config.toml'), 'utf8');
  assert.equal(JSON.parse(settings).theme, 'dark'); assert.match(settings, /codercrew-turn-complete/);
  assert.match(config, /fixture-model/); assert.match(config, /codercrew-turn-complete/);
  const native = JSON.parse(readFileSync(join(f.codex, 'hooks.json'), 'utf8'));
  assert.match(native.hooks.UserPromptSubmit[0].hooks[0].command, /codex-start$/);
  assert.equal(native.hooks.SessionStart[0].matcher, 'startup|resume');
  assert.equal(native.hooks.Interrupt[0].hooks[0].timeout, 3);
  assert.equal(JSON.parse(settings).hooks.SessionStart[0].matcher, 'startup|resume');
  for (const directory of [f.claude, f.codex]) {
    assert.equal(readdirSync(directory).filter((name) => name.includes('codercrew-backup')).length, 1);
    for (const skill of ['review-handoff', 'commit-handoff', 'plan-handoff']) assert.equal(realpathSync(join(directory, 'skills', skill)), realpathSync(join(f.root, 'skills', skill)));
  }
  const target = join(f.root, 'web', '.env.local'); const content = readFileSync(target, 'utf8');
  const token = content.match(/^CODERCREW_TOKEN=([a-f0-9]{64})$/m)?.[1]; assert.ok(token, 'A random token is stored in the local environment file.');
  assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token), 'Setup must not print its token.');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const edited = `${content}\n# User setting retained\n`; writeFileSync(target, edited);
  const again = f.run(); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /nothing was overwritten/);
  assert.ok(readFileSync(target, 'utf8') === edited, 'Rerunning setup must preserve local configuration and token.');
  assert.equal(readFileSync(join(f.claude, 'settings.json'), 'utf8'), settings); assert.equal(readFileSync(join(f.codex, 'config.toml'), 'utf8'), config);
  assert.deepEqual(JSON.parse(readFileSync(join(f.codex, 'hooks.json'), 'utf8')), native);
  for (const directory of [f.claude, f.codex]) assert.equal(readdirSync(directory).filter((name) => name.includes('codercrew-backup')).length, 1);
});
test('setup stops on dependency installation failure before editing CLI or local configuration', (t) => {
  const f = fixture(t); const result = f.run({ SETUP_TEST_NPM_EXIT: '17' });
  assert.equal(result.status, 17); assert.doesNotMatch(result.stdout, /Setup complete/);
  for (const path of [f.claude, f.codex, join(f.root, 'web', '.env.local')]) assert.equal(existsSync(path), false);
});
test('setup surfaces unsupported hook configuration without claiming completion', (t) => {
  const f = fixture(t); mkdirSync(f.codex); writeFileSync(join(f.codex, 'config.toml'), 'notify = ["""unsupported"""]\n');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsupported/i); assert.doesNotMatch(result.stdout, /Setup complete/);
  assert.equal(existsSync(f.claude), false); assert.equal(existsSync(join(f.root, 'web', '.env.local')), false);
  assert.equal(readFileSync(join(f.codex, 'config.toml'), 'utf8'), 'notify = ["""unsupported"""]\n');
});
test('setup preserves conflicting real skill directories and reports failure', (t) => {
  const f = fixture(t); const existing = join(f.claude, 'skills', 'plan-handoff'); mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, 'SKILL.md'), 'User-owned skill\n');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /exists and is not a symlink/); assert.doesNotMatch(result.stdout, /Setup complete/);
  assert.equal(readFileSync(join(existing, 'SKILL.md'), 'utf8'), 'User-owned skill\n');
});
