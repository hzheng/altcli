// Registers hooks/codercrew-turn-complete.mjs with both CLIs so CoderCrew learns when a turn ends, and the reviewer's
// RELAY-OUTCOME line, from the CLI itself, never from screen text: Claude Code's Stop hook in ~/.claude/settings.json
// and Codex's notify in ~/.codex/config.toml. The registered command is the .sh wrapper, which finds a node binary at
// run time (PATH, Homebrew, nvm) so node upgrades and nvm-less CLI environments both keep working. Idempotent; merges
// into existing files; an older CoderCrew entry is upgraded; a foreign notify command is kept and chained. --check
// reports without writing.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const hook = join(root, "hooks", "codercrew-turn-complete.sh");
const isOurs = (text) => typeof text === "string" && text.includes("codercrew-turn-complete");
const check = process.argv.includes("--check");
const claudeSettings = join(homedir(), ".claude", "settings.json");
const codexConfig = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
const read = (path) => readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
let failed = false;
// Claude Code: hooks.Stop is a list of {hooks: [{type: "command", command}]} groups.
{
  const text = await read(claudeSettings);
  const settings = text ? JSON.parse(text) : {};
  const groups = settings.hooks?.Stop ?? [];
  const command = `${JSON.stringify(hook)} claude`;
  const current = groups.some((group) => (group.hooks ?? []).some((h) => h.command === command && h.timeout === 10));
  const stale = groups.some((group) => (group.hooks ?? []).some((h) => isOurs(h.command) && h.command !== command));
  if (current && !stale) console.log(`Claude Code: Stop hook already present in ${claudeSettings}`);
  else if (check) { failed = true; console.error(`Claude Code: Stop hook ${stale ? "outdated" : "missing"} in ${claudeSettings}; run node scripts/install-hooks.mjs.`); }
  else {
    const kept = groups.filter((group) => !(group.hooks ?? []).some((h) => isOurs(h.command)));
    // The hook may wait up to ~1.5 s for the transcript to settle plus 3 s for the post; 10 s leaves margin.
    settings.hooks = { ...(settings.hooks ?? {}), Stop: [...kept, { hooks: [{ type: "command", command, timeout: 10 }] }] };
    await mkdir(join(homedir(), ".claude"), { recursive: true });
    await writeFile(claudeSettings, JSON.stringify(settings, null, 2) + "\n");
    console.log(`Claude Code: ${stale ? "upgraded" : "added"} Stop hook in ${claudeSettings}`);
  }
}
// Codex: a top-level `notify = [...]` key, which must come before any [table] in the file. Codex allows one notify
// command, so an existing one is kept and chained after ours via --then.
{
  const text = (await read(codexConfig)) ?? "";
  const lines = text.split("\n");
  const index = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
  const line = index >= 0 ? lines[index] : undefined;
  const ours = (previous) => `notify = ${JSON.stringify([hook, "codex", ...(previous.length ? ["--then", ...previous] : [])])}`;
  const elements = line ? [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)) : [];
  // Previous CoderCrew entries (any version, any name) wrap the foreign command after --then; a foreign entry is the whole array.
  let previous = elements;
  while (previous.length && isOurs(previous[0])) { const then = previous.indexOf("--then"); previous = then >= 0 ? previous.slice(then + 1) : []; }
  if (line && line === ours(previous)) console.log(`Codex: notify already set in ${codexConfig}`);
  else if (check) { failed = true; console.error(`Codex: notify ${line ? (elements.some(isOurs) ? "outdated" : "does not include CoderCrew's hook") : "missing"} in ${codexConfig}; run node scripts/install-hooks.mjs.`); }
  else if (line) {
    lines[index] = ours(previous);
    await writeFile(codexConfig, lines.join("\n"));
    console.log(`Codex: notify now runs CoderCrew's hook${previous.length ? `, then the previous command (${previous[0]})` : ""} in ${codexConfig}`);
  } else {
    await mkdir(join(codexConfig, ".."), { recursive: true });
    await writeFile(codexConfig, `${ours([])}\n${text}`);
    console.log(`Codex: added notify to ${codexConfig}`);
  }
}
if (!check) await chmod(hook, 0o755);
if (failed) process.exit(1);
console.log(check ? "Turn-complete hooks are installed for both CLIs." : "Restart Claude Code and Codex sessions so they load the hooks.");
