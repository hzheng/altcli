import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t, customDirectories = false) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'altcli-setup-'))); // Git reports canonical paths
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
  const run = (extra = {}, checkout = root) => spawnSync(process.execPath, [join(checkout, 'scripts', 'setup.mjs')], { cwd: scratch, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, claude, codex, env, run, scratch };
}
/** Commits the fixture clone as a repository's main checkout and adds one linked task worktree beside it. */
function worktreeOf(f) {
  const linked = join(f.scratch, 'task worktree');
  const git = (...args) => { const result = spawnSync('git', ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture'); git('worktree', 'add', '-q', '-b', 'task', linked);
  return linked;
}
for (const custom of [false, true]) test(`one setup command installs and verifies hooks/skills, preserving config on repeat (${custom ? 'custom' : 'default'} CLI directories)`, (t) => {
  const f = fixture(t, custom);
  mkdirSync(f.claude); mkdirSync(f.codex);
  writeFileSync(join(f.claude, 'settings.json'), '{"theme":"dark"}\n');
  writeFileSync(join(f.codex, 'config.toml'), 'model = "fixture-model"\n');
  const first = f.run(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /Setup complete/);
  assert.deepEqual(JSON.parse(readFileSync(f.env.SETUP_TEST_CALLS, 'utf8').trim()), { cwd: realpathSync(f.root), args: ['--prefix', 'web', 'ci'] });
  const settings = readFileSync(join(f.claude, 'settings.json'), 'utf8'); const config = readFileSync(join(f.codex, 'config.toml'), 'utf8');
  assert.equal(JSON.parse(settings).theme, 'dark'); assert.match(settings, /altcli-turn-complete/);
  assert.match(config, /fixture-model/); assert.match(config, /altcli-turn-complete/);
  const native = JSON.parse(readFileSync(join(f.codex, 'hooks.json'), 'utf8'));
  assert.match(native.hooks.UserPromptSubmit[0].hooks[0].command, /codex-start$/);
  assert.equal(native.hooks.SessionStart[0].matcher, 'startup|resume');
  assert.equal(native.hooks.Interrupt[0].hooks[0].timeout, 3);
  assert.equal(JSON.parse(settings).hooks.SessionStart[0].matcher, 'startup|resume');
  for (const directory of [f.claude, f.codex]) {
    assert.equal(readdirSync(directory).filter((name) => name.includes('altcli-backup')).length, 1);
    for (const skill of ['review-handoff', 'commit-handoff', 'plan-handoff']) assert.equal(realpathSync(join(directory, 'skills', skill)), realpathSync(join(f.root, 'skills', skill)));
  }
  const target = join(f.root, 'web', '.env.local'); const content = readFileSync(target, 'utf8');
  const token = content.match(/^ALTCLI_TOKEN=([a-f0-9]{64})$/m)?.[1]; assert.ok(token, 'A random token is stored in the local environment file.');
  assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token), 'Setup must not print its token.');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.match(content, /^ALTCLI_ENABLE_TERMINAL=true$/m); assert.match(content, /^ALTCLI_ENABLE_AGENT_LAUNCH=true$/m);
  const edited = `${content}\n# User setting retained\n`; writeFileSync(target, edited);
  const again = f.run(); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /nothing was overwritten/);
  assert.ok(readFileSync(target, 'utf8') === edited, 'Rerunning setup must preserve local configuration and token.');
  assert.equal(readFileSync(join(f.claude, 'settings.json'), 'utf8'), settings); assert.equal(readFileSync(join(f.codex, 'config.toml'), 'utf8'), config);
  assert.deepEqual(JSON.parse(readFileSync(join(f.codex, 'hooks.json'), 'utf8')), native);
  for (const directory of [f.claude, f.codex]) assert.equal(readdirSync(directory).filter((name) => name.includes('altcli-backup')).length, 1);
});
test('every ALTCLI_ENABLE_* switch the host reads is written into the generated environment template', () => {
  const flags = [...new Set(readFileSync(join(source, 'web', 'src', 'server', 'config.ts'), 'utf8').match(/env\.ALTCLI_ENABLE_[A-Z_]+/g).map((m) => m.slice(4)))];
  const template = readFileSync(join(source, 'web', '.env.example'), 'utf8');
  assert.ok(flags.length >= 4, `expected the host switches, found ${flags.join(', ')}`);
  for (const flag of flags) assert.match(template, new RegExp(`^${flag}=(true|false)$`, 'm'), `${flag} is missing from web/.env.example`);
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
test('installers point at the main checkout: a linked worktree can verify the installation but never own it', (t) => {
  const f = fixture(t); const main = f.root; const linked = worktreeOf(f); mkdirSync(f.claude);
  const run = (checkout, script, ...args) => spawnSync(process.execPath, [join(checkout, 'scripts', script), ...args], { cwd: f.scratch, env: f.env, encoding: 'utf8' });
  for (const script of ['install-hooks.mjs', 'install-skills.mjs']) {
    const refused = run(linked, script); assert.equal(refused.status, 1); assert.ok(refused.stderr.includes(`Run this from ${main}.`), refused.stderr);
    assert.notEqual(run(linked, script, '--check').status, 0, 'The main checkout is not installed yet.');
  }
  assert.equal(existsSync(join(f.claude, 'settings.json')), false); assert.equal(existsSync(join(f.claude, 'skills')), false);
  for (const script of ['install-hooks.mjs', 'install-skills.mjs']) { const installed = run(main, script); assert.equal(installed.status, 0, installed.stderr); }
  const settings = readFileSync(join(f.claude, 'settings.json'), 'utf8');
  assert.ok(settings.includes(join(main, 'hooks', 'altcli-turn-complete.sh')) && !settings.includes(linked), settings);
  for (const skill of ['review-handoff', 'commit-handoff', 'plan-handoff']) assert.equal(realpathSync(join(f.claude, 'skills', skill)), realpathSync(join(main, 'skills', skill)));
  // The same check passes from the linked worktree now: nothing nudges a worktree session into reinstalling from itself.
  for (const script of ['install-hooks.mjs', 'install-skills.mjs']) { const verified = run(linked, script, '--check'); assert.equal(verified.status, 0, verified.stderr); }
});
test('setup in a linked worktree installs dependencies, verifies the main installation and copies its token instead of minting one', (t) => {
  const f = fixture(t); const linked = worktreeOf(f); mkdirSync(f.claude);
  const calls = () => readFileSync(f.env.SETUP_TEST_CALLS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const early = f.run({}, linked); assert.notEqual(early.status, 0); assert.doesNotMatch(early.stdout, /Setup complete/);
  assert.match(early.stdout, /verifying that installation instead of reinstalling/); assert.match(early.stderr, /needs installation/);
  assert.deepEqual(calls(), [{ cwd: linked, args: ['--prefix', 'web', 'ci'] }]); // dependencies land in the worktree
  assert.equal(existsSync(join(linked, 'web', '.env.local')), false); assert.equal(existsSync(join(f.claude, 'settings.json')), false);
  const main = f.run(); assert.equal(main.status, 0, main.stderr); const token = readFileSync(join(f.root, 'web', '.env.local'), 'utf8');
  const settings = readFileSync(join(f.claude, 'settings.json'), 'utf8'); const backups = readdirSync(f.claude).filter((name) => name.includes('altcli-backup'));
  // A worktree set up before hooks moved to the main checkout kept its own minted token; that must not pass as complete.
  const stale = token.replace(/^ALTCLI_TOKEN=.*$/m, `ALTCLI_TOKEN=${'f'.repeat(64)}`); writeFileSync(join(linked, 'web', '.env.local'), stale);
  const mismatch = f.run({}, linked); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /different ALTCLI_TOKEN/); assert.doesNotMatch(mismatch.stdout, /Setup complete/);
  assert.equal(readFileSync(join(linked, 'web', '.env.local'), 'utf8'), stale, 'User configuration is preserved, not overwritten.');
  rmSync(join(linked, 'web', '.env.local'));
  const first = f.run({}, linked); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /Copied the main checkout/); assert.match(first.stdout, /Setup complete for this worktree/);
  assert.equal(readFileSync(join(linked, 'web', '.env.local'), 'utf8'), token); assert.equal(statSync(join(linked, 'web', '.env.local')).mode & 0o777, 0o600);
  assert.ok(!first.stdout.includes(token.match(/^ALTCLI_TOKEN=([a-f0-9]{64})$/m)[1]), 'Setup must not print the token.');
  assert.equal(readFileSync(join(f.claude, 'settings.json'), 'utf8'), settings); assert.deepEqual(readdirSync(f.claude).filter((name) => name.includes('altcli-backup')), backups);
  assert.ok(!settings.includes(linked), 'The worktree never enters the host configuration.');
  const again = f.run({}, linked); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /nothing was overwritten/);
});
