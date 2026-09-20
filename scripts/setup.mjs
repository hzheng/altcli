import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["--prefix", "web", "ci"]);
for (const script of ["install-hooks.mjs", "install-skills.mjs"]) {
  run(process.execPath, [fileURLToPath(new URL(script, import.meta.url))]);
  run(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "--check"]);
}
const source = new URL("../web/.env.example", import.meta.url);
const target = new URL("../web/.env.local", import.meta.url);
const token = randomBytes(32).toString("hex");
const template = (await readFile(source, "utf8")).replace("REPLACE_WITH_A_RANDOM_64_CHARACTER_HEX_TOKEN", token);
try {
  await writeFile(target, template, { flag: "wx", mode: 0o600 });
  console.log("Created private web/.env.local. Read your access token from that file; keep it private.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("web/.env.local already exists; nothing was overwritten. Read your token from that file.");
}
console.log("Setup complete. Restart the coding CLIs to load their hooks and skills.");
console.log("For first-use capture checks, set CODERCREW_ENABLE_INPUT=false in web/.env.local.");
console.log("Then start the console: cd web && npm run dev");
