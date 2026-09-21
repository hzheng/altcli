import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installRoot } from "./lib/install-root.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
// A linked worktree shares the host's installation with the main checkout: verify it, never reinstall from here.
const { root: main, linked } = installRoot(root);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["--prefix", "web", "ci"]);
if (linked) console.log(`Linked worktree: hooks and skills stay installed from ${main}; verifying that installation instead of reinstalling.`);
for (const script of ["install-hooks.mjs", "install-skills.mjs"]) {
  if (!linked) run(process.execPath, [fileURLToPath(new URL(script, import.meta.url))]);
  run(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "--check"]);
}
const source = new URL("../web/.env.example", import.meta.url);
const target = new URL("../web/.env.local", import.meta.url);
const tokenOf = (env) => /^CODERCREW_TOKEN=([0-9a-f]{64})\s*$/im.exec(env)?.[1] ?? null;
let template;
if (linked) {
  // The installed hook posts the main checkout's token, so a server started here must accept that same token.
  try { template = await readFile(join(main, "web", ".env.local"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; console.error(`No web/.env.local in ${main}; run node scripts/setup.mjs there first.`); process.exit(1); }
} else {
  const token = randomBytes(32).toString("hex");
  template = (await readFile(source, "utf8")).replace("REPLACE_WITH_A_RANDOM_64_CHARACTER_HEX_TOKEN", token);
}
try {
  await writeFile(target, template, { flag: "wx", mode: 0o600 });
  console.log(linked ? "Copied the main checkout's private web/.env.local so the installed hooks' token matches this server. Keep it private."
    : "Created private web/.env.local. Read your access token from that file; keep it private.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  // An existing worktree file may carry its own minted token from an earlier setup; the hooks would then be rejected here.
  if (linked && tokenOf(await readFile(target, "utf8")) !== tokenOf(template)) {
    console.error(`web/.env.local already exists here with a different CODERCREW_TOKEN than ${join(main, "web", ".env.local")}. The installed hooks post the main checkout's token, so a backend started here would reject them. Replace this file with a copy of the main one (or set the same token), then rerun.`);
    process.exit(1);
  }
  console.log("web/.env.local already exists; nothing was overwritten. Read your token from that file.");
}
console.log(linked ? "Setup complete for this worktree. Stop any other backend on this store before starting one here." : "Setup complete. Restart the coding CLIs to load their hooks and skills.");
console.log("For first-use capture checks, set CODERCREW_ENABLE_INPUT=false in web/.env.local.");
console.log("Then start the console: cd web && npm run dev");
