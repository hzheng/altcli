// Read and validate every plan first. Unsupported input is never rewritten heuristically.
import { lstat, mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { claudeSettings, codexConfig, codexHooks } from './lib/hook-config.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const hook = join(root, 'hooks', 'codercrew-turn-complete.sh');
const check = process.argv.includes('--check');
async function read(path) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace a symlink or non-file: ${path}`); return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const claudePath = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const codexPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const plans = [];
for (const [path, transform] of [[claudePath, claudeSettings], [codexPath, (text, target) => codexConfig(text ?? '', target)], [join(dirname(codexPath), 'hooks.json'), codexHooks]]) {
  const before = await read(path); const after = transform(before, hook);
  plans.push({ path, before, after });
}
if (check) {
  const changed = plans.filter((p) => p.before !== p.after);
  for (const plan of changed) console.error(`Hook configuration needs installation: ${plan.path}`);
  process.exitCode = changed.length ? 1 : 0;
} else {
  for (const { path, before, after } of plans) {
    if (before === after) continue;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const suffix = `${Date.now()}-${randomUUID()}`; const temporary = `${path}.codercrew-${suffix}.tmp`;
    try {
      if (await read(path) !== before) throw new Error(`Configuration changed while planning: ${path}`);
      if (before !== null) { const backup = `${path}.codercrew-backup-${suffix}`; await writeFile(backup, before, { mode: 0o600, flag: 'wx' }); console.log(`Backup: ${backup}`); }
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
      if (await read(path) !== before) throw new Error(`Configuration changed before replacement: ${path}`);
      await rename(temporary, path); console.log(`Installed: ${path}`);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  console.log('Restart both coding CLIs to load the hooks. Backups are private; keep them until verification succeeds.');
  console.log('In Codex, use /hooks to review and trust the CoderCrew UserPromptSubmit, SessionStart and Interrupt hooks before sending work.');
}
