// Links this repository's skills/<name> directories into the CLIs' user-level skill directories:
// refresh a symlink, never replace a real directory, so unrelated installed skills are untouched.
// An edit under skills/ is live for every CLI session immediately; there is no separate publish step.
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const roots = [join(claudeRoot, "skills"), join(codexRoot, "skills")];
const names = (await readdir(join(root, "skills"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
const exists = async (path) => lstat(path).then(() => true, () => false);
if (check && !(await exists(claudeRoot)) && !(await exists(codexRoot))) {
  console.log("No Claude Code or Codex user directory on this host; skill check skipped.");
  process.exit(0);
}
let failed = false;
for (const skillRoot of roots) {
  if (!check) await mkdir(skillRoot, { recursive: true });
  for (const name of names) {
    const source = join(root, "skills", name);
    const target = join(skillRoot, name);
    const info = await lstat(target).catch(() => null);
    if (check) {
      // Committed assignments name this repository file explicitly. A global discovery link is optional;
      // if one exists, it must still point here. The legacy alias continues to require its installed link.
      if (['commit-handoff', 'plan-handoff'].includes(name) && !info) {
        const skill = await readFile(join(source, 'SKILL.md'), 'utf8');
        if (!skill.startsWith(`---\nname: ${name}\n`)) { failed = true; console.error(`Invalid repository ${name} skill.`); }
        continue;
      }
      const linked = info?.isSymbolicLink() && (await realpath(target).catch(() => null)) === (await realpath(source));
      if (!linked) { failed = true; console.error(`${target} is not a symlink to ${source}${info ? ` (found ${info.isSymbolicLink() ? await readlink(target) : "a real directory"})` : ""}; run node scripts/install-skills.mjs.`); }
      continue;
    }
    if (info && !info.isSymbolicLink()) { console.error(`Skipping ${target}: exists and is not a symlink.`); failed = true; continue; }
    if (info) await unlink(target);
    await symlink(resolve(source), target, "dir");
    console.log(`${target} -> ${source}`);
  }
}
if (failed) process.exit(1);
console.log(check ? "Installed skill links point at this repository." : "Skill links installed. Restart or refresh the CLIs if needed.");
